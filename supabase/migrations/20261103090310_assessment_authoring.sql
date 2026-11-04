-- =====================================================================
-- SolveEdu Platform — Migration 13: Assessment authoring RPCs
--   * set_item_key()               write-only: authors set/replace a key, never read it
--   * item_key_status()            per item: has a key? still valid? (no key content)
--   * publish_instrument_version() draft → published; every item needs a valid key
--   * clone_instrument_version()   new draft copied from any version (items + keys)
--   * reorder_course_items('item') reorder the items of a draft version
--
-- content_hash covers the item content only. Hashing the keys too would let
-- anyone who sees the items and the hash brute-force the key offline (a test
-- of 10 four-choice items has only ~1M combinations). Keys of a published
-- version are frozen by trigger instead.
-- =====================================================================

create or replace function private.version_content_hash(p_version uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object(
           'item_type', i.item_type,
           'prompt', i.prompt,
           'media_path', i.media_path,
           'options', i.options_json,
           'max_score', i.max_score) order by i.display_order), '[]'::jsonb)::text, 'UTF8')), 'hex')
    from public.instrument_items i
   where i.instrument_version_id = p_version
$$;

revoke all on function private.version_content_hash(uuid) from public;

-- ---------------------------------------------------------------------
-- Item / key edits take a SHARE lock on the version row, so they wait for a
-- concurrent publish (FOR UPDATE) and then see status = 'published'.
-- ---------------------------------------------------------------------
create or replace function private.instrument_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version uuid := case when tg_op = 'DELETE' then old.instrument_version_id else new.instrument_version_id end;
  v_status text;
  v_instrument uuid;
  v_error text;
  v_path text;
begin
  select v.status, v.instrument_id into v_status, v_instrument
    from public.instrument_versions v where v.id = v_version
     for share;
  if v_status is distinct from 'draft'
     or (tg_op = 'UPDATE' and new.instrument_version_id <> old.instrument_version_id) then
    raise exception 'items of a published version cannot change (create a new version instead)'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_error := private.item_shape_error(new.item_type, new.options_json);
  if v_error is not null then
    raise exception 'invalid item: %', v_error using errcode = 'check_violation';
  end if;

  for v_path in
    select new.media_path
    union all
    select o ->> 'image_path'
      from jsonb_array_elements(coalesce(new.options_json -> 'options', '[]'::jsonb)) o
  loop
    if v_path is not null
       and (not starts_with(v_path, v_instrument::text || '/') or v_path ~ '(^|/)\.\.(/|$)') then
      raise exception 'invalid item: media must be stored under the instrument folder'
        using errcode = 'check_violation';
    end if;
  end loop;

  -- A changed item type makes the old answer key meaningless.
  if tg_op = 'UPDATE' and new.item_type <> old.item_type then
    delete from private.instrument_answer_keys where item_id = old.id;
  end if;
  return new;
end;
$$;

create or replace function private.instrument_answer_keys_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item uuid := case when tg_op = 'DELETE' then old.item_id else new.item_id end;
  v_type text;
  v_options jsonb;
  v_status text;
  v_error text;
begin
  select i.item_type, i.options_json, v.status into v_type, v_options, v_status
    from public.instrument_items i
    join public.instrument_versions v on v.id = i.instrument_version_id
   where i.id = v_item
     for share of v;

  -- v_status is null while the item itself is being cascade-deleted
  if v_status is not null and v_status <> 'draft' then
    raise exception 'answer keys of a published version cannot change' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  v_error := private.answer_key_error(v_type, v_options, new.answer_json, new.scoring_json);
  if v_error is not null then
    raise exception 'invalid answer key: %', v_error using errcode = 'check_violation';
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- set_item_key(item, answer, scoring)
-- ---------------------------------------------------------------------
create or replace function public.set_item_key(p_item uuid, p_answer jsonb, p_scoring jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_version uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select i.instrument_version_id into v_version from public.instrument_items i where i.id = p_item;
  if v_version is null or not authz.can_manage_version(v_version) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- Draft-only and shape checks run in the key trigger.
  insert into private.instrument_answer_keys (item_id, answer_json, scoring_json)
  values (p_item, p_answer, coalesce(p_scoring, '{}'::jsonb))
  on conflict (item_id) do update
     set answer_json = excluded.answer_json, scoring_json = excluded.scoring_json;

  -- The audit trail records who set a key, never the key itself.
  insert into private.audit_logs (actor_id, action, table_name, record_id, after_json)
  values (v_uid, 'SET_ANSWER_KEY', 'private.instrument_answer_keys', p_item,
          jsonb_build_object('instrument_version_id', v_version));
end;
$$;

-- ---------------------------------------------------------------------
-- item_key_status(version) → (item_id, has_key, key_valid)
-- ---------------------------------------------------------------------
create or replace function public.item_key_status(p_version uuid)
returns table (item_id uuid, has_key boolean, key_valid boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not authz.can_manage_version(p_version) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  return query
    select i.id,
           k.item_id is not null,
           k.item_id is not null
             and private.answer_key_error(i.item_type, i.options_json, k.answer_json, k.scoring_json) is null
      from public.instrument_items i
      left join private.instrument_answer_keys k on k.item_id = i.id
     where i.instrument_version_id = p_version
     order by i.display_order;
end;
$$;

-- ---------------------------------------------------------------------
-- publish_instrument_version(version) → content_hash
-- ---------------------------------------------------------------------
create or replace function public.publish_instrument_version(p_version uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_bad integer;
  v_hash text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if not authz.can_manage_version(p_version) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  select v.status into v_status from public.instrument_versions v where v.id = p_version for update;
  if v_status is distinct from 'draft' then
    raise exception 'only a draft version can be published' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.instrument_items i where i.instrument_version_id = p_version) then
    raise exception 'a version needs at least one item' using errcode = 'check_violation';
  end if;

  -- Keys are re-validated: choices may have changed after the key was set.
  select count(*) into v_bad
    from public.instrument_items i
    left join private.instrument_answer_keys k on k.item_id = i.id
   where i.instrument_version_id = p_version
     and (k.item_id is null
          or private.answer_key_error(i.item_type, i.options_json, k.answer_json, k.scoring_json) is not null);
  if v_bad > 0 then
    raise exception 'every item needs a valid answer key (% missing or invalid)', v_bad
      using errcode = 'check_violation';
  end if;

  v_hash := private.version_content_hash(p_version);
  update public.instrument_versions
     set status = 'published', published_at = now(), published_by = v_uid, content_hash = v_hash
   where id = p_version;
  return v_hash;
end;
$$;

-- ---------------------------------------------------------------------
-- clone_instrument_version(version) → new draft id
-- ---------------------------------------------------------------------
create or replace function public.clone_instrument_version(p_version uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_instrument uuid;
  v_new uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select v.instrument_id into v_instrument from public.instrument_versions v where v.id = p_version;
  if v_instrument is null or not authz.can_manage_instrument(v_instrument) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.instrument_versions v where v.instrument_id = v_instrument and v.status = 'draft') then
    raise exception 'a draft version already exists' using errcode = 'unique_violation';
  end if;

  insert into public.instrument_versions (instrument_id) values (v_instrument) returning id into v_new;

  insert into public.instrument_items (instrument_version_id, item_type, prompt, media_path, options_json, max_score, display_order)
  select v_new, i.item_type, i.prompt, i.media_path, i.options_json, i.max_score, i.display_order
    from public.instrument_items i
   where i.instrument_version_id = p_version;

  -- display_order is unique per version, so it maps old items to new ones.
  insert into private.instrument_answer_keys (item_id, answer_json, scoring_json)
  select n.id, k.answer_json, k.scoring_json
    from public.instrument_items o
    join private.instrument_answer_keys k on k.item_id = o.id
    join public.instrument_items n on n.instrument_version_id = v_new and n.display_order = o.display_order
   where o.instrument_version_id = p_version;

  insert into private.audit_logs (actor_id, action, table_name, record_id, after_json)
  values (v_uid, 'CLONE_VERSION', 'public.instrument_versions', v_new,
          jsonb_build_object('source_version_id', p_version));
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------
-- reorder_course_items: + kind 'item' (items of an instrument version).
-- Still SECURITY INVOKER; the item trigger refuses published versions.
-- ---------------------------------------------------------------------
create or replace function public.reorder_course_items(p_kind text, p_parent uuid, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_table text;
  v_parent_col text;
  v_allowed boolean;
  v_children uuid[];
  v_updated integer;
begin
  case p_kind
    when 'unit'   then v_table := 'course_units';     v_parent_col := 'course_id';             v_allowed := authz.can_manage_course(p_parent);
    when 'lesson' then v_table := 'lessons';          v_parent_col := 'unit_id';               v_allowed := authz.can_manage_unit(p_parent);
    when 'block'  then v_table := 'lesson_blocks';    v_parent_col := 'lesson_id';             v_allowed := authz.can_manage_lesson(p_parent);
    when 'item'   then v_table := 'instrument_items'; v_parent_col := 'instrument_version_id'; v_allowed := authz.can_manage_version(p_parent);
    else raise exception 'invalid kind: %', p_kind using errcode = 'invalid_parameter_value';
  end case;

  if not coalesce(v_allowed, false) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  if p_ids is null or cardinality(p_ids) = 0
     or array_position(p_ids, null) is not null
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'ids must be a non-empty list without duplicates' using errcode = 'invalid_parameter_value';
  end if;

  execute format('select array_agg(id order by id) from public.%I where %I = $1', v_table, v_parent_col)
     into v_children using p_parent;

  if v_children is distinct from (select array_agg(x order by x) from unnest(p_ids) x) then
    raise exception 'ids must list every item of the parent exactly once' using errcode = 'invalid_parameter_value';
  end if;

  execute format(
    'update public.%I t set display_order = o.pos
       from unnest($2) with ordinality as o(id, pos)
      where t.id = o.id and t.%I = $1 and t.display_order is distinct from o.pos',
    v_table, v_parent_col)
  using p_parent, p_ids;

  -- Rows hidden by RLS would be silently skipped; verify the final state instead.
  execute format(
    'select count(*) from public.%I t join unnest($2) with ordinality as o(id, pos) on o.id = t.id
      where t.%I = $1 and t.display_order = o.pos',
    v_table, v_parent_col)
  into v_updated using p_parent, p_ids;
  if v_updated <> cardinality(p_ids) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke execute on function public.set_item_key(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.item_key_status(uuid) from public, anon;
revoke execute on function public.publish_instrument_version(uuid) from public, anon;
revoke execute on function public.clone_instrument_version(uuid) from public, anon;
grant execute on function public.set_item_key(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.item_key_status(uuid) to authenticated;
grant execute on function public.publish_instrument_version(uuid) to authenticated;
grant execute on function public.clone_instrument_version(uuid) to authenticated;

comment on function public.set_item_key(uuid, jsonb, jsonb) is 'ตั้ง/แทนที่เฉลยของข้อในฉบับร่าง — เขียนได้อย่างเดียว ไม่มีทางอ่านเฉลยกลับ; audit ไม่เก็บเนื้อเฉลย';
comment on function public.item_key_status(uuid) is 'สถานะเฉลยรายข้อ (มีเฉลยไหม/ยังตรงกับตัวเลือกไหม) โดยไม่ส่งเนื้อเฉลย';
comment on function public.publish_instrument_version(uuid) is 'เผยแพร่ฉบับร่าง — ทุกข้อต้องมีเฉลยที่ถูกต้อง; content_hash คิดจากเนื้อหาข้อสอบเท่านั้น (ไม่รวมเฉลย)';
comment on function public.clone_instrument_version(uuid) is 'สร้างฉบับร่างใหม่โดยคัดลอกข้อและเฉลยจากฉบับเดิม';

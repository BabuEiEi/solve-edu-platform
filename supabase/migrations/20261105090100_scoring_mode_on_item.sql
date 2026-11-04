-- =====================================================================
-- Phase 2C.1 / step 3 — the scoring mode lives on the item
--
-- "partial / all or nothing" used to sit in the answer key
-- (private.instrument_answer_keys.scoring_json), which nobody can read back
-- (owner rule: keys are write-only). So the edit form could never show the
-- mode that was set. The mode is not secret, so it moves to
-- public.instrument_items.scoring_mode; the key keeps only the answer.
--
--   scoring_mode  null = the type's default (mcq_multiple: all_or_nothing;
--                 ordering … image_labelling: partial). Types with one part
--                 (mcq_single, true_false, numeric) take none.
--   scoring_json  kept for compatibility, now always '{}'.
-- Existing modes are copied over. Published versions are not changed in
-- substance (same mode, new place), so the guard triggers are bypassed for
-- this one-off copy only.
-- =====================================================================

alter table public.instrument_items
  add column scoring_mode text,
  add constraint instrument_items_scoring_mode_check
    check (scoring_mode in ('partial', 'all_or_nothing')),
  add constraint instrument_items_scoring_mode_type_check
    check (scoring_mode is null or item_type not in ('mcq_single', 'true_false', 'numeric'));

comment on column public.instrument_items.scoring_mode is
  'partial | all_or_nothing · null = ค่าเริ่มต้นของประเภท (mcq_multiple: all_or_nothing, ข้อแบบใหม่: partial) · ไม่ใช่ความลับ (2C.1)';

-- One-off copy that skips the draft-only guards. SET LOCAL inside DO (always
-- one transaction), so the setting ends with it whatever tool runs the file.
-- (SET, not set_config(): Supabase lets the postgres role SET this parameter
-- but not set it through the function.)
do $$
begin
  set local session_replication_role = replica;
  update public.instrument_items i
     set scoring_mode = k.scoring_json ->> 'mode'
    from private.instrument_answer_keys k
   where k.item_id = i.id and k.scoring_json ? 'mode';
  update private.instrument_answer_keys set scoring_json = '{}'::jsonb where scoring_json <> '{}'::jsonb;
  set local session_replication_role = origin;
end $$;

alter table private.instrument_answer_keys
  add constraint instrument_answer_keys_scoring_moved check (scoring_json = '{}'::jsonb);
comment on column private.instrument_answer_keys.scoring_json is
  'เลิกใช้ (2C.1): วิธีให้คะแนนอยู่ที่ instrument_items.scoring_mode — ต้องเป็น {} เสมอ';

grant insert (scoring_mode), update (scoring_mode) on public.instrument_items to authenticated;

-- The scoring object handed to score_response for an item.
create function private.item_scoring(p_mode text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_mode is null then '{}'::jsonb else jsonb_build_object('mode', p_mode) end
$$;
revoke all on function private.item_scoring(text) from public;

-- ---------------------------------------------------------------------
-- Scoring reads the mode from the item (was: the key's scoring_json)
-- ---------------------------------------------------------------------
create or replace function private.finalize_attempt(p_attempt uuid, p_responses jsonb, p_auto boolean)
returns public.assessment_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.assessment_attempts%rowtype;
  v_a public.assessment_assignments%rowtype;
  v_item record;
  v_resp jsonb;
  v_error text;
  v_awarded numeric;
  v_frac numeric;
  v_score numeric := 0;
  v_max numeric := 0;
  v_correct integer := 0;
  v_count integer := 0;
begin
  select * into v_t from public.assessment_attempts t where t.id = p_attempt for update;
  if v_t.status <> 'in_progress' then
    raise exception 'attempt already submitted' using errcode = 'SE003';
  end if;
  select * into v_a from public.assessment_assignments a where a.id = v_t.assignment_id;

  v_error := private.responses_error(v_a.instrument_version_id, p_responses);
  if v_error is not null then
    raise exception 'invalid response: %', v_error using errcode = 'invalid_parameter_value';
  end if;

  for v_item in
    select i.id, i.item_type, i.max_score, k.item_id as key_item, k.answer_json,
           private.item_scoring(i.scoring_mode) as scoring
      from public.instrument_items i
      left join private.instrument_answer_keys k on k.item_id = i.id
     where i.instrument_version_id = v_a.instrument_version_id
     order by i.display_order
  loop
    if v_item.key_item is null then
      raise exception 'published item % has no answer key', v_item.id;  -- cannot happen after publish
    end if;
    v_resp := coalesce(p_responses -> v_item.id::text, 'null'::jsonb);
    v_frac := case when v_resp = 'null'::jsonb then 0
                   else private.score_response(v_item.item_type, v_item.answer_json, v_item.scoring, v_resp) end;
    v_awarded := round(v_frac * v_item.max_score, 2);
    insert into public.assessment_responses (attempt_id, item_id, response_json, awarded_score, graded_at)
    values (p_attempt, v_item.id, v_resp, v_awarded, now());
    v_score := v_score + v_awarded;
    v_max := v_max + v_item.max_score;
    v_count := v_count + 1;
    if v_frac = 1 then
      v_correct := v_correct + 1;
    end if;
  end loop;

  update public.assessment_attempts t
     set status = 'submitted', submitted_at = now(), score = v_score, max_score = v_max,
         passed = case when v_a.passing_percent is null then null
                       else v_score * 100 >= v_a.passing_percent * v_max end,
         correct_count = v_correct, item_count = v_count,
         auto_submitted = p_auto, draft_json = null
   where t.id = p_attempt
  returning t.* into v_t;
  return v_t;
end;
$$;
revoke all on function private.finalize_attempt(uuid, jsonb, boolean) from public;

-- ---------------------------------------------------------------------
-- A new draft copies the mode with the item
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

  insert into public.instrument_items (instrument_version_id, item_type, prompt, media_path, options_json, max_score,
                                       display_order, scoring_mode)
  select v_new, i.item_type, i.prompt, i.media_path, i.options_json, i.max_score, i.display_order, i.scoring_mode
    from public.instrument_items i
   where i.instrument_version_id = p_version;

  -- display_order is unique per version, so it maps old items to new ones.
  insert into private.instrument_answer_keys (item_id, answer_json)
  select n.id, k.answer_json
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
revoke execute on function public.clone_instrument_version(uuid) from public, anon;
grant execute on function public.clone_instrument_version(uuid) to authenticated;

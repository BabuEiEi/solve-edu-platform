-- =====================================================================
-- Phase 2C / step 1 — item types, group A + server-side shuffle
--
--   ordering        options [3-10 entries]                 key {"order":[ids]}
--                   response {"order":[ids]} (a full permutation)
--   matching        left [2-10], right [>= left, <= 15]    key {"slots":{left id: right id}} (1:1)
--   classification  categories [2-6], items [2-15]         key {"slots":{item id: category id}}
--   choice_matrix   rows [1-15], columns [2-6]             key {"slots":{row id: column id}}
--   (the last three) response {"slots":{slot id: choice id}} — slots may be left out
--
-- An entry is {id, text?, image_path?} like an MCQ choice. Keys never sit in
-- options_json. scoring_json {"mode": "all_or_nothing" | "partial"}; the
-- default for these types is partial (owner decision): ordering = positions
-- right / n, slot types = slots right / slots.
--
-- Shuffle: start_attempt builds the order each person sees and stores it on
-- the attempt (presentation_json, evidence). Ordering lists and the right
-- column of matching are always shuffled (an ordering list never starts in
-- the correct order); choices and items only when the assignment asks
-- (shuffle_choices / shuffle_items, both off by default).
-- =====================================================================

alter table public.instrument_items drop constraint instrument_items_item_type_check;
alter table public.instrument_items add constraint instrument_items_item_type_check
  check (item_type in ('mcq_single', 'mcq_multiple', 'true_false', 'numeric',
                       'ordering', 'matching', 'classification', 'choice_matrix'));
comment on column public.instrument_items.item_type is 'mcq_single|mcq_multiple|true_false|numeric (2B) · ordering|matching|classification|choice_matrix (2C)';

alter table public.assessment_assignments
  add column shuffle_items boolean not null default false,
  add column shuffle_choices boolean not null default false;
grant insert (shuffle_items, shuffle_choices), update (shuffle_items, shuffle_choices)
  on public.assessment_assignments to authenticated;
comment on column public.assessment_assignments.shuffle_items is 'สลับลำดับข้อต่อคน (บันทึกใน attempts.presentation_json)';
comment on column public.assessment_assignments.shuffle_choices is 'สลับลำดับตัวเลือกต่อคน (ข้อเรียงลำดับและฝั่งขวาของข้อจับคู่สลับเสมอ)';

alter table public.assessment_attempts add column presentation_json jsonb;
grant select (presentation_json) on public.assessment_attempts to authenticated;
comment on column public.assessment_attempts.presentation_json is 'ลำดับข้อและตัวเลือกที่ผู้ทำเห็น {items:[ids], lists:{item:{list:[ids]}}} — สร้างโดย server ตอนเริ่ม';

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function private.ids_of(p_list jsonb)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(e ->> 'id'), '{}')
    from jsonb_array_elements(case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end) e
$$;

-- An array of entries {id, text?, image_path?}: error or null.
create or replace function private.entries_error(p_list jsonb, p_min integer, p_max integer, p_what text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v jsonb;
  v_ids text[] := '{}';
begin
  if jsonb_typeof(p_list) is distinct from 'array' then
    return format('%s must be an array of %s-%s entries', p_what, p_min, p_max);
  end if;
  if jsonb_array_length(p_list) not between p_min and p_max then
    return format('%s must be an array of %s-%s entries', p_what, p_min, p_max);
  end if;
  for v in select value from jsonb_array_elements(p_list) loop
    if jsonb_typeof(v) is distinct from 'object' then
      return format('each entry of %s must be an object', p_what);
    end if;
    if exists (select 1 from jsonb_object_keys(v) k where k not in ('id', 'text', 'image_path')) then
      return 'an entry may only contain id, text, image_path';
    end if;
    if jsonb_typeof(v -> 'id') is distinct from 'string' or (v ->> 'id') !~ '^[a-z0-9]{1,8}$' then
      return 'entry id must match [a-z0-9]{1,8}';
    end if;
    if (v ->> 'id') = any (v_ids) then
      return format('duplicate id in %s', p_what);
    end if;
    v_ids := v_ids || (v ->> 'id');
    if (v ? 'text' and jsonb_typeof(v -> 'text') is distinct from 'string')
       or (v ? 'image_path' and jsonb_typeof(v -> 'image_path') is distinct from 'string') then
      return 'entry text and image_path must be strings';
    end if;
    if coalesce(btrim(v ->> 'text'), '') = '' and coalesce(v ->> 'image_path', '') = '' then
      return 'an entry needs text or an image';
    end if;
    if char_length(coalesce(v ->> 'text', '')) > 1000 then
      return 'entry text is too long';
    end if;
  end loop;
  return null;
end;
$$;

-- Every image path in an item's options (any list), for folder and in-use checks.
create or replace function private.options_media_paths(p_options jsonb)
returns setof text language sql immutable set search_path = '' as $$
  select e ->> 'image_path'
    from jsonb_each(case when jsonb_typeof(p_options) = 'object' then p_options else '{}'::jsonb end) kv
   cross join lateral jsonb_array_elements(case when jsonb_typeof(kv.value) = 'array' then kv.value else '[]'::jsonb end) e
   where jsonb_typeof(e) = 'object' and e ? 'image_path'
$$;

-- Slot types: each slot and the choice ids it accepts.
create or replace function private.slot_choices(p_type text, p_options jsonb)
returns table (slot_id text, choice_ids text[])
language sql immutable
set search_path = ''
as $$
  select s ->> 'id',
         private.ids_of(p_options -> case p_type when 'matching' then 'right'
                                                 when 'classification' then 'categories'
                                                 when 'choice_matrix' then 'columns' end)
    from jsonb_array_elements(coalesce(p_options -> case p_type when 'matching' then 'left'
                                                                when 'classification' then 'items'
                                                                when 'choice_matrix' then 'rows' end,
                                       '[]'::jsonb)) s
   where p_type in ('matching', 'classification', 'choice_matrix')
$$;

-- {slot id: choice id}: every key a slot, every value one of its choices.
-- p_complete: every slot present (keys); p_distinct: no choice used twice.
create or replace function private.slot_map_error(p_type text, p_options jsonb, p_map jsonb,
                                                  p_complete boolean, p_distinct boolean)
returns text
language plpgsql immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_map) is distinct from 'object' then
    return 'slots must be an object {slot id: choice id}';
  end if;
  if exists (
    select 1
      from jsonb_each(p_map) kv
      left join private.slot_choices(p_type, p_options) sc on sc.slot_id = kv.key
     where sc.slot_id is null
        or jsonb_typeof(kv.value) is distinct from 'string'
        or not ((kv.value #>> '{}') = any (sc.choice_ids))
  ) then
    return 'unknown slot or choice';
  end if;
  if p_complete and exists (select 1 from private.slot_choices(p_type, p_options) sc where not p_map ? sc.slot_id) then
    return 'every slot needs a choice';
  end if;
  if p_distinct and (select count(*) from jsonb_each_text(p_map)) <> (select count(distinct value) from jsonb_each_text(p_map)) then
    return 'a choice may be used only once';
  end if;
  return null;
end;
$$;

create or replace function private.scoring_mode_error(p_scoring jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when exists (select 1 from jsonb_object_keys(p_scoring) k where k <> 'mode')
      or coalesce(p_scoring ->> 'mode', 'partial') not in ('all_or_nothing', 'partial')
    then 'scoring_json must be {"mode": "all_or_nothing" | "partial"}' end
$$;

-- ---------------------------------------------------------------------
-- Shapes
-- ---------------------------------------------------------------------
create or replace function private.item_shape_error(p_type text, p_options jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if jsonb_typeof(p_options) is distinct from 'object' then
    return 'options_json must be an object';
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_object_keys(p_options) k;

  case p_type
    when 'mcq_single', 'mcq_multiple', 'ordering' then
      if v_keys <> array['options'] then
        return 'options_json must contain exactly "options"';
      end if;
      return private.entries_error(p_options -> 'options', case when p_type = 'ordering' then 3 else 2 end, 10, 'options');
    when 'matching' then
      if v_keys <> array['left', 'right'] then
        return 'options_json must contain exactly "left" and "right"';
      end if;
      return coalesce(
        private.entries_error(p_options -> 'left', 2, 10, 'left'),
        private.entries_error(p_options -> 'right', 2, 15, 'right'),
        case when jsonb_array_length(p_options -> 'right') < jsonb_array_length(p_options -> 'left')
             then 'right needs at least as many entries as left' end);
    when 'classification' then
      if v_keys <> array['categories', 'items'] then
        return 'options_json must contain exactly "categories" and "items"';
      end if;
      return coalesce(private.entries_error(p_options -> 'categories', 2, 6, 'categories'),
                      private.entries_error(p_options -> 'items', 2, 15, 'items'));
    when 'choice_matrix' then
      if v_keys <> array['columns', 'rows'] then
        return 'options_json must contain exactly "rows" and "columns"';
      end if;
      return coalesce(private.entries_error(p_options -> 'rows', 1, 15, 'rows'),
                      private.entries_error(p_options -> 'columns', 2, 6, 'columns'));
    when 'true_false' then
      if p_options <> '{}'::jsonb then
        return 'true_false takes no options';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_options) k where k <> 'unit') then
        return 'numeric options may only contain "unit"';
      end if;
      if p_options ? 'unit' and (jsonb_typeof(p_options -> 'unit') is distinct from 'string'
                                 or char_length(p_options ->> 'unit') > 32) then
        return 'unit must be a short string';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Answer keys
-- ---------------------------------------------------------------------
create or replace function private.answer_key_error(p_type text, p_options jsonb, p_answer jsonb, p_scoring jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
  v_correct text[];
begin
  if jsonb_typeof(p_answer) is distinct from 'object' or jsonb_typeof(p_scoring) is distinct from 'object' then
    return 'answer_json and scoring_json must be objects';
  end if;

  case p_type
    when 'mcq_single', 'mcq_multiple' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'correct')
         or jsonb_typeof(p_answer -> 'correct') is distinct from 'array' then
        return 'answer_json must be {"correct": [choice ids]}';
      end if;
      if exists (select 1 from jsonb_array_elements(p_answer -> 'correct') e where jsonb_typeof(e) <> 'string') then
        return 'answer_json must be {"correct": [choice ids]}';
      end if;
      v_ids := private.ids_of(p_options -> 'options');
      select array_agg(e) into v_correct from jsonb_array_elements_text(p_answer -> 'correct') e;
      if v_correct is null or cardinality(v_correct) <> (select count(distinct x) from unnest(v_correct) x) then
        return 'correct choices must be a non-empty list without duplicates';
      end if;
      if not (v_correct <@ v_ids) then
        return 'correct choice id does not exist in the item';
      end if;
      if p_type = 'mcq_single' then
        if cardinality(v_correct) <> 1 then
          return 'mcq_single needs exactly one correct choice';
        end if;
        if p_scoring <> '{}'::jsonb then
          return 'mcq_single takes no scoring options';
        end if;
      elsif exists (select 1 from jsonb_object_keys(p_scoring) k where k <> 'mode')
            or coalesce(p_scoring ->> 'mode', 'all_or_nothing') not in ('all_or_nothing', 'partial') then
        return 'scoring_json must be {"mode": "all_or_nothing" | "partial"}';
      end if;
    when 'ordering' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'order')
         or jsonb_typeof(p_answer -> 'order') is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(p_answer -> 'order') e where jsonb_typeof(e) <> 'string') then
        return 'answer_json must be {"order": [every option id once]}';
      end if;
      v_ids := private.ids_of(p_options -> 'options');
      select array_agg(e) into v_correct from jsonb_array_elements_text(p_answer -> 'order') e;
      if v_correct is null or cardinality(v_correct) <> cardinality(v_ids)
         or not (v_correct <@ v_ids and v_ids <@ v_correct) then
        return 'answer_json must be {"order": [every option id once]}';
      end if;
      return private.scoring_mode_error(p_scoring);
    when 'matching', 'classification', 'choice_matrix' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'slots') then
        return 'answer_json must be {"slots": {slot id: choice id}}';
      end if;
      return coalesce(private.slot_map_error(p_type, p_options, p_answer -> 'slots', true, p_type = 'matching'),
                      private.scoring_mode_error(p_scoring));
    when 'true_false' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'correct')
         or jsonb_typeof(p_answer -> 'correct') is distinct from 'boolean' then
        return 'answer_json must be {"correct": true|false}';
      end if;
      if p_scoring <> '{}'::jsonb then
        return 'true_false takes no scoring options';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k not in ('value', 'tolerance'))
         or jsonb_typeof(p_answer -> 'value') is distinct from 'number'
         or (p_answer ? 'tolerance' and jsonb_typeof(p_answer -> 'tolerance') is distinct from 'number') then
        return 'answer_json must be {"value": number, "tolerance": number >= 0}';
      end if;
      if coalesce((p_answer ->> 'tolerance')::numeric, 0) < 0 then
        return 'answer_json must be {"value": number, "tolerance": number >= 0}';
      end if;
      if p_scoring <> '{}'::jsonb then
        return 'numeric takes no scoring options';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Responses
-- ---------------------------------------------------------------------
create or replace function private.response_error(p_type text, p_options jsonb, p_response jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
  v_sel text[];
begin
  if jsonb_typeof(p_response) is distinct from 'object' then
    return 'response must be an object';
  end if;
  v_ids := private.ids_of(p_options -> 'options');

  case p_type
    when 'mcq_single' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'choice')
         or jsonb_typeof(p_response -> 'choice') is distinct from 'string'
         or not ((p_response ->> 'choice') = any (v_ids)) then
        return 'expected {"choice": <choice id>}';
      end if;
    when 'mcq_multiple' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'choices')
         or jsonb_typeof(p_response -> 'choices') is distinct from 'array' then
        return 'expected {"choices": [choice ids]}';
      end if;
      if exists (select 1 from jsonb_array_elements(p_response -> 'choices') e where jsonb_typeof(e) <> 'string') then
        return 'expected {"choices": [choice ids]}';
      end if;
      select array_agg(e) into v_sel from jsonb_array_elements_text(p_response -> 'choices') e;
      if v_sel is null
         or cardinality(v_sel) <> (select count(distinct x) from unnest(v_sel) x)
         or not (v_sel <@ v_ids) then
        return 'choices must be existing ids without duplicates';
      end if;
    when 'ordering' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'order')
         or jsonb_typeof(p_response -> 'order') is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(p_response -> 'order') e where jsonb_typeof(e) <> 'string') then
        return 'expected {"order": [every option id once]}';
      end if;
      select array_agg(e) into v_sel from jsonb_array_elements_text(p_response -> 'order') e;
      if v_sel is null or cardinality(v_sel) <> cardinality(v_ids) or not (v_sel <@ v_ids and v_ids <@ v_sel) then
        return 'expected {"order": [every option id once]}';
      end if;
    when 'matching', 'classification', 'choice_matrix' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'slots') or not p_response ? 'slots' then
        return 'expected {"slots": {slot id: choice id}}';
      end if;
      return private.slot_map_error(p_type, p_options, p_response -> 'slots', false, false);
    when 'true_false' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'value')
         or jsonb_typeof(p_response -> 'value') is distinct from 'boolean' then
        return 'expected {"value": true|false}';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'value')
         or jsonb_typeof(p_response -> 'value') is distinct from 'number' then
        return 'expected {"value": number}';
      end if;
      if abs((p_response ->> 'value')::numeric) > 1e12 then
        return 'value out of range';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Scoring: fraction of max_score (0..1). Inputs are pre-validated.
-- ---------------------------------------------------------------------
create or replace function private.score_response(
  p_type text, p_answer jsonb, p_scoring jsonb, p_response jsonb
) returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text[];
  v_sel text[];
  v_hit integer;
  v_n integer;
begin
  case p_type
    when 'mcq_single' then
      return case when (p_response ->> 'choice') = (p_answer -> 'correct' ->> 0) then 1 else 0 end;
    when 'mcq_multiple' then
      select array_agg(e) into v_key from jsonb_array_elements_text(p_answer -> 'correct') e;
      select array_agg(e) into v_sel from jsonb_array_elements_text(p_response -> 'choices') e;
      if coalesce(p_scoring ->> 'mode', 'all_or_nothing') = 'partial' then
        v_hit := (select count(*) from unnest(v_sel) s where s = any (v_key));
        return greatest(0, v_hit - (cardinality(v_sel) - v_hit))::numeric / cardinality(v_key);
      end if;
      return case when v_sel <@ v_key and v_key <@ v_sel then 1 else 0 end;
    when 'ordering' then
      select count(*), count(*) filter (where k.v = r.v) into v_n, v_hit
        from jsonb_array_elements_text(p_answer -> 'order') with ordinality k(v, i)
        join jsonb_array_elements_text(p_response -> 'order') with ordinality r(v, i) on r.i = k.i;
    when 'matching', 'classification', 'choice_matrix' then
      select count(*), count(*) filter (where (p_response -> 'slots' ->> kv.key) = kv.value) into v_n, v_hit
        from jsonb_each_text(p_answer -> 'slots') kv;
    when 'true_false' then
      return case when (p_response -> 'value') = (p_answer -> 'correct') then 1 else 0 end;
    when 'numeric' then
      return case
        when abs((p_response ->> 'value')::numeric - (p_answer ->> 'value')::numeric)
             <= coalesce((p_answer ->> 'tolerance')::numeric, 0) then 1
        else 0 end;
    else
      raise exception 'no scorer for item type %', p_type;
  end case;
  -- ordering and slot types (partial is their default)
  if v_n = 0 then
    return 0;
  end if;
  if coalesce(p_scoring ->> 'mode', 'partial') = 'all_or_nothing' then
    return case when v_hit = v_n then 1 else 0 end;
  end if;
  return v_hit::numeric / v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Image paths: every list of an item, not only "options"
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
    select p from private.options_media_paths(new.options_json) p
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

create or replace function authz.assessment_media_in_use(p_name text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.instrument_items i
     where i.instrument_version_id in (
             select v.id from public.instrument_versions v where v.instrument_id = authz.object_owner_id(p_name))
       and (i.media_path = p_name
            or exists (select 1 from private.options_media_paths(i.options_json) p where p = p_name))
  );
$$;

-- ---------------------------------------------------------------------
-- What each person sees: item order and list orders, built once per attempt.
-- ---------------------------------------------------------------------
create or replace function private.build_presentation(p_version uuid, p_shuffle_items boolean, p_shuffle_choices boolean)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_items jsonb;
  v_lists jsonb := '{}'::jsonb;
  v_item record;
  v_name text;
  v_order jsonb;
  v_key jsonb;
  v_try integer;
  v_item_lists jsonb;
begin
  select coalesce(jsonb_agg(i.id order by case when p_shuffle_items then random() else i.display_order::double precision end), '[]'::jsonb)
    into v_items
    from public.instrument_items i where i.instrument_version_id = p_version;

  for v_item in
    select i.id, i.item_type, i.options_json, k.answer_json
      from public.instrument_items i
      left join private.instrument_answer_keys k on k.item_id = i.id
     where i.instrument_version_id = p_version
  loop
    v_item_lists := '{}'::jsonb;
    foreach v_name in array (
      case v_item.item_type
        when 'ordering' then array['options']
        when 'matching' then case when p_shuffle_choices then array['right', 'left'] else array['right'] end
        when 'classification' then case when p_shuffle_choices then array['items'] else '{}'::text[] end
        when 'choice_matrix' then case when p_shuffle_choices then array['rows'] else '{}'::text[] end
        when 'mcq_single' then case when p_shuffle_choices then array['options'] else '{}'::text[] end
        when 'mcq_multiple' then case when p_shuffle_choices then array['options'] else '{}'::text[] end
        else '{}'::text[]
      end)
    loop
      v_key := case when v_item.item_type = 'ordering' then v_item.answer_json -> 'order' end;
      v_try := 0;
      loop
        select jsonb_agg(e ->> 'id' order by random()) into v_order
          from jsonb_array_elements(v_item.options_json -> v_name) e;
        v_try := v_try + 1;
        -- an ordering list never starts out already in the correct order
        exit when v_key is null or v_order <> v_key or v_try >= 20;
      end loop;
      v_item_lists := v_item_lists || jsonb_build_object(v_name, v_order);
    end loop;
    if v_item_lists <> '{}'::jsonb then
      v_lists := v_lists || jsonb_build_object(v_item.id::text, v_item_lists);
    end if;
  end loop;

  return jsonb_build_object('items', v_items, 'lists', v_lists);
end;
$$;

-- ---------------------------------------------------------------------
-- start_attempt: + presentation (built for new attempts, kept on resume)
-- ---------------------------------------------------------------------
drop function public.start_attempt(uuid);
create function public.start_attempt(p_assignment uuid)
returns table (attempt_id uuid, attempt_no integer, started_at timestamptz, resumed boolean,
               deadline_at timestamptz, server_now timestamptz, draft jsonb, timed_out boolean,
               draft_seq bigint, presentation jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.assessment_assignments%rowtype;
  v_t public.assessment_attempts%rowtype;
  v_used integer;
  v_extra integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_assignment::text || '/' || v_uid::text, 0));

  select * into v_a from public.assessment_assignments a where a.id = p_assignment;
  if not found or v_a.status <> 'published'
     or not authz.is_cohort_member(v_a.cohort_id, array['trainee']) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  select * into v_t from public.assessment_attempts t
   where t.assignment_id = p_assignment and t.user_id = v_uid and t.status = 'in_progress'
   for update;
  if found then
    if now() > private.cutoff_of(v_t) then
      v_t := private.finalize_attempt(v_t.id, coalesce(v_t.draft_json, '{}'::jsonb), true);
      return query select v_t.id, v_t.attempt_no, v_t.started_at, false,
                          private.deadline_of(v_t), now(), null::jsonb, true, v_t.draft_seq, v_t.presentation_json;
      return;
    end if;
    update public.assessment_attempts t
       set draft_seq = t.draft_seq + private.draft_seq_block()
     where t.id = v_t.id
    returning t.* into v_t;
    return query select v_t.id, v_t.attempt_no, v_t.started_at, true,
                        private.deadline_of(v_t), now(), v_t.draft_json, false, v_t.draft_seq, v_t.presentation_json;
    return;
  end if;

  if (v_a.open_at is not null and now() < v_a.open_at)
     or (v_a.close_at is not null and now() >= v_a.close_at) then
    raise exception 'assessment is not open' using errcode = 'SE001';
  end if;

  select count(*) into v_used from public.assessment_attempts t
   where t.assignment_id = p_assignment and t.user_id = v_uid;
  select count(*) into v_extra from public.assessment_extra_attempts x
   where x.assignment_id = p_assignment and x.user_id = v_uid;
  if v_used >= v_a.attempt_limit + v_extra then
    raise exception 'attempt limit reached' using errcode = 'SE002';
  end if;

  insert into public.assessment_attempts as t (assignment_id, user_id, attempt_no, started_at, draft_seq, presentation_json)
  values (p_assignment, v_uid, v_used + 1, now(), private.draft_seq_block(),
          private.build_presentation(v_a.instrument_version_id, v_a.shuffle_items, v_a.shuffle_choices))
  returning t.* into v_t;
  return query select v_t.id, v_t.attempt_no, v_t.started_at, false,
                      private.deadline_of(v_t), now(), null::jsonb, false, v_t.draft_seq, v_t.presentation_json;
end;
$$;

revoke all on function private.ids_of(jsonb) from public;
revoke all on function private.entries_error(jsonb, integer, integer, text) from public;
revoke all on function private.options_media_paths(jsonb) from public;
revoke all on function private.slot_choices(text, jsonb) from public;
revoke all on function private.slot_map_error(text, jsonb, jsonb, boolean, boolean) from public;
revoke all on function private.scoring_mode_error(jsonb) from public;
revoke all on function private.build_presentation(uuid, boolean, boolean) from public;
revoke execute on function public.start_attempt(uuid) from public, anon;
grant execute on function public.start_attempt(uuid) to authenticated;

comment on function public.start_attempt(uuid) is 'เริ่ม/ทำต่อ — คืนเส้นตาย เวลา server คำตอบที่บันทึกไว้ เลขฐานลำดับการบันทึก และลำดับข้อ/ตัวเลือกที่ผู้ทำเห็น; ครั้งที่เลยเวลาแล้วจะถูกส่งอัตโนมัติ (timed_out)';

-- =====================================================================
-- Phase 3 / step 1 — rubrics (owner decisions)
--
-- A rubric is an instrument of type 'rubric', versioned like a quiz: drafts
-- are edited, a published version never changes, so a score given with it
-- keeps its meaning. Each criterion is an item of type 'rubric_criterion':
--
--   prompt        the criterion, e.g. "การกำหนดเป้าหมายการเรียนรู้"
--   options_json  {description?, levels:[{id, label, score, description?}] 2-6}
--   max_score     set by the server = the highest level score
--
-- One criterion = a holistic rubric. A rubric has no answer key and is
-- never taken as a test: it cannot be assigned through
-- assessment_assignments. Rubric instruments hold only criteria; quizzes
-- hold no criteria. Tasks and reviews that use a rubric come in steps 2–3.
-- =====================================================================

alter table public.instruments drop constraint instruments_instrument_type_check;
alter table public.instruments add constraint instruments_instrument_type_check
  check (instrument_type in ('quiz', 'rubric'));
comment on column public.instruments.instrument_type is 'quiz | rubric (Phase 3) — ตั้งได้ตอนสร้างเท่านั้น (ไม่มี grant update)';

alter table public.instrument_items drop constraint instrument_items_item_type_check;
alter table public.instrument_items add constraint instrument_items_item_type_check
  check (item_type in ('mcq_single', 'mcq_multiple', 'true_false', 'numeric',
                       'ordering', 'matching', 'classification', 'choice_matrix',
                       'dropdown', 'cloze', 'image_labelling',
                       'rubric_criterion'));
comment on column public.instrument_items.item_type is 'mcq_single|mcq_multiple|true_false|numeric (2B) · ordering|matching|classification|choice_matrix|dropdown|cloze|image_labelling (2C) · rubric_criterion (3)';

-- ---------------------------------------------------------------------
-- Shape of a criterion
-- ---------------------------------------------------------------------
create function private.rubric_criterion_error(p_options jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_levels jsonb := p_options -> 'levels';
  v_n integer;
begin
  if jsonb_typeof(p_options) is distinct from 'object' then
    return 'options_json must be an object';
  end if;
  if exists (select 1 from jsonb_object_keys(p_options) k where k not in ('levels', 'description')) then
    return 'a criterion takes only levels and description';
  end if;
  if p_options ? 'description' and (jsonb_typeof(p_options -> 'description') <> 'string'
                                    or char_length(p_options ->> 'description') > 2000) then
    return 'criterion description: text of at most 2000 characters';
  end if;
  if jsonb_typeof(v_levels) is distinct from 'array' then
    return 'levels must be an array';
  end if;
  v_n := jsonb_array_length(v_levels);
  if v_n < 2 or v_n > 6 then
    return 'a criterion needs 2-6 levels';
  end if;
  if exists (
       select 1 from jsonb_array_elements(v_levels) l
        where jsonb_typeof(l) <> 'object'
           or exists (select 1 from jsonb_object_keys(l) k where k not in ('id', 'label', 'score', 'description'))
           or coalesce(l ->> 'id', '') !~ '^[a-z0-9]{1,8}$'
           or jsonb_typeof(l -> 'label') is distinct from 'string'
           or char_length(btrim(l ->> 'label')) not between 1 and 100
           or jsonb_typeof(l -> 'score') is distinct from 'number'
           or (l ->> 'score')::numeric < 0 or (l ->> 'score')::numeric > 1000
           or (l ? 'description' and (jsonb_typeof(l -> 'description') <> 'string'
                                      or char_length(l ->> 'description') > 1000))) then
    return 'each level is {id: [a-z0-9]{1,8}, label: 1-100 chars, score: 0-1000, description?: up to 1000 chars}';
  end if;
  if (select count(distinct l ->> 'id') from jsonb_array_elements(v_levels) l) <> v_n then
    return 'level ids must be unique';
  end if;
  if (select count(distinct (l ->> 'score')::numeric) from jsonb_array_elements(v_levels) l) <> v_n then
    return 'each level needs a different score';
  end if;
  if (select max((l ->> 'score')::numeric) from jsonb_array_elements(v_levels) l) <= 0 then
    return 'the highest level must score more than 0';
  end if;
  return null;
end;
$$;

alter function private.item_shape_error(text, jsonb) rename to item_shape_base_error;

create function private.item_shape_error(p_type text, p_options jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_type = 'rubric_criterion' then private.rubric_criterion_error(p_options)
              else private.item_shape_base_error(p_type, p_options) end
$$;

revoke all on function private.rubric_criterion_error(jsonb) from public;
revoke all on function private.item_shape_error(text, jsonb) from public;
revoke all on function private.item_shape_base_error(text, jsonb) from public;

-- ---------------------------------------------------------------------
-- Items match their instrument; a criterion's max score comes from its levels
-- (runs after instrument_items_guard, which has checked the shape)
-- ---------------------------------------------------------------------
create function private.instrument_items_kind()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  select ins.instrument_type into v_type
    from public.instrument_versions v
    join public.instruments ins on ins.id = v.instrument_id
   where v.id = new.instrument_version_id;
  if (v_type = 'rubric') <> (new.item_type = 'rubric_criterion') then
    raise exception 'a rubric holds only criteria, and a quiz holds no criteria' using errcode = 'check_violation';
  end if;
  if new.item_type = 'rubric_criterion' then
    if new.media_path is not null or new.scoring_mode is not null then
      raise exception 'a criterion has no picture and no scoring mode' using errcode = 'check_violation';
    end if;
    new.max_score := (select max((l ->> 'score')::numeric) from jsonb_array_elements(new.options_json -> 'levels') l);
  end if;
  return new;
end;
$$;
revoke all on function private.instrument_items_kind() from public;

create trigger instrument_items_kind
  before insert or update of instrument_version_id, item_type, options_json, max_score, media_path, scoring_mode
  on public.instrument_items
  for each row execute function private.instrument_items_kind();

-- ---------------------------------------------------------------------
-- A rubric is never assigned as a test
-- ---------------------------------------------------------------------
create function private.assessment_assignments_quiz_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1
               from public.instrument_versions v
               join public.instruments ins on ins.id = v.instrument_id
              where v.id = new.instrument_version_id and ins.instrument_type <> 'quiz') then
    raise exception 'only a quiz can be assigned as a test (a rubric is used by tasks)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.assessment_assignments_quiz_only() from public;

create trigger assessment_assignments_quiz_only
  before insert or update of instrument_version_id on public.assessment_assignments
  for each row execute function private.assessment_assignments_quiz_only();

-- ---------------------------------------------------------------------
-- Publishing: a rubric has no answer keys to check
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
  v_type text;
  v_bad integer;
  v_hash text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if not authz.can_manage_version(p_version) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  select v.status, ins.instrument_type into v_status, v_type
    from public.instrument_versions v
    join public.instruments ins on ins.id = v.instrument_id
   where v.id = p_version
     for update of v;
  if v_status is distinct from 'draft' then
    raise exception 'only a draft version can be published' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.instrument_items i where i.instrument_version_id = p_version) then
    raise exception 'a version needs at least one item' using errcode = 'check_violation';
  end if;

  -- Quiz keys are re-validated: choices may have changed after the key was set.
  if v_type = 'quiz' then
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
  end if;

  v_hash := private.version_content_hash(p_version);
  update public.instrument_versions
     set status = 'published', published_at = now(), published_by = v_uid, content_hash = v_hash
   where id = p_version;
  return v_hash;
end;
$$;
revoke execute on function public.publish_instrument_version(uuid) from public, anon;
grant execute on function public.publish_instrument_version(uuid) to authenticated;

comment on function private.rubric_criterion_error(jsonb) is 'ตรวจโครงเกณฑ์ของ Rubric: 2–6 ระดับ, id ไม่ซ้ำ, คะแนนไม่ซ้ำ 0–1000 (สูงสุด > 0), ป้าย 1–100 ตัวอักษร';
comment on function private.instrument_items_kind() is 'Rubric มีแต่เกณฑ์ / แบบทดสอบไม่มีเกณฑ์ · คะแนนเต็มของเกณฑ์ = คะแนนระดับสูงสุด (คิดที่ server)';

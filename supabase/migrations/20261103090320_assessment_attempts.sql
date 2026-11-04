-- =====================================================================
-- SolveEdu Platform — Migration 14: taking a test (server-side scoring)
--
-- start_attempt(assignment)            → attempt (resumes an open one)
-- submit_attempt(attempt, responses)   → total score only (release policy)
--
-- Both serialise on a transaction-scoped advisory lock per
-- (assignment, person), so concurrent requests cannot exceed the attempt
-- limit or submit twice; the partial unique index "one open attempt" and
-- UNIQUE(assignment_id, user_id, attempt_no) back this up.
-- started_at / submitted_at / score / passed are produced here, never sent
-- by the browser. A started attempt counts toward the limit (no free peeks).
--
-- Errors: 42501 not allowed (also for unknown ids: existence not revealed)
--         SE001 outside the open window   SE002 attempt limit reached
--         SE003 attempt already submitted 22023 malformed responses
-- =====================================================================

alter table public.assessment_attempts
  add column correct_count integer check (correct_count is null or correct_count >= 0),
  add column item_count    integer check (item_count is null or item_count >= 0);

comment on column public.assessment_attempts.correct_count is 'จำนวนข้อที่ได้คะแนนเต็ม — แสดงผู้เรียนได้ (ไม่บอกว่าข้อไหน)';

-- ---------------------------------------------------------------------
-- Response shape per item_type. Error message or null.
--   mcq_single {"choice": "b"}   mcq_multiple {"choices": ["a","d"]}
--   true_false {"value": true}   numeric      {"value": 75}
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
  select array_agg(o ->> 'id') into v_ids from jsonb_array_elements(coalesce(p_options -> 'options', '[]'::jsonb)) o;

  case p_type
    when 'mcq_single' then
      if exists (select 1 from jsonb_object_keys(p_response) k where k <> 'choice')
         or jsonb_typeof(p_response -> 'choice') is distinct from 'string'
         or not ((p_response ->> 'choice') = any (coalesce(v_ids, '{}'))) then
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
         or not (v_sel <@ coalesce(v_ids, '{}')) then
        return 'choices must be existing ids without duplicates';
      end if;
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

-- Fraction of the item's max_score earned (0..1). Inputs are pre-validated.
--   mcq_multiple partial: max(0, right picks - wrong picks) / |correct|
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
end;
$$;

revoke all on function private.response_error(text, jsonb, jsonb) from public;
revoke all on function private.score_response(text, jsonb, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------
-- start_attempt(assignment)
-- ---------------------------------------------------------------------
create or replace function public.start_attempt(p_assignment uuid)
returns table (attempt_id uuid, attempt_no integer, started_at timestamptz, resumed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.assessment_assignments%rowtype;
  v_t public.assessment_attempts%rowtype;
  v_used integer;
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
  if (v_a.open_at is not null and now() < v_a.open_at)
     or (v_a.close_at is not null and now() >= v_a.close_at) then
    raise exception 'assessment is not open' using errcode = 'SE001';
  end if;

  select * into v_t from public.assessment_attempts t
   where t.assignment_id = p_assignment and t.user_id = v_uid and t.status = 'in_progress';
  if found then
    return query select v_t.id, v_t.attempt_no, v_t.started_at, true;
    return;
  end if;

  select count(*) into v_used from public.assessment_attempts t
   where t.assignment_id = p_assignment and t.user_id = v_uid;
  if v_used >= v_a.attempt_limit then
    raise exception 'attempt limit reached' using errcode = 'SE002';
  end if;

  insert into public.assessment_attempts as t (assignment_id, user_id, attempt_no, started_at)
  values (p_assignment, v_uid, v_used + 1, now())
  returning t.* into v_t;
  return query select v_t.id, v_t.attempt_no, v_t.started_at, false;
end;
$$;

-- ---------------------------------------------------------------------
-- submit_attempt(attempt, {"<item_id>": response, ...})
-- Items without a response score 0 and are stored as JSON null.
-- ---------------------------------------------------------------------
create or replace function public.submit_attempt(p_attempt uuid, p_responses jsonb)
returns table (attempt_id uuid, score numeric, max_score numeric, percent numeric,
               passed boolean, correct_count integer, item_count integer, submitted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_assignment uuid;
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
  v_passed boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_responses) is distinct from 'object' then
    raise exception 'responses must be an object keyed by item id' using errcode = 'invalid_parameter_value';
  end if;

  select t.assignment_id into v_assignment
    from public.assessment_attempts t where t.id = p_attempt and t.user_id = v_uid;
  if v_assignment is null then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_assignment::text || '/' || v_uid::text, 0));

  select * into v_t from public.assessment_attempts t where t.id = p_attempt for update;
  if v_t.status <> 'in_progress' then
    raise exception 'attempt already submitted' using errcode = 'SE003';
  end if;

  select * into v_a from public.assessment_assignments a where a.id = v_t.assignment_id;
  if v_a.status <> 'published' or not authz.is_cohort_member(v_a.cohort_id, array['trainee']) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_a.close_at is not null and now() >= v_a.close_at then
    raise exception 'assessment is closed' using errcode = 'SE001';
  end if;

  if exists (
    select 1 from jsonb_object_keys(p_responses) k
     where not exists (select 1 from public.instrument_items i
                        where i.instrument_version_id = v_a.instrument_version_id and i.id::text = k)
  ) then
    raise exception 'response for an item that is not in this test' using errcode = 'invalid_parameter_value';
  end if;

  for v_item in
    select i.id, i.item_type, i.options_json, i.max_score, k.item_id as key_item, k.answer_json, k.scoring_json
      from public.instrument_items i
      left join private.instrument_answer_keys k on k.item_id = i.id
     where i.instrument_version_id = v_a.instrument_version_id
     order by i.display_order
  loop
    if v_item.key_item is null then
      raise exception 'published item % has no answer key', v_item.id;  -- cannot happen after publish
    end if;
    v_resp := coalesce(p_responses -> v_item.id::text, 'null'::jsonb);
    if v_resp = 'null'::jsonb then
      v_frac := 0;
    else
      v_error := private.response_error(v_item.item_type, v_item.options_json, v_resp);
      if v_error is not null then
        raise exception 'invalid response: %', v_error using errcode = 'invalid_parameter_value';
      end if;
      v_frac := private.score_response(v_item.item_type, v_item.answer_json, v_item.scoring_json, v_resp);
    end if;

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

  v_passed := case when v_a.passing_percent is null then null
                   else v_score * 100 >= v_a.passing_percent * v_max end;

  update public.assessment_attempts t
     set status = 'submitted', submitted_at = now(), score = v_score, max_score = v_max,
         passed = v_passed, correct_count = v_correct, item_count = v_count
   where t.id = p_attempt
  returning t.* into v_t;

  return query select v_t.id, v_t.score, v_t.max_score,
                      case when v_t.max_score > 0 then round(v_t.score * 100 / v_t.max_score, 2) end,
                      v_t.passed, v_t.correct_count, v_t.item_count, v_t.submitted_at;
end;
$$;

revoke execute on function public.start_attempt(uuid) from public, anon;
revoke execute on function public.submit_attempt(uuid, jsonb) from public, anon;
grant execute on function public.start_attempt(uuid) to authenticated;
grant execute on function public.submit_attempt(uuid, jsonb) to authenticated;

comment on function public.start_attempt(uuid) is 'เริ่ม (หรือทำต่อ) การทำแบบทดสอบ — ตรวจสิทธิ์ ช่วงเวลา และจำนวนครั้งภายใต้ lock; เวลาเริ่มประทับโดย server';
comment on function public.submit_attempt(uuid, jsonb) is 'ส่งคำตอบ ตรวจด้วยเฉลยใน private และบันทึกใน transaction เดียว; คืนเฉพาะคะแนนรวม ผ่าน/ไม่ผ่าน และจำนวนข้อที่ถูก';

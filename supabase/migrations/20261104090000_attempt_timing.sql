-- =====================================================================
-- Phase 2B.1 / step 2 — time limits, grace, server-saved answers,
-- auto-finalise, extra attempts
--
-- Deadline of an attempt = the earlier of (started_at + time_limit) and
-- close_at, from the assignment's CURRENT settings (extending close_at helps
-- everyone). Answers are accepted until deadline + grace_minutes (default 5).
-- After that the attempt is finalised from the answers last saved on the
-- server (save_attempt_draft) — never from a late payload — by whichever
-- comes first: the trainee's own submit/save/start, or the pg_cron job.
--
-- Errors: as migration 14, plus SE001 when saving outside the window.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
alter table public.assessment_assignments
  add column time_limit_minutes integer
    check (time_limit_minutes is null or time_limit_minutes between 1 and 600),
  add column grace_minutes integer not null default 5 check (grace_minutes between 0 and 60);

grant insert (time_limit_minutes, grace_minutes), update (time_limit_minutes, grace_minutes)
  on public.assessment_assignments to authenticated;

comment on column public.assessment_assignments.time_limit_minutes is 'เวลาทำต่อครั้ง (นาที); null = ใช้เฉพาะช่วงเปิด–ปิด — ตรึงเมื่อมีผู้เริ่มทำ';
comment on column public.assessment_assignments.grace_minutes is 'ช่วงผ่อนผันหลังเส้นตาย (นาที) ที่ยังรับคำตอบ — กันเน็ตช้าตอนส่ง';

alter table public.assessment_attempts
  add column draft_json     jsonb,
  add column draft_saved_at timestamptz,
  add column auto_submitted boolean not null default false,
  add constraint assessment_attempts_draft_shape
    check (draft_json is null or (jsonb_typeof(draft_json) = 'object' and octet_length(draft_json::text) <= 65536));

comment on column public.assessment_attempts.draft_json is 'คำตอบที่บันทึกระหว่างทำ (save_attempt_draft) — ใช้ให้คะแนนเมื่อหมดเวลา; ล้างเมื่อส่งแล้ว';
comment on column public.assessment_attempts.auto_submitted is 'true = ระบบส่งให้เมื่อหมดเวลา (คะแนนจากคำตอบที่บันทึกไว้)';

-- ---------------------------------------------------------------------
-- Extra attempts granted to one person (e.g. lost connection). Append-only.
-- ---------------------------------------------------------------------
create table public.assessment_extra_attempts (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assessment_assignments (id) on delete restrict,
  user_id       uuid not null references public.profiles (id) on delete restrict,
  reason        text check (reason is null or char_length(reason) <= 500),
  granted_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index assessment_extra_attempts_idx on public.assessment_extra_attempts (assignment_id, user_id);

comment on table public.assessment_extra_attempts is 'สิทธิ์ทำเพิ่มรายบุคคล (+1 ครั้งต่อแถว) — แก้/ลบไม่ได้; ผู้มอบและเวลาบันทึกโดย server';

create or replace function private.assessment_extra_attempts_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.assessment_assignments a
      join public.cohort_memberships cm on cm.cohort_id = a.cohort_id
     where a.id = new.assignment_id
       and cm.user_id = new.user_id and cm.cohort_role = 'trainee' and cm.status = 'active'
  ) then
    raise exception 'extra attempts go to an active trainee of the cohort' using errcode = 'check_violation';
  end if;
  new.granted_by := coalesce(auth.uid(), new.granted_by);
  new.created_at := now();
  return new;
end;
$$;

create trigger assessment_extra_attempts_validate
  before insert on public.assessment_extra_attempts
  for each row execute function private.assessment_extra_attempts_validate();
create trigger assessment_extra_attempts_audit
  after insert on public.assessment_extra_attempts
  for each row execute function private.audit_row();

create or replace function authz.can_assess_assignment(p_assignment uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assessment_assignments a
     where a.id = p_assignment and authz.is_cohort_assessor(a.cohort_id)
  );
$$;
revoke execute on function authz.can_assess_assignment(uuid) from public, anon;
grant execute on function authz.can_assess_assignment(uuid) to authenticated, service_role;

alter table public.assessment_extra_attempts enable row level security;
grant select on public.assessment_extra_attempts to authenticated;
grant insert (assignment_id, user_id, reason) on public.assessment_extra_attempts to authenticated;

create policy assessment_extra_attempts_select on public.assessment_extra_attempts
  for select to authenticated
  using (authz.can_view_attempt(assignment_id, user_id));
create policy assessment_extra_attempts_insert on public.assessment_extra_attempts
  for insert to authenticated
  with check (authz.can_assess_assignment(assignment_id));

-- ---------------------------------------------------------------------
-- The time limit joins the settings frozen once an attempt exists (SE004):
-- everyone in the cohort sits the test under the same limit.
-- ---------------------------------------------------------------------
create or replace function private.assessment_assignments_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.assessment_attempts t where t.assignment_id = old.id) then
    return new;
  end if;
  if new.passing_percent is distinct from old.passing_percent
     or new.purpose is distinct from old.purpose
     or new.course_id is distinct from old.course_id
     or new.time_limit_minutes is distinct from old.time_limit_minutes then
    raise exception 'passing_percent, purpose, course and time limit are fixed once an attempt exists'
      using errcode = 'SE004';
  end if;
  if new.status = 'draft' and old.status <> 'draft' then
    raise exception 'an assignment with attempts cannot return to draft' using errcode = 'SE004';
  end if;
  return new;
end;
$$;

drop trigger assessment_assignments_lock on public.assessment_assignments;
create trigger assessment_assignments_lock
  before update of passing_percent, purpose, course_id, status, time_limit_minutes
  on public.assessment_assignments
  for each row execute function private.assessment_assignments_lock();

-- ---------------------------------------------------------------------
-- Timing helpers (pure)
-- ---------------------------------------------------------------------
create or replace function private.attempt_deadline(p_started timestamptz, p_limit integer, p_close timestamptz)
returns timestamptz
language sql immutable
set search_path = ''
as $$
  select least(p_started + make_interval(mins => p_limit), p_close);  -- least() ignores nulls
$$;

create or replace function private.attempt_cutoff(
  p_started timestamptz, p_limit integer, p_close timestamptz, p_grace integer
) returns timestamptz
language sql immutable
set search_path = ''
as $$
  select private.attempt_deadline(p_started, p_limit, p_close) + make_interval(mins => p_grace);
$$;

-- Whole-response check against a version: error message or null.
create or replace function private.responses_error(p_version uuid, p_responses jsonb)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_item record;
  v_resp jsonb;
  v_error text;
begin
  if jsonb_typeof(p_responses) is distinct from 'object' then
    return 'responses must be an object keyed by item id';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_responses) k
     where not exists (select 1 from public.instrument_items i
                        where i.instrument_version_id = p_version and i.id::text = k)
  ) then
    return 'response for an item that is not in this test';
  end if;
  for v_item in
    select i.id, i.item_type, i.options_json from public.instrument_items i where i.instrument_version_id = p_version
  loop
    v_resp := p_responses -> v_item.id::text;
    if v_resp is not null and v_resp <> 'null'::jsonb then
      v_error := private.response_error(v_item.item_type, v_item.options_json, v_resp);
      if v_error is not null then
        return v_error;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Score and close one attempt. The caller holds the (assignment, person)
-- advisory lock. p_auto = finalised by the deadline from saved answers.
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
    select i.id, i.item_type, i.max_score, k.item_id as key_item, k.answer_json, k.scoring_json
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
                   else private.score_response(v_item.item_type, v_item.answer_json, v_item.scoring_json, v_resp) end;
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

-- Own attempt + lock + eligibility. Returns the locked attempt; 42501 otherwise.
create or replace function private.lock_own_attempt(p_attempt uuid)
returns public.assessment_attempts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_t public.assessment_attempts%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_t from public.assessment_attempts t where t.id = p_attempt and t.user_id = v_uid;
  if not found then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_t.assignment_id::text || '/' || v_uid::text, 0));
  if not exists (
    select 1 from public.assessment_assignments a
     where a.id = v_t.assignment_id and a.status = 'published'
       and authz.is_cohort_member(a.cohort_id, array['trainee'])
  ) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select * into v_t from public.assessment_attempts t where t.id = p_attempt for update;
  return v_t;
end;
$$;

create or replace function private.cutoff_of(p_t public.assessment_attempts)
returns timestamptz
language sql stable
set search_path = ''
as $$
  select private.attempt_cutoff(p_t.started_at, a.time_limit_minutes, a.close_at, a.grace_minutes)
    from public.assessment_assignments a where a.id = p_t.assignment_id;
$$;

create or replace function private.deadline_of(p_t public.assessment_attempts)
returns timestamptz
language sql stable
set search_path = ''
as $$
  select private.attempt_deadline(p_t.started_at, a.time_limit_minutes, a.close_at)
    from public.assessment_assignments a where a.id = p_t.assignment_id;
$$;

-- ---------------------------------------------------------------------
-- start_attempt: also returns the deadline, the server clock and the saved
-- answers; an open attempt past its cutoff is finalised (timed_out) instead
-- of resumed, and no new attempt is started in the same call.
-- ---------------------------------------------------------------------
drop function public.start_attempt(uuid);
create function public.start_attempt(p_assignment uuid)
returns table (attempt_id uuid, attempt_no integer, started_at timestamptz, resumed boolean,
               deadline_at timestamptz, server_now timestamptz, draft jsonb, timed_out boolean)
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
                          private.deadline_of(v_t), now(), null::jsonb, true;
      return;
    end if;
    return query select v_t.id, v_t.attempt_no, v_t.started_at, true,
                        private.deadline_of(v_t), now(), v_t.draft_json, false;
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

  insert into public.assessment_attempts as t (assignment_id, user_id, attempt_no, started_at)
  values (p_assignment, v_uid, v_used + 1, now())
  returning t.* into v_t;
  return query select v_t.id, v_t.attempt_no, v_t.started_at, false,
                      private.deadline_of(v_t), now(), null::jsonb, false;
end;
$$;

-- ---------------------------------------------------------------------
-- save_attempt_draft: store the answers so far (validated). Past the
-- cutoff the attempt is finalised from what was saved before, and
-- finalized = true tells the page to show the result.
-- ---------------------------------------------------------------------
create function public.save_attempt_draft(p_attempt uuid, p_responses jsonb)
returns table (saved_at timestamptz, finalized boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.assessment_attempts%rowtype;
  v_version uuid;
  v_error text;
begin
  v_t := private.lock_own_attempt(p_attempt);
  if v_t.status <> 'in_progress' then
    raise exception 'attempt already submitted' using errcode = 'SE003';
  end if;
  if now() > private.cutoff_of(v_t) then
    perform private.finalize_attempt(v_t.id, coalesce(v_t.draft_json, '{}'::jsonb), true);
    return query select null::timestamptz, true;
    return;
  end if;

  select a.instrument_version_id into v_version from public.assessment_assignments a where a.id = v_t.assignment_id;
  v_error := private.responses_error(v_version, p_responses);
  if v_error is not null then
    raise exception 'invalid response: %', v_error using errcode = 'invalid_parameter_value';
  end if;

  update public.assessment_attempts t
     set draft_json = p_responses, draft_saved_at = now()
   where t.id = p_attempt;
  return query select now(), false;
end;
$$;

-- ---------------------------------------------------------------------
-- submit_attempt: within the cutoff the submitted answers are scored; after
-- it, the late payload is ignored and the saved answers are scored instead.
-- ---------------------------------------------------------------------
drop function public.submit_attempt(uuid, jsonb);
create function public.submit_attempt(p_attempt uuid, p_responses jsonb)
returns table (attempt_id uuid, score numeric, max_score numeric, percent numeric, passed boolean,
               correct_count integer, item_count integer, submitted_at timestamptz, auto_submitted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.assessment_attempts%rowtype;
begin
  if jsonb_typeof(p_responses) is distinct from 'object' then
    raise exception 'responses must be an object keyed by item id' using errcode = 'invalid_parameter_value';
  end if;
  v_t := private.lock_own_attempt(p_attempt);
  if v_t.status <> 'in_progress' then
    raise exception 'attempt already submitted' using errcode = 'SE003';
  end if;

  if now() > private.cutoff_of(v_t) then
    v_t := private.finalize_attempt(v_t.id, coalesce(v_t.draft_json, '{}'::jsonb), true);
  else
    v_t := private.finalize_attempt(v_t.id, p_responses, false);
  end if;

  return query select v_t.id, v_t.score, v_t.max_score,
                      case when v_t.max_score > 0 then round(v_t.score * 100 / v_t.max_score, 2) end,
                      v_t.passed, v_t.correct_count, v_t.item_count, v_t.submitted_at, v_t.auto_submitted;
end;
$$;

-- ---------------------------------------------------------------------
-- Background: finalise every open attempt past its cutoff. Each attempt in
-- its own subtransaction so one bad row cannot block the rest.
-- ---------------------------------------------------------------------
create or replace function private.finalize_expired_attempts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_status text;
  v_draft jsonb;
  v_done integer := 0;
begin
  for v in
    select t.id, t.assignment_id, t.user_id
      from public.assessment_attempts t
      join public.assessment_assignments a on a.id = t.assignment_id
     where t.status = 'in_progress'
       and now() > private.attempt_cutoff(t.started_at, a.time_limit_minutes, a.close_at, a.grace_minutes)
  loop
    begin
      perform pg_advisory_xact_lock(hashtextextended(v.assignment_id::text || '/' || v.user_id::text, 0));
      select t.status, t.draft_json into v_status, v_draft from public.assessment_attempts t where t.id = v.id;
      if v_status = 'in_progress' then
        perform private.finalize_attempt(v.id, coalesce(v_draft, '{}'::jsonb), true);
        v_done := v_done + 1;
      end if;
    exception when others then
      raise warning 'finalize_expired_attempts: attempt % skipped: %', v.id, sqlerrm;
    end;
  end loop;
  return v_done;
end;
$$;

revoke all on function private.assessment_extra_attempts_validate() from public;
revoke all on function private.attempt_deadline(timestamptz, integer, timestamptz) from public;
revoke all on function private.attempt_cutoff(timestamptz, integer, timestamptz, integer) from public;
revoke all on function private.responses_error(uuid, jsonb) from public;
revoke all on function private.finalize_attempt(uuid, jsonb, boolean) from public;
revoke all on function private.lock_own_attempt(uuid) from public;
revoke all on function private.cutoff_of(public.assessment_attempts) from public;
revoke all on function private.deadline_of(public.assessment_attempts) from public;
revoke all on function private.finalize_expired_attempts() from public;

revoke execute on function public.start_attempt(uuid) from public, anon;
revoke execute on function public.save_attempt_draft(uuid, jsonb) from public, anon;
revoke execute on function public.submit_attempt(uuid, jsonb) from public, anon;
grant execute on function public.start_attempt(uuid) to authenticated;
grant execute on function public.save_attempt_draft(uuid, jsonb) to authenticated;
grant execute on function public.submit_attempt(uuid, jsonb) to authenticated;

comment on function public.start_attempt(uuid) is 'เริ่ม/ทำต่อ — คืนเส้นตาย เวลา server และคำตอบที่บันทึกไว้; ครั้งที่เลยเวลาแล้วจะถูกส่งอัตโนมัติ (timed_out) แทนการทำต่อ';
comment on function public.save_attempt_draft(uuid, jsonb) is 'บันทึกคำตอบระหว่างทำ (ตรวจรูปแบบ) — เลยเวลาแล้วจะส่งอัตโนมัติจากคำตอบที่บันทึกก่อนหน้า';
comment on function public.submit_attempt(uuid, jsonb) is 'ส่งคำตอบ — ภายในเส้นตาย+ช่วงผ่อนผันให้คะแนนจากคำตอบที่ส่ง; เลยแล้วให้คะแนนจากคำตอบที่บันทึกไว้ (auto_submitted)';

-- ---------------------------------------------------------------------
-- Schedule (Supabase has pg_cron preloaded). Plain PostgreSQL test setups
-- without it skip this; the lazy paths above still finalise on next contact.
-- ---------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('finalize-expired-attempts', '* * * * *', 'select private.finalize_expired_attempts()');
exception when others then
  raise notice 'pg_cron unavailable, expired attempts finalise lazily only: %', sqlerrm;
end;
$$;

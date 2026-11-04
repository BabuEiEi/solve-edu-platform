-- =====================================================================
-- Phase 2B.1 / sub-step — ordered draft saves, newest device wins
--
-- Every save carries a sequence number; the server keeps the highest one
-- (draft_seq) and ignores anything not newer, so a slow request can never
-- overwrite later answers. start_attempt hands each page a fresh base far
-- above the stored value: saves from a page opened earlier (another device,
-- or this device before a reload) are then "stale", and that page stops
-- and asks the trainee to reload. Submitting from a stale page → SE005.
--
-- Also: the attempts audit trigger now fires only for evidence-bearing
-- columns, not for every autosave (which flooded audit_logs with drafts).
-- =====================================================================

alter table public.assessment_attempts
  add column draft_seq bigint not null default 0;

comment on column public.assessment_attempts.draft_seq is 'ลำดับการบันทึกคำตอบล่าสุดที่รับไว้ — ไม่ GRANT ให้ client; กันคำขอที่มาช้าทับคำตอบใหม่';

-- One page = one block of sequence numbers; far more saves than any page makes.
create or replace function private.draft_seq_block()
returns bigint language sql immutable set search_path = '' as $$ select 1000000::bigint $$;

drop trigger assessment_attempts_audit on public.assessment_attempts;
create trigger assessment_attempts_audit
  after update of assignment_id, user_id, attempt_no, status, started_at, submitted_at,
                  score, max_score, passed, correct_count, item_count, auto_submitted
  on public.assessment_attempts
  for each row execute function private.audit_row();
create trigger assessment_attempts_audit_delete
  after delete on public.assessment_attempts
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- start_attempt: + draft_seq (this page's base)
-- ---------------------------------------------------------------------
drop function public.start_attempt(uuid);
create function public.start_attempt(p_assignment uuid)
returns table (attempt_id uuid, attempt_no integer, started_at timestamptz, resumed boolean,
               deadline_at timestamptz, server_now timestamptz, draft jsonb, timed_out boolean,
               draft_seq bigint)
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
                          private.deadline_of(v_t), now(), null::jsonb, true, v_t.draft_seq;
      return;
    end if;
    update public.assessment_attempts t
       set draft_seq = t.draft_seq + private.draft_seq_block()
     where t.id = v_t.id
    returning t.* into v_t;
    return query select v_t.id, v_t.attempt_no, v_t.started_at, true,
                        private.deadline_of(v_t), now(), v_t.draft_json, false, v_t.draft_seq;
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

  insert into public.assessment_attempts as t (assignment_id, user_id, attempt_no, started_at, draft_seq)
  values (p_assignment, v_uid, v_used + 1, now(), private.draft_seq_block())
  returning t.* into v_t;
  return query select v_t.id, v_t.attempt_no, v_t.started_at, false,
                      private.deadline_of(v_t), now(), null::jsonb, false, v_t.draft_seq;
end;
$$;

-- ---------------------------------------------------------------------
-- save_attempt_draft(attempt, responses, seq)
--   seq not newer than the stored one → nothing saved, stale = true.
--   seq null (older clients) → saved without ordering.
-- ---------------------------------------------------------------------
drop function public.save_attempt_draft(uuid, jsonb);
create function public.save_attempt_draft(p_attempt uuid, p_responses jsonb, p_seq bigint default null)
returns table (saved_at timestamptz, finalized boolean, stale boolean)
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
    return query select null::timestamptz, true, false;
    return;
  end if;
  if p_seq is not null and p_seq <= v_t.draft_seq then
    return query select null::timestamptz, false, true;
    return;
  end if;

  select a.instrument_version_id into v_version from public.assessment_assignments a where a.id = v_t.assignment_id;
  v_error := private.responses_error(v_version, p_responses);
  if v_error is not null then
    raise exception 'invalid response: %', v_error using errcode = 'invalid_parameter_value';
  end if;

  update public.assessment_attempts t
     set draft_json = p_responses, draft_saved_at = now(), draft_seq = coalesce(p_seq, t.draft_seq)
   where t.id = p_attempt;
  return query select now(), false, false;
end;
$$;

-- ---------------------------------------------------------------------
-- submit_attempt(attempt, responses, seq): a page superseded by a newer
-- one (seq not newer than draft_seq) may not submit → SE005.
-- ---------------------------------------------------------------------
drop function public.submit_attempt(uuid, jsonb);
create function public.submit_attempt(p_attempt uuid, p_responses jsonb, p_seq bigint default null)
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
  elsif p_seq is not null and p_seq <= v_t.draft_seq then
    raise exception 'this attempt continues on another device' using errcode = 'SE005';
  else
    v_t := private.finalize_attempt(v_t.id, p_responses, false);
  end if;

  return query select v_t.id, v_t.score, v_t.max_score,
                      case when v_t.max_score > 0 then round(v_t.score * 100 / v_t.max_score, 2) end,
                      v_t.passed, v_t.correct_count, v_t.item_count, v_t.submitted_at, v_t.auto_submitted;
end;
$$;

revoke all on function private.draft_seq_block() from public;
revoke execute on function public.start_attempt(uuid) from public, anon;
revoke execute on function public.save_attempt_draft(uuid, jsonb, bigint) from public, anon;
revoke execute on function public.submit_attempt(uuid, jsonb, bigint) from public, anon;
grant execute on function public.start_attempt(uuid) to authenticated;
grant execute on function public.save_attempt_draft(uuid, jsonb, bigint) to authenticated;
grant execute on function public.submit_attempt(uuid, jsonb, bigint) to authenticated;

comment on function public.start_attempt(uuid) is 'เริ่ม/ทำต่อ — คืนเส้นตาย เวลา server คำตอบที่บันทึกไว้ และเลขฐานลำดับการบันทึกของหน้านี้; ครั้งที่เลยเวลาแล้วจะถูกส่งอัตโนมัติ (timed_out)';
comment on function public.save_attempt_draft(uuid, jsonb, bigint) is 'บันทึกคำตอบระหว่างทำ — รับเฉพาะลำดับที่ใหม่กว่า (stale = หน้าอื่นทำต่อแล้ว); เลยเวลาแล้วส่งอัตโนมัติจากคำตอบที่บันทึกก่อนหน้า';
comment on function public.submit_attempt(uuid, jsonb, bigint) is 'ส่งคำตอบ — หน้าที่ถูกแทนด้วยหน้าใหม่กว่าส่งไม่ได้ (SE005); เลยเวลา+ช่วงผ่อนผันให้คะแนนจากคำตอบที่บันทึกไว้';

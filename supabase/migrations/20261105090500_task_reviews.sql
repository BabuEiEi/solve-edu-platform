-- =====================================================================
-- Phase 3 / step 3 — reviewing submitted work (owner decisions)
--
--   task_reviews        one review of one attempt by one reviewer:
--                       draft (private to its reviewer) → released (the
--                       trainee sees it; never changes again)
--   task_review_scores  the level picked per rubric criterion (+ comment);
--                       the score is the level's score, read by the server
--
-- save_task_review     creates/updates the caller's draft; the server
--                      checks criteria and levels against the task's rubric
--                      and adds up score / max_score
-- release_task_review  needs an outcome (passed | revise) and every
--                      criterion scored; a second release for the same
--                      attempt is a re-grade: it needs a reason, points at
--                      the review it replaces, and both are audited
--
-- Reviewers: the cohort's assessors (all trainees) and a trainee's mentor
-- (own mentees) — never the person who submitted. A new attempt opens only
-- when the current review of the latest attempt says "revise".
-- =====================================================================

create table public.task_reviews (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references public.task_submissions (id) on delete restrict,
  reviewer_id       uuid not null references public.profiles (id) on delete restrict,
  rubric_version_id uuid references public.instrument_versions (id) on delete restrict,
  status            text not null default 'draft' check (status in ('draft', 'released')),
  outcome           text check (outcome in ('passed', 'revise')),
  feedback          text check (feedback is null or char_length(feedback) <= 10000),
  score             numeric(9, 2),
  max_score         numeric(9, 2),
  supersedes_id     uuid references public.task_reviews (id) on delete restrict,
  regrade_reason    text check (regrade_reason is null or char_length(regrade_reason) <= 1000),
  released_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint task_reviews_released check ((status = 'released') = (released_at is not null and outcome is not null))
);
create unique index task_reviews_one_draft on public.task_reviews (submission_id, reviewer_id) where status = 'draft';
create index task_reviews_submission_idx on public.task_reviews (submission_id, released_at desc);

create table public.task_review_scores (
  id           uuid primary key default gen_random_uuid(),
  review_id    uuid not null references public.task_reviews (id) on delete cascade,
  criterion_id uuid not null references public.instrument_items (id) on delete restrict,
  level_id     text not null,
  score        numeric(9, 2) not null,
  comment      text check (comment is null or char_length(comment) <= 2000),
  constraint task_review_scores_once unique (review_id, criterion_id)
);

comment on table public.task_reviews is 'ผลการตรวจงานรายรอบ: ร่าง (เฉพาะผู้ตรวจ) → ส่งผล (ผู้เรียนเห็น, แก้ไม่ได้) · คะแนนรวมจาก server · ตรวจใหม่ = แถวใหม่ + เหตุผล + supersedes_id';
comment on table public.task_review_scores is 'ระดับที่เลือกรายเกณฑ์ของ Rubric + ความเห็น · score = คะแนนของระดับ (server)';

-- ---------------------------------------------------------------------
-- authz
-- ---------------------------------------------------------------------
create function authz.can_view_task_review(p_review uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.task_reviews r
     where r.id = p_review
       and ((r.status = 'draft' and r.reviewer_id = (select auth.uid()) and authz.is_active_user())
            or (r.status = 'released' and authz.can_view_task_submission(r.submission_id)))
  );
$$;
revoke execute on all functions in schema authz from public, anon;
grant execute on all functions in schema authz to authenticated, service_role;

-- ---------------------------------------------------------------------
-- A released review and its scores never change
-- ---------------------------------------------------------------------
create function private.task_reviews_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'released' then
    raise exception 'a released review cannot change (re-grade instead)' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger task_reviews_guard
  before update or delete on public.task_reviews
  for each row execute function private.task_reviews_guard();

create function private.task_review_scores_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.task_reviews r
              where r.id = case when tg_op = 'DELETE' then old.review_id else new.review_id end
                and r.status = 'released') then
    raise exception 'scores of a released review cannot change' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger task_review_scores_guard
  before insert or update or delete on public.task_review_scores
  for each row execute function private.task_review_scores_guard();

create trigger task_reviews_updated_at before update on public.task_reviews
  for each row execute function private.set_updated_at();

revoke all on function private.task_reviews_guard() from public;
revoke all on function private.task_review_scores_guard() from public;

-- ---------------------------------------------------------------------
-- save_task_review(submission, scores, feedback, outcome, reason)
--   scores: {criterion item id: {level: level id, comment?: text}} — may be
--   partial while drafting; {} for a task without a rubric
-- ---------------------------------------------------------------------
create function public.save_task_review(
  p_submission uuid, p_scores jsonb, p_feedback text, p_outcome text, p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_s public.task_submissions%rowtype;
  v_rubric uuid;
  v_review uuid;
  v_bad text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_s from public.task_submissions s where s.id = p_submission;
  if not found or v_s.status <> 'submitted' or v_s.user_id = v_uid
     or not authz.can_review_task_of(v_s.allocation_id, v_s.user_id) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select t.rubric_version_id into v_rubric
    from public.task_allocations a join public.tasks t on t.id = a.task_id
   where a.id = v_s.allocation_id;

  if jsonb_typeof(coalesce(p_scores, '{}'::jsonb)) <> 'object' then
    raise exception 'scores must be {criterion id: {level, comment?}}' using errcode = 'invalid_parameter_value';
  end if;
  p_scores := coalesce(p_scores, '{}'::jsonb);
  if p_outcome is not null and p_outcome not in ('passed', 'revise') then
    raise exception 'outcome is passed or revise' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(coalesce(p_feedback, '')) > 10000 or char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'feedback up to 10000 characters, reason up to 1000' using errcode = 'invalid_parameter_value';
  end if;

  select format('criterion %s: %s', kv.key, case
           when v_rubric is null then 'this task has no rubric'
           when i.id is null then 'not a criterion of this rubric'
           when jsonb_typeof(kv.value) <> 'object'
                or exists (select 1 from jsonb_object_keys(kv.value) k where k not in ('level', 'comment')) then 'expected {level, comment?}'
           when not exists (select 1 from jsonb_array_elements(i.options_json -> 'levels') l where l ->> 'id' = kv.value ->> 'level')
             then 'unknown level'
           when kv.value ? 'comment' and (jsonb_typeof(kv.value -> 'comment') <> 'string'
                                          or char_length(kv.value ->> 'comment') > 2000) then 'comment: text up to 2000 characters'
         end)
    into v_bad
    from jsonb_each(p_scores) kv
    left join public.instrument_items i
      on v_rubric is not null and i.instrument_version_id = v_rubric and i.id::text = kv.key
   where v_rubric is null or i.id is null
      or jsonb_typeof(kv.value) <> 'object'
      or exists (select 1 from jsonb_object_keys(kv.value) k where k not in ('level', 'comment'))
      or not exists (select 1 from jsonb_array_elements(i.options_json -> 'levels') l where l ->> 'id' = kv.value ->> 'level')
      or (kv.value ? 'comment' and (jsonb_typeof(kv.value -> 'comment') <> 'string' or char_length(kv.value ->> 'comment') > 2000))
   limit 1;
  if v_bad is not null then
    raise exception '%', v_bad using errcode = 'invalid_parameter_value';
  end if;

  select r.id into v_review from public.task_reviews r
   where r.submission_id = p_submission and r.reviewer_id = v_uid and r.status = 'draft'
     for update;
  if not found then
    insert into public.task_reviews (submission_id, reviewer_id, rubric_version_id)
    values (p_submission, v_uid, v_rubric)
    returning id into v_review;
  end if;

  delete from public.task_review_scores sc where sc.review_id = v_review;
  insert into public.task_review_scores (review_id, criterion_id, level_id, score, comment)
  select v_review, i.id, kv.value ->> 'level',
         (select (l ->> 'score')::numeric from jsonb_array_elements(i.options_json -> 'levels') l
           where l ->> 'id' = kv.value ->> 'level'),
         nullif(btrim(kv.value ->> 'comment'), '')
    from jsonb_each(p_scores) kv
    join public.instrument_items i on i.instrument_version_id = v_rubric and i.id::text = kv.key;

  update public.task_reviews r
     set feedback = nullif(btrim(p_feedback), ''),
         outcome = p_outcome,
         regrade_reason = nullif(btrim(p_reason), ''),
         score = case when v_rubric is null then null
                      else (select coalesce(sum(sc.score), 0) from public.task_review_scores sc where sc.review_id = v_review) end,
         max_score = case when v_rubric is null then null
                          else (select sum(i.max_score) from public.instrument_items i where i.instrument_version_id = v_rubric) end
   where r.id = v_review;
  return v_review;
end;
$$;

-- ---------------------------------------------------------------------
-- release_task_review(review)
-- ---------------------------------------------------------------------
create function public.release_task_review(p_review uuid)
returns public.task_reviews
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_r public.task_reviews%rowtype;
  v_s public.task_submissions%rowtype;
  v_prev public.task_reviews%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_r from public.task_reviews r where r.id = p_review for update;
  if not found or v_r.reviewer_id <> v_uid or v_r.status <> 'draft' then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select * into v_s from public.task_submissions s where s.id = v_r.submission_id;
  if not authz.can_review_task_of(v_s.allocation_id, v_s.user_id) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_r.outcome is null then
    raise exception 'choose passed or revise before releasing' using errcode = 'check_violation';
  end if;
  if v_r.rubric_version_id is not null and exists (
       select 1 from public.instrument_items i
        where i.instrument_version_id = v_r.rubric_version_id
          and not exists (select 1 from public.task_review_scores sc where sc.review_id = v_r.id and sc.criterion_id = i.id)) then
    raise exception 'score every criterion before releasing' using errcode = 'check_violation';
  end if;

  -- serialise releases of the same attempt, then find the review in force
  perform pg_advisory_xact_lock(hashtextextended('task_review:' || v_r.submission_id::text, 0));
  select * into v_prev from public.task_reviews r
   where r.submission_id = v_r.submission_id and r.status = 'released'
   order by r.released_at desc, r.id desc
   limit 1;
  if found and v_r.regrade_reason is null then
    raise exception 'this attempt has a released review: give the reason for re-grading' using errcode = 'check_violation';
  end if;

  update public.task_reviews r
     set status = 'released', released_at = now(), supersedes_id = v_prev.id
   where r.id = p_review
  returning r.* into v_r;

  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json, reason)
  values (v_uid,
          case when v_prev.id is null then 'RELEASE_TASK_REVIEW' else 'REGRADE_TASK_REVIEW' end,
          'public.task_reviews', v_r.id,
          case when v_prev.id is null then null
               else jsonb_build_object('review_id', v_prev.id, 'score', v_prev.score, 'max_score', v_prev.max_score,
                                       'outcome', v_prev.outcome) end,
          jsonb_build_object('submission_id', v_r.submission_id, 'score', v_r.score, 'max_score', v_r.max_score,
                             'outcome', v_r.outcome),
          v_r.regrade_reason);
  return v_r;
end;
$$;

-- ---------------------------------------------------------------------
-- A new attempt follows a review that returned the work for revision
-- ---------------------------------------------------------------------
create or replace function public.start_task_submission(p_allocation uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.task_allocations%rowtype;
  v_t public.tasks%rowtype;
  v_id uuid;
  v_count integer;
  v_last public.task_submissions%rowtype;
  v_outcome text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_a from public.task_allocations a where a.id = p_allocation;
  if not found or not authz.is_cohort_member(v_a.cohort_id, array['trainee']) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select * into v_t from public.tasks t where t.id = v_a.task_id;
  if v_t.status <> 'published' then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_a.available_at is not null and now() < v_a.available_at then
    raise exception 'this task is not open yet' using errcode = 'SE001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_allocation::text || v_uid::text, 0));
  select s.id into v_id from public.task_submissions s
   where s.allocation_id = p_allocation and s.user_id = v_uid and s.status = 'draft';
  if found then
    return v_id;
  end if;
  select count(*) into v_count from public.task_submissions s
   where s.allocation_id = p_allocation and s.user_id = v_uid;
  if v_count > 0 then
    select * into v_last from public.task_submissions s
     where s.allocation_id = p_allocation and s.user_id = v_uid
     order by s.attempt_no desc limit 1;
    select r.outcome into v_outcome from public.task_reviews r
     where r.submission_id = v_last.id and r.status = 'released'
     order by r.released_at desc, r.id desc limit 1;
    if v_outcome is distinct from 'revise' then
      raise exception 'the last attempt is waiting for review or has passed' using errcode = 'SE007';
    end if;
  end if;
  if v_count >= v_t.max_attempts then
    raise exception 'no attempts left' using errcode = 'SE002';
  end if;
  insert into public.task_submissions (allocation_id, user_id, attempt_no)
  values (p_allocation, v_uid, v_count + 1)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.save_task_review(uuid, jsonb, text, text, text) from public, anon;
revoke execute on function public.release_task_review(uuid) from public, anon;
revoke execute on function public.start_task_submission(uuid) from public, anon;
grant execute on function public.save_task_review(uuid, jsonb, text, text, text) to authenticated;
grant execute on function public.release_task_review(uuid) to authenticated;
grant execute on function public.start_task_submission(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- GRANTs + RLS: read-only for clients, except discarding one's own draft
-- ---------------------------------------------------------------------
alter table public.task_reviews       enable row level security;
alter table public.task_review_scores enable row level security;

grant select, delete on public.task_reviews to authenticated;
grant select on public.task_review_scores to authenticated;
create policy task_reviews_select on public.task_reviews
  for select to authenticated
  using ((status = 'draft' and reviewer_id = (select auth.uid()) and authz.is_active_user())
         or (status = 'released' and authz.can_view_task_submission(submission_id)));
create policy task_reviews_delete on public.task_reviews
  for delete to authenticated
  using (status = 'draft' and reviewer_id = (select auth.uid()));
create policy task_review_scores_select on public.task_review_scores
  for select to authenticated using (authz.can_view_task_review(review_id));

comment on function public.save_task_review(uuid, jsonb, text, text, text) is 'บันทึกร่างการตรวจของผู้เรียก (ผู้ดูแลรุ่น/ครูพี่เลี้ยงของครูคนนั้น ไม่ใช่เจ้าของงาน) · ตรวจเกณฑ์/ระดับกับ Rubric ของภาระงาน · คะแนนรวมที่ server';
comment on function public.release_task_review(uuid) is 'ส่งผล: ต้องมีผลและคะแนนครบทุกเกณฑ์ · ครั้งที่สองของรอบเดียวกัน = ตรวจใหม่ ต้องมีเหตุผล · audit ค่าเดิม/ค่าใหม่/เหตุผล (ไม่เก็บข้อเสนอแนะ)';

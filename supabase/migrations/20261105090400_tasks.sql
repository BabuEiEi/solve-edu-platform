-- =====================================================================
-- Phase 3 / step 2 — ภาระงาน (tasks), allocation to cohorts, submissions
-- with text, links and files (owner decisions)
--
--   tasks                   a piece of work in a course, optionally scored with
--                           a published rubric version; draft → published
--   task_allocations        a task opened to one cohort (available_at, due_at)
--   task_submissions        one attempt per row; a trainee edits only their
--                           draft; submit_task_submission freezes it and stamps
--                           submitted_at / is_late on the server
--   task_submission_files   files of an attempt, in the private bucket
--                           task-files/<submission_id>/<random>.<ext>
--
-- Who sees what: a trainee their own attempts (drafts included); staff only
-- SUBMITTED attempts — cohort assessors (trainer, coordinator, program
-- managers) all of the cohort, a mentor only their mentees. Reviews and
-- resubmission after "ส่งกลับแก้ไข" come in step 3.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.tasks (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.courses (id) on delete restrict,
  unit_id           uuid references public.course_units (id) on delete set null,
  title             text not null check (char_length(btrim(title)) between 1 and 300),
  instructions      text check (instructions is null or char_length(instructions) <= 10000),
  rubric_version_id uuid references public.instrument_versions (id) on delete restrict,
  max_attempts      integer not null default 3 check (max_attempts between 1 and 10),
  status            text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by        uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index tasks_course_idx on public.tasks (course_id);

create table public.task_allocations (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete restrict,
  cohort_id    uuid not null references public.cohorts (id) on delete restrict,
  available_at timestamptz,
  due_at       timestamptz,
  created_by   uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint task_allocations_once unique (task_id, cohort_id),
  constraint task_allocations_window check (due_at is null or available_at is null or due_at > available_at)
);
create index task_allocations_cohort_idx on public.task_allocations (cohort_id);

create table public.task_submissions (
  id            uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references public.task_allocations (id) on delete restrict,
  user_id       uuid not null references public.profiles (id) on delete restrict,
  attempt_no    integer not null check (attempt_no between 1 and 10),
  status        text not null default 'draft' check (status in ('draft', 'submitted')),
  text_response text check (text_response is null or char_length(text_response) <= 20000),
  links         jsonb not null default '[]'::jsonb,
  submitted_at  timestamptz,
  is_late       boolean,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint task_submissions_attempt unique (allocation_id, user_id, attempt_no),
  constraint task_submissions_evidence check ((status = 'submitted') = (submitted_at is not null and is_late is not null))
);
create unique index task_submissions_one_draft on public.task_submissions (allocation_id, user_id) where status = 'draft';
create index task_submissions_user_idx on public.task_submissions (user_id);

create table public.task_submission_files (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.task_submissions (id) on delete restrict,
  object_path   text not null unique,
  file_name     text not null check (char_length(file_name) between 1 and 255),
  size_bytes    bigint,
  mime_type     text,
  created_at    timestamptz not null default now()
);
create index task_submission_files_submission_idx on public.task_submission_files (submission_id);

comment on table public.tasks is 'ภาระงานของหลักสูตร (Phase 3) · rubric_version_id = Rubric ฉบับเผยแพร่ (ไม่บังคับ) · draft/published/archived';
comment on table public.task_allocations is 'เปิดภาระงานให้รุ่น: วันเปิด/กำหนดส่ง (ส่งช้าได้ แต่ติดป้าย)';
comment on table public.task_submissions is 'การส่งงานรายรอบ: ผู้ส่งแก้ได้เฉพาะร่าง · ส่งแล้วแก้ไม่ได้ · submitted_at/is_late จาก server';
comment on table public.task_submission_files is 'ไฟล์ของการส่งงาน (bucket task-files ส่วนตัว) · ขนาด/ชนิดอ่านจาก storage ฝั่ง server';

-- ---------------------------------------------------------------------
-- Links: up to 5 {url: https://…, label?}
-- ---------------------------------------------------------------------
create function private.task_links_error(p_links jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_links) is distinct from 'array' then 'links must be an array'
    when jsonb_array_length(p_links) > 5 then 'at most 5 links'
    when exists (
      select 1 from jsonb_array_elements(p_links) l
       where jsonb_typeof(l) <> 'object'
          or exists (select 1 from jsonb_object_keys(l) k where k not in ('url', 'label'))
          or jsonb_typeof(l -> 'url') is distinct from 'string'
          or (l ->> 'url') !~ '^https://[^\s<>"]+$'
          or char_length(l ->> 'url') > 2000
          or (l ? 'label' and (jsonb_typeof(l -> 'label') <> 'string' or char_length(l ->> 'label') > 200)))
      then 'each link is {url: https://…, label?: up to 200 characters}'
  end
$$;
revoke all on function private.task_links_error(jsonb) from public;
-- Checked in task_submissions_guard (a CHECK constraint would run with the
-- caller's rights, and clients cannot call private functions). Inserts come
-- only from start_task_submission, with no links.

-- ---------------------------------------------------------------------
-- authz helpers
-- ---------------------------------------------------------------------
-- Staff who may see a person's SUBMITTED work in this allocation.
create function authz.can_review_task_of(p_allocation uuid, p_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.task_allocations a
     where a.id = p_allocation
       and (authz.is_cohort_assessor(a.cohort_id) or authz.is_mentor_of(p_user, a.cohort_id))
  );
$$;

create function authz.can_view_task_submission(p_submission uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.task_submissions s
     where s.id = p_submission
       and ((s.user_id = (select auth.uid()) and authz.is_active_user())
            or (s.status = 'submitted' and authz.can_review_task_of(s.allocation_id, s.user_id)))
  );
$$;

create function authz.owns_draft_task_submission(p_submission uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_active_user() and exists (
    select 1 from public.task_submissions s
     where s.id = p_submission and s.user_id = (select auth.uid()) and s.status = 'draft'
  );
$$;

create function authz.can_view_task(p_task uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and (authz.can_manage_course(t.course_id)
            or exists (select 1 from public.task_allocations a
                        where a.task_id = t.id
                          and (authz.is_cohort_assessor(a.cohort_id)
                               or authz.is_cohort_member(a.cohort_id, array['mentor'])
                               or (t.status = 'published' and authz.is_cohort_member(a.cohort_id, array['trainee'])))))
  );
$$;

-- Policy helpers that read ONE table each, so the tasks and allocations
-- policies do not call each other (infinite recursion).
create function authz.task_seen_through_allocation(p_task uuid, p_task_status text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.task_allocations a
                  where a.task_id = p_task
                    and (authz.is_cohort_assessor(a.cohort_id)
                         or authz.is_cohort_member(a.cohort_id, array['mentor'])
                         or (p_task_status = 'published' and authz.is_cohort_member(a.cohort_id, array['trainee']))));
$$;

create function authz.task_is_published(p_task uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.tasks t where t.id = p_task and t.status = 'published');
$$;

-- A rubric used by a task is readable by whoever can see the task.
create or replace function authz.can_view_version(p_version uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_version(p_version)
      or exists (
           select 1 from public.assessment_assignments a
            where a.instrument_version_id = p_version
              and (authz.is_cohort_assessor(a.cohort_id)
                   or authz.is_cohort_member(a.cohort_id, array['mentor']))
         )
      or (authz.is_active_user() and exists (
           select 1
             from public.assessment_attempts t
             join public.assessment_assignments a on a.id = t.assignment_id
            where a.instrument_version_id = p_version
              and t.user_id = (select auth.uid())
         ))
      or exists (
           select 1 from public.tasks tk
            where tk.rubric_version_id = p_version and authz.can_view_task(tk.id)
         );
$$;

revoke execute on all functions in schema authz from public, anon;
grant execute on all functions in schema authz to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------
create function private.tasks_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.unit_id is not null and not exists (
       select 1 from public.course_units u where u.id = new.unit_id and u.course_id = new.course_id) then
    raise exception 'the unit is not part of this course' using errcode = 'check_violation';
  end if;
  if new.rubric_version_id is not null
     and (tg_op = 'INSERT' or new.rubric_version_id is distinct from old.rubric_version_id) then
    if not exists (
         select 1 from public.instrument_versions v
           join public.instruments ins on ins.id = v.instrument_id
          where v.id = new.rubric_version_id and v.status = 'published' and ins.instrument_type = 'rubric') then
      raise exception 'a task uses a published rubric version' using errcode = 'check_violation';
    end if;
    if auth.uid() is not null and not authz.can_manage_version(new.rubric_version_id) then
      raise exception 'not allowed to use this rubric' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.rubric_version_id is distinct from old.rubric_version_id and exists (
       select 1 from public.task_submissions s
         join public.task_allocations a on a.id = s.allocation_id
        where a.task_id = new.id and s.status = 'submitted') then
    raise exception 'work has been submitted: the rubric of this task cannot change' using errcode = 'SE006';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;
  return new;
end;
$$;
create trigger tasks_validate
  before insert or update on public.tasks
  for each row execute function private.tasks_validate();

create function private.task_allocations_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.task_id <> old.task_id or new.cohort_id <> old.cohort_id) then
    raise exception 'an allocation keeps its task and cohort' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.tasks t where t.id = new.task_id and t.status = 'published') then
      raise exception 'only a published task can be opened to a cohort' using errcode = 'check_violation';
    end if;
    if not exists (
         select 1 from public.tasks t
           join public.cohorts c on c.id = new.cohort_id
           join public.program_courses pc on pc.program_id = c.program_id and pc.course_id = t.course_id
          where t.id = new.task_id) then
      raise exception 'the course of this task is not part of the program of this cohort' using errcode = 'check_violation';
    end if;
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;
  return new;
end;
$$;
create trigger task_allocations_validate
  before insert or update on public.task_allocations
  for each row execute function private.task_allocations_validate();

-- A submitted attempt never changes; a draft only in its content.
create function private.task_submissions_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'submitted' then
    raise exception 'submitted work cannot change' using errcode = 'check_violation';
  end if;
  if new.allocation_id <> old.allocation_id or new.user_id <> old.user_id or new.attempt_no <> old.attempt_no then
    raise exception 'an attempt keeps its task, person and number' using errcode = 'check_violation';
  end if;
  if private.task_links_error(new.links) is not null then
    raise exception 'invalid links: %', private.task_links_error(new.links) using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger task_submissions_guard
  before update on public.task_submissions
  for each row execute function private.task_submissions_guard();

-- A file row points at an object already uploaded under the attempt's own
-- folder; size and type are read from storage, not from the client.
create function private.task_submission_files_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.task_submissions s where s.id = old.submission_id and s.status <> 'draft') then
      raise exception 'files of submitted work cannot change' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if not exists (select 1 from public.task_submissions s where s.id = new.submission_id and s.status = 'draft') then
    raise exception 'files are added to a draft only' using errcode = 'check_violation';
  end if;
  if not starts_with(new.object_path, new.submission_id::text || '/') or new.object_path ~ '(^|/)\.\.(/|$)' then
    raise exception 'the file must be stored under its attempt folder' using errcode = 'check_violation';
  end if;
  select o.metadata into v_meta from storage.objects o where o.bucket_id = 'task-files' and o.name = new.object_path;
  if not found then
    raise exception 'upload the file first' using errcode = 'check_violation';
  end if;
  if (select count(*) from public.task_submission_files f where f.submission_id = new.submission_id) >= 5 then
    raise exception 'at most 5 files per attempt' using errcode = 'check_violation';
  end if;
  new.size_bytes := (v_meta ->> 'size')::bigint;
  new.mime_type := v_meta ->> 'mimetype';
  new.created_at := now();
  return new;
end;
$$;
create trigger task_submission_files_validate
  before insert or delete on public.task_submission_files
  for each row execute function private.task_submission_files_validate();

create trigger tasks_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();
create trigger task_allocations_updated_at before update on public.task_allocations
  for each row execute function private.set_updated_at();
create trigger task_submissions_updated_at before update on public.task_submissions
  for each row execute function private.set_updated_at();

revoke all on function private.tasks_validate() from public;
revoke all on function private.task_allocations_validate() from public;
revoke all on function private.task_submissions_guard() from public;
revoke all on function private.task_submission_files_validate() from public;

-- ---------------------------------------------------------------------
-- RPCs: start an attempt, submit it
-- ---------------------------------------------------------------------
-- Returns the person's open draft, or opens the next attempt. Step 3 lets a
-- new attempt follow a review that returned the work for revision.
create function public.start_task_submission(p_allocation uuid)
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
  if v_count >= v_t.max_attempts then
    raise exception 'no attempts left' using errcode = 'SE002';
  end if;
  if v_count > 0 then
    raise exception 'the last attempt is waiting for review or has passed' using errcode = 'SE007';
  end if;
  insert into public.task_submissions (allocation_id, user_id, attempt_no)
  values (p_allocation, v_uid, v_count + 1)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.submit_task_submission(p_submission uuid)
returns public.task_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_s public.task_submissions%rowtype;
  v_a public.task_allocations%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_s from public.task_submissions s where s.id = p_submission for update;
  if not found or v_s.user_id <> v_uid or not authz.is_active_user() then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select * into v_a from public.task_allocations a where a.id = v_s.allocation_id;
  if not authz.is_cohort_member(v_a.cohort_id, array['trainee']) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if v_s.status <> 'draft' then
    raise exception 'already submitted' using errcode = 'SE003';
  end if;
  if coalesce(btrim(v_s.text_response), '') = '' and jsonb_array_length(v_s.links) = 0
     and not exists (select 1 from public.task_submission_files f where f.submission_id = v_s.id) then
    raise exception 'add text, a link or a file before submitting' using errcode = 'check_violation';
  end if;
  update public.task_submissions s
     set status = 'submitted', submitted_at = now(),
         is_late = (v_a.due_at is not null and now() > v_a.due_at)
   where s.id = p_submission
  returning s.* into v_s;
  return v_s;
end;
$$;

revoke execute on function public.start_task_submission(uuid) from public, anon;
revoke execute on function public.submit_task_submission(uuid) from public, anon;
grant execute on function public.start_task_submission(uuid) to authenticated;
grant execute on function public.submit_task_submission(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- GRANTs + RLS
-- ---------------------------------------------------------------------
alter table public.tasks                 enable row level security;
alter table public.task_allocations      enable row level security;
alter table public.task_submissions      enable row level security;
alter table public.task_submission_files enable row level security;

grant select on public.tasks to authenticated;
grant insert (course_id, unit_id, title, instructions, rubric_version_id, max_attempts, status) on public.tasks to authenticated;
grant update (unit_id, title, instructions, rubric_version_id, max_attempts, status) on public.tasks to authenticated;
grant delete on public.tasks to authenticated;
create policy tasks_select on public.tasks
  for select to authenticated
  using (authz.can_manage_course(course_id) or authz.task_seen_through_allocation(id, status));
create policy tasks_insert on public.tasks
  for insert to authenticated with check (authz.can_manage_course(course_id));
create policy tasks_update on public.tasks
  for update to authenticated using (authz.can_manage_course(course_id)) with check (authz.can_manage_course(course_id));
create policy tasks_delete on public.tasks
  for delete to authenticated using (status = 'draft' and authz.can_manage_course(course_id));

grant select on public.task_allocations to authenticated;
grant insert (task_id, cohort_id, available_at, due_at) on public.task_allocations to authenticated;
grant update (available_at, due_at) on public.task_allocations to authenticated;
grant delete on public.task_allocations to authenticated;
create policy task_allocations_select on public.task_allocations
  for select to authenticated
  using (authz.is_cohort_assessor(cohort_id)
         or authz.is_cohort_member(cohort_id, array['mentor'])
         or (authz.is_cohort_member(cohort_id, array['trainee'])
             and authz.task_is_published(task_id)));
create policy task_allocations_insert on public.task_allocations
  for insert to authenticated with check (authz.is_cohort_assessor(cohort_id) and authz.can_view_task(task_id));
create policy task_allocations_update on public.task_allocations
  for update to authenticated using (authz.is_cohort_assessor(cohort_id)) with check (authz.is_cohort_assessor(cohort_id));
-- Removing an allocation is refused by the FK once anyone has started.
create policy task_allocations_delete on public.task_allocations
  for delete to authenticated using (authz.is_cohort_assessor(cohort_id));

grant select on public.task_submissions to authenticated;
grant update (text_response, links) on public.task_submissions to authenticated;
create policy task_submissions_select on public.task_submissions
  for select to authenticated
  using ((user_id = (select auth.uid()) and authz.is_active_user())
         or (status = 'submitted' and authz.can_review_task_of(allocation_id, user_id)));
create policy task_submissions_update on public.task_submissions
  for update to authenticated
  using (user_id = (select auth.uid()) and status = 'draft' and authz.is_active_user())
  with check (user_id = (select auth.uid()) and status = 'draft');

grant select on public.task_submission_files to authenticated;
grant insert (submission_id, object_path, file_name) on public.task_submission_files to authenticated;
grant delete on public.task_submission_files to authenticated;
create policy task_submission_files_select on public.task_submission_files
  for select to authenticated using (authz.can_view_task_submission(submission_id));
create policy task_submission_files_insert on public.task_submission_files
  for insert to authenticated with check (authz.owns_draft_task_submission(submission_id));
create policy task_submission_files_delete on public.task_submission_files
  for delete to authenticated using (authz.owns_draft_task_submission(submission_id));

-- ---------------------------------------------------------------------
-- Storage: task-files/<submission_id>/<random>.<ext>
--   view   = authz.can_view_task_submission (owner; staff once submitted)
--   upload / delete = the owner while the attempt is a draft; no overwrite
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('task-files', 'task-files', false, 20971520, array[
     'application/pdf',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy task_files_select on storage.objects
  for select to authenticated
  using (bucket_id = 'task-files' and authz.can_view_task_submission(authz.object_owner_id(name)));
create policy task_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'task-files' and authz.owns_draft_task_submission(authz.object_owner_id(name)));
create policy task_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'task-files' and authz.owns_draft_task_submission(authz.object_owner_id(name)));

comment on function public.start_task_submission(uuid) is 'คืนร่างที่เปิดอยู่ หรือเปิดรอบใหม่ (ผู้เรียนของรุ่น, ภาระงานเผยแพร่, ถึงวันเปิดแล้ว, ยังไม่ครบรอบ) — SE001 ยังไม่เปิด · SE002 ครบรอบ · SE007 รอบล่าสุดรอตรวจ/ผ่านแล้ว';
comment on function public.submit_task_submission(uuid) is 'ส่งงาน: ร่างของตนเท่านั้น ต้องมีข้อความ ลิงก์ หรือไฟล์ · submitted_at/is_late จาก server · ส่งแล้วแก้ไม่ได้ (SE003)';

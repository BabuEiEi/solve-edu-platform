-- =====================================================================
-- Phase 3b / step 4 — copy submitted task files to a central Google Drive
--
-- A cohort assessor (trainer / cohort manager) presses "ส่งสำเนาไป Google
-- Drive" for one task in one cohort. The Edge Function `drive-export-task`
--   1. calls begin_task_drive_export AS THE PERSON (their JWT): checks they
--      assess that cohort, refuses a second run in parallel, records the run,
--      and returns the list of submitted attempts and files to copy;
--   2. downloads each file AS THE PERSON (storage RLS applies) and uploads it
--      to Drive under course / cohort / task / trainee / attempt, skipping
--      files already there (Drive is searched by our own file id, so a
--      repeated press never makes duplicates);
--   3. calls finish_task_drive_export with the server key: result + which
--      file is which Drive file.
--
-- task_drive_exports  one row per press: who, when, result (the log)
-- task_drive_copies   one row per file copied: which Drive file, when, run
-- Both readable by the cohort's assessors; nobody writes them directly.
-- =====================================================================

create table public.task_drive_exports (
  id              uuid primary key default gen_random_uuid(),
  allocation_id   uuid not null references public.task_allocations (id) on delete restrict,
  requested_by    uuid not null references public.profiles (id) on delete restrict,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running', 'done', 'partial', 'failed')),
  files_copied    integer not null default 0 check (files_copied >= 0),
  files_skipped   integer not null default 0 check (files_skipped >= 0),
  files_failed    integer not null default 0 check (files_failed >= 0),
  drive_folder_id text check (drive_folder_id is null or drive_folder_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  error           text check (error is null or char_length(error) <= 500),
  constraint task_drive_exports_finished check ((status = 'running') = (finished_at is null))
);
create index task_drive_exports_allocation_idx on public.task_drive_exports (allocation_id, started_at desc);

create table public.task_drive_copies (
  file_id       uuid primary key references public.task_submission_files (id) on delete restrict,
  run_id        uuid not null references public.task_drive_exports (id) on delete restrict,
  drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  copied_at     timestamptz not null default now()
);
create index task_drive_copies_run_idx on public.task_drive_copies (run_id);

comment on table public.task_drive_exports is 'การส่งสำเนาไฟล์งานไป Google Drive ส่วนกลาง (ต่อภาระงานต่อรุ่น): ใคร เมื่อไร ผลเป็นอย่างไร · เขียนผ่าน begin/finish เท่านั้น';
comment on table public.task_drive_copies is 'ไฟล์งานที่อยู่ใน Google Drive แล้ว: ไฟล์ไหน = ไฟล์ Drive ใด ส่งในครั้งไหน';

-- ---------------------------------------------------------------------
-- authz
-- ---------------------------------------------------------------------
create function authz.is_assessor_of_allocation(p_allocation uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.task_allocations a
                  where a.id = p_allocation and authz.is_cohort_assessor(a.cohort_id));
$$;

create function authz.can_see_drive_export(p_run uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.task_drive_exports r
                  where r.id = p_run and authz.is_assessor_of_allocation(r.allocation_id));
$$;

revoke execute on function authz.is_assessor_of_allocation(uuid) from public, anon;
revoke execute on function authz.can_see_drive_export(uuid) from public, anon;
grant execute on function authz.is_assessor_of_allocation(uuid) to authenticated, service_role;
grant execute on function authz.can_see_drive_export(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- begin: as the person pressing the button
-- ---------------------------------------------------------------------
create function public.begin_task_drive_export(p_allocation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.task_allocations%rowtype;
  v_run uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  -- the lock makes two presses at once take turns
  select * into v_a from public.task_allocations a where a.id = p_allocation for update;
  if not found or not authz.is_active_user() or not authz.is_cohort_assessor(v_a.cohort_id) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  -- a run that never finished (function killed) stops blocking after 15 minutes
  update public.task_drive_exports r
     set status = 'failed', finished_at = now(), error = 'did not finish within 15 minutes'
   where r.allocation_id = p_allocation and r.status = 'running' and r.started_at < now() - interval '15 minutes';
  if exists (select 1 from public.task_drive_exports r where r.allocation_id = p_allocation and r.status = 'running') then
    raise exception 'a copy to Google Drive is already running for this task' using errcode = 'SE008';
  end if;

  insert into public.task_drive_exports (allocation_id, requested_by)
  values (p_allocation, v_uid)
  returning id into v_run;

  return (
    select jsonb_build_object(
      'run_id', v_run,
      'allocation_id', v_a.id,
      'course', jsonb_build_object('id', c.id, 'title', c.title),
      'cohort', jsonb_build_object('id', h.id, 'name', h.name),
      'task', jsonb_build_object('id', t.id, 'title', t.title),
      'attempts', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'submission_id', s.id,
                 'attempt_no', s.attempt_no,
                 'user_id', s.user_id,
                 'person', coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.display_name), ''), s.user_id::text),
                 'submitted_at', s.submitted_at,
                 'is_late', s.is_late,
                 'files', (select jsonb_agg(jsonb_build_object(
                                    'id', f.id, 'object_path', f.object_path, 'file_name', f.file_name,
                                    'mime_type', f.mime_type, 'size_bytes', f.size_bytes)
                                  order by f.created_at, f.id)
                             from public.task_submission_files f where f.submission_id = s.id))
               order by p.full_name, s.user_id, s.attempt_no)
          from public.task_submissions s
          join public.profiles p on p.id = s.user_id
         where s.allocation_id = v_a.id
           and s.status = 'submitted'
           and exists (select 1 from public.task_submission_files f where f.submission_id = s.id)), '[]'::jsonb))
      from public.tasks t
      join public.courses c on c.id = t.course_id
      join public.cohorts h on h.id = v_a.cohort_id
     where t.id = v_a.task_id);
end;
$$;

-- ---------------------------------------------------------------------
-- finish: the Edge Function with the server key only
--   p_copies: [{file_id, drive_file_id}] for every file now in Drive
--   (uploaded this time or found there), recorded only if the file belongs
--   to this run's task and cohort and was submitted
-- ---------------------------------------------------------------------
create function public.finish_task_drive_export(
  p_run uuid,
  p_status text,
  p_copies jsonb,
  p_copied integer,
  p_skipped integer,
  p_failed integer,
  p_folder_id text default null,
  p_error text default null)
returns public.task_drive_exports
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_run public.task_drive_exports%rowtype;
begin
  if p_status is null or p_status not in ('done', 'partial', 'failed') then
    raise exception 'status must be done, partial or failed' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(coalesce(p_copies, '[]'::jsonb)) <> 'array' then
    raise exception 'p_copies must be an array' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_run from public.task_drive_exports r where r.id = p_run for update;
  if not found then
    raise exception 'no such run' using errcode = 'no_data_found';
  end if;
  if v_run.status <> 'running' then
    raise exception 'this run has already finished' using errcode = 'check_violation';
  end if;

  insert into public.task_drive_copies (file_id, run_id, drive_file_id)
  select distinct on (f.id) f.id, v_run.id, c ->> 'drive_file_id'
    from jsonb_array_elements(coalesce(p_copies, '[]'::jsonb)) c
    join public.task_submission_files f on f.id = authz.uuid_or_null(c ->> 'file_id')
    join public.task_submissions s on s.id = f.submission_id
   where s.allocation_id = v_run.allocation_id
     and s.status = 'submitted'
     and (c ->> 'drive_file_id') ~ '^[A-Za-z0-9_-]{1,200}$'
  on conflict (file_id) do update
     set drive_file_id = excluded.drive_file_id, run_id = excluded.run_id, copied_at = now()
   where public.task_drive_copies.drive_file_id is distinct from excluded.drive_file_id;

  update public.task_drive_exports r
     set status = p_status,
         finished_at = now(),
         files_copied = greatest(coalesce(p_copied, 0), 0),
         files_skipped = greatest(coalesce(p_skipped, 0), 0),
         files_failed = greatest(coalesce(p_failed, 0), 0),
         drive_folder_id = p_folder_id,
         error = left(p_error, 500)
   where r.id = p_run
  returning r.* into v_run;
  return v_run;
end;
$$;

revoke execute on function public.begin_task_drive_export(uuid) from public, anon;
grant execute on function public.begin_task_drive_export(uuid) to authenticated;
revoke execute on function public.finish_task_drive_export(uuid, text, jsonb, integer, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_task_drive_export(uuid, text, jsonb, integer, integer, integer, text, text)
  to service_role;

-- ---------------------------------------------------------------------
-- GRANTs + RLS: read-only for the cohort's assessors
-- ---------------------------------------------------------------------
alter table public.task_drive_exports enable row level security;
alter table public.task_drive_copies  enable row level security;

grant select on public.task_drive_exports to authenticated;
create policy task_drive_exports_select on public.task_drive_exports
  for select to authenticated using (authz.is_assessor_of_allocation(allocation_id));

grant select on public.task_drive_copies to authenticated;
create policy task_drive_copies_select on public.task_drive_copies
  for select to authenticated using (authz.can_see_drive_export(run_id));

-- finish runs as service_role (SECURITY INVOKER): it gets exactly what it
-- needs (Supabase grants service_role everything on new tables by default),
-- so even the server key cannot delete or rewrite the history.
revoke all on public.task_drive_exports, public.task_drive_copies from service_role;
grant select, update (status, finished_at, files_copied, files_skipped, files_failed, drive_folder_id, error)
  on public.task_drive_exports to service_role;
grant select, insert (file_id, run_id, drive_file_id), update (drive_file_id, run_id, copied_at)
  on public.task_drive_copies to service_role;

comment on function public.begin_task_drive_export(uuid) is
  'ผู้ตรวจของรุ่นเริ่มส่งสำเนาไป Google Drive: บันทึกการกด + คืนรายการรอบที่ส่งแล้วที่มีไฟล์ · SE008 = กำลังส่งอยู่ (ค้างเกิน 15 นาทีถือว่าล้มเหลว)';
comment on function public.finish_task_drive_export(uuid, text, jsonb, integer, integer, integer, text, text) is
  'service_role เท่านั้น: ปิดการส่งสำเนา (done/partial/failed) และบันทึกว่าไฟล์ใดอยู่ใน Drive แล้ว (เฉพาะไฟล์ของภาระงาน/รุ่นนั้นที่ส่งแล้ว)';

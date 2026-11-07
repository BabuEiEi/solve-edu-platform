-- =====================================================================
-- Phase 3b / step 3 — nightly clean-up of task files nobody needs
--
-- Storage objects cannot be deleted from SQL (only through the Storage
-- API), so the Edge Function `cleanup-task-files` does the deleting. The
-- database decides WHAT may go, atomically, and keeps the record:
--
--   1. task_files_cleanup_orphans    objects in task-files with no file row,
--                                    older than 24 h (an upload whose row was
--                                    never written, or a row removed while
--                                    the object delete failed). Read-only.
--   2. task_files_cleanup_stale_drafts  file rows of DRAFT attempts nobody
--                                    touched for 30 days (text, links and
--                                    files): rows deleted + audited here,
--                                    objects then removed by the function.
--                                    Submitted work is never touched.
--   3. task_files_cleanup_record     audit rows for orphan objects the
--                                    function removed (only those really
--                                    gone from storage).
--
-- All three are SECURITY INVOKER and executable by service_role ONLY (the
-- Edge Function's server-side key). anon/authenticated cannot call them.
-- =====================================================================

-- The functions write their own audit rows; service_role gets INSERT on
-- the audit log only (no select/update/delete). private stays unexposed.
grant insert (actor_id, action, table_name, record_id, before_json, after_json, reason)
  on private.audit_logs to service_role;

create function public.task_files_cleanup_orphans(
  p_older_than interval default interval '24 hours',
  p_limit integer default 500)
returns table (object_path text)
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_older_than is null or p_older_than < interval '1 hour' then
    raise exception 'p_older_than must be at least 1 hour' using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'p_limit must be 1-1000' using errcode = 'invalid_parameter_value';
  end if;
  return query
    select o.name
      from storage.objects o
     where o.bucket_id = 'task-files'
       and o.created_at < now() - p_older_than
       and not exists (select 1 from public.task_submission_files f where f.object_path = o.name)
     order by o.created_at, o.name
     limit p_limit;
end;
$$;

-- Last activity of a draft = its own last edit (autosave bumps updated_at)
-- or its newest file, whichever is later.
create function public.task_files_cleanup_stale_drafts(
  p_idle interval default interval '30 days',
  p_limit integer default 500,
  p_dry_run boolean default false)
returns table (object_path text)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_reason text;
begin
  if p_idle is null or p_idle < interval '7 days' then
    raise exception 'p_idle must be at least 7 days' using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'p_limit must be 1-1000' using errcode = 'invalid_parameter_value';
  end if;
  v_reason := 'cleanup: files of a draft untouched for ' || p_idle::text;

  if p_dry_run then
    return query
      select f.object_path
        from public.task_submission_files f
        join public.task_submissions s on s.id = f.submission_id
       where s.status = 'draft'
         and s.updated_at < now() - p_idle
         and not exists (select 1 from public.task_submission_files g
                          where g.submission_id = f.submission_id and g.created_at >= now() - p_idle)
       order by f.created_at, f.id
       limit p_limit;
    return;
  end if;

  -- Lock the drafts first (submit and the file trigger lock the same row):
  -- a draft being submitted or edited right now is skipped, not waited for,
  -- and staleness is decided on the locked row. The audit rows and the
  -- delete come from the same snapshot, in one statement.
  return query
    with drafts as (
      select s.id
        from public.task_submissions s
       where s.status = 'draft'
         and s.updated_at < now() - p_idle
         for update skip locked
    ), chosen as (
      select f.id
        from public.task_submission_files f
        join drafts d on d.id = f.submission_id
       where not exists (select 1 from public.task_submission_files g
                          where g.submission_id = f.submission_id and g.created_at >= now() - p_idle)
       order by f.created_at, f.id
       limit p_limit
    ), audited as (
      insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, reason)
      select null, 'DELETE', 'public.task_submission_files', f.id, to_jsonb(f), v_reason
        from public.task_submission_files f
       where f.id in (select id from chosen)
    )
    delete from public.task_submission_files f
     where f.id in (select id from chosen)
    returning f.object_path;
end;
$$;

create function public.task_files_cleanup_record(p_paths text[])
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_paths is null or cardinality(p_paths) > 1000 then
    raise exception 'p_paths must hold at most 1000 paths' using errcode = 'invalid_parameter_value';
  end if;
  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, reason)
  select null, 'DELETE', 'storage.objects', authz.uuid_or_null(split_part(p.name, '/', 1)),
         jsonb_build_object('bucket_id', 'task-files', 'name', p.name),
         'cleanup: task file with no submission row, older than 24 hours'
    from (select distinct unnest(p_paths) as name) p
   where p.name ~ '^[0-9a-f-]{36}/[^/]+$'
     and not exists (select 1 from storage.objects o where o.bucket_id = 'task-files' and o.name = p.name)
     and not exists (select 1 from public.task_submission_files f where f.object_path = p.name);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.task_files_cleanup_orphans(interval, integer) from public, anon, authenticated;
revoke execute on function public.task_files_cleanup_stale_drafts(interval, integer, boolean) from public, anon, authenticated;
revoke execute on function public.task_files_cleanup_record(text[]) from public, anon, authenticated;
grant execute on function public.task_files_cleanup_orphans(interval, integer) to service_role;
grant execute on function public.task_files_cleanup_stale_drafts(interval, integer, boolean) to service_role;
grant execute on function public.task_files_cleanup_record(text[]) to service_role;

comment on function public.task_files_cleanup_orphans(interval, integer) is
  'service_role เท่านั้น: ไฟล์ใน task-files ที่ไม่มีแถวในงานส่ง และเก่ากว่า p_older_than (ขั้นต่ำ 1 ชม.) — อ่านอย่างเดียว';
comment on function public.task_files_cleanup_stale_drafts(interval, integer, boolean) is
  'service_role เท่านั้น: ลบแถวไฟล์ของ "ร่าง" ที่ไม่มีใครแตะเกิน p_idle (ขั้นต่ำ 7 วัน) + บันทึก audit · คืน path ให้ Edge Function ลบไฟล์จริง · งานที่ส่งแล้วไม่ถูกแตะ';
comment on function public.task_files_cleanup_record(text[]) is
  'service_role เท่านั้น: บันทึก audit ของไฟล์ค้างที่ลบแล้ว (เฉพาะที่หายจาก storage จริง)';

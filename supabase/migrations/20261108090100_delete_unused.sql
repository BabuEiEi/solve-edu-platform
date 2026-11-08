-- =====================================================================
-- Phase 4a / step 2 — delete courses, quizzes/rubrics and tasks that
-- nobody has used yet (owner decision: used items are archived instead)
--
--   deletion_usage(kind, id)   what blocks a delete, as counts (for the page)
--   delete_course(id, confirm)       + its units, lessons, quizzes, rubrics,
--                                     tasks, assignments and programme links
--   delete_instrument(id, confirm)   a quiz or rubric + versions, items, keys,
--                                     assignments
--   delete_task(id, confirm)         + its allocations to cohorts
--   media_cleanup_orphans / _record  lesson / quiz media whose owner is gone
--                                     (removed nightly by cleanup-task-files)
--
-- "Used" = any learner activity or evidence: enrolments, attempts, task
-- submissions (draft or sent), reviews, Drive copies, or a rubric chosen by
-- a task. Every results table references its parent with ON DELETE
-- RESTRICT, so even a race (someone starts while we delete) makes the
-- delete fail rather than lose evidence.
-- Who may: whoever may manage the course / quiz (unchanged rules).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Items guard: a cascade from deleting the whole version must pass (the
-- answer-key guard already treats a vanished parent this way). Deleting
-- items of a published version directly is still refused.
-- ---------------------------------------------------------------------
create or replace function private.instrument_items_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- the version itself is being deleted (cascade from delete_instrument /
  -- delete_course, which checked that nobody used it): let its items go
  if tg_op = 'DELETE' and v_status is null then
    return old;
  end if;
  if v_status is distinct from 'draft'
     or (tg_op = 'UPDATE' and new.instrument_version_id <> old.instrument_version_id) then
    raise exception 'items of a published version cannot change (create a new version instead)'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_error := private.item_shape_error(new.item_type, new.options_json);
  if v_error is null and new.item_type = 'image_labelling' and new.media_path is null then
    v_error := 'image_labelling needs its image (media_path)';
  end if;
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
$function$;

-- ---------------------------------------------------------------------
-- usage (internal, no permission check)
-- ---------------------------------------------------------------------
create function private.instrument_usage(p_instrument uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  with v as (select id from public.instrument_versions where instrument_id = p_instrument)
  select jsonb_strip_nulls(jsonb_build_object(
    'attempts', nullif((select count(*) from public.assessment_attempts t
                          join public.assessment_assignments a on a.id = t.assignment_id
                         where a.instrument_version_id in (select id from v)), 0),
    'rubric_tasks', nullif((select count(*) from public.tasks k where k.rubric_version_id in (select id from v)), 0),
    'reviews', nullif((select count(*) from public.task_reviews r where r.rubric_version_id in (select id from v)), 0)));
$$;

create function private.task_usage(p_task uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'submissions', nullif((select count(*) from public.task_submissions s
                             join public.task_allocations a on a.id = s.allocation_id
                            where a.task_id = p_task), 0),
    'drive_exports', nullif((select count(*) from public.task_drive_exports e
                               join public.task_allocations a on a.id = e.allocation_id
                              where a.task_id = p_task), 0)));
$$;

-- A course is used if anyone enrolled, or any of its quizzes/tasks is used,
-- or a rubric of this course is chosen by a task of ANOTHER course.
create function private.course_usage(p_course uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  with v as (select v.id from public.instrument_versions v
               join public.instruments i on i.id = v.instrument_id where i.course_id = p_course)
  select jsonb_strip_nulls(jsonb_build_object(
    'enrollments', nullif((select count(*) from public.course_enrollments e where e.course_id = p_course), 0),
    'attempts', nullif((select count(*) from public.assessment_attempts t
                          join public.assessment_assignments a on a.id = t.assignment_id
                         where a.course_id = p_course or a.instrument_version_id in (select id from v)), 0),
    'submissions', nullif((select count(*) from public.task_submissions s
                             join public.task_allocations a on a.id = s.allocation_id
                             join public.tasks k on k.id = a.task_id
                            where k.course_id = p_course), 0),
    'drive_exports', nullif((select count(*) from public.task_drive_exports e
                               join public.task_allocations a on a.id = e.allocation_id
                               join public.tasks k on k.id = a.task_id
                              where k.course_id = p_course), 0),
    'rubric_tasks_elsewhere', nullif((select count(*) from public.tasks k
                                       where k.rubric_version_id in (select id from v)
                                         and k.course_id <> p_course), 0),
    'reviews', nullif((select count(*) from public.task_reviews r where r.rubric_version_id in (select id from v)), 0)));
$$;

revoke all on function private.instrument_usage(uuid) from public;
revoke all on function private.task_usage(uuid) from public;
revoke all on function private.course_usage(uuid) from public;

-- ---------------------------------------------------------------------
-- removal (internal; callers have checked rights, lock and usage)
-- ---------------------------------------------------------------------
create function private.remove_instrument(p_instrument uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_assignments int;
  v_versions int;
begin
  delete from public.assessment_extra_attempts x
   using public.assessment_assignments a, public.instrument_versions v
   where x.assignment_id = a.id and a.instrument_version_id = v.id and v.instrument_id = p_instrument;
  delete from public.assessment_assignments a
   using public.instrument_versions v
   where a.instrument_version_id = v.id and v.instrument_id = p_instrument;
  get diagnostics v_assignments = row_count;
  delete from public.instrument_versions v where v.instrument_id = p_instrument;  -- items and keys cascade
  get diagnostics v_versions = row_count;
  delete from public.instruments i where i.id = p_instrument;
  return jsonb_build_object('assignments', v_assignments, 'versions', v_versions);
end;
$$;

create function private.remove_task(p_task uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_allocations int;
begin
  delete from public.task_allocations a where a.task_id = p_task;
  get diagnostics v_allocations = row_count;
  delete from public.tasks t where t.id = p_task;
  return jsonb_build_object('allocations', v_allocations);
end;
$$;

revoke all on function private.remove_instrument(uuid) from public;
revoke all on function private.remove_task(uuid) from public;

-- ---------------------------------------------------------------------
-- deletion_usage: for the page (button "ลบ" or "เก็บถาวร" + why)
-- ---------------------------------------------------------------------
create function public.deletion_usage(p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reasons jsonb;
  v_course uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if p_kind = 'course' then
    if not authz.can_manage_course(p_id) then
      raise exception 'not allowed' using errcode = 'insufficient_privilege';
    end if;
    v_reasons := private.course_usage(p_id);
  elsif p_kind = 'instrument' then
    if not authz.can_manage_instrument(p_id) then
      raise exception 'not allowed' using errcode = 'insufficient_privilege';
    end if;
    v_reasons := private.instrument_usage(p_id);
  elsif p_kind = 'task' then
    select t.course_id into v_course from public.tasks t where t.id = p_id;
    if v_course is null or not authz.can_manage_course(v_course) then
      raise exception 'not allowed' using errcode = 'insufficient_privilege';
    end if;
    v_reasons := private.task_usage(p_id);
  else
    raise exception 'kind must be course, instrument or task' using errcode = 'invalid_parameter_value';
  end if;
  return jsonb_build_object('can_delete', v_reasons = '{}'::jsonb, 'reasons', v_reasons);
end;
$$;

-- ---------------------------------------------------------------------
-- delete_* : lock, re-check, remove, audit. p_confirm = the code (course,
-- quiz/rubric) or the title (task), typed by the person.
-- SE009 = in use (detail holds the counts)
-- ---------------------------------------------------------------------
create function public.delete_instrument(p_instrument uuid, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.instruments%rowtype;
  v_reasons jsonb;
  v_removed jsonb;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from public.instruments i where i.id = p_instrument for update;
  if not found or not authz.can_manage_instrument(p_instrument) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_confirm is distinct from v_row.code then
    raise exception 'type the code to confirm' using errcode = 'invalid_parameter_value';
  end if;
  v_reasons := private.instrument_usage(p_instrument);
  if v_reasons <> '{}'::jsonb then
    raise exception 'in use' using errcode = 'SE009', detail = v_reasons::text;
  end if;
  v_removed := private.remove_instrument(p_instrument);
  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json)
  values (v_actor, 'DELETE', 'public.instruments', p_instrument,
          jsonb_build_object('code', v_row.code, 'title', v_row.title, 'type', v_row.instrument_type,
                             'course_id', v_row.course_id, 'status', v_row.status),
          jsonb_build_object('removed', v_removed));
  return jsonb_build_object('deleted', true, 'removed', v_removed);
end;
$$;

create function public.delete_task(p_task uuid, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.tasks%rowtype;
  v_reasons jsonb;
  v_removed jsonb;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from public.tasks t where t.id = p_task for update;
  if not found or not authz.can_manage_course(v_row.course_id) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if btrim(coalesce(p_confirm, '')) is distinct from btrim(v_row.title) then
    raise exception 'type the title to confirm' using errcode = 'invalid_parameter_value';
  end if;
  v_reasons := private.task_usage(p_task);
  if v_reasons <> '{}'::jsonb then
    raise exception 'in use' using errcode = 'SE009', detail = v_reasons::text;
  end if;
  v_removed := private.remove_task(p_task);
  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json)
  values (v_actor, 'DELETE', 'public.tasks', p_task,
          jsonb_build_object('title', v_row.title, 'course_id', v_row.course_id, 'status', v_row.status,
                             'rubric_version_id', v_row.rubric_version_id),
          jsonb_build_object('removed', v_removed));
  return jsonb_build_object('deleted', true, 'removed', v_removed);
end;
$$;

create function public.delete_course(p_course uuid, p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.courses%rowtype;
  v_reasons jsonb;
  v_id uuid;
  v_tasks int := 0;
  v_instruments int := 0;
  v_assignments int;
  v_programs int;
  v_units int;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from public.courses c where c.id = p_course for update;
  if not found or not authz.can_manage_course(p_course) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_confirm is distinct from v_row.code then
    raise exception 'type the code to confirm' using errcode = 'invalid_parameter_value';
  end if;
  v_reasons := private.course_usage(p_course);
  if v_reasons <> '{}'::jsonb then
    raise exception 'in use' using errcode = 'SE009', detail = v_reasons::text;
  end if;

  -- tasks first (they may point at this course's rubrics)
  for v_id in select t.id from public.tasks t where t.course_id = p_course for update loop
    perform private.remove_task(v_id);
    v_tasks := v_tasks + 1;
  end loop;
  for v_id in select i.id from public.instruments i where i.course_id = p_course for update loop
    perform private.remove_instrument(v_id);
    v_instruments := v_instruments + 1;
  end loop;
  delete from public.assessment_assignments a where a.course_id = p_course;
  get diagnostics v_assignments = row_count;
  delete from public.program_courses pc where pc.course_id = p_course;
  get diagnostics v_programs = row_count;
  delete from public.course_units u where u.course_id = p_course;  -- lessons and blocks cascade
  get diagnostics v_units = row_count;
  delete from public.courses c where c.id = p_course;

  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json)
  values (v_actor, 'DELETE', 'public.courses', p_course,
          jsonb_build_object('code', v_row.code, 'title', v_row.title, 'status', v_row.status,
                             'owner_org_id', v_row.owner_org_id),
          jsonb_build_object('removed', jsonb_build_object('tasks', v_tasks, 'instruments', v_instruments,
                             'other_assignments', v_assignments, 'program_links', v_programs, 'units', v_units)));
  return jsonb_build_object('deleted', true, 'removed',
    jsonb_build_object('tasks', v_tasks, 'instruments', v_instruments, 'units', v_units, 'program_links', v_programs));
end;
$$;

revoke execute on function public.deletion_usage(text, uuid) from public, anon;
revoke execute on function public.delete_instrument(uuid, text) from public, anon;
revoke execute on function public.delete_task(uuid, text) from public, anon;
revoke execute on function public.delete_course(uuid, text) from public, anon;
grant execute on function public.deletion_usage(text, uuid) to authenticated;
grant execute on function public.delete_instrument(uuid, text) to authenticated;
grant execute on function public.delete_task(uuid, text) to authenticated;
grant execute on function public.delete_course(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- media whose owner (lesson / quiz) is gone — removed by the nightly
-- Edge Function with the server key (storage objects cannot be deleted
-- from SQL)
-- ---------------------------------------------------------------------
create function public.media_cleanup_orphans(
  p_older_than interval default interval '24 hours',
  p_limit integer default 500)
returns table (bucket_id text, object_path text)
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
    select o.bucket_id, o.name
      from storage.objects o
     where o.bucket_id in ('lesson-media', 'assessment-media')
       and o.created_at < now() - p_older_than
       and authz.object_owner_id(o.name) is not null
       and ((o.bucket_id = 'lesson-media'
             and not exists (select 1 from public.lessons l where l.id = authz.object_owner_id(o.name)))
         or (o.bucket_id = 'assessment-media'
             and not exists (select 1 from public.instruments i where i.id = authz.object_owner_id(o.name))))
     order by o.created_at, o.name
     limit p_limit;
end;
$$;

create function public.media_cleanup_record(p_bucket text, p_paths text[])
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_bucket is null or p_bucket not in ('lesson-media', 'assessment-media') then
    raise exception 'unknown bucket' using errcode = 'invalid_parameter_value';
  end if;
  if p_paths is null or cardinality(p_paths) > 1000 then
    raise exception 'p_paths must hold at most 1000 paths' using errcode = 'invalid_parameter_value';
  end if;
  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, reason)
  select null, 'DELETE', 'storage.objects', authz.object_owner_id(p.name),
         jsonb_build_object('bucket_id', p_bucket, 'name', p.name),
         'cleanup: media of a deleted lesson or quiz'
    from (select distinct unnest(p_paths) as name) p
   where authz.object_owner_id(p.name) is not null
     and not exists (select 1 from storage.objects o where o.bucket_id = p_bucket and o.name = p.name)
     and ((p_bucket = 'lesson-media' and not exists (select 1 from public.lessons l where l.id = authz.object_owner_id(p.name)))
       or (p_bucket = 'assessment-media' and not exists (select 1 from public.instruments i where i.id = authz.object_owner_id(p.name))));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.media_cleanup_orphans(interval, integer) from public, anon, authenticated;
revoke execute on function public.media_cleanup_record(text, text[]) from public, anon, authenticated;
grant execute on function public.media_cleanup_orphans(interval, integer) to service_role;
grant execute on function public.media_cleanup_record(text, text[]) to service_role;

comment on function public.deletion_usage(text, uuid) is 'อะไรทำให้ลบไม่ได้ (นับเป็นจำนวน) · kind = course / instrument / task · ผู้จัดการรายการนั้นเท่านั้น';
comment on function public.delete_course(uuid, text) is 'ลบหลักสูตรที่ยังไม่มีผู้ใช้ (พิมพ์รหัสยืนยัน) พร้อมหน่วย บทเรียน แบบทดสอบ Rubric ภาระงาน การมอบหมาย และการผูกโครงการ · SE009 = มีผู้ใช้แล้ว (ให้เก็บถาวรแทน) · audit';
comment on function public.delete_instrument(uuid, text) is 'ลบแบบทดสอบ/Rubric ที่ยังไม่มีผู้ใช้ (พิมพ์รหัสยืนยัน) พร้อมฉบับ ข้อ เฉลย การมอบหมาย · SE009 = มีผู้ใช้แล้ว · audit';
comment on function public.delete_task(uuid, text) is 'ลบภาระงานที่ยังไม่มีผู้ส่ง (พิมพ์ชื่อยืนยัน) พร้อมการเปิดให้รุ่น · SE009 = มีผู้ใช้แล้ว · audit';
comment on function public.media_cleanup_orphans(interval, integer) is 'service_role เท่านั้น: รูป/สื่อของบทเรียนหรือแบบทดสอบที่ถูกลบแล้ว (เก่ากว่า p_older_than)';
comment on function public.media_cleanup_record(text, text[]) is 'service_role เท่านั้น: บันทึก audit ของสื่อที่ลบแล้ว (เฉพาะที่หายจาก storage จริงและเจ้าของไม่มีแล้ว)';

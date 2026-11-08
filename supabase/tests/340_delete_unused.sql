-- Phase 4a step 2: delete only what nobody has used; typed confirmation;
-- everything below goes with it; evidence can never go (FK RESTRICT);
-- orphaned media is listed for the nightly clean-up.
begin;
select plan(38);

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $$;
grant execute on function pg_temp.err(text) to authenticated, anon, service_role;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

-- demo data: course AFL-101 (enrolments) · quiz AFL-101-PRE · quiz AFL-102-TYPES (has an image)
-- · rubric RUB-LESSONPLAN (chosen by the demo task) · the demo task (no submissions) · empty course DRAFT-201

-- ---------- privileges ----------
select ok(not has_function_privilege('anon', 'public.delete_course(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.delete_instrument(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.delete_task(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.deletion_usage(text,uuid)', 'execute'), 'anon can call none of the delete functions');
select ok(not has_function_privilege('authenticated', 'public.media_cleanup_orphans(interval,integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.media_cleanup_record(text,text[])', 'execute')
      and has_function_privilege('service_role', 'public.media_cleanup_orphans(interval,integer)', 'execute'),
  'media clean-up: the server key only');
select is((select count(*)::int from pg_proc
            where proname in ('delete_course', 'delete_instrument', 'delete_task', 'deletion_usage')
              and prosecdef and proconfig = array['search_path=""']), 4,
  'the four SECURITY DEFINER functions pin an empty search_path');

-- ---------- what blocks a delete ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err($$ select public.deletion_usage('course', tests.uid('course')) $$), '42501', 'a teacher cannot even ask');
select is(pg_temp.err($$ select public.delete_course(tests.uid('draft_course'), 'DRAFT-201') $$), '42501', '… nor delete');
-- a learner starts the pre-test: AFL-101-PRE becomes "used"
select lives_ok($$ select public.start_attempt('a4000000-0000-4000-a000-000000000001') $$, 'teacher A1 starts the pre-test');
reset role;

select tests.authenticate_as('district_admin');
select is(public.deletion_usage('course', tests.uid('course')) -> 'reasons' ->> 'enrollments', '3', 'the demo course: 3 enrolments');
select is((public.deletion_usage('course', tests.uid('course')) ->> 'can_delete')::boolean, false, '… so it cannot be deleted');
select is(public.deletion_usage('instrument', 'a1000000-0000-4000-a000-000000000001'),
  '{"reasons": {"attempts": 1}, "can_delete": false}'::jsonb, 'the pre-test: 1 attempt');
select is(public.deletion_usage('instrument', 'a1000000-0000-4000-a000-000000000003') -> 'reasons',
  '{"rubric_tasks": 1}'::jsonb, 'the rubric: chosen by 1 task');
select is((public.deletion_usage('instrument', 'a1000000-0000-4000-a000-000000000002') ->> 'can_delete')::boolean, true,
  'AFL-102-TYPES: assigned but never attempted → can be deleted');
select is((public.deletion_usage('task', 'b1000000-0000-4000-a000-000000000001') ->> 'can_delete')::boolean, true,
  'the demo task: opened to a cohort but nobody started → can be deleted');
select is(pg_temp.err($$ select public.deletion_usage('lesson', tests.uid('course')) $$), '22023', 'unknown kind refused');

-- ---------- quizzes and rubrics ----------
select is(pg_temp.err($$ select public.delete_instrument('a1000000-0000-4000-a000-000000000001', 'AFL-101-PRE') $$), 'SE009',
  'a quiz with an attempt: SE009 (archive instead)');
select is(pg_temp.err($$ select public.delete_instrument('a1000000-0000-4000-a000-000000000003', 'RUB-LESSONPLAN') $$), 'SE009',
  'a rubric chosen by a task: SE009');
select is(pg_temp.err($$ select public.delete_instrument('a1000000-0000-4000-a000-000000000002', 'afl-102-types') $$), '22023',
  'the typed code must match exactly');
select is(public.delete_instrument('a1000000-0000-4000-a000-000000000002', 'AFL-102-TYPES') -> 'removed',
  '{"versions": 1, "assignments": 1}'::jsonb, 'deleting AFL-102-TYPES removes its version and its assignment');
reset role;
select is((select count(*)::int from public.instruments where id = 'a1000000-0000-4000-a000-000000000002')
        + (select count(*)::int from public.instrument_versions where instrument_id = 'a1000000-0000-4000-a000-000000000002')
        + (select count(*)::int from public.assessment_assignments where id = 'a4000000-0000-4000-a000-000000000003'), 0,
  'quiz, versions and assignment are gone');
select is((select count(*)::int from private.instrument_answer_keys k
            where not exists (select 1 from public.instrument_items i where i.id = k.item_id)), 0, 'no answer key is left behind');
select is((select before_json ->> 'code' from private.audit_logs
            where action = 'DELETE' and table_name = 'public.instruments' and record_id = 'a1000000-0000-4000-a000-000000000002'),
  'AFL-102-TYPES', 'the delete is audited with what it was');
select is(pg_temp.err($$ select private.remove_instrument('a1000000-0000-4000-a000-000000000001') $$), '23503',
  'even bypassing the check, an attempt blocks the delete (FK RESTRICT): evidence cannot go');

select is(pg_temp.err($$ delete from public.instrument_items
                         where instrument_version_id in (select id from public.instrument_versions
                                                          where instrument_id = 'a1000000-0000-4000-a000-000000000001' and status = 'published') $$),
  '23514', 'deleting items of a published version directly is still refused (only a whole-version cascade passes)');

-- ---------- tasks ----------
select tests.authenticate_as('district_admin');
select is(pg_temp.err($$ select public.delete_task('b1000000-0000-4000-a000-000000000001', 'ผิดชื่อ') $$), '22023', 'the typed title must match');
select is(public.delete_task('b1000000-0000-4000-a000-000000000001', 'ส่งแผนการสอน AfL 1 คาบ (ทดลอง)') -> 'removed',
  '{"allocations": 1}'::jsonb, 'deleting the demo task removes its opening to the cohort');
select is((public.deletion_usage('instrument', 'a1000000-0000-4000-a000-000000000003') ->> 'can_delete')::boolean, true,
  'with the task gone, the rubric is free to delete');
-- a task somebody started cannot go
reset role;
insert into public.tasks (id, course_id, title, status) values ('b1000000-0000-4000-a000-0000000000e1', tests.uid('course'), 'งานทดสอบลบ', 'published');
insert into public.task_allocations (id, task_id, cohort_id) values ('b2000000-0000-4000-a000-0000000000e1', 'b1000000-0000-4000-a000-0000000000e1', tests.uid('cohort'));
reset role;
select tests.authenticate_as('teacher_a1');
select lives_ok($$ select public.start_task_submission('b2000000-0000-4000-a000-0000000000e1') $$, 'a trainee opens a draft of the new task');
reset role;
select tests.authenticate_as('district_admin');
select is(pg_temp.err($$ select public.delete_task('b1000000-0000-4000-a000-0000000000e1', 'งานทดสอบลบ') $$), 'SE009',
  'a task with even a draft submission: SE009');
reset role;

-- ---------- courses ----------
select tests.authenticate_as('district_admin');
select is(pg_temp.err($$ select public.delete_course(tests.uid('course'), 'AFL-101') $$), 'SE009', 'a course with enrolments: SE009');
select is(pg_temp.err($$ select public.delete_course(tests.uid('draft_course'), 'DRAFT') $$), '22023', 'the typed code must match');
select is(public.delete_course(tests.uid('draft_course'), 'DRAFT-201') ->> 'deleted', 'true', 'the empty draft course is deleted');
reset role;
-- an unused course with content: unit + lesson, a quiz, a rubric, a task, a programme link
insert into public.courses (id, code, title, owner_org_id, status) values ('40000000-0000-4000-a000-0000000000e1', 'DEL-1', 'หลักสูตรลบได้', tests.uid('district'), 'draft');
insert into public.course_units (id, course_id, title, display_order) values ('50000000-0000-4000-a000-0000000000e1', '40000000-0000-4000-a000-0000000000e1', 'หน่วย 1', 1);
insert into public.lessons (id, unit_id, title, display_order) values ('60000000-0000-4000-a000-0000000000e1', '50000000-0000-4000-a000-0000000000e1', 'บทที่ 1', 1);
insert into public.instruments (id, owner_org_id, course_id, code, title, instrument_type) values
  ('a1000000-0000-4000-a000-0000000000e1', tests.uid('district'), '40000000-0000-4000-a000-0000000000e1', 'DEL-1-Q', 'แบบทดสอบลบได้', 'quiz'),
  ('a1000000-0000-4000-a000-0000000000e2', tests.uid('district'), '40000000-0000-4000-a000-0000000000e1', 'DEL-1-R', 'Rubric ลบได้', 'rubric');
insert into public.instrument_versions (instrument_id, version_no) values ('a1000000-0000-4000-a000-0000000000e1', 1), ('a1000000-0000-4000-a000-0000000000e2', 1);
insert into public.tasks (course_id, title) values ('40000000-0000-4000-a000-0000000000e1', 'งานของหลักสูตรลบได้');
insert into public.program_courses (program_id, course_id, display_order) values (tests.uid('program'), '40000000-0000-4000-a000-0000000000e1', 9);
select tests.authenticate_as('district_admin');
select is(public.delete_course('40000000-0000-4000-a000-0000000000e1', 'DEL-1') -> 'removed',
  '{"tasks": 1, "units": 1, "instruments": 2, "program_links": 1}'::jsonb, 'an unused course goes with its tasks, quiz, rubric, units and programme link');
reset role;
select is((select count(*)::int from public.lessons where id = '60000000-0000-4000-a000-0000000000e1')
        + (select count(*)::int from public.instruments where course_id = '40000000-0000-4000-a000-0000000000e1')
        + (select count(*)::int from public.program_courses where course_id = '40000000-0000-4000-a000-0000000000e1'), 0,
  'nothing of it is left');
select is((select count(*)::int from private.audit_logs where action = 'DELETE' and table_name = 'public.courses'), 2, 'both course deletes are audited');
select is((select count(*)::int from public.courses where id = tests.uid('course')), 1, 'the used demo course is untouched');

-- ---------- media of deleted owners ----------
insert into storage.objects (bucket_id, name, created_at) values
  ('lesson-media', '60000000-0000-4000-a000-0000000000e1/gone.png', now() - interval '2 days'),
  ('lesson-media', tests.uid('lesson1') || '/kept.png', now() - interval '2 days'),
  ('lesson-media', '60000000-0000-4000-a000-0000000000e1/fresh.png', now() - interval '10 minutes');
update storage.objects set created_at = now() - interval '2 days'
 where bucket_id = 'assessment-media' and name = 'a1000000-0000-4000-a000-000000000002/afl-cycle.png';
select pg_temp.as_service();
select set_eq('select bucket_id || '':'' || object_path from public.media_cleanup_orphans()',
  array['lesson-media:60000000-0000-4000-a000-0000000000e1/gone.png',
        'assessment-media:a1000000-0000-4000-a000-000000000002/afl-cycle.png'],
  'orphans: media of the deleted lesson and quiz (not of living lessons, not fresh uploads)');
select is(pg_temp.err($$ select public.media_cleanup_record('task-files', array['x']) $$), '22023', 'record: only the two media buckets');
select is(public.media_cleanup_record('lesson-media', array['60000000-0000-4000-a000-0000000000e1/gone.png']), 0,
  'record: an object still in storage is not logged as removed');
reset role;
set local session_replication_role = replica;
delete from storage.objects where bucket_id = 'lesson-media' and name = '60000000-0000-4000-a000-0000000000e1/gone.png';
set local session_replication_role = origin;
select pg_temp.as_service();
select is(public.media_cleanup_record('lesson-media', array['60000000-0000-4000-a000-0000000000e1/gone.png', '60000000-0000-4000-a000-000000000001/kept.png']), 1,
  'record: logs the removed orphan once, never a living lesson''s file');
reset role;

select * from finish();
rollback;

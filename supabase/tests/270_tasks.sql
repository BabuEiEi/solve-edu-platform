-- Phase 3 step 2: tasks, allocation to cohorts, submissions with text,
-- links and files — who may do and see what.
begin;
select plan(53);

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $$;
grant execute on function pg_temp.err(text) to authenticated;
create temporary table ids (k text primary key, id uuid);
grant select, insert, update on ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;

select ok(not has_function_privilege('anon', 'public.start_task_submission(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.submit_task_submission(uuid)', 'execute'), 'anon cannot start or submit');

-- ---------- a published rubric, a quiz version, a draft rubric ----------
select tests.authenticate_as('trainer');
insert into public.instruments (owner_org_id, course_id, code, title, instrument_type)
values (tests.uid('district'), tests.uid('course'), 'RUB-T', 'เกณฑ์ตรวจภาระงาน (ทดสอบ)', 'rubric');
insert into ids select 'rubric_ins', id from public.instruments where code = 'RUB-T';
insert into public.instrument_versions (instrument_id) values (pg_temp.id('rubric_ins'));
insert into ids select 'rubric', id from public.instrument_versions where instrument_id = pg_temp.id('rubric_ins');
insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
values (pg_temp.id('rubric'), 'rubric_criterion', 'ความชัดเจนของเป้าหมาย',
        '{"levels":[{"id":"a","label":"ปรับปรุง","score":1},{"id":"b","label":"ดี","score":3}]}', 1);
do $$ begin perform public.publish_instrument_version(pg_temp.id('rubric')); end $$;
insert into ids values ('rubric_draft', public.clone_instrument_version(pg_temp.id('rubric')));
reset role;

-- ---------- tasks ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err($$ insert into public.tasks (course_id, title) values (tests.uid('course'), 'งานของผู้เรียน') $$), '42501',
  'a trainee cannot create a task');
reset role;

select tests.authenticate_as('trainer');
select is(pg_temp.err(format($$ insert into public.tasks (course_id, title, rubric_version_id) values (%L, 'x', %L) $$,
                             tests.uid('course'), pg_temp.id('rubric_draft'))), '23514', 'a task uses a published rubric only');
select is(pg_temp.err(format($$ insert into public.tasks (course_id, title, rubric_version_id) values (%L, 'x', %L) $$,
                             tests.uid('course'), tests.uid('quiz_v1'))), '23514', 'a quiz is not a rubric');
with t as (insert into public.tasks (course_id, unit_id, title, instructions, rubric_version_id)
           values (tests.uid('course'), tests.uid('unit1'), 'ส่งแผนการสอน AfL (ทดสอบ)', 'แนบแผนการสอน 1 คาบ', pg_temp.id('rubric'))
           returning id)
insert into ids select 'task', id from t;
select is((select status || '/' || max_attempts from public.tasks where id = pg_temp.id('task')), 'draft/3',
  'trainer creates a draft task; 3 attempts by default');
select is(pg_temp.err(format($$ insert into public.task_allocations (task_id, cohort_id) values (%L, %L) $$,
                             pg_temp.id('task'), tests.uid('cohort'))), '23514', 'a draft task cannot be opened to a cohort');
update public.tasks set status = 'published' where id = pg_temp.id('task');
with a as (insert into public.task_allocations (task_id, cohort_id, due_at)
           values (pg_temp.id('task'), tests.uid('cohort'), now() - interval '1 hour') returning id)
insert into ids select 'alloc', id from a;
select ok(pg_temp.id('alloc') is not null, 'trainer opens the task to the cohort (due an hour ago, to test late work)');
select is(pg_temp.err(format($$ insert into public.task_allocations (task_id, cohort_id) values (%L, %L) $$,
                             pg_temp.id('task'), tests.uid('cohort'))), '23505', 'once per cohort');
-- a second task, not open yet
with t as (insert into public.tasks (course_id, title, status) values (tests.uid('course'), 'งานที่ยังไม่เปิด (ทดสอบ)', 'published') returning id)
insert into ids select 'task_later', id from t;
with a as (insert into public.task_allocations (task_id, cohort_id, available_at)
           values (pg_temp.id('task_later'), tests.uid('cohort'), now() + interval '1 day') returning id)
insert into ids select 'alloc_later', id from a;
select is(pg_temp.err(format($$ delete from public.tasks where id = %L $$, pg_temp.id('task'))), 'no error', 'delete of a published task is a no-op');
select is((select count(*)::int from public.tasks where id = pg_temp.id('task')), 1, 'the published task is still there');
reset role;

-- ---------- who sees the task (and its rubric) ----------
select tests.authenticate_as('teacher_a1');
select is((select count(*)::int from public.tasks where id = pg_temp.id('task')), 1, 'trainee of the cohort sees the published task');
select is((select count(*)::int from public.task_allocations where id = pg_temp.id('alloc')), 1, '… and its allocation');
select is((select count(*)::int from public.instrument_items where instrument_version_id = pg_temp.id('rubric')), 1,
  '… and the rubric criteria it is scored with');
select is(pg_temp.err($$ insert into public.task_allocations (task_id, cohort_id) values (pg_temp.id('task_later'), tests.uid('cohort')) $$), '42501',
  'a trainee cannot open tasks');
reset role;
select tests.authenticate_as('mentor');
select is((select count(*)::int from public.tasks where id = pg_temp.id('task')), 1, 'mentor of the cohort sees the task');
reset role;
select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.tasks where id = pg_temp.id('task') $$, 'unrelated admin does not see the task');
select is_empty($$ select 1 from public.instrument_items where instrument_version_id = pg_temp.id('rubric') $$, '… nor its rubric');
reset role;

-- ---------- starting an attempt ----------
select tests.authenticate_as('trainer');
select is(pg_temp.err(format('select public.start_task_submission(%L)', pg_temp.id('alloc'))), '42501', 'staff do not submit work');
reset role;
select tests.authenticate_as('teacher_a1');
insert into ids values ('a1', public.start_task_submission(pg_temp.id('alloc')));
select is(public.start_task_submission(pg_temp.id('alloc')), pg_temp.id('a1'), 'starting again returns the same draft');
select is(pg_temp.err(format('select public.start_task_submission(%L)', pg_temp.id('alloc_later'))), 'SE001', 'not open yet');
update public.task_submissions set text_response = 'แผนการสอนเรื่องเศษส่วน',
       links = '[{"url":"https://docs.example.test/plan","label":"แผนฉบับเต็ม"}]' where id = pg_temp.id('a1');
select is((select text_response from public.task_submissions where id = pg_temp.id('a1')), 'แผนการสอนเรื่องเศษส่วน', 'the owner edits the draft');
select is(pg_temp.err($$ update public.task_submissions set links = '[{"url":"javascript:alert(1)"}]' where id = pg_temp.id('a1') $$),
  '23514', 'links are https only (no javascript:)');
select is(pg_temp.err($$ update public.task_submissions set links = '[{"url":"http://plain.example.test"}]' where id = pg_temp.id('a1') $$),
  '23514', 'no plain http');
select is(pg_temp.err($$ update public.task_submissions set submitted_at = now() where id = pg_temp.id('a1') $$), '42501',
  'the submission time is not the client''s to set');
select is(pg_temp.err($$ update public.task_submissions set status = 'submitted' where id = pg_temp.id('a1') $$), '42501',
  'nor the status');
reset role;

select tests.authenticate_as('teacher_a2');
insert into ids values ('a2', public.start_task_submission(pg_temp.id('alloc')));
select is_empty($$ select 1 from public.task_submissions where id = pg_temp.id('a1') $$, 'another trainee does not see the draft');
update public.task_submissions set text_response = 'แก้ของคนอื่น' where id = pg_temp.id('a1');
select is(pg_temp.err(format('select public.submit_task_submission(%L)', pg_temp.id('a2'))), '23514', 'an empty attempt cannot be submitted');
reset role;
select is((select text_response from public.task_submissions where id = pg_temp.id('a1')), 'แผนการสอนเรื่องเศษส่วน',
  'another trainee cannot change it');

select tests.authenticate_as('trainer');
select is_empty($$ select 1 from public.task_submissions where id = pg_temp.id('a1') $$, 'staff do not see drafts');
reset role;

-- ---------- files ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err(format($$ insert into storage.objects (bucket_id, name, metadata) values ('task-files', %L, '{"size":2048,"mimetype":"application/pdf"}') $$,
                             pg_temp.id('a1') || '/plan.pdf')), 'no error', 'the owner uploads into the draft''s folder');
select is(pg_temp.err(format($$ insert into storage.objects (bucket_id, name) values ('task-files', %L) $$, pg_temp.id('a2') || '/x.pdf')),
  '42501', 'not into someone else''s attempt');
select is(pg_temp.err($$ insert into storage.objects (bucket_id, name) values ('task-files', '80000000-0000-4000-a000-0000000000d1/x.pdf') $$),
  '42501', 'not into a folder that is no attempt');
select is(pg_temp.err(format($$ insert into public.task_submission_files (submission_id, object_path, file_name) values (%L, %L, 'x.pdf') $$,
                             pg_temp.id('a1'), pg_temp.id('a2') || '/x.pdf')), '23514', 'a file row points under its own attempt');
select is(pg_temp.err(format($$ insert into public.task_submission_files (submission_id, object_path, file_name) values (%L, %L, 'ghost.pdf') $$,
                             pg_temp.id('a1'), pg_temp.id('a1') || '/ghost.pdf')), '23514', 'the file must be uploaded first');
insert into public.task_submission_files (submission_id, object_path, file_name)
values (pg_temp.id('a1'), pg_temp.id('a1') || '/plan.pdf', 'แผนการสอน.pdf');
select results_eq(format($$ select size_bytes, mime_type from public.task_submission_files where submission_id = %L $$, pg_temp.id('a1')),
  $$ values (2048::bigint, 'application/pdf'::text) $$, 'size and type come from storage, not the client');
insert into storage.objects (bucket_id, name, metadata)
select 'task-files', pg_temp.id('a1') || '/f' || n || '.png', '{"size":10,"mimetype":"image/png"}' from generate_series(2, 6) n;
insert into public.task_submission_files (submission_id, object_path, file_name)
select pg_temp.id('a1'), pg_temp.id('a1') || '/f' || n || '.png', 'รูป ' || n from generate_series(2, 5) n;
select is(pg_temp.err(format($$ insert into public.task_submission_files (submission_id, object_path, file_name) values (%L, %L, 'รูป 6') $$,
                             pg_temp.id('a1'), pg_temp.id('a1') || '/f6.png')), '23514', 'at most 5 files');
delete from public.task_submission_files where object_path = pg_temp.id('a1') || '/f5.png';
select is((select count(*)::int from public.task_submission_files where submission_id = pg_temp.id('a1')), 4, 'the owner removes a file from the draft');
-- (storage objects are removed through the Storage API, which checks the task_files_delete policy below)

-- ---------- submit ----------
create temporary table sub as select * from public.submit_task_submission(pg_temp.id('a1'));
select results_eq($$ select status, is_late, submitted_at is not null from sub $$, $$ values ('submitted'::text, true, true) $$,
  'submitted, stamped by the server, flagged late (due an hour ago)');
select is(pg_temp.err(format('select public.submit_task_submission(%L)', pg_temp.id('a1'))), 'SE003', 'submitting twice');
update public.task_submissions set text_response = 'แก้หลังส่ง' where id = pg_temp.id('a1');
select is((select text_response from public.task_submissions where id = pg_temp.id('a1')), 'แผนการสอนเรื่องเศษส่วน', 'submitted work does not change');
delete from public.task_submission_files where submission_id = pg_temp.id('a1');
select is((select count(*)::int from public.task_submission_files where submission_id = pg_temp.id('a1')), 4, 'its files stay');
select is(authz.owns_draft_task_submission(pg_temp.id('a1')), false,
  'the storage delete policy no longer lets the owner remove its files');
select is(pg_temp.err(format('select public.start_task_submission(%L)', pg_temp.id('alloc'))), 'SE007',
  'no new attempt while the last one waits for review');
reset role;
select tests.authenticate_as('teacher_a2');
update public.task_submissions set text_response = 'งานของ A2' where id = pg_temp.id('a2');
do $$ begin perform public.submit_task_submission(pg_temp.id('a2')); end $$;
reset role;

-- ---------- who sees submitted work ----------
select tests.authenticate_as('trainer');
select is((select count(*)::int from public.task_submissions where allocation_id = pg_temp.id('alloc')), 2, 'trainer sees all submitted work of the cohort');
select is((select count(*)::int from public.task_submission_files where submission_id = pg_temp.id('a1')), 4, '… with its files');
select is((select count(*)::int from storage.objects where bucket_id = 'task-files' and name like pg_temp.id('a1') || '/%'), 6,
  '… and can open them (every object in the attempt folder)');
select is(pg_temp.err($$ insert into storage.objects (bucket_id, name) values ('task-files', pg_temp.id('a1') || '/x.pdf') $$), '42501',
  'staff cannot add files to someone''s work');
select is(pg_temp.err(format('update public.tasks set rubric_version_id = null where id = %L', pg_temp.id('task'))), 'SE006',
  'the rubric of a task with submitted work cannot change');
reset role;
select tests.authenticate_as('mentor');
select results_eq($$ select user_id from public.task_submissions where allocation_id = pg_temp.id('alloc') $$,
  format('values (%L::uuid)', tests.uid('teacher_a1')), 'a mentor sees only their mentee''s work');
select is((select count(*)::int from storage.objects where bucket_id = 'task-files' and name like pg_temp.id('a2') || '/%'), 0,
  '… and no other trainee''s files');
reset role;
select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.task_submissions $$, 'unrelated admin sees no work');
select is_empty($$ select 1 from storage.objects where bucket_id = 'task-files' $$, '… and no files');
reset role;
select tests.as_anon();
select is_empty($$ select 1 from storage.objects where bucket_id = 'task-files' $$, 'anon sees no files');
reset role;

select * from finish();
rollback;

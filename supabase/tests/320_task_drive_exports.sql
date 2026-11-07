-- Phase 3b step 4: copying task files to Google Drive — only the cohort's
-- assessors start it, only submitted files with their own task/cohort are
-- listed and recorded, one run at a time, and nobody rewrites the history.
begin;
select plan(37);

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
create temporary table ids (k text primary key, id uuid);
grant select, insert on ids to authenticated, service_role;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;
grant execute on function pg_temp.id(text) to authenticated, service_role;
create temporary table m (k text primary key, v jsonb);
grant select, insert, update on m to authenticated, service_role;
create or replace function pg_temp.obj(p_sub uuid, p_file text) returns text language sql as $$
  insert into storage.objects (bucket_id, name, metadata)
  values ('task-files', p_sub || '/' || p_file, '{"size": 12, "mimetype": "application/pdf"}')
  returning name $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
insert into ids values ('alloc', 'b2000000-0000-4000-a000-000000000001');

-- ---------- privileges ----------
select ok(not has_function_privilege('anon', 'public.begin_task_drive_export(uuid)', 'execute'), 'anon cannot begin');
select ok(not has_function_privilege('authenticated', 'public.finish_task_drive_export(uuid,text,jsonb,integer,integer,integer,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.finish_task_drive_export(uuid,text,jsonb,integer,integer,integer,text,text)', 'execute'),
  'only the server key may finish (not signed-in users, not anon)');
select is((select prosecdef from pg_proc where oid = 'public.finish_task_drive_export(uuid,text,jsonb,integer,integer,integer,text,text)'::regprocedure),
  false, 'finish runs with the caller''s rights');
select is((select proconfig from pg_proc where oid = 'public.begin_task_drive_export(uuid)'::regprocedure), array['search_path=""'],
  'begin (SECURITY DEFINER) pins an empty search_path');
select ok(not has_table_privilege('authenticated', 'public.task_drive_exports', 'insert')
      and not has_table_privilege('authenticated', 'public.task_drive_exports', 'update')
      and not has_table_privilege('authenticated', 'public.task_drive_exports', 'delete')
      and not has_table_privilege('authenticated', 'public.task_drive_copies', 'insert')
      and not has_table_privilege('authenticated', 'public.task_drive_copies', 'delete'),
  'signed-in users cannot write either table');
select ok(not has_table_privilege('service_role', 'public.task_drive_exports', 'delete')
      and not has_table_privilege('service_role', 'public.task_drive_exports', 'truncate')
      and not has_table_privilege('service_role', 'public.task_drive_copies', 'delete')
      and not has_column_privilege('service_role', 'public.task_drive_exports', 'requested_by', 'update')
      and not has_column_privilege('service_role', 'public.task_drive_exports', 'started_at', 'update'),
  'even the server key cannot delete the history or change who/when');

-- ---------- work: A1 submitted with 2 files, A2 submitted text only, B1 draft with a file ----------
select tests.authenticate_as('teacher_a1');
insert into ids values ('s1', public.start_task_submission(pg_temp.id('alloc')));
reset role;
insert into public.task_submission_files (submission_id, object_path, file_name)
values (pg_temp.id('s1'), pg_temp.obj(pg_temp.id('s1'), 'a.pdf'), 'แผนการสอน.pdf'),
       (pg_temp.id('s1'), pg_temp.obj(pg_temp.id('s1'), 'b.pdf'), 'ใบงาน.pdf');
select tests.authenticate_as('teacher_a1');
do $$ begin perform public.submit_task_submission(pg_temp.id('s1')); end $$;
reset role;
select tests.authenticate_as('teacher_a2');
insert into ids values ('s2', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'ข้อความอย่างเดียว' where id = pg_temp.id('s2');
do $$ begin perform public.submit_task_submission(pg_temp.id('s2')); end $$;
reset role;
select tests.authenticate_as('teacher_b1');
insert into ids values ('d3', public.start_task_submission(pg_temp.id('alloc')));
reset role;
insert into public.task_submission_files (submission_id, object_path, file_name)
values (pg_temp.id('d3'), pg_temp.obj(pg_temp.id('d3'), 'draft.pdf'), 'ร่าง.pdf');
insert into ids select 'f1', id from public.task_submission_files where object_path = pg_temp.id('s1') || '/a.pdf';
insert into ids select 'f2', id from public.task_submission_files where object_path = pg_temp.id('s1') || '/b.pdf';
insert into ids select 'fd', id from public.task_submission_files where object_path = pg_temp.id('d3') || '/draft.pdf';
-- a file of ANOTHER task's submitted work (a second task opened to the same cohort)
insert into public.tasks (id, course_id, title, status, created_by)
values ('b1000000-0000-4000-a000-0000000000f1', '40000000-0000-4000-a000-000000000001', 'ภาระงานอื่น', 'published', tests.uid('trainer'));
insert into public.task_allocations (id, task_id, cohort_id)
values ('b2000000-0000-4000-a000-0000000000f1', 'b1000000-0000-4000-a000-0000000000f1', '30000000-0000-4000-a000-000000000001');
select tests.authenticate_as('teacher_a1');
insert into ids values ('sx', public.start_task_submission('b2000000-0000-4000-a000-0000000000f1'));
reset role;
insert into public.task_submission_files (submission_id, object_path, file_name)
values (pg_temp.id('sx'), pg_temp.obj(pg_temp.id('sx'), 'x.pdf'), 'อื่น.pdf');
select tests.authenticate_as('teacher_a1');
do $$ begin perform public.submit_task_submission(pg_temp.id('sx')); end $$;
reset role;
insert into ids select 'fx', id from public.task_submission_files where object_path = pg_temp.id('sx') || '/x.pdf';

-- ---------- who may begin ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err($$select public.begin_task_drive_export(pg_temp.id('alloc'))$$), '42501', 'a trainee cannot begin');
reset role;
select tests.authenticate_as('mentor');
select is(pg_temp.err($$select public.begin_task_drive_export(pg_temp.id('alloc'))$$), '42501', 'a mentor cannot begin (cohort assessors only)');
reset role;
select tests.authenticate_as('school_admin_b');
select is(pg_temp.err($$select public.begin_task_drive_export(pg_temp.id('alloc'))$$), '42501', 'an outsider cannot begin');
select is(pg_temp.err($$select public.begin_task_drive_export(gen_random_uuid())$$), '42501', 'an unknown task-cohort: same refusal');
reset role;
select is((select count(*)::int from public.task_drive_exports), 0, 'refused presses leave no run behind');

select tests.authenticate_as('trainer');
insert into m values ('run1', public.begin_task_drive_export(pg_temp.id('alloc')));
reset role;
insert into ids select 'run1', (v ->> 'run_id')::uuid from m where k = 'run1';
select is((select r.status || '/' || (r.requested_by = tests.uid('trainer'))::text from public.task_drive_exports r where r.id = pg_temp.id('run1')),
  'running/true', 'the trainer''s press is recorded as running, by the trainer');
select is((select v #>> '{task,title}' from m where k = 'run1'), 'ส่งแผนการสอน AfL 1 คาบ (ทดลอง)', 'the list names the task');
select ok((select (v #>> '{course,title}') is not null and (v #>> '{cohort,name}') is not null from m where k = 'run1'), '… and the course and cohort');
select is((select jsonb_array_length(v -> 'attempts') from m where k = 'run1'), 1,
  'only submitted attempts WITH files are listed (not text-only work, not drafts)');
select is((select v #>> '{attempts,0,submission_id}' from m where k = 'run1'), pg_temp.id('s1')::text, '… that is A1''s attempt');
select is((select (v #> '{attempts,0,files}') @> jsonb_build_array(jsonb_build_object('id', pg_temp.id('f1'), 'file_name', 'แผนการสอน.pdf'))
            and jsonb_array_length(v #> '{attempts,0,files}') = 2 from m where k = 'run1'), true, 'with both of its files and their names');
select ok((select v #>> '{attempts,0,person}' from m where k = 'run1') <> '', 'the attempt carries the trainee''s name (for the folder)');
select ok((select not (v::text like '%contact_email%' or v::text like '%' || pg_temp.id('fd') || '%' or v::text like '%' || pg_temp.id('fx') || '%') from m where k = 'run1'),
  'no e-mail, no draft file, no file of another task in the list');

select tests.authenticate_as('trainer');
select is(pg_temp.err($$select public.begin_task_drive_export(pg_temp.id('alloc'))$$), 'SE008', 'a second press while running: SE008');
reset role;

-- ---------- who may read ----------
select tests.authenticate_as('trainer');
select is((select count(*)::int from public.task_drive_exports), 1, 'the trainer sees the run');
select is(pg_temp.err($$delete from public.task_drive_exports$$) || '/' || (select count(*)::int from public.task_drive_exports)::text, '42501/1',
  'the trainer cannot delete the record of a press (refused; still 1)');
reset role;
select tests.authenticate_as('mentor');
select is((select count(*)::int from public.task_drive_exports), 0, 'a mentor sees no run');
reset role;
select tests.authenticate_as('teacher_a1');
select is((select count(*)::int from public.task_drive_exports), 0, 'a trainee sees no run');
select is(pg_temp.err($$select public.finish_task_drive_export(pg_temp.id('run1'), 'done', '[]', 0, 0, 0)$$), '42501', 'a trainee cannot finish a run');
reset role;
select tests.authenticate_as('trainer');
select is(pg_temp.err($$select public.finish_task_drive_export(pg_temp.id('run1'), 'done', '[]', 0, 0, 0)$$), '42501',
  'the trainer cannot finish (and so cannot fake the result) either');
reset role;

-- ---------- finish (server key) ----------
select pg_temp.as_service();
select is((public.finish_task_drive_export(pg_temp.id('run1'), 'done',
  jsonb_build_array(
    jsonb_build_object('file_id', pg_temp.id('f1'), 'drive_file_id', 'driveFileA1'),
    jsonb_build_object('file_id', pg_temp.id('f2'), 'drive_file_id', 'driveFileB2'),
    jsonb_build_object('file_id', pg_temp.id('fd'), 'drive_file_id', 'driveDraft'),
    jsonb_build_object('file_id', pg_temp.id('fx'), 'drive_file_id', 'driveOther'),
    jsonb_build_object('file_id', gen_random_uuid(), 'drive_file_id', 'driveGhost'),
    jsonb_build_object('file_id', pg_temp.id('f2'), 'drive_file_id', 'bad id/../x')),
  2, 0, 0, 'folderTask1')).status, 'done', 'the server key finishes the run');
select is(pg_temp.err($$select public.finish_task_drive_export(pg_temp.id('run1'), 'failed', '[]', 0, 0, 0)$$), '23514', 'a finished run cannot be finished again');
select is(pg_temp.err($$select public.finish_task_drive_export(pg_temp.id('run1'), 'running', '[]', 0, 0, 0)$$), '22023', 'an unknown status is refused');
reset role;
select set_eq('select file_id from public.task_drive_copies', array[pg_temp.id('f1'), pg_temp.id('f2')],
  'only this task''s submitted files are recorded (not a draft''s, not another task''s, not unknown ids)');
select is((select drive_file_id from public.task_drive_copies where file_id = pg_temp.id('f2')), 'driveFileB2', 'a malformed Drive id is ignored');
select is((select files_copied || '/' || drive_folder_id from public.task_drive_exports where id = pg_temp.id('run1')), '2/folderTask1', 'counts and folder kept');

-- ---------- again: a new run; an unchanged copy keeps its first record ----------
select tests.authenticate_as('trainer');
insert into m values ('run2', public.begin_task_drive_export(pg_temp.id('alloc')));
select is((select count(*)::int from public.task_drive_copies), 2, 'the trainer sees which files are already in Drive');
reset role;
select tests.authenticate_as('teacher_a1');
select is((select count(*)::int from public.task_drive_copies), 0, '… a trainee does not');
reset role;
select pg_temp.as_service();
select public.finish_task_drive_export(((select v from m where k = 'run2') ->> 'run_id')::uuid, 'done',
  jsonb_build_array(jsonb_build_object('file_id', pg_temp.id('f1'), 'drive_file_id', 'driveFileA1'),
                    jsonb_build_object('file_id', pg_temp.id('f2'), 'drive_file_id', 'driveFileNEW')), 1, 1, 0);
reset role;
select is((select string_agg((run_id = pg_temp.id('run1'))::text, ',' order by drive_file_id) from public.task_drive_copies), 'true,false',
  'same Drive file: first record kept · re-created in Drive: record moves to the new run');

-- ---------- a run that never finished stops blocking after 15 minutes ----------
select tests.authenticate_as('trainer');
insert into m values ('run3', public.begin_task_drive_export(pg_temp.id('alloc')));
reset role;
update public.task_drive_exports set started_at = now() - interval '20 minutes' where id = ((select v from m where k = 'run3') ->> 'run_id')::uuid;
select tests.authenticate_as('trainer');
select is(pg_temp.err($$select public.begin_task_drive_export(pg_temp.id('alloc'))$$), 'no error', 'a stuck run older than 15 minutes no longer blocks');
reset role;
select is((select status || ':' || error from public.task_drive_exports where id = ((select v from m where k = 'run3') ->> 'run_id')::uuid),
  'failed:did not finish within 15 minutes', '… and is closed as failed, with the reason');

select * from finish();
rollback;

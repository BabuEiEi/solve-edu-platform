-- Phase 3 pre-merge review: nothing of one cohort's tasks leaks to another
-- cohort of the same program (its trainer, its trainees), and a person who
-- left the cohort can no longer start or submit.
begin;
select plan(13);

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
grant select, insert on ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;

-- cohort 2 of the same program, with its own trainer and trainee
insert into public.cohorts (id, program_id, code, name, status)
values ('30000000-0000-4000-a000-000000000292', tests.uid('program'), 'C2', 'รุ่นที่ 2 (ทดสอบ)', 'in_progress');
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-000000000291', 'scope.trainer@example.test', now(), '{"full_name":"วิทยากร รุ่น 2 (สมมติ)"}'),
  ('99999999-0000-4000-a000-000000000292', 'scope.trainee@example.test', now(), '{"full_name":"ครู รุ่น 2 (สมมติ)"}');
update public.profiles set status = 'active' where id::text like '99999999-0000-4000-a000-00000000029_';
insert into public.cohort_memberships (cohort_id, user_id, cohort_role, status) values
  ('30000000-0000-4000-a000-000000000292', '99999999-0000-4000-a000-000000000291', 'trainer', 'active'),
  ('30000000-0000-4000-a000-000000000292', '99999999-0000-4000-a000-000000000292', 'trainee', 'active');

-- cohort 1: A1 submits the demo task, the trainer releases a review
insert into ids values ('alloc', 'b2000000-0000-4000-a000-000000000001');
select tests.authenticate_as('teacher_a1');
insert into ids values ('a1', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'งานรุ่น 1' where id = pg_temp.id('a1');
insert into storage.objects (bucket_id, name, metadata)
values ('task-files', pg_temp.id('a1') || '/plan.pdf', '{"size":10,"mimetype":"application/pdf"}');
insert into public.task_submission_files (submission_id, object_path, file_name) values (pg_temp.id('a1'), pg_temp.id('a1') || '/plan.pdf', 'plan.pdf');
do $$ begin perform public.submit_task_submission(pg_temp.id('a1')); end $$;
reset role;
select tests.authenticate_as('trainer');
do $$ begin perform public.release_task_review(public.save_task_review(pg_temp.id('a1'),
     '{"a3000000-0000-4000-a000-000000000021":{"level":"b"},"a3000000-0000-4000-a000-000000000022":{"level":"x"}}', 'ok', 'revise')); end $$;
reset role;

-- ---------- the trainer of cohort 2 ----------
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000291');
select is_empty($$ select 1 from public.task_allocations where id = pg_temp.id('alloc') $$, 'another cohort''s trainer does not see the allocation');
select is_empty($$ select 1 from public.task_submissions $$, '… nor its submitted work');
select is_empty($$ select 1 from public.task_reviews $$, '… nor its reviews');
select is_empty($$ select 1 from storage.objects where bucket_id = 'task-files' $$, '… nor its files');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', 'passed') $$, pg_temp.id('a1'))), '42501', '… and cannot review it');
select is(pg_temp.err(format($$ update public.task_allocations set due_at = now() where id = %L $$, pg_temp.id('alloc'))), 'no error',
  '(an update of an allocation it cannot see changes nothing)');
reset role;
select ok((select due_at = '2027-03-31 23:59+07' from public.task_allocations where id = pg_temp.id('alloc')), 'the due date is unchanged');

-- ---------- the trainee of cohort 2 ----------
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000292');
select is_empty($$ select 1 from public.task_allocations where id = pg_temp.id('alloc') $$, 'another cohort''s trainee does not see the allocation');
select is(pg_temp.err(format('select public.start_task_submission(%L)', pg_temp.id('alloc'))), '42501', '… and cannot start it');
select is_empty($$ select 1 from public.task_submissions $$, '… nor see anyone''s work');
reset role;

-- ---------- a trainee who left the cohort ----------
update public.cohort_memberships set status = 'withdrawn'
 where cohort_id = tests.uid('cohort') and user_id = tests.uid('teacher_a2') and cohort_role = 'trainee';
select tests.authenticate_as('teacher_a2');
select is(pg_temp.err(format('select public.start_task_submission(%L)', pg_temp.id('alloc'))), '42501', 'after leaving the cohort: no new attempt');
select is_empty($$ select 1 from public.task_allocations where id = pg_temp.id('alloc') $$, '… and the task is no longer listed');
select is_empty(format('select 1 from public.task_submissions where id = %L', pg_temp.id('a1')), '… and other people''s work stays hidden');
reset role;

select * from finish();
rollback;

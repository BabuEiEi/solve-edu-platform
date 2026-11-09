-- Phase 4d: an archived quiz or rubric cannot be put to new use; what already
-- uses it keeps working; bringing it back lifts the block.
begin;
select plan(24);

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
create temp table ids (k text primary key, id uuid);
grant select, insert on ids to authenticated;
create or replace function pg_temp.id(p_key text) returns uuid language sql as $$ select id from ids where k = p_key $$;
grant execute on function pg_temp.id(text) to authenticated;

-- demo data: quiz AFL-101-PRE (version quiz_v1) with the published pretest and formative ·
-- rubric RUB-LESSONPLAN (version a2…03) chosen by the published demo task b1…01

-- ---------- the functions themselves ----------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private'
              and p.proname in ('instrument_status_for_use', 'assessment_assignments_validate_active', 'tasks_validate_rubric_active')
              and p.prosecdef and p.proconfig = array['search_path=""']), 3,
  'the three SECURITY DEFINER functions pin an empty search_path');
select ok(not has_function_privilege('anon', 'private.instrument_status_for_use(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'private.instrument_status_for_use(uuid)', 'execute'),
  'nobody signed in (or not) can call the status helper');
select ok(not has_function_privilege('authenticated', 'private.assessment_assignments_validate_active()', 'execute')
      and not has_function_privilege('authenticated', 'private.tasks_validate_rubric_active()', 'execute'),
  'the trigger functions cannot be called directly');

-- ---------- quizzes ----------
select tests.authenticate_as('trainer');
-- a draft assignment made while the quiz is still active
-- (with a close date, so that publishing it is refused only because of the archive)
with r as (insert into public.assessment_assignments (instrument_version_id, cohort_id, course_id, purpose, title, close_at)
           values (tests.uid('quiz_v1'), tests.uid('cohort'), tests.uid('course'), 'formative', 'ร่างก่อนเก็บถาวร (ทดสอบ)',
                   now() + interval '30 days')
           returning id)
insert into ids select 'draft_assignment', id from r;
select isnt(pg_temp.id('draft_assignment'), null, 'an active quiz can be assigned (draft)');

select lives_ok($$ update public.instruments set status = 'archived' where id = tests.uid('quiz') $$,
  'the trainer archives the quiz');
select is(pg_temp.err($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, course_id, purpose, title)
                         values (tests.uid('quiz_v1'), tests.uid('cohort'), tests.uid('course'), 'formative', 'x') $$),
  'SE010', 'an archived quiz cannot be assigned again');
select is(pg_temp.err($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, course_id, purpose, title, status, close_at)
                         values (tests.uid('quiz_v1'), tests.uid('cohort'), tests.uid('course'), 'formative', 'x', 'published',
                                 now() + interval '30 days') $$),
  'SE010', '… not even straight to published');
select is(pg_temp.err($$ update public.assessment_assignments set status = 'published' where id = pg_temp.id('draft_assignment') $$),
  'SE010', 'a draft assignment of it cannot be published');
select is((select status from public.assessment_assignments where id = pg_temp.id('draft_assignment')), 'draft',
  '… it stays a draft');
select lives_ok($$ update public.assessment_assignments set title = 'ร่าง (แก้ชื่อ)' where id = pg_temp.id('draft_assignment') $$,
  '… but it can still be edited, or deleted');

-- what already uses it keeps working
select lives_ok($$ update public.assessment_assignments set title = 'แบบทดสอบก่อนเรียน (แก้ชื่อ)', close_at = now() + interval '60 days'
                    where id = tests.uid('pretest') $$,
  'the published pretest can still be edited');
select is((select status from public.assessment_assignments where id = tests.uid('pretest')), 'published',
  '… and stays open to learners');
select lives_ok($$ update public.assessment_assignments set status = 'archived' where id = tests.uid('formative') $$,
  'an existing assignment can be archived');
select is(pg_temp.err($$ update public.assessment_assignments set status = 'published' where id = tests.uid('formative') $$),
  'SE010', '… but not reopened while the quiz is archived');
reset role;

select tests.authenticate_as('teacher_a1');
select lives_ok($$ select public.start_attempt(tests.uid('pretest')) $$,
  'a learner can still start the pretest of an archived quiz');
reset role;

-- not even server code may move an assignment onto an archived quiz (clients cannot change the version at all)
select is(pg_temp.err(format($$ update public.assessment_assignments set instrument_version_id = %L where id = %L $$,
                             tests.uid('quiz_v1'), 'a4000000-0000-4000-a000-000000000003')),
  'SE010', 'the server cannot move another assignment onto the archived quiz either');

select tests.authenticate_as('trainer');
select lives_ok($$ update public.instruments set status = 'active' where id = tests.uid('quiz') $$,
  'the trainer brings the quiz back');
select lives_ok($$ update public.assessment_assignments set status = 'published' where id = pg_temp.id('draft_assignment') $$,
  '… now the draft can be published');
reset role;

-- ---------- rubrics ----------
select tests.authenticate_as('trainer');
select lives_ok($$ update public.instruments set status = 'archived' where id = 'a1000000-0000-4000-a000-000000000003' $$,
  'the trainer archives the rubric');
select is(pg_temp.err($$ insert into public.tasks (course_id, title, rubric_version_id)
                         values (tests.uid('course'), 'x', 'a2000000-0000-4000-a000-000000000003') $$),
  'SE010', 'a new task cannot use the archived rubric');
select lives_ok($$ update public.tasks set title = 'ส่งแผนการสอน (แก้ชื่อ)', max_attempts = 2
                    where id = 'b1000000-0000-4000-a000-000000000001' $$,
  'the task that already uses it can still be edited (it keeps its rubric)');
select lives_ok($$ update public.tasks set rubric_version_id = null where id = 'b1000000-0000-4000-a000-000000000001' $$,
  'the rubric can be taken off a task');
select is(pg_temp.err($$ update public.tasks set rubric_version_id = 'a2000000-0000-4000-a000-000000000003'
                         where id = 'b1000000-0000-4000-a000-000000000001' $$),
  'SE010', '… but not put back while it is archived');
reset role;

-- someone who may not use the rubric learns nothing about it: the permission error comes first
select tests.authenticate_as('mentor');
select is(pg_temp.err($$ insert into public.tasks (course_id, title, rubric_version_id)
                         values (tests.uid('course'), 'x', 'a2000000-0000-4000-a000-000000000003') $$),
  '42501', 'a mentor gets "not allowed", not "archived"');
reset role;

select * from finish();
rollback;

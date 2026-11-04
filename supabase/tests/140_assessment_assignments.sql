-- Assigning tests to a cohort and reading results: who may assign, publish,
-- edit and delete; settings frozen once attempts exist; who sees whose results.
begin;
select plan(34);

create temporary table ids (k text primary key, v uuid);
grant select, insert on ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select v from ids where k = p $$;

-- ---------- privileges ----------
select ok(not has_function_privilege('authenticated', 'private.assessment_assignments_lock()', 'execute'),
  'lock trigger function is not callable by clients');

-- ---------- who may assign ----------
select tests.authenticate_as('trainer');
with r as (
  insert into public.assessment_assignments
    (instrument_version_id, cohort_id, course_id, purpose, title, attempt_limit, passing_percent)
  values (tests.uid('quiz_v1'), tests.uid('cohort'), tests.uid('course'), 'posttest', 'Posttest ทดสอบ', 1, 50)
  returning id)
insert into ids select 'a', id from r;
select isnt(pg_temp.id('a'), null, 'Cohort trainer creates an assignment (INSERT … RETURNING sees it)');
select is((select status from public.assessment_assignments where id = pg_temp.id('a')), 'draft',
  'New assignments start as draft');

insert into ids values ('draft_version', public.clone_instrument_version(tests.uid('quiz_v1')));
select throws_ok(format($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title)
                           values (%L, %L, 'formative', 'x') $$, pg_temp.id('draft_version'), tests.uid('cohort')),
  '23514', null, 'A draft version cannot be assigned');
select throws_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, course_id, purpose, title)
                    values (tests.uid('quiz_v1'), tests.uid('cohort'), tests.uid('draft_course'), 'formative', 'x') $$,
  '23514', null, 'Course must belong to the cohort''s program');
select throws_ok($$ update public.assessment_assignments set cohort_id = tests.uid('cohort') where id = pg_temp.id('a') $$,
  '42501', null, 'cohort_id is not updatable by clients');
reset role;

select tests.authenticate_as('mentor');
select throws_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title)
                    values (tests.uid('quiz_v1'), tests.uid('cohort'), 'formative', 'x') $$,
  '42501', null, 'Mentor cannot assign');
update public.assessment_assignments set title = 'แก้โดยครูพี่เลี้ยง' where id = tests.uid('pretest');
reset role;
select tests.authenticate_as('teacher_a1');
select throws_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title)
                    values (tests.uid('quiz_v1'), tests.uid('cohort'), 'formative', 'x') $$,
  '42501', null, 'Trainee cannot assign');
select is_empty(format('select 1 from public.assessment_assignments where id = %L', pg_temp.id('a')),
  'Trainee does not see a draft assignment');
update public.assessment_assignments set attempt_limit = 20 where id = tests.uid('pretest');
reset role;
select tests.authenticate_as('school_admin_b');
select throws_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title)
                    values (tests.uid('quiz_v1'), tests.uid('cohort'), 'formative', 'x') $$,
  '42501', null, 'Unrelated admin cannot assign');
select is_empty($$ select 1 from public.assessment_assignments $$, 'Unrelated admin sees no assignments');
reset role;
select is((select title || '/' || attempt_limit from public.assessment_assignments where id = tests.uid('pretest')),
  'แบบทดสอบก่อนเรียน AfL/1', 'Mentor and trainee updates affect no rows');

-- ---------- before any attempt: everything editable ----------
select tests.authenticate_as('trainer');
select lives_ok(format($$ update public.assessment_assignments
                            set passing_percent = 60, purpose = 'formative', status = 'published' where id = %L $$, pg_temp.id('a')),
  'Without attempts, passing %, purpose and status can change');
select lives_ok(format($$ update public.assessment_assignments set status = 'draft' where id = %L $$, pg_temp.id('a')),
  'Without attempts, a published assignment can go back to draft');
select lives_ok(format($$ update public.assessment_assignments set status = 'published', purpose = 'posttest' where id = %L $$, pg_temp.id('a')),
  'Publish again');
reset role;

select tests.authenticate_as('teacher_a1');
select isnt_empty(format('select 1 from public.assessment_assignments where id = %L', pg_temp.id('a')),
  'Trainee sees the published assignment');
insert into ids select 't_a1', attempt_id from public.start_attempt(pg_temp.id('a'));
select isnt(pg_temp.id('t_a1'), null, 'Trainee starts an attempt');
reset role;
select tests.authenticate_as('teacher_a2');
insert into ids select 't_a2', attempt_id from public.start_attempt(pg_temp.id('a'));
reset role;

-- ---------- after an attempt: evidence-bearing settings are frozen ----------
select tests.authenticate_as('trainer');
select throws_ok(format($$ update public.assessment_assignments set passing_percent = 40 where id = %L $$, pg_temp.id('a')),
  'SE004', null, 'passing_percent is frozen once an attempt exists');
select throws_ok(format($$ update public.assessment_assignments set purpose = 'formative' where id = %L $$, pg_temp.id('a')),
  'SE004', null, 'purpose is frozen once an attempt exists');
select throws_ok(format($$ update public.assessment_assignments set course_id = null where id = %L $$, pg_temp.id('a')),
  'SE004', null, 'course is frozen once an attempt exists');
select throws_ok(format($$ update public.assessment_assignments set status = 'draft' where id = %L $$, pg_temp.id('a')),
  'SE004', null, 'cannot return to draft once an attempt exists');
select lives_ok(format($$ update public.assessment_assignments
                            set close_at = now() + interval '1 day', attempt_limit = 2, title = 'Posttest (ขยายเวลา)',
                                passing_percent = passing_percent
                          where id = %L $$, pg_temp.id('a')),
  'Window, attempt limit and title stay editable (unchanged passing % is fine)');
select lives_ok(format($$ update public.assessment_assignments set status = 'archived' where id = %L $$, pg_temp.id('a')),
  'Archive is allowed');
select lives_ok(format($$ update public.assessment_assignments set status = 'published' where id = %L $$, pg_temp.id('a')),
  'Re-publish from archive is allowed');
delete from public.assessment_assignments where id = pg_temp.id('a');
reset role;
select isnt_empty(format('select 1 from public.assessment_assignments where id = %L', pg_temp.id('a')),
  'A published assignment is not deleted');
select ok(exists (select 1 from private.audit_logs
                   where table_name = 'public.assessment_assignments' and record_id = pg_temp.id('a')
                     and action = 'UPDATE' and actor_id = tests.uid('trainer')),
  'Assignment changes are audited with the actor');

select tests.authenticate_as('trainer');
with r as (
  insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title)
  values (tests.uid('quiz_v1'), tests.uid('cohort'), 'formative', 'ลบทิ้ง') returning id)
insert into ids select 'd', id from r;
delete from public.assessment_assignments where id = pg_temp.id('d');
select is_empty(format('select 1 from public.assessment_assignments where id = %L', pg_temp.id('d')),
  'An unused draft assignment can be deleted');
reset role;

-- ---------- results: who sees whose attempts ----------
select tests.authenticate_as('trainer');
select is((select count(*)::int from public.assessment_attempts where assignment_id = pg_temp.id('a')), 2,
  'Trainer sees every attempt of the cohort');
select is((select count(*)::int from public.cohort_memberships
            where cohort_id = tests.uid('cohort') and cohort_role = 'trainee' and status = 'active'), 3,
  'Trainer reads the trainee roster');
reset role;

select tests.authenticate_as('mentor');
select results_eq(format('select user_id from public.assessment_attempts where assignment_id = %L', pg_temp.id('a')),
  format('values (%L::uuid)', tests.uid('teacher_a1')), 'Mentor sees only the assigned trainee''s attempt');
select is((select count(*)::int from public.cohort_memberships
            where cohort_id = tests.uid('cohort') and user_id <> tests.uid('mentor')), 0,
  'Mentor cannot read the cohort roster');
select results_eq($$ select p.full_name from public.mentor_assignments ma
                      join public.profiles p on p.id = ma.trainee_id
                     where ma.mentor_id = tests.uid('mentor') and ma.ended_at is null $$,
  $$ values ('ครู ก1 (สมมติ)'::text) $$, 'Mentor''s roster is their mentees (names visible)');
reset role;

select tests.authenticate_as('teacher_a2');
select results_eq(format('select user_id from public.assessment_attempts where assignment_id = %L', pg_temp.id('a')),
  format('values (%L::uuid)', tests.uid('teacher_a2')), 'Trainee sees only their own attempt');
reset role;

select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.assessment_attempts $$, 'Unrelated admin sees no attempts');
reset role;

select * from finish();
rollback;

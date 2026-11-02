-- Enrollment integrity and lesson-progress ownership
begin;
select plan(15);

select tests.authenticate_as('teacher_a1');
select results_eq($$ select id from public.course_enrollments $$, $$ values (tests.uid('enr_a1')) $$,
  'Trainee sees only own enrollment');
select is_empty($$ select 1 from public.lesson_progress where enrollment_id = tests.uid('enr_a2') $$,
  'Trainee cannot read another trainee''s progress');
select lives_ok($$ insert into public.lesson_progress (enrollment_id, lesson_id, status, progress_percent)
                   values (tests.uid('enr_a1'), tests.uid('lesson2'), 'in_progress', 40) $$,
  'Trainee records progress on own enrollment');
select ok((select started_at is not null and completed_at is null from public.lesson_progress
            where enrollment_id = tests.uid('enr_a1') and lesson_id = tests.uid('lesson2')),
  'server stamps started_at');
select lives_ok($$ update public.lesson_progress set status = 'completed'
                    where enrollment_id = tests.uid('enr_a1') and lesson_id = tests.uid('lesson2') $$,
  'Trainee completes a lesson');
select results_eq($$ select progress_percent, completed_at is not null from public.lesson_progress
                      where enrollment_id = tests.uid('enr_a1') and lesson_id = tests.uid('lesson2') $$,
  $$ values (100.00::numeric(5,2), true) $$, 'completed ⇒ 100% and completed_at set by server');
select throws_ok($$ insert into public.lesson_progress (enrollment_id, lesson_id) values (tests.uid('enr_a2'), tests.uid('lesson2')) $$,
  '42501', null, 'Trainee cannot write progress into someone else''s enrollment');
select throws_ok($$ insert into public.lesson_progress (enrollment_id, lesson_id) values (tests.uid('enr_a1'), tests.uid('draft_lesson')) $$,
  '23514', null, 'Progress on a draft lesson is rejected');
select throws_ok($$ update public.lesson_progress set completed_at = '2000-01-01' where enrollment_id = tests.uid('enr_a1') $$,
  '42501', null, 'Client cannot forge completed_at');
select throws_ok($$ insert into public.course_enrollments (cohort_id, course_id, user_id)
                    values (tests.uid('cohort'), tests.uid('course'), tests.uid('teacher_a1')) $$,
  '42501', null, 'Trainee cannot enroll themselves');
reset role;

select tests.authenticate_as('mentor');
select ok(exists (select 1 from public.lesson_progress where enrollment_id = tests.uid('enr_a1')), 'Mentor sees assigned trainee progress');
select is_empty($$ select 1 from public.lesson_progress where enrollment_id = tests.uid('enr_a2') $$,
  'Mentor cannot see unassigned trainee progress');
reset role;

select tests.authenticate_as('trainer');
select is((select count(*)::int from public.course_enrollments), 3, 'Trainer sees all cohort enrollments');
reset role;

select tests.authenticate_as('district_admin');
select throws_ok($$ insert into public.course_enrollments (cohort_id, course_id, user_id)
                    values (tests.uid('cohort'), tests.uid('course'), tests.uid('mentor')) $$,
  '23514', null, 'Only active trainees of the cohort can be enrolled');
select throws_ok($$ insert into public.course_enrollments (cohort_id, course_id, user_id)
                    values (tests.uid('cohort'), tests.uid('draft_course'), tests.uid('teacher_a1')) $$,
  '23514', null, 'Course must belong to the cohort''s program');
reset role;

select * from finish();
rollback;

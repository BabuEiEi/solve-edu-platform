-- Program / cohort scope, cohort role grants, mentor assignment invariants
begin;
select plan(16);

-- ---------- visibility ----------
select tests.authenticate_as('teacher_a1');
select is((select count(*)::int from public.programs), 1, 'Trainee sees the program of own cohort');
select is((select count(*)::int from public.cohort_memberships), 1, 'Trainee sees only own cohort membership');
select is_empty($$ select 1 from public.mentor_assignments where trainee_id <> tests.uid('teacher_a1') $$,
  'Trainee sees only own mentor assignment');
select throws_ok($$ insert into public.programs (code, name, fiscal_year, owner_org_id)
                    values ('P2', 'x', 2570, tests.uid('district')) $$,
  '42501', null, 'Trainee cannot create programs');
select throws_ok($$ insert into public.cohort_memberships (cohort_id, user_id, cohort_role)
                    values (tests.uid('cohort'), tests.uid('teacher_a1'), 'trainer') $$,
  '42501', null, 'Trainee cannot promote self to trainer');
reset role;

select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.programs $$, 'Non-participant school admin sees no programs');
reset role;

select tests.authenticate_as('trainer');
select is((select count(*)::int from public.cohort_memberships where cohort_id = tests.uid('cohort')),
  5, 'Trainer sees all members of own cohort');
reset role;

-- ---------- mentor scope ----------
select tests.authenticate_as('mentor');
select ok(exists (select 1 from public.profiles where id = tests.uid('teacher_a1')), 'Mentor sees assigned trainee A1');
select is_empty($$ select 1 from public.profiles where id = tests.uid('teacher_a2') $$,
  'Mentor cannot see unassigned trainee A2');
select is_empty($$ select 1 from public.course_enrollments where user_id = tests.uid('teacher_a2') $$,
  'Mentor cannot see enrollment of unassigned trainee');
reset role;

-- ---------- supervisor manages program; coordinator limits ----------
select tests.authenticate_as('supervisor');
select lives_ok($$ insert into public.programs (code, name, fiscal_year, owner_org_id)
                   values ('PLC-2570', 'โครงการ PLC (ทดลอง)', 2570, tests.uid('district')) $$,
  'Supervisor creates a program in own district');
select lives_ok($$ insert into public.cohort_memberships (cohort_id, user_id, cohort_role)
                   values (tests.uid('cohort'), tests.uid('teacher_a2'), 'coordinator') $$,
  'Supervisor (program manager) appoints a coordinator');
select throws_ok($$ insert into public.mentor_assignments (cohort_id, mentor_id, trainee_id)
                    values (tests.uid('cohort'), tests.uid('teacher_b1'), tests.uid('teacher_a1')) $$,
  '23514', null, 'Mentor assignment requires an active mentor membership');
reset role;

select tests.authenticate_as('teacher_a2');  -- now coordinator
select throws_ok($$ insert into public.cohort_memberships (cohort_id, user_id, cohort_role)
                    values (tests.uid('cohort'), tests.uid('teacher_b1'), 'coordinator') $$,
  '42501', null, 'Coordinator cannot create another coordinator');
select lives_ok($$ insert into public.cohort_memberships (cohort_id, user_id, cohort_role)
                   values (tests.uid('cohort'), tests.uid('teacher_b1'), 'mentor') $$,
  'Coordinator can add a mentor');
select throws_ok($$ update public.cohorts set program_id = gen_random_uuid() where id = tests.uid('cohort') $$,
  '42501', null, 'cohort.program_id is immutable for clients');
reset role;

select * from finish();
rollback;

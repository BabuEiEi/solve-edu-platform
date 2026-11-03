-- INSERT ... RETURNING (supabase-js `.insert().select()`) must pass the SELECT
-- policy for the NEW row. Policies that re-look-up the row by id inside a
-- STABLE helper cannot see it yet, so they must decide from row columns.
begin;
select plan(10);

select tests.authenticate_as('supervisor');
select lives_ok($$ insert into public.courses (code, title, owner_org_id)
                   values ('RET-1', 'คืนค่า', tests.uid('district')) returning id $$,
  'Supervisor can create a course and read it back in the same statement');
select lives_ok($$ insert into public.course_units (course_id, title, display_order)
                   select id, 'หน่วย', 1 from public.courses where code = 'RET-1' returning id $$,
  '...a unit (draft) with RETURNING');
select lives_ok($$ insert into public.lessons (unit_id, title, display_order)
                   select u.id, 'บท', 1 from public.course_units u join public.courses c on c.id = u.course_id
                    where c.code = 'RET-1' returning id $$,
  '...a lesson (draft) with RETURNING');
select lives_ok($$ insert into public.programs (code, name, fiscal_year, owner_org_id)
                   values ('RET-P', 'โครงการ', 2570, tests.uid('district')) returning id $$,
  '...a program with RETURNING');
select lives_ok($$ insert into public.cohorts (program_id, code, name)
                   select id, 'R1', 'รุ่น' from public.programs where code = 'RET-P' returning id $$,
  '...a cohort with RETURNING');
reset role;

select tests.authenticate_as('trainer');
select lives_ok($$ insert into public.course_units (course_id, title, display_order)
                   values (tests.uid('course'), 'หน่วยใหม่', 9) returning id $$,
  'Trainer adds a unit to an assigned course with RETURNING');
reset role;

-- The rewritten policies must not widen visibility
select tests.authenticate_as('teacher_a1');
select is_empty($$ select 1 from public.courses where code = 'RET-1' $$,
  'Trainee still cannot see the new draft course');
select is_empty($$ select 1 from public.course_units where course_id = tests.uid('course') and title = 'หน่วยใหม่' $$,
  'Trainee cannot see the new draft unit');
select is_empty($$ select 1 from public.programs where code = 'RET-P' $$,
  'Trainee cannot see an unrelated program');
reset role;
select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.courses where code = 'RET-1' $$,
  'Unrelated school admin cannot see the new course');
reset role;

select * from finish();
rollback;

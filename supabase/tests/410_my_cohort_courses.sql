-- Phase 4g step 5: my_cohort_courses (own cohorts, own enrollments, nobody
-- else's) and self-enrollment only while the cohort is running.
begin;
select plan(20);

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $$;
grant execute on function pg_temp.err(text) to authenticated, anon;

-- fixtures (as postgres): a cohort CLOSED to joining that a manager filled, with a second
-- published course and a draft one in the programme
insert into public.cohorts (id, program_id, code, name, status, enrollment_mode) values
  ('30000000-0000-4000-a000-0000000000d1', tests.uid('program'), 'D1', 'รุ่นที่ผู้จัดการเพิ่มคน (ทดสอบ)', 'in_progress', 'closed');
insert into public.courses (id, code, title, status, owner_org_id) values
  ('40000000-0000-4000-a000-0000000000d2', 'AFL-D2', 'หลักสูตรที่สอง (ทดสอบ)', 'published', tests.uid('district'));
insert into public.program_courses (program_id, course_id, display_order) values
  (tests.uid('program'), '40000000-0000-4000-a000-0000000000d2', 2),
  (tests.uid('program'), tests.uid('draft_course'), 3);
insert into public.cohort_memberships (cohort_id, user_id, cohort_role, status) values
  ('30000000-0000-4000-a000-0000000000d1', tests.uid('teacher_b1'), 'trainee', 'active'),
  ('30000000-0000-4000-a000-0000000000d1', tests.uid('teacher_a2'), 'trainee', 'requested');
\set d1 '\'30000000-0000-4000-a000-0000000000d1\''
\set k2 '\'40000000-0000-4000-a000-0000000000d2\''

-- ---------- the function ----------
select is((select proconfig from pg_proc where oid = 'public.my_cohort_courses()'::regprocedure), array['search_path=""'],
  'my_cohort_courses pins an empty search_path');
select ok(not has_function_privilege('anon', 'public.my_cohort_courses()', 'execute'), 'anon cannot call it');
select tests.as_anon();
select is(pg_temp.err('select public.my_cohort_courses()'), '42501', '… and is refused if it tries');
reset role;

-- ---------- a member of a cohort closed to joining sees it and its courses ----------
select tests.authenticate_as('teacher_b1');
select is_empty(format('select 1 from public.courses where id = %L', :k2),
  'the trainee cannot read the course row itself (not enrolled) …');
select ok(public.my_cohort_courses() @> jsonb_build_array(jsonb_build_object('cohort_id', :d1)),
  '… but my_cohort_courses lists the cohort they were added to (closed to joining)');
select is((select jsonb_agg(x ->> 'title' order by x ->> 'title')
             from jsonb_array_elements((select c -> 'courses' from jsonb_array_elements(public.my_cohort_courses()) c
                                         where c ->> 'cohort_id' = :d1)) x),
  '["การประเมินเพื่อพัฒนาการเรียนรู้ (Assessment for Learning) — ทดลอง", "หลักสูตรที่สอง (ทดสอบ)"]'::jsonb,
  '… with the programme''s published courses (no draft)');
select is((select c ->> 'can_enroll' from jsonb_array_elements(public.my_cohort_courses()) c where c ->> 'cohort_id' = :d1), 'true',
  '… and says they may enroll (the cohort is running)');
select ok(public.my_cohort_courses() @> jsonb_build_array(jsonb_build_object('cohort_id', tests.uid('cohort'))),
  'their demo cohort is listed too');
select is((select x ->> 'enrollment_status'
             from jsonb_array_elements(public.my_cohort_courses()) c, jsonb_array_elements(c -> 'courses') x
            where c ->> 'cohort_id' = tests.uid('cohort')::text and x ->> 'id' = tests.uid('course')::text), 'active',
  'their own enrollment is shown');
select ok(public.my_cohort_courses()::text not like '%teacher.a2%' and public.my_cohort_courses()::text not like '%ครู ก2%',
  'nothing about the other members (the person waiting in the same cohort is not mentioned)');
select isnt(public.enroll_in_course(:d1, :k2), null, 'they enroll themself in a course of the cohort closed to joining');
reset role;

-- ---------- a waiting request sees nothing and cannot promote itself ----------
select tests.authenticate_as('teacher_a2');
select ok(not (public.my_cohort_courses() @> jsonb_build_array(jsonb_build_object('cohort_id', :d1))),
  'a person still waiting does not get the cohort');
select is(pg_temp.err(format($$ update public.cohort_memberships set status = 'active'
                                where cohort_id = %L and user_id = auth.uid() returning id $$, :d1)), 'no error',
  '(an UPDATE of their own request runs …)');
reset role;
select is((select status from public.cohort_memberships where cohort_id = :d1 and user_id = tests.uid('teacher_a2')), 'requested',
  '… but RLS changes nothing: they cannot accept themself');

-- ---------- self-enrollment only while the cohort is running ----------
update public.cohorts set status = 'closed' where id = :d1;
select tests.authenticate_as('teacher_b1');
select is((select c ->> 'can_enroll' from jsonb_array_elements(public.my_cohort_courses()) c where c ->> 'cohort_id' = :d1), 'false',
  'an ended cohort says it cannot be enrolled in');
select is(pg_temp.err(format('select public.enroll_in_course(%L, %L)', :d1, tests.uid('course'))), 'SE014',
  '… and the server refuses a self-enrollment (SE014)');
reset role;
select tests.authenticate_as('staff');
select isnt(public.enroll_in_course(:d1, tests.uid('course'), tests.uid('teacher_b1')), null,
  'Staff still enrolls them in an ended cohort (catching up)');
reset role;
update public.cohorts set status = 'archived' where id = :d1;
select tests.authenticate_as('teacher_b1');
select ok(not (public.my_cohort_courses() @> jsonb_build_array(jsonb_build_object('cohort_id', :d1))),
  'an archived cohort is no longer listed');
reset role;

-- ---------- enrolling twice gives the same enrollment ----------
select tests.authenticate_as('teacher_a1');
select is(public.enroll_in_course(tests.uid('cohort'), tests.uid('course')), tests.uid('enr_a1'),
  'enrolling again in a course one is already in returns the existing enrollment (no duplicate, no error)');
reset role;
select is((select count(*)::int from public.course_enrollments where cohort_id = tests.uid('cohort') and user_id = tests.uid('teacher_a1')
            and course_id = tests.uid('course')), 1, '… still one row');

select * from finish();
rollback;

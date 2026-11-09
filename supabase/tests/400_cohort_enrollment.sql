-- Phase 4g step 1: joining cohorts (closed / approval / open, seats, window),
-- per-course enrollment by the person or the cohort's managers, and Staff
-- managing programmes and cohorts without becoming an assessor.
begin;
select plan(47);

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
create or replace function pg_temp.trainee_status(p_cohort uuid, p_user uuid) returns text language sql as $$
  select status from public.cohort_memberships where cohort_id = p_cohort and user_id = p_user and cohort_role = 'trainee' $$;

-- fixtures (as postgres): a second cohort of the demo programme, a second published course in it,
-- two newcomers who are active accounts without any cohort
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000a1', 'joiner.one@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000a2', 'joiner.two@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000a3', 'joiner.three@example.test', now(), '{}');
update public.profiles set status = 'active'
 where id in ('99999999-0000-4000-a000-0000000000a1', '99999999-0000-4000-a000-0000000000a2', '99999999-0000-4000-a000-0000000000a3');
insert into public.cohorts (id, program_id, code, name, status) values
  ('30000000-0000-4000-a000-0000000000c2', tests.uid('program'), 'C2', 'รุ่นที่ 2 (ทดสอบ)', 'open');
insert into public.courses (id, code, title, status, owner_org_id) values
  ('40000000-0000-4000-a000-0000000000c2', 'AFL-102', 'หลักสูตรที่สอง (ทดสอบ)', 'published', tests.uid('district'));
insert into public.program_courses (program_id, course_id, display_order) values
  (tests.uid('program'), '40000000-0000-4000-a000-0000000000c2', 2),
  (tests.uid('program'), tests.uid('draft_course'), 3);
\set c2 '\'30000000-0000-4000-a000-0000000000c2\''

-- ---------- the functions themselves ----------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname, p.proname) in (('public','list_open_cohorts'), ('public','request_cohort_join'), ('public','cancel_cohort_request'),
                                             ('public','decide_cohort_request'), ('public','enroll_in_course'),
                                             ('private','cohort_open_for_joining'), ('private','cohort_seats_left'))
              and p.prosecdef and p.proconfig = array['search_path=""']), 7,
  'the seven SECURITY DEFINER functions pin an empty search_path');
select ok(not has_function_privilege('anon', 'public.request_cohort_join(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.list_open_cohorts()', 'execute')
      and not has_function_privilege('anon', 'public.enroll_in_course(uuid,uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.decide_cohort_request(uuid,boolean)', 'execute'),
  'anon can call none of them');
select ok(not has_function_privilege('authenticated', 'private.cohort_open_for_joining(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'private.cohort_seats_left(uuid)', 'execute'),
  'the private helpers are not callable');

-- ---------- closed by default ----------
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a1');
select is(public.list_open_cohorts(), '[]'::jsonb, 'a new cohort is closed: nothing is listed');
select is(pg_temp.err(format('select public.request_cohort_join(%L)', :c2)), 'SE012', '… and nobody can join it');
reset role;

-- ---------- approval mode ----------
select tests.authenticate_as('trainer'); -- not a programme manager: cannot open a cohort
select is(pg_temp.err(format($$ update public.cohorts set enrollment_mode = 'approval' where id = %L returning id $$, :c2)) , 'no error',
  '(the update runs but RLS keeps the row out of reach of a trainer of another cohort)');
reset role;
select is((select enrollment_mode from public.cohorts where id = :c2), 'closed', '… so it stays closed');
select tests.authenticate_as('staff');
select lives_ok(format($$ update public.cohorts set enrollment_mode = 'approval', seat_limit = 2 where id = %L $$, :c2),
  'Staff opens cohort 2 for requests, 2 seats');
reset role;
select is((select enrollment_mode || '/' || seat_limit from public.cohorts where id = :c2), 'approval/2', '… stored');

select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a1');
select is(jsonb_array_length(public.list_open_cohorts()), 1, 'an ordinary account now sees one open cohort');
select is(public.list_open_cohorts() -> 0 ->> 'program_name', 'โครงการพัฒนาสมรรถนะการวัดและประเมินผลในชั้นเรียน (ทดลอง)',
  '… with its programme (which the person could not read from the table itself)');
select is(jsonb_array_length(public.list_open_cohorts() -> 0 -> 'courses'), 2, '… and its two PUBLISHED courses (the draft is hidden)');
select ok(not (public.list_open_cohorts()::text like '%teacher.a1%' or public.list_open_cohorts()::text like '%ครู ก1%'),
  '… and nobody else''s name or e-mail');
select is(public.request_cohort_join(:c2), 'requested', 'joining an approval cohort makes a request');
select is(public.request_cohort_join(:c2), 'requested', '… pressing again changes nothing');
select is(public.list_open_cohorts() -> 0 ->> 'my_status', 'requested', '… and the list says so');
select is(pg_temp.err(format('select public.enroll_in_course(%L, %L)', :c2, tests.uid('course'))), 'SE013',
  'a person still waiting cannot enroll in a course');
select is_empty(format('select 1 from public.cohorts c where c.id = %L and authz.can_view_cohort(c.id)', :c2),
  'a waiting request gives no right to the cohort');
reset role;

-- the request's real id (read as postgres): the callers below must be refused for who they are,
-- not because RLS hid the row from them
select id as req_a1 from public.cohort_memberships
 where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a1' and cohort_role = 'trainee' \gset
select tests.authenticate_as('teacher_a2'); -- a trainee of cohort 1, not a manager of cohort 2
select is(pg_temp.err(format('select public.decide_cohort_request(%L, true)', :'req_a1')), '42501',
  'a trainee cannot accept requests, even knowing the request id');
reset role;
select tests.authenticate_as('trainer'); -- trainer of cohort 1 only
select is(pg_temp.err(format('select public.decide_cohort_request(%L, true)', :'req_a1')), '42501',
  '… nor a trainer of another cohort');
reset role;

select tests.authenticate_as('district_admin'); -- manages the programme
select is(public.decide_cohort_request((select id from public.cohort_memberships where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a1'), true),
  'active', 'the programme manager accepts the request');
reset role;
select is((select approved_by from public.cohort_memberships where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a1' and cohort_role = 'trainee'),
  tests.uid('district_admin'), '… approved_by is the manager');

-- ---------- seats ----------
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a2');
select is(public.request_cohort_join(:c2), 'requested', 'a second person asks');
reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a3');
select is(public.request_cohort_join(:c2), 'requested', 'a third person asks');
reset role;
select tests.authenticate_as('staff');
select is(public.decide_cohort_request((select id from public.cohort_memberships where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a2'), true),
  'active', 'Staff accepts the second: 2 of 2 seats taken');
select is(pg_temp.err(format($$ select public.decide_cohort_request((select id from public.cohort_memberships where cohort_id = %L and user_id = %L), true) $$,
                             :c2, '99999999-0000-4000-a000-0000000000a3')), 'SE011', 'the third cannot be accepted: the cohort is full');
select is(public.decide_cohort_request((select id from public.cohort_memberships where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a3'), false),
  'withdrawn', '… but can be declined');
reset role;

-- ---------- open mode: join at once; someone removed must ask again ----------
update public.cohorts set enrollment_mode = 'open', seat_limit = null where id = :c2;
update public.cohort_memberships set status = 'withdrawn'
 where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a2' and cohort_role = 'trainee';
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a2');
select is(public.request_cohort_join(:c2), 'requested', 'removed from an OPEN cohort: may only ask again, not rejoin by themself');
select lives_ok(format('select public.cancel_cohort_request(%L)', :c2), '… and may take the request back');
reset role;
select is(pg_temp.trainee_status(:c2, '99999999-0000-4000-a000-0000000000a2'), 'withdrawn', '… withdrawn again');
select tests.authenticate_as('teacher_b1'); -- active trainee of cohort 1 only
select is(public.request_cohort_join(:c2), 'active', 'an open cohort with free seats: joined at once');
reset role;

-- ---------- the window and the programme ----------
update public.cohorts set enroll_until = now() - interval '1 minute' where id = :c2;
select tests.authenticate_as('teacher_a2');
select is(pg_temp.err(format('select public.request_cohort_join(%L)', :c2)), 'SE012', 'after the enrollment window: refused');
reset role;
update public.cohorts set enroll_until = null where id = :c2;
update public.programs set status = 'closed' where id = tests.uid('program');
select tests.authenticate_as('teacher_a2');
select is(public.list_open_cohorts(), '[]'::jsonb, 'a closed programme lists nothing');
reset role;
update public.programs set status = 'active' where id = tests.uid('program');

-- ---------- enrolling in a course ----------
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a1');
select isnt(public.enroll_in_course(:c2, '40000000-0000-4000-a000-0000000000c2'), null,
  'an accepted trainee enrolls themself in one course of the programme');
select is(pg_temp.err(format('select public.enroll_in_course(%L, %L)', :c2, tests.uid('draft_course'))), 'SE013',
  '… not in a draft course');
select is(pg_temp.err(format('select public.enroll_in_course(%L, %L, %L)', :c2, '40000000-0000-4000-a000-0000000000c2', tests.uid('teacher_b1'))), '42501',
  '… and never for someone else');
select is((select count(*)::int from public.course_enrollments where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a1'), 1,
  'one course, not all of them (per-course enrollment)');
reset role;
select is((select enrolled_by from public.course_enrollments where cohort_id = :c2 and user_id = '99999999-0000-4000-a000-0000000000a1'),
  '99999999-0000-4000-a000-0000000000a1'::uuid, 'enrolled_by records who enrolled');

select tests.authenticate_as('staff');
select isnt(public.enroll_in_course(:c2, tests.uid('course'), tests.uid('teacher_b1')), null, 'Staff enrolls a trainee of the cohort');
select is(pg_temp.err(format('select public.enroll_in_course(%L, %L, %L)', :c2, tests.uid('course'), tests.uid('teacher_a2'))), 'SE013',
  '… but not someone who is not a trainee of that cohort');
reset role;
update public.course_enrollments set status = 'withdrawn' where cohort_id = :c2 and user_id = tests.uid('teacher_b1');
select tests.authenticate_as('teacher_b1');
select is(public.enroll_in_course(:c2, tests.uid('course')),
  (select id from public.course_enrollments where cohort_id = :c2 and user_id = tests.uid('teacher_b1')),
  'enrolling again after withdrawing reuses the same enrollment (history and progress kept)');
reset role;
select is((select status from public.course_enrollments where cohort_id = :c2 and user_id = tests.uid('teacher_b1')), 'active', '… active again');

-- ---------- Staff manages programmes but is not an assessor ----------
select tests.authenticate_as('staff');
select lives_ok($$ insert into public.programs (code, name, fiscal_year, owner_org_id) values ('STAFF-P', 'โครงการโดย Staff', 2570, tests.uid('district')) $$,
  'Staff creates a programme');
select ok(exists (select 1 from public.courses where id = tests.uid('course')), 'Staff sees published courses (to put in a programme)');
select is_empty($$ select 1 from public.courses where id = tests.uid('draft_course') $$, '… but not drafts');
select ok(not authz.is_cohort_assessor(tests.uid('cohort')), 'Staff is NOT an assessor of the cohorts it manages (no results, no reviews)');
select is(pg_temp.err($$ insert into public.cohort_memberships (cohort_id, user_id, cohort_role) values (tests.uid('cohort'), tests.uid('staff'), 'trainer') $$),
  '42501', 'Staff cannot add itself to a cohort');
reset role;

select * from finish();
rollback;

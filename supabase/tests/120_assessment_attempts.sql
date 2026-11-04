-- Taking a test: eligibility, window, attempt limit, server-side scoring,
-- malformed input, release policy (total only), audit
begin;
select plan(46);

-- Responses that answer every demo item correctly
create temporary table all_right (body jsonb);
insert into all_right values (jsonb_build_object(
  tests.uid('q_single')::text,    '{"choice":"b"}'::jsonb,
  tests.uid('q_multiple')::text,  '{"choices":["d","a","b"]}'::jsonb,
  tests.uid('q_truefalse')::text, '{"value":true}'::jsonb,
  tests.uid('q_numeric')::text,   '{"value":75}'::jsonb));
grant select on all_right to authenticated;

-- ---------- privileges ----------
select ok(not has_function_privilege('anon', 'public.start_attempt(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.submit_attempt(uuid,jsonb,bigint)', 'execute'),
  'anon cannot execute start/submit');
select ok(not has_function_privilege('authenticated', 'private.score_response(text,jsonb,jsonb,jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'private.response_error(text,jsonb,jsonb)', 'execute'),
  'scoring helpers are not executable by clients');
select is((select count(*)::int from information_schema.parameters p
            join information_schema.routines r on r.specific_name = p.specific_name
           where r.routine_schema = 'public' and r.routine_name in ('start_attempt', 'submit_attempt')
             and p.parameter_mode = 'IN' and p.parameter_name in ('p_score', 'p_started_at', 'p_submitted_at', 'p_passed')),
  0, 'clients cannot pass score or timestamps');

-- ---------- scorer (pure functions, as postgres) ----------
select is(private.score_response('mcq_multiple', '{"correct":["a","b","d"]}', '{"mode":"partial"}', '{"choices":["a","b","c"]}'),
  (1::numeric / 3), 'partial: 2 right - 1 wrong over 3 correct = 1/3');
select is(private.score_response('mcq_multiple', '{"correct":["a"]}', '{"mode":"partial"}', '{"choices":["a","b","c"]}'),
  0::numeric, 'partial credit never goes below zero (no tick-everything strategy)');
select is(private.score_response('mcq_multiple', '{"correct":["a","b"]}', '{}', '{"choices":["a"]}'),
  0::numeric, 'all-or-nothing is the default');
select is(private.score_response('numeric', '{"value":75,"tolerance":0.5}', '{}', '{"value":75.5}'),
  1::numeric, 'numeric tolerance is inclusive');
select is(private.score_response('numeric', '{"value":75}', '{}', '{"value":75.01}'),
  0::numeric, 'numeric without tolerance is exact');
select is(private.score_response('true_false', '{"correct":false}', '{}', '{"value":false}'),
  1::numeric, 'true_false compares booleans');

-- ---------- outsiders ----------
select tests.authenticate_as('mentor');
select throws_ok($$ select * from public.start_attempt(tests.uid('pretest')) $$, '42501', null,
  'Mentor (not a trainee of the cohort) cannot start');
reset role;
select tests.authenticate_as('school_admin_b');
select throws_ok($$ select * from public.start_attempt(tests.uid('pretest')) $$, '42501', null,
  'Unrelated admin cannot start');
select throws_ok($$ select * from public.start_attempt('00000000-0000-4000-a000-0000000000ff') $$, '42501', null,
  'Unknown assignment is "not allowed" (existence not revealed)');
reset role;

-- ---------- trainee A: start, resume, all correct ----------
select tests.authenticate_as('teacher_a1');
select is_empty($$ select 1 from public.instrument_items where instrument_version_id = tests.uid('quiz_v1') $$,
  'Items are hidden before starting');
select results_eq($$ select attempt_no, started_at = now(), resumed from public.start_attempt(tests.uid('pretest')) $$,
  $$ values (1, true, false) $$, 'First start creates attempt 1 with a server timestamp');
select results_eq($$ select attempt_no, resumed from public.start_attempt(tests.uid('pretest')) $$,
  $$ values (1, true) $$, 'Starting again resumes the open attempt (no second attempt)');
select is((select count(*)::int from public.instrument_items where instrument_version_id = tests.uid('quiz_v1')),
  4, 'Items become visible once started');
select results_eq($$ select score, max_score, percent, passed, correct_count, item_count
                     from public.submit_attempt(
                       (select id from public.assessment_attempts where assignment_id = tests.uid('pretest')),
                       (select body from all_right)) $$,
  $$ values (5.00::numeric, 5.00::numeric, 100.00::numeric, true, 4, 4) $$,
  'All-correct submission scores 5/5 and passes (choice order does not matter)');
select is((select count(*)::int from information_schema.parameters p
            join information_schema.routines r on r.specific_name = p.specific_name
           where r.routine_name = 'submit_attempt' and p.parameter_mode = 'OUT'
             and p.parameter_name not in ('attempt_id', 'score', 'max_score', 'percent', 'passed',
                                          'correct_count', 'item_count', 'submitted_at', 'auto_submitted')),
  0, 'submit returns totals only (no per-item correctness, no key)');
select throws_ok($$ select * from public.submit_attempt(
                     (select id from public.assessment_attempts where assignment_id = tests.uid('pretest')),
                     (select body from all_right)) $$,
  'SE003', null, 'Submitting the same attempt twice is refused');
select throws_ok($$ select * from public.start_attempt(tests.uid('pretest')) $$, 'SE002', null,
  'Attempt limit (1) reached');
select results_eq($$ select status, score, passed from public.assessment_attempts where assignment_id = tests.uid('pretest') $$,
  $$ values ('submitted'::text, 5.00::numeric, true) $$, 'Stored attempt matches the result');
reset role;

select is((select sum(awarded_score) from public.assessment_responses r
             join public.assessment_attempts t on t.id = r.attempt_id
            where t.user_id = tests.uid('teacher_a1')),
  5.00::numeric, 'Per-item scores are stored server-side and add up');
select ok(exists (select 1 from private.audit_logs
                   where table_name = 'public.assessment_attempts' and action = 'UPDATE'
                     and actor_id = tests.uid('teacher_a1') and after_json ->> 'status' = 'submitted'),
  'Submission is audited with the actor');

-- ---------- trainee B: partial / unanswered / wrong ----------
select tests.authenticate_as('teacher_a2');
select throws_ok($$ select * from public.submit_attempt(
                     (select id from public.assessment_attempts limit 1), (select body from all_right)) $$,
  '42501', null, 'Trainee cannot submit before starting');
select lives_ok($$ select * from public.start_attempt(tests.uid('pretest')) $$, 'Trainee B starts');
select results_eq($$ select score, max_score, percent, passed, correct_count
                     from public.submit_attempt(
                       (select id from public.assessment_attempts where assignment_id = tests.uid('pretest')),
                       jsonb_build_object(
                         tests.uid('q_single')::text,   '{"choice":"b"}'::jsonb,
                         tests.uid('q_multiple')::text, '{"choices":["a","b"]}'::jsonb,
                         tests.uid('q_numeric')::text,  '{"value":75.4}'::jsonb)) $$,
  $$ values (1.00::numeric, 5.00::numeric, 20.00::numeric, false, 1) $$,
  'Missing / incomplete / inexact answers score 0; 20% fails the 60% threshold');
select is((select response_json from public.assessment_responses where item_id = tests.uid('q_truefalse')),
  'null'::jsonb, 'An unanswered item is stored as JSON null');
reset role;

select tests.authenticate_as('teacher_a1');
select throws_ok($$ select * from public.submit_attempt(
                     (select id from public.assessment_attempts where user_id = tests.uid('teacher_a1')),
                     (select body from all_right)) $$,
  'SE003', null, 'Trainee A cannot resubmit');
reset role;
-- trainee A tries B's attempt id (taken as postgres, as if leaked)
create temporary table b_attempt as
  select id from public.assessment_attempts where user_id = tests.uid('teacher_a2');
grant select on b_attempt to authenticated;
select tests.authenticate_as('teacher_a1');
select throws_ok($$ select * from public.submit_attempt((select id from b_attempt), (select body from all_right)) $$,
  '42501', null, 'Trainee cannot submit someone else''s attempt');
reset role;

-- ---------- malformed input (formative, 3 attempts) ----------
select tests.authenticate_as('teacher_b1');
select lives_ok($$ select * from public.start_attempt(tests.uid('formative')) $$, 'Trainee C starts the formative quiz');
reset role;
create temporary table c_attempt as
  select id from public.assessment_attempts where user_id = tests.uid('teacher_b1') and assignment_id = tests.uid('formative');
grant select on c_attempt to authenticated;

select tests.authenticate_as('teacher_b1');
select throws_ok($$ select * from public.submit_attempt((select id from c_attempt),
                     jsonb_build_object(tests.uid('q_single')::text, '{"choice":"z"}'::jsonb)) $$,
  '22023', null, 'Choice id that does not exist is rejected');
select throws_ok($$ select * from public.submit_attempt((select id from c_attempt),
                     jsonb_build_object(tests.uid('q_single')::text, '{"choice":"b","score":1}'::jsonb)) $$,
  '22023', null, 'Extra fields in a response are rejected');
select throws_ok($$ select * from public.submit_attempt((select id from c_attempt),
                     jsonb_build_object(tests.uid('q_multiple')::text, '{"choices":["a","a"]}'::jsonb)) $$,
  '22023', null, 'Duplicate choices are rejected (no double counting)');
select throws_ok($$ select * from public.submit_attempt((select id from c_attempt),
                     jsonb_build_object(tests.uid('q_numeric')::text, '{"value":"75"}'::jsonb)) $$,
  '22023', null, 'Numeric answer must be a JSON number');
select throws_ok($$ select * from public.submit_attempt((select id from c_attempt),
                     jsonb_build_object(tests.uid('lesson1')::text, '{"value":true}'::jsonb)) $$,
  '22023', null, 'Responses for items outside the test are rejected');
select throws_ok($$ select * from public.submit_attempt((select id from c_attempt), '[1,2]'::jsonb) $$,
  '22023', null, 'Non-object payload is rejected');
select is((select status from public.assessment_attempts where id = (select id from c_attempt)),
  'in_progress', 'Rejected submissions leave the attempt open and unscored');
reset role;

-- ---------- time window ----------
-- past close_at + grace (5 min): the late payload is ignored, saved answers (none) are scored (see 150)
update public.assessment_assignments set close_at = now() - interval '10 minutes', open_at = null
 where id = tests.uid('formative');
select tests.authenticate_as('teacher_b1');
select results_eq($$ select score, auto_submitted from public.submit_attempt((select id from c_attempt), (select body from all_right)) $$,
  $$ values (0.00::numeric, true) $$, 'Submitting after close_at + grace scores the saved answers, not the late payload');
reset role;
select tests.authenticate_as('teacher_a2');
select throws_ok($$ select * from public.start_attempt(tests.uid('formative')) $$, 'SE001', null,
  'Starting after close_at is refused');
reset role;
update public.assessment_assignments set open_at = now() + interval '1 day', close_at = now() + interval '2 days'
 where id = tests.uid('formative');
select tests.authenticate_as('teacher_a2');
select throws_ok($$ select * from public.start_attempt(tests.uid('formative')) $$, 'SE001', null,
  'Starting before open_at is refused');
reset role;
update public.assessment_assignments set open_at = null where id = tests.uid('formative');

-- ---------- eligibility changes ----------
update public.assessment_assignments set status = 'archived' where id = tests.uid('formative');
select tests.authenticate_as('teacher_a2');
select throws_ok($$ select * from public.start_attempt(tests.uid('formative')) $$, '42501', null,
  'Archived assignment cannot be started');
reset role;
update public.assessment_assignments set status = 'published' where id = tests.uid('formative');

update public.cohort_memberships set status = 'withdrawn'
 where cohort_id = tests.uid('cohort') and user_id = tests.uid('teacher_b1') and cohort_role = 'trainee';
select tests.authenticate_as('teacher_b1');
select throws_ok($$ select * from public.submit_attempt((select id from c_attempt), (select body from all_right)) $$,
  '42501', null, 'Withdrawn trainee cannot submit');
select throws_ok($$ select * from public.start_attempt(tests.uid('formative')) $$, '42501', null,
  'Withdrawn trainee cannot start');
reset role;

-- ---------- multi-attempt quiz ----------
select tests.authenticate_as('teacher_a2');
select results_eq($$ select attempt_no from public.start_attempt(tests.uid('formative')) $$,
  $$ values (1) $$, 'Formative attempt 1');
select lives_ok($$ select * from public.submit_attempt(
                     (select id from public.assessment_attempts where assignment_id = tests.uid('formative') and status = 'in_progress'),
                     '{}'::jsonb) $$, 'An empty submission is allowed and scores 0');
select results_eq($$ select attempt_no from public.start_attempt(tests.uid('formative')) $$,
  $$ values (2) $$, 'Formative attempt 2 after submitting attempt 1');
reset role;

select * from finish();
rollback;

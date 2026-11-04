-- Time limits, grace, server-saved answers, auto-finalise, extra attempts.
-- now() is fixed inside a transaction, so "time passing" is simulated by
-- moving started_at / close_at back as postgres.
begin;
select plan(52);

create temporary table ids (k text primary key, v uuid);
grant select, insert on ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select v from ids where k = p $$;

create temporary table r (k text primary key, body jsonb);
insert into r values
  ('all_right', jsonb_build_object(
     tests.uid('q_single')::text,    '{"choice":"b"}'::jsonb,
     tests.uid('q_multiple')::text,  '{"choices":["a","b","d"]}'::jsonb,
     tests.uid('q_truefalse')::text, '{"value":true}'::jsonb,
     tests.uid('q_numeric')::text,   '{"value":75}'::jsonb)),
  ('one_right', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"b"}'::jsonb,
                                   tests.uid('q_truefalse')::text, 'null'::jsonb)),
  ('unknown_item', '{"00000000-0000-4000-a000-0000000000ff":{"value":1}}'),
  ('bad_shape', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"z"}'::jsonb));
grant select on r to authenticated;
create or replace function pg_temp.body(p text) returns jsonb language sql stable as $$ select body from r where k = p $$;

-- ---------- privileges / pure helpers ----------
select ok(not has_function_privilege('anon', 'public.save_attempt_draft(uuid,jsonb)', 'execute'),
  'anon cannot save drafts');
select ok(not has_function_privilege('authenticated', 'private.finalize_expired_attempts()', 'execute')
      and not has_function_privilege('authenticated', 'private.finalize_attempt(uuid,jsonb,boolean)', 'execute'),
  'finalisers are not callable by clients');
select is(private.attempt_deadline(now(), 30, now() + interval '10 minutes'), now() + interval '10 minutes',
  'Deadline is the earlier of time limit and close_at');
select is(private.attempt_deadline(now(), 30, null), now() + interval '30 minutes', 'Time limit alone');
select is(private.attempt_deadline(now(), null, null), null, 'No limit and no close_at: no deadline');
select is(private.attempt_cutoff(now(), 30, null, 5), now() + interval '35 minutes', 'Cutoff adds the grace period');
select ok(exists (select 1 from cron.job where jobname = 'finalize-expired-attempts' and schedule = '* * * * *'),
  'pg_cron finalises expired attempts every minute');

-- ---------- settings ----------
select tests.authenticate_as('trainer');
select lives_ok($$ update public.assessment_assignments set time_limit_minutes = 30 where id = tests.uid('formative') $$,
  'Trainer sets a 30-minute limit before anyone starts');
select is((select grace_minutes from public.assessment_assignments where id = tests.uid('formative')), 5,
  'Grace defaults to 5 minutes');
reset role;

-- ---------- start returns deadline, server clock, saved answers ----------
select tests.authenticate_as('teacher_a1');
create temporary table s1 as select * from public.start_attempt(tests.uid('formative'));
select results_eq($$ select attempt_no, deadline_at = now() + interval '30 minutes', server_now = now(), draft is null, timed_out from s1 $$,
  $$ values (1, true, true, true, false) $$, 'start: attempt 1, deadline = start + 30 min, server clock, no draft');
insert into ids select 'a1_1', attempt_id from s1;
select results_eq(format($$ select saved_at = now(), finalized from public.save_attempt_draft(%L, %L) $$,
                         pg_temp.id('a1_1'), pg_temp.body('one_right')),
  $$ values (true, false) $$, 'Saving answers records a server timestamp');
select throws_ok(format($$ select * from public.save_attempt_draft(%L, %L) $$, pg_temp.id('a1_1'), pg_temp.body('unknown_item')),
  '22023', null, 'Draft with an item outside the test is refused');
select throws_ok(format($$ select * from public.save_attempt_draft(%L, %L) $$, pg_temp.id('a1_1'), pg_temp.body('bad_shape')),
  '22023', null, 'Draft with an unknown choice is refused');
select results_eq($$ select resumed, draft = pg_temp.body('one_right') from public.start_attempt(tests.uid('formative')) $$,
  $$ values (true, true) $$, 'Resuming returns the saved answers (any device)');
select throws_ok(format($$ update public.assessment_attempts set draft_json = '{}' where id = %L $$, pg_temp.id('a1_1')),
  '42501', null, 'Drafts cannot be written directly');
reset role;

select tests.authenticate_as('teacher_a2');
select throws_ok(format($$ select * from public.save_attempt_draft(%L, '{}') $$, pg_temp.id('a1_1')),
  '42501', null, 'Another trainee cannot save into my attempt');
reset role;
-- In-progress answers stay private until submitted (owner decision): no client reads draft_json.
select tests.authenticate_as('mentor');
select throws_ok(format('select draft_json from public.assessment_attempts where id = %L', pg_temp.id('a1_1')),
  '42501', null, 'The mentor cannot read in-progress answers');
reset role;
select tests.authenticate_as('trainer');
select throws_ok(format('select draft_json from public.assessment_attempts where id = %L', pg_temp.id('a1_1')),
  '42501', null, 'The trainer cannot read in-progress answers');
select is((select draft_saved_at is not null from public.assessment_attempts where id = pg_temp.id('a1_1')), true,
  '…but can see that answers were saved, and when');
reset role;
select tests.authenticate_as('teacher_a1');
select throws_ok(format('select draft_json from public.assessment_attempts where id = %L', pg_temp.id('a1_1')),
  '42501', null, 'Even the trainee reads the draft only through start_attempt');
reset role;

-- ---------- within grace: the submitted answers count ----------
update public.assessment_attempts set started_at = now() - interval '33 minutes' where id = pg_temp.id('a1_1');
select tests.authenticate_as('teacher_a1');
select results_eq(format($$ select score, auto_submitted from public.submit_attempt(%L, %L) $$,
                         pg_temp.id('a1_1'), pg_temp.body('all_right')),
  $$ values (5.00::numeric, false) $$, '3 minutes late, inside the 5-minute grace: submission scored as sent');
reset role;
select is((select draft_json from public.assessment_attempts where id = pg_temp.id('a1_1')), null,
  'The draft is cleared once submitted');
select tests.authenticate_as('teacher_a1');

-- ---------- past the cutoff: saved answers count, late payload ignored ----------
insert into ids select 'a1_2', attempt_id from public.start_attempt(tests.uid('formative'));
select lives_ok(format($$ select * from public.save_attempt_draft(%L, %L) $$, pg_temp.id('a1_2'), pg_temp.body('one_right')),
  'Attempt 2 saves one right answer');
reset role;
update public.assessment_attempts set started_at = now() - interval '40 minutes' where id = pg_temp.id('a1_2');
select tests.authenticate_as('teacher_a1');
select results_eq(format($$ select score, auto_submitted from public.submit_attempt(%L, %L) $$,
                         pg_temp.id('a1_2'), pg_temp.body('all_right')),
  $$ values (1.00::numeric, true) $$, 'After the cutoff a late payload is ignored; the saved answers are scored');

-- ---------- save after the cutoff finalises ----------
insert into ids select 'a1_3', attempt_id from public.start_attempt(tests.uid('formative'));
select lives_ok(format($$ select * from public.save_attempt_draft(%L, %L) $$, pg_temp.id('a1_3'), pg_temp.body('one_right')),
  'Attempt 3 saves');
reset role;
update public.assessment_attempts set started_at = now() - interval '40 minutes' where id = pg_temp.id('a1_3');
select tests.authenticate_as('teacher_a1');
select results_eq(format($$ select saved_at, finalized from public.save_attempt_draft(%L, %L) $$,
                         pg_temp.id('a1_3'), pg_temp.body('all_right')),
  $$ values (null::timestamptz, true) $$, 'Saving after the cutoff finalises instead of saving');
select results_eq(format($$ select status, auto_submitted, score from public.assessment_attempts where id = %L $$, pg_temp.id('a1_3')),
  $$ values ('submitted'::text, true, 1.00::numeric) $$, '…scored from the answers saved before the cutoff');
select is((select count(*)::int from public.assessment_responses where attempt_id = pg_temp.id('a1_3')), 4,
  'Auto-finalised attempts store one response per item like a normal submit');
select throws_ok($$ select * from public.start_attempt(tests.uid('formative')) $$, 'SE002', null,
  'Limit 3 reached (auto-submitted attempts count)');
reset role;

-- ---------- extra attempts ----------
select tests.authenticate_as('mentor');
select throws_ok($$ insert into public.assessment_extra_attempts (assignment_id, user_id) values (tests.uid('formative'), tests.uid('teacher_a1')) $$,
  '42501', null, 'Mentor cannot grant extra attempts');
reset role;
select tests.authenticate_as('teacher_a1');
select throws_ok($$ insert into public.assessment_extra_attempts (assignment_id, user_id) values (tests.uid('formative'), tests.uid('teacher_a1')) $$,
  '42501', null, 'A trainee cannot grant themself an attempt');
reset role;
select tests.authenticate_as('trainer');
select throws_ok($$ insert into public.assessment_extra_attempts (assignment_id, user_id, granted_by)
                    values (tests.uid('formative'), tests.uid('teacher_a1'), tests.uid('district_admin')) $$,
  '42501', null, 'granted_by cannot be supplied');
select throws_ok($$ insert into public.assessment_extra_attempts (assignment_id, user_id) values (tests.uid('formative'), tests.uid('mentor')) $$,
  '23514', null, 'Extra attempts only go to trainees of the cohort');
select lives_ok($$ insert into public.assessment_extra_attempts (assignment_id, user_id, reason)
                   values (tests.uid('formative'), tests.uid('teacher_a1'), 'สัญญาณอินเทอร์เน็ตขาด') $$,
  'Trainer grants one extra attempt with a reason');
select throws_ok($$ update public.assessment_extra_attempts set reason = 'x' $$, '42501', null, 'Grants cannot be edited');
select throws_ok($$ delete from public.assessment_extra_attempts $$, '42501', null, 'Grants cannot be deleted');
select throws_ok($$ update public.assessment_assignments set time_limit_minutes = 60 where id = tests.uid('formative') $$,
  'SE004', null, 'The time limit is frozen once an attempt exists');
select lives_ok($$ update public.assessment_assignments set grace_minutes = 10 where id = tests.uid('formative') $$,
  'Grace stays editable');
reset role;
select is((select granted_by from public.assessment_extra_attempts where user_id = tests.uid('teacher_a1')), tests.uid('trainer'),
  'granted_by is recorded by the server');
select ok(exists (select 1 from private.audit_logs where table_name = 'public.assessment_extra_attempts' and actor_id = tests.uid('trainer')),
  'Grants are audited');

select tests.authenticate_as('teacher_a1');
select is((select count(*)::int from public.assessment_extra_attempts where assignment_id = tests.uid('formative')), 1,
  'Trainee sees their own grant');
insert into ids select 'a1_4', attempt_id from public.start_attempt(tests.uid('formative'));
select results_eq(format($$ select attempt_no from public.assessment_attempts where id = %L $$, pg_temp.id('a1_4')),
  $$ values (4) $$, 'The extra attempt can be started');
select lives_ok(format($$ select * from public.save_attempt_draft(%L, %L) $$, pg_temp.id('a1_4'), pg_temp.body('one_right')),
  'Attempt 4 saves');
reset role;
select tests.authenticate_as('teacher_a2');
select is_empty($$ select 1 from public.assessment_extra_attempts $$, 'Other trainees do not see the grant');
reset role;

-- ---------- reopening the page after the cutoff ----------
update public.assessment_attempts set started_at = now() - interval '50 minutes' where id = pg_temp.id('a1_4');
select tests.authenticate_as('teacher_a1');
select results_eq($$ select attempt_id = pg_temp.id('a1_4'), resumed, timed_out from public.start_attempt(tests.uid('formative')) $$,
  $$ values (true, false, true) $$, 'start on an expired attempt finalises it and reports timed_out');
select is((select count(*)::int from public.assessment_attempts where assignment_id = tests.uid('formative')), 4,
  '…without starting another attempt in the same call');
reset role;

-- ---------- background job ----------
select tests.authenticate_as('teacher_a2');
insert into ids select 'a2_1', attempt_id from public.start_attempt(tests.uid('formative'));
select lives_ok(format($$ select * from public.save_attempt_draft(%L, %L) $$, pg_temp.id('a2_1'), pg_temp.body('all_right')),
  'Trainee B saves all answers, then closes the browser');
reset role;
update public.assessment_attempts set started_at = now() - interval '60 minutes' where id = pg_temp.id('a2_1');
select ok(private.finalize_expired_attempts() >= 1, 'The job finalises expired attempts');
select results_eq(format($$ select status, auto_submitted, score from public.assessment_attempts where id = %L $$, pg_temp.id('a2_1')),
  $$ values ('submitted'::text, true, 5.00::numeric) $$, 'Abandoned attempt scored from its saved answers');

-- ---------- close_at alone ----------
select tests.authenticate_as('teacher_b1');
insert into ids select 'b1_pre', attempt_id from public.start_attempt(tests.uid('pretest'));
reset role;
update public.assessment_assignments set close_at = now() - interval '2 minutes' where id = tests.uid('pretest');
select tests.authenticate_as('teacher_b1');
select results_eq(format($$ select finalized from public.save_attempt_draft(%L, %L) $$, pg_temp.id('b1_pre'), pg_temp.body('one_right')),
  $$ values (false) $$, 'Two minutes after close_at, inside grace: still saving');
select results_eq($$ select resumed, timed_out from public.start_attempt(tests.uid('pretest')) $$,
  $$ values (true, false) $$, 'The open attempt can still be resumed inside grace');
reset role;
select tests.authenticate_as('teacher_a2');
select throws_ok($$ select * from public.start_attempt(tests.uid('pretest')) $$, 'SE001', null,
  'A new attempt cannot start after close_at (grace is only for attempts already running)');
reset role;

select * from finish();
rollback;

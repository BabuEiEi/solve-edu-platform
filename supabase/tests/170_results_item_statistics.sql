-- Cohort results (RLS-scoped) and item analysis, checked against hand-computed values.
--
-- Six trainees take the demo formative quiz (keys: single b · multiple a,b,d ·
-- true/false true · numeric 75; 1 + 2 + 1 + 1 = 5 points):
--   U1 b  abd  T  75 → 5     U4 a  abd  F  80 → 2
--   U2 b  abd  T  70 → 4     U5 b  c    F  60 → 1
--   U3 b  ab   T  75 → 3     U6 (blank)       → 0
-- p      = .667 .500 .500 .333        D (2 high vs 2 low) = .5 1 1 .5
-- KR-20  = 4/3 · (1 − 1.6944/2.9167) = .559     mean 2.5  SD 1.71
-- r(single, rest) = .403
begin;
select plan(22);

-- three more trainees so the cohort has six
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-000000000171', 'stat.four@example.test', now(), '{"full_name":"ครู สี่ (สมมติ)"}'),
  ('99999999-0000-4000-a000-000000000172', 'stat.five@example.test', now(), '{"full_name":"ครู ห้า (สมมติ)"}'),
  ('99999999-0000-4000-a000-000000000173', 'stat.six@example.test', now(), '{"full_name":"ครู หก (สมมติ)"}');
update public.profiles set status = 'active' where id::text like '99999999-0000-4000-a000-00000000017_';
insert into public.cohort_memberships (cohort_id, user_id, cohort_role)
select tests.uid('cohort'), id, 'trainee' from public.profiles where id::text like '99999999-0000-4000-a000-00000000017_';

create temporary table r (k text primary key, body jsonb);
insert into r values
  ('u1', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"b"}'::jsonb, tests.uid('q_multiple')::text, '{"choices":["a","b","d"]}'::jsonb,
                            tests.uid('q_truefalse')::text, '{"value":true}'::jsonb, tests.uid('q_numeric')::text, '{"value":75}'::jsonb)),
  ('u2', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"b"}'::jsonb, tests.uid('q_multiple')::text, '{"choices":["a","b","d"]}'::jsonb,
                            tests.uid('q_truefalse')::text, '{"value":true}'::jsonb, tests.uid('q_numeric')::text, '{"value":70}'::jsonb)),
  ('u3', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"b"}'::jsonb, tests.uid('q_multiple')::text, '{"choices":["a","b"]}'::jsonb,
                            tests.uid('q_truefalse')::text, '{"value":true}'::jsonb, tests.uid('q_numeric')::text, '{"value":75}'::jsonb)),
  ('u4', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"a"}'::jsonb, tests.uid('q_multiple')::text, '{"choices":["a","b","d"]}'::jsonb,
                            tests.uid('q_truefalse')::text, '{"value":false}'::jsonb, tests.uid('q_numeric')::text, '{"value":80}'::jsonb)),
  ('u5', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"b"}'::jsonb, tests.uid('q_multiple')::text, '{"choices":["c"]}'::jsonb,
                            tests.uid('q_truefalse')::text, '{"value":false}'::jsonb, tests.uid('q_numeric')::text, '{"value":60}'::jsonb)),
  ('u6', '{}');
grant select on r to authenticated;
create temporary table sink (x int);
grant insert on sink to authenticated;
create or replace function pg_temp.take(p_body text) returns void language sql as $$
  insert into sink select 1 from public.submit_attempt(
    (select attempt_id from public.start_attempt(tests.uid('formative'))), (select body from r where k = p_body));
$$;
grant execute on function pg_temp.take(text) to authenticated;

select tests.authenticate_as('teacher_a1');  do $$ begin perform pg_temp.take('u1'); end $$; reset role;
select tests.authenticate_as('teacher_a2');  do $$ begin perform pg_temp.take('u2'); end $$; reset role;
select tests.authenticate_as('teacher_b1');  do $$ begin perform pg_temp.take('u3'); end $$; reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000171'); do $$ begin perform pg_temp.take('u4'); end $$; reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000172'); do $$ begin perform pg_temp.take('u5'); end $$; reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000173'); do $$ begin perform pg_temp.take('u6'); end $$;
do $$ begin perform pg_temp.take('u1'); end $$;  -- U6 retakes and gets 5/5: item analysis must still use the first attempt
reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000172');
insert into sink select 1 from public.start_attempt(tests.uid('formative'));  -- U5 has an attempt open
reset role;

-- ---------- privileges ----------
select ok(not has_function_privilege('anon', 'public.assignment_results(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.item_statistics(uuid)', 'execute'),
  'anon cannot call either RPC');
select is((select prosecdef from pg_proc where oid = 'public.assignment_results(uuid)'::regprocedure), false,
  'assignment_results runs with the caller''s rights (RLS decides the rows)');

-- ---------- results ----------
select tests.authenticate_as('trainer');
select is((select count(*)::int from public.assignment_results(tests.uid('formative'))), 6,
  'Trainer: one row per trainee of the cohort');
select results_eq($$ select used, submitted, first_score, best_score, best_passed, in_progress
                      from public.assignment_results(tests.uid('formative'))
                     where user_id = '99999999-0000-4000-a000-000000000173' $$,
  $$ values (2, 2, 0.00::numeric, 5.00::numeric, true, false) $$, 'First and best attempt per person');
select results_eq($$ select in_progress, used, submitted from public.assignment_results(tests.uid('formative'))
                     where user_id = '99999999-0000-4000-a000-000000000172' $$,
  $$ values (true, 2, 1) $$, 'An open attempt shows as in progress');
select is((select name from public.assignment_results(tests.uid('formative')) where user_id = tests.uid('teacher_a1')),
  'ครู ก1 (สมมติ)', 'Names come with the rows');
reset role;

select tests.authenticate_as('mentor');
select results_eq($$ select user_id from public.assignment_results(tests.uid('formative')) $$,
  format('values (%L::uuid)', tests.uid('teacher_a1')), 'Mentor: only the assigned trainee');
reset role;
select tests.authenticate_as('teacher_a2');
select results_eq($$ select user_id from public.assignment_results(tests.uid('formative')) $$,
  format('values (%L::uuid)', tests.uid('teacher_a2')), 'Trainee: only themself');
reset role;
select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.assignment_results(tests.uid('formative')) $$, 'Unrelated admin: nothing');
reset role;

-- ---------- item statistics: who ----------
select tests.authenticate_as('mentor');
select throws_ok($$ select public.item_statistics(tests.uid('formative')) $$, '42501', null, 'Mentor cannot run item analysis');
reset role;
select tests.authenticate_as('teacher_a1');
select throws_ok($$ select public.item_statistics(tests.uid('formative')) $$, '42501', null, 'Trainee cannot run item analysis');
reset role;
select tests.authenticate_as('school_admin_b');
select throws_ok($$ select public.item_statistics(tests.uid('formative')) $$, '42501', null, 'Unrelated admin cannot run item analysis');
reset role;

-- ---------- item statistics: values ----------
select tests.authenticate_as('trainer');
create temporary table s as select public.item_statistics(tests.uid('formative')) as j;
create temporary table it as
  select (e ->> 'display_order')::int as no, e from s, jsonb_array_elements(s.j -> 'items') e;
select results_eq($$ select (j->>'n')::int, (j->>'suppressed')::boolean, j->>'basis', (j->>'group_size')::int, (j->>'k')::int from s $$,
  $$ values (6, false, 'first_attempt', 2, 4) $$, 'Six people, first attempts, groups of 2, four items');
select results_eq($$ select (j->>'mean_score')::numeric, (j->>'sd_score')::numeric, (j->>'max_score')::numeric from s $$,
  $$ values (2.50, 1.71, 5.00) $$, 'Mean 2.5 and SD 1.71 of 5 (U6''s retake is not counted)');
select results_eq($$ select (j->>'reliability')::numeric, j->>'reliability_kind' from s $$,
  $$ values (0.559, 'kr20') $$, 'KR-20 = .559 (all items scored right/wrong)');
select results_eq($$ select no, (e->>'p')::numeric from it order by no $$,
  $$ values (1, 0.667), (2, 0.500), (3, 0.500), (4, 0.333) $$, 'Difficulty p per item');
select results_eq($$ select no, (e->>'d')::numeric from it order by no $$,
  $$ values (1, 0.500), (2, 1.000), (3, 1.000), (4, 0.500) $$, 'Discrimination D (upper − lower 27 %)');
select is((select (e->>'r_it')::numeric from it where no = 1), 0.403, 'Corrected item-total correlation (single choice)');
select results_eq($$ select no, e->'choices', (e->>'blank')::int from it order by no $$,
  $$ values (1, '{"a":1,"b":4}'::jsonb, 1), (2, '{"a":4,"b":4,"c":1,"d":3}'::jsonb, 1),
            (3, '{"true":3,"false":2}'::jsonb, 1), (4, '{}'::jsonb, 1) $$,
  'Choices picked and blanks per item');
select ok((select j::text from s) !~ '"correct"|answer_json|scoring_json|tolerance|awarded_score',
  'No answer key and no per-person score in the output');
select ok(not exists (select 1 from it where e ? 'user_id'), 'Aggregates only: no person in the item rows');

-- ---------- too few people ----------
select results_eq($$ select (j->>'n')::int, (j->>'suppressed')::boolean, j ? 'items'
                      from (select public.item_statistics(tests.uid('pretest')) as j) x $$,
  $$ values (0, true, false) $$, 'Fewer than 5 people: only the count is returned');
reset role;

select * from finish();
rollback;

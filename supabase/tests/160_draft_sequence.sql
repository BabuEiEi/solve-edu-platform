-- Ordered draft saves: a slow request never overwrites newer answers; the most
-- recently opened page wins; autosaves are not audited (evidence changes are).
begin;
select plan(17);

create temporary table ids (k text primary key, v uuid, n bigint);
grant select, insert on ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select v from ids where k = p $$;
create or replace function pg_temp.base(p text) returns bigint language sql stable as $$ select n from ids where k = p $$;

create temporary table r (k text primary key, body jsonb);
insert into r values
  ('a', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"a"}'::jsonb)),
  ('b', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"b"}'::jsonb)),
  ('c', jsonb_build_object(tests.uid('q_single')::text, '{"choice":"c"}'::jsonb));
grant select on r to authenticated;
create or replace function pg_temp.body(p text) returns jsonb language sql stable as $$ select body from r where k = p $$;
create or replace function pg_temp.draft(p uuid) returns jsonb language sql stable security definer as $$
  select draft_json from public.assessment_attempts where id = p $$;
grant execute on function pg_temp.draft(uuid) to authenticated;

select ok(not has_column_privilege('authenticated', 'public.assessment_attempts', 'draft_seq', 'select'),
  'draft_seq is not readable by clients');

-- ---------- page 1 ----------
select tests.authenticate_as('teacher_a1');
insert into ids select 'p1', attempt_id, draft_seq from public.start_attempt(tests.uid('formative'));
select ok(pg_temp.base('p1') >= 1000000, 'A new attempt hands the page a sequence base');
select results_eq(format($$ select finalized, stale from public.save_attempt_draft(%L, %L, %s) $$,
                         pg_temp.id('p1'), pg_temp.body('b'), pg_temp.base('p1') + 2),
  $$ values (false, false) $$, 'Save #2 (sent later, arrives first) is stored');
select results_eq(format($$ select saved_at, finalized, stale from public.save_attempt_draft(%L, %L, %s) $$,
                         pg_temp.id('p1'), pg_temp.body('a'), pg_temp.base('p1') + 1),
  $$ values (null::timestamptz, false, true) $$, 'Save #1 arriving late is ignored (stale)');
select is(pg_temp.draft(pg_temp.id('p1')), pg_temp.body('b'), 'The newer answers survive');
select results_eq(format($$ select stale from public.save_attempt_draft(%L, %L, %s) $$,
                         pg_temp.id('p1'), pg_temp.body('c'), pg_temp.base('p1') + 2),
  $$ values (true) $$, 'An equal sequence number is not newer');
reset role;
select is((select count(*)::int from private.audit_logs
            where table_name = 'public.assessment_attempts' and record_id = pg_temp.id('p1')), 0,
  'Autosaves and resumes are not written to the audit log');

-- ---------- page 2 (another device / a reload) ----------
select tests.authenticate_as('teacher_a1');
insert into ids select 'p2', attempt_id, draft_seq from public.start_attempt(tests.uid('formative'));
select is(pg_temp.id('p2'), pg_temp.id('p1'), 'The second page resumes the same attempt');
select ok(pg_temp.base('p2') > pg_temp.base('p1') + 2, '…with a base above everything page 1 can send');
select results_eq(format($$ select draft = %L from public.start_attempt(tests.uid('formative')) $$, pg_temp.body('b')),
  $$ values (true) $$, '…and the latest saved answers');
select results_eq(format($$ select stale from public.save_attempt_draft(%L, %L, %s) $$,
                         pg_temp.id('p1'), pg_temp.body('c'), pg_temp.base('p1') + 3),
  $$ values (true) $$, 'Page 1 saving again is stale (its next number is below the new base)');
select throws_ok(format($$ select * from public.submit_attempt(%L, %L, %s) $$,
                        pg_temp.id('p1'), pg_temp.body('c'), pg_temp.base('p1') + 4),
  'SE005', null, 'Page 1 cannot submit once another page took over');
reset role;
select tests.authenticate_as('teacher_a1');
insert into ids select 'p3', attempt_id, draft_seq from public.start_attempt(tests.uid('formative'));
select results_eq(format($$ select stale from public.save_attempt_draft(%L, %L, %s) $$,
                         pg_temp.id('p3'), pg_temp.body('c'), pg_temp.base('p3') + 1),
  $$ values (false) $$, 'The newest page saves normally');
select results_eq(format($$ select stale from public.save_attempt_draft(%L, %L, null) $$,
                         pg_temp.id('p3'), pg_temp.body('a')),
  $$ values (false) $$, 'A save without a sequence number (older clients) is accepted');
select results_eq(format($$ select score, auto_submitted from public.submit_attempt(%L, %L, %s) $$,
                         pg_temp.id('p3'), pg_temp.body('b'), pg_temp.base('p3') + 2),
  $$ values (1.00::numeric, false) $$, 'The newest page submits');
reset role;
select ok(exists (select 1 from private.audit_logs
                   where table_name = 'public.assessment_attempts' and record_id = pg_temp.id('p3')
                     and action = 'UPDATE' and after_json ->> 'status' = 'submitted'),
  'Submitting is audited');
select ok(not exists (select 1 from private.audit_logs
                       where table_name = 'public.assessment_attempts' and record_id = pg_temp.id('p3')
                         and after_json ->> 'status' = 'in_progress'),
  'No audit row holds an in-progress draft');

select * from finish();
rollback;

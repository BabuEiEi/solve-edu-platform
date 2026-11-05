-- Phase 3b step 2: notice counts and "opened" marks — right numbers, and
-- nobody learns or marks anything outside their own scope.
begin;
select plan(25);

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $$;
grant execute on function pg_temp.err(text) to authenticated;
create temporary table ids (k text primary key, id uuid);
grant select, insert on ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;
create or replace function pg_temp.n(p text) returns int language sql stable as $$ select (public.task_notice_counts() ->> p)::int $$;
grant execute on function pg_temp.n(text) to authenticated;
insert into ids values ('alloc', 'b2000000-0000-4000-a000-000000000001');
-- the demo task allows 3 attempts; rubric criteria of the demo rubric
create or replace function pg_temp.lv() returns jsonb language sql stable as $$
  select '{"a3000000-0000-4000-a000-000000000021":{"level":"b"},"a3000000-0000-4000-a000-000000000022":{"level":"x"}}'::jsonb $$;
grant execute on function pg_temp.lv() to authenticated;

select ok(not has_function_privilege('anon', 'public.task_notice_counts()', 'execute')
      and not has_function_privilege('anon', 'public.mark_task_results_seen(uuid)', 'execute'), 'anon cannot call either function');
select is((select prosecdef from pg_proc where oid = 'public.task_notice_counts()'::regprocedure)
       or (select prosecdef from pg_proc where oid = 'public.mark_task_results_seen(uuid)'::regprocedure), false,
  'both run with the caller''s rights (RLS decides what is counted)');

-- ---------- nothing yet ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.n('unread_results') + pg_temp.n('revise') + pg_temp.n('waiting'), 0, 'a trainee with no work: all zero');
insert into ids values ('a1', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'งาน ก1' where id = pg_temp.id('a1');
do $$ begin perform public.submit_task_submission(pg_temp.id('a1')); end $$;
select is(pg_temp.n('waiting'), 0, 'a trainee''s own work never counts as "waiting for me"');
reset role;
select tests.authenticate_as('teacher_a2');
insert into ids values ('a2', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'งาน ก2' where id = pg_temp.id('a2');
do $$ begin perform public.submit_task_submission(pg_temp.id('a2')); end $$;
reset role;

-- ---------- the reviewer's count ----------
select tests.authenticate_as('trainer');
select is(pg_temp.n('waiting'), 2, 'trainer: two people wait');
reset role;
select tests.authenticate_as('mentor');
select is(pg_temp.n('waiting'), 1, 'mentor: only the mentee waits');
reset role;
select tests.authenticate_as('school_admin_b');
select is(pg_temp.n('waiting') + pg_temp.n('unread_results') + pg_temp.n('revise'), 0, 'an outsider: zero everywhere');
reset role;

-- ---------- a review is released: unread / revise for the trainee, waiting drops ----------
select tests.authenticate_as('trainer');
insert into ids select 'r1', public.save_task_review(pg_temp.id('a1'), pg_temp.lv(), 'เพิ่มหลักฐาน', 'revise');
do $$ begin perform public.release_task_review(pg_temp.id('r1')); end $$;
select is(pg_temp.n('waiting'), 1, 'after releasing one, one still waits');
reset role;
select tests.authenticate_as('teacher_a1');
select is(pg_temp.n('unread_results'), 1, 'trainee: one unread result');
select is(pg_temp.n('revise'), 1, 'trainee: one task returned for revision');
select is(public.mark_task_results_seen(pg_temp.id('alloc')), 1, 'opening the task marks one review as seen');
select is(public.mark_task_results_seen(pg_temp.id('alloc')), 0, 'again: nothing new to mark');
select is(pg_temp.n('unread_results'), 0, 'no unread result any more');
select is(pg_temp.n('revise'), 1, '… but the task still needs revision');
-- opening the next attempt: no longer "needs revision" (a draft is open)
insert into ids values ('a1b', public.start_task_submission(pg_temp.id('alloc')));
select is(pg_temp.n('revise'), 0, 'a draft of the next attempt is open: not counted as waiting for the trainee');
reset role;

-- ---------- who can mark what ----------
select tests.authenticate_as('teacher_a2');
select is(pg_temp.n('unread_results'), 0, 'another trainee has no unread result of A1''s review');
select is(public.mark_task_results_seen(pg_temp.id('alloc')), 0, 'and marks nothing for A1''s review');
select is(pg_temp.err(format($$ insert into public.task_review_reads (review_id) values (%L) $$, pg_temp.id('r1'))), '42501',
  'cannot insert a mark for a review that is not on their work');
select is(pg_temp.err(format($$ insert into public.task_review_reads (review_id, user_id) values (%L, %L) $$,
                             pg_temp.id('r1'), tests.uid('teacher_a1'))), '42501', 'cannot set user_id (no grant)');
reset role;
select tests.authenticate_as('trainer');
select is(pg_temp.err(format($$ insert into public.task_review_reads (review_id) values (%L) $$, pg_temp.id('r1'))), '42501',
  'staff do not mark trainees'' results either');
select is_empty($$ select 1 from public.task_review_reads $$, 'and see no one''s marks');
reset role;
select tests.authenticate_as('teacher_a1');
select is((select count(*)::int from public.task_review_reads), 1, 'a trainee sees only their own mark');
select is(pg_temp.err($$ delete from public.task_review_reads $$), '42501', 'marks cannot be deleted by the client');
select is(pg_temp.err($$ update public.task_review_reads set read_at = now() - interval '1 year' $$), '42501', 'nor edited');
reset role;
select tests.as_anon();
select is(pg_temp.err('select 1 from public.task_review_reads'), '42501', 'anon cannot read marks');
reset role;

select * from finish();
rollback;

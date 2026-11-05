-- Phase 3 step 3: reviews with a rubric — draft → release, revise → new
-- attempt, re-grade with a reason, who may review and see what.
begin;
select plan(44);

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
grant select, insert, update on ids to authenticated;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;
-- scores keyed by the two criteria
create or replace function pg_temp.sc(l1 text, l2 text) returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    pg_temp.id('c1')::text, case when l1 is not null then jsonb_build_object('level', l1) end,
    pg_temp.id('c2')::text, case when l2 is not null then jsonb_build_object('level', l2) end))
$$;
grant execute on function pg_temp.sc(text, text) to authenticated;

select ok(not has_function_privilege('anon', 'public.save_task_review(uuid, jsonb, text, text, text)', 'execute')
      and not has_function_privilege('anon', 'public.release_task_review(uuid)', 'execute'), 'anon cannot review');

-- ---------- a rubric (c1: a=1 b=3 · c2: x=0 y=2 → max 5), a task, two submissions ----------
select tests.authenticate_as('trainer');
insert into public.instruments (owner_org_id, course_id, code, title, instrument_type)
values (tests.uid('district'), tests.uid('course'), 'RUB-R', 'เกณฑ์ตรวจ (ทดสอบ)', 'rubric');
insert into public.instrument_versions (instrument_id) select id from public.instruments where code = 'RUB-R';
insert into ids select 'rubric', v.id from public.instrument_versions v join public.instruments i on i.id = v.instrument_id where i.code = 'RUB-R';
with c as (insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
           values (pg_temp.id('rubric'), 'rubric_criterion', 'เป้าหมาย', '{"levels":[{"id":"a","label":"ปรับปรุง","score":1},{"id":"b","label":"ดี","score":3}]}', 1)
           returning id) insert into ids select 'c1', id from c;
with c as (insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
           values (pg_temp.id('rubric'), 'rubric_criterion', 'หลักฐาน', '{"levels":[{"id":"x","label":"ไม่มี","score":0},{"id":"y","label":"มี","score":2}]}', 2)
           returning id) insert into ids select 'c2', id from c;
do $$ begin perform public.publish_instrument_version(pg_temp.id('rubric')); end $$;
with t as (insert into public.tasks (course_id, title, rubric_version_id, max_attempts, status)
           values (tests.uid('course'), 'ส่งแผน (ทดสอบตรวจ)', pg_temp.id('rubric'), 2, 'published') returning id)
insert into ids select 'task', id from t;
with a as (insert into public.task_allocations (task_id, cohort_id) values (pg_temp.id('task'), tests.uid('cohort')) returning id)
insert into ids select 'alloc', id from a;
-- and a task without a rubric
with t as (insert into public.tasks (course_id, title, status) values (tests.uid('course'), 'สะท้อนคิด (ไม่มี Rubric)', 'published') returning id)
insert into ids select 'task_free', id from t;
with a as (insert into public.task_allocations (task_id, cohort_id) values (pg_temp.id('task_free'), tests.uid('cohort')) returning id)
insert into ids select 'alloc_free', id from a;
reset role;

select tests.authenticate_as('teacher_a1');
insert into ids values ('a1_1', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'รอบแรก' where id = pg_temp.id('a1_1');
do $$ begin perform public.submit_task_submission(pg_temp.id('a1_1')); end $$;
insert into ids values ('a1_free', public.start_task_submission(pg_temp.id('alloc_free')));
update public.task_submissions set text_response = 'สะท้อนคิด' where id = pg_temp.id('a1_free');
do $$ begin perform public.submit_task_submission(pg_temp.id('a1_free')); end $$;
reset role;
select tests.authenticate_as('teacher_a2');
insert into ids values ('a2_1', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'งาน A2' where id = pg_temp.id('a2_1');
do $$ begin perform public.submit_task_submission(pg_temp.id('a2_1')); end $$;
reset role;

-- ---------- who may review ----------
select tests.authenticate_as('teacher_a2');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', 'passed') $$, pg_temp.id('a1_1'))), '42501', 'a trainee cannot review someone else''s work');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', 'passed') $$, pg_temp.id('a2_1'))), '42501', '… nor their own');
select is(pg_temp.err(format($$ insert into public.task_reviews (submission_id, reviewer_id, status, outcome, released_at) values (%L, auth.uid(), 'released', 'passed', now()) $$,
                             pg_temp.id('a2_1'))), '42501', 'no writing reviews directly');
reset role;
-- a trainee who is also staff of the cohort still cannot review their own work
insert into public.cohort_memberships (cohort_id, user_id, cohort_role, status)
values (tests.uid('cohort'), tests.uid('teacher_a2'), 'coordinator', 'active');
select tests.authenticate_as('teacher_a2');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', 'passed') $$, pg_temp.id('a2_1'))), '42501',
  'staff who also submitted cannot review their own work');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', null) $$, pg_temp.id('a1_1'))), 'no error',
  '(as staff they may review others: the refusal above is about their own work)');
delete from public.task_reviews where submission_id = pg_temp.id('a1_1') and reviewer_id = tests.uid('teacher_a2');
reset role;
delete from public.cohort_memberships where user_id = tests.uid('teacher_a2') and cohort_role = 'coordinator';
select tests.authenticate_as('mentor');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', 'passed') $$, pg_temp.id('a2_1'))), '42501', 'a mentor cannot review a trainee they do not look after');
reset role;
select tests.authenticate_as('school_admin_b');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', 'passed') $$, pg_temp.id('a1_1'))), '42501', 'an outsider cannot review');
reset role;

-- ---------- trainer drafts a review ----------
select tests.authenticate_as('trainer');
insert into ids values ('r1', public.save_task_review(pg_temp.id('a1_1'), pg_temp.sc('b', null), 'ดีแล้ว เพิ่มหลักฐาน', null));
select results_eq(format('select status, score, max_score, outcome from public.task_reviews where id = %L', pg_temp.id('r1')),
  $$ values ('draft'::text, 3.00::numeric, 5.00::numeric, null::text) $$, 'a partial draft: score from the level (3 of 5), no outcome yet');
select is(pg_temp.err(format($$ select public.save_task_review(%L, jsonb_build_object(gen_random_uuid()::text, '{"level":"a"}'::jsonb), 'x', null) $$, pg_temp.id('a1_1'))),
  '22023', 'a criterion of another rubric is refused');
select is(pg_temp.err(format($$ select public.save_task_review(%L, pg_temp.sc('z', null), 'x', null) $$, pg_temp.id('a1_1'))), '22023', 'an unknown level is refused');
select is(pg_temp.err(format($$ select public.save_task_review(%L, '{}', 'x', 'maybe') $$, pg_temp.id('a1_1'))), '22023', 'outcome is passed or revise');
select is(pg_temp.err(format($$ select public.save_task_review(%L, jsonb_build_object(pg_temp.id('c1')::text, '{"level":"b","score":99}'::jsonb), 'x', null) $$, pg_temp.id('a1_1'))),
  '22023', 'the client cannot send a score');
select is(pg_temp.err(format('select public.release_task_review(%L)', pg_temp.id('r1'))), '23514', 'release needs an outcome');
do $$ begin perform public.save_task_review(pg_temp.id('a1_1'), pg_temp.sc('b', null), 'ดีแล้ว เพิ่มหลักฐาน', 'revise'); end $$;
select is(pg_temp.err(format('select public.release_task_review(%L)', pg_temp.id('r1'))), '23514', 'release needs every criterion scored');
select is(public.save_task_review(pg_temp.id('a1_1'), pg_temp.sc('b', 'x'), 'ดีแล้ว เพิ่มหลักฐาน', 'revise'), pg_temp.id('r1'),
  'saving again updates the same draft');
reset role;

select tests.authenticate_as('teacher_a1');
select is_empty(format('select 1 from public.task_reviews where id = %L', pg_temp.id('r1')), 'the trainee does not see a draft review');
reset role;
select tests.authenticate_as('mentor');
select is_empty(format('select 1 from public.task_reviews where id = %L', pg_temp.id('r1')), 'nor does another reviewer');
select is(pg_temp.err(format('select public.release_task_review(%L)', pg_temp.id('r1'))), '42501', 'nor can they release it');
reset role;

select tests.authenticate_as('trainer');
create temporary table rel as select * from public.release_task_review(pg_temp.id('r1'));
select results_eq('select status, outcome, score, released_at is not null, supersedes_id from rel',
  $$ values ('released'::text, 'revise'::text, 3.00::numeric, true, null::uuid) $$, 'released: revise, 3 of 5, stamped by the server');
select is(pg_temp.err(format('select public.release_task_review(%L)', pg_temp.id('r1'))), '42501', 'releasing twice');
select is(pg_temp.err(format($$ update public.task_reviews set score = 5 where id = %L $$, pg_temp.id('r1'))), '42501', 'no editing a review directly');
delete from public.task_reviews where id = pg_temp.id('r1');
select is((select count(*)::int from public.task_reviews where id = pg_temp.id('r1')), 1, 'a released review cannot be deleted');
reset role;
select ok(exists (select 1 from private.audit_logs
                   where action = 'RELEASE_TASK_REVIEW' and record_id = pg_temp.id('r1')
                     and after_json ->> 'outcome' = 'revise' and (after_json ->> 'score')::numeric = 3
                     and after_json::text !~ 'เพิ่มหลักฐาน'),
  'the release is audited (score and outcome, not the feedback text)');
select throws_ok(format($$ update public.task_reviews set outcome = 'passed' where id = %L $$, pg_temp.id('r1')), '23514', null,
  'even the database owner cannot change a released review');

-- ---------- the trainee sees the result; revise → a new attempt ----------
select tests.authenticate_as('teacher_a1');
select results_eq(format('select outcome, score, feedback from public.task_reviews where submission_id = %L', pg_temp.id('a1_1')),
  $$ values ('revise'::text, 3.00::numeric, 'ดีแล้ว เพิ่มหลักฐาน'::text) $$, 'the trainee sees the released review');
select is((select count(*)::int from public.task_review_scores where review_id = pg_temp.id('r1')), 2, '… and the level per criterion');
insert into ids values ('a1_2', public.start_task_submission(pg_temp.id('alloc')));
select is((select attempt_no from public.task_submissions where id = pg_temp.id('a1_2')), 2, 'returned for revision: attempt 2 opens');
update public.task_submissions set text_response = 'รอบสอง พร้อมหลักฐาน' where id = pg_temp.id('a1_2');
do $$ begin perform public.submit_task_submission(pg_temp.id('a1_2')); end $$;
reset role;
select tests.authenticate_as('teacher_a2');
select is_empty(format('select 1 from public.task_reviews where submission_id = %L', pg_temp.id('a1_1')), 'another trainee does not see it');
reset role;

-- ---------- the mentor reviews their mentee's second attempt: passed ----------
select tests.authenticate_as('mentor');
select results_eq(format('select outcome from public.task_reviews where submission_id = %L', pg_temp.id('a1_1')),
  $$ values ('revise'::text) $$, 'the mentor sees the released review of a mentee');
insert into ids values ('r2', public.save_task_review(pg_temp.id('a1_2'), pg_temp.sc('b', 'y'), 'ผ่าน', 'passed'));
select results_eq(format('select outcome, score from public.release_task_review(%L)', pg_temp.id('r2')),
  $$ values ('passed'::text, 5.00::numeric) $$, 'mentor releases: passed, 5 of 5');
reset role;
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err(format('select public.start_task_submission(%L)', pg_temp.id('alloc'))), 'SE007', 'passed: no further attempt');
reset role;

-- ---------- re-grade attempt 1 ----------
select tests.authenticate_as('trainer');
insert into ids values ('r3', public.save_task_review(pg_temp.id('a1_1'), pg_temp.sc('a', 'x'), 'ตรวจใหม่', 'revise'));
select is(pg_temp.err(format('select public.release_task_review(%L)', pg_temp.id('r3'))), '23514', 'a re-grade needs a reason');
do $$ begin perform public.save_task_review(pg_temp.id('a1_1'), pg_temp.sc('a', 'x'), 'ตรวจใหม่', 'revise', 'ให้คะแนนเกณฑ์แรกสูงเกินไป'); end $$;
select results_eq(format('select score, supersedes_id from public.release_task_review(%L)', pg_temp.id('r3')),
  format('values (1.00::numeric, %L::uuid)', pg_temp.id('r1')), 're-graded: 1 of 5, replacing the first review');
select is((select count(*)::int from public.task_reviews where submission_id = pg_temp.id('a1_1') and status = 'released'), 2,
  'both reviews are kept (history)');
reset role;
select ok(exists (select 1 from private.audit_logs
                   where action = 'REGRADE_TASK_REVIEW' and record_id = pg_temp.id('r3')
                     and (before_json ->> 'score')::numeric = 3 and (after_json ->> 'score')::numeric = 1
                     and reason = 'ให้คะแนนเกณฑ์แรกสูงเกินไป'),
  'the re-grade is audited with the old score, the new score and the reason');

-- ---------- attempt limit (2) ----------
select tests.authenticate_as('trainer');
do $$ begin perform public.release_task_review(public.save_task_review(pg_temp.id('a2_1'), pg_temp.sc('a', 'x'), 'แก้', 'revise')); end $$;
reset role;
select tests.authenticate_as('teacher_a2');
insert into ids values ('a2_2', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'A2 รอบสอง' where id = pg_temp.id('a2_2');
do $$ begin perform public.submit_task_submission(pg_temp.id('a2_2')); end $$;
reset role;
select tests.authenticate_as('trainer');
do $$ begin perform public.release_task_review(public.save_task_review(pg_temp.id('a2_2'), pg_temp.sc('a', 'x'), 'ยังต้องแก้', 'revise')); end $$;
reset role;
select tests.authenticate_as('teacher_a2');
select is(pg_temp.err(format('select public.start_task_submission(%L)', pg_temp.id('alloc'))), 'SE002', 'returned again, but both attempts are used');
reset role;

-- ---------- a task without a rubric ----------
select tests.authenticate_as('trainer');
select is(pg_temp.err(format($$ select public.save_task_review(%L, pg_temp.sc('a', null), 'x', 'passed') $$, pg_temp.id('a1_free'))),
  '22023', 'no criteria to score when the task has no rubric');
insert into ids values ('rf', public.save_task_review(pg_temp.id('a1_free'), '{}', 'สะท้อนคิดได้ดี', 'passed'));
select results_eq(format('select status, score, max_score from public.release_task_review(%L)', pg_temp.id('rf')),
  $$ values ('released'::text, null::numeric, null::numeric) $$, 'feedback and outcome only: no score');

-- ---------- discarding a draft ----------
insert into ids values ('rd', public.save_task_review(pg_temp.id('a2_1'), '{}', 'ร่างที่จะทิ้ง', null, 'ทดลอง'));
delete from public.task_reviews where id = pg_temp.id('rd');
select is((select count(*)::int from public.task_reviews where id = pg_temp.id('rd')), 0, 'a reviewer discards their own draft');
reset role;
select tests.authenticate_as('mentor');
insert into ids values ('rm', public.save_task_review(pg_temp.id('a1_2'), pg_temp.sc('b', 'y'), 'ร่างของครูพี่เลี้ยง', null, 'ทบทวน'));
reset role;
select tests.authenticate_as('trainer');
delete from public.task_reviews where id = pg_temp.id('rm');
reset role;
select is((select count(*)::int from public.task_reviews where id = pg_temp.id('rm')), 1, 'but not someone else''s');

-- ---------- outsiders ----------
select tests.authenticate_as('school_admin_b');
select is_empty('select 1 from public.task_reviews', 'an outsider sees no reviews');
select is_empty('select 1 from public.task_review_scores', '… and no scores');
reset role;
select tests.as_anon();
select is(pg_temp.err('select 1 from public.task_reviews'), '42501', 'anon cannot read reviews');
reset role;

select * from finish();
rollback;

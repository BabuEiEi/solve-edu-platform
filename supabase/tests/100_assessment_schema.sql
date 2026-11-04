-- Assessment engine schema: grants, RLS, published-version immutability,
-- answer keys unreachable, attempts/scores not client-writable
begin;
select plan(64);

-- ---------- fixtures (as postgres; triggers still run) ----------
-- I1 belongs to the district and to course AFL-101 (managed by the cohort trainer)
insert into public.instruments (id, owner_org_id, course_id, code, title)
values ('80000000-0000-4000-a000-000000000001', tests.uid('district'), tests.uid('course'), 'AFL-PRE', 'แบบทดสอบก่อนเรียน');

insert into public.instrument_versions (id, instrument_id)
values ('81000000-0000-4000-a000-000000000001', '80000000-0000-4000-a000-000000000001');

insert into public.instrument_items (id, instrument_version_id, item_type, prompt, options_json, display_order) values
  ('82000000-0000-4000-a000-000000000001', '81000000-0000-4000-a000-000000000001', 'mcq_single', 'ข้อ 1',
   '{"options":[{"id":"a","text":"ก"},{"id":"b","text":"ข"},{"id":"c","image_path":"80000000-0000-4000-a000-000000000001/c.png"}]}', 1),
  ('82000000-0000-4000-a000-000000000002', '81000000-0000-4000-a000-000000000001', 'true_false', 'ข้อ 2', '{}', 2),
  ('82000000-0000-4000-a000-000000000003', '81000000-0000-4000-a000-000000000001', 'numeric', 'ข้อ 3', '{"unit":"คน"}', 3);

insert into private.instrument_answer_keys (item_id, answer_json) values
  ('82000000-0000-4000-a000-000000000001', '{"correct":["b"]}'),
  ('82000000-0000-4000-a000-000000000002', '{"correct":true}'),
  ('82000000-0000-4000-a000-000000000003', '{"value":12,"tolerance":0.5}');

update public.instrument_versions
   set status = 'published', published_at = now(), content_hash = 'fixture'
 where id = '81000000-0000-4000-a000-000000000001';

insert into public.assessment_assignments (id, instrument_version_id, cohort_id, course_id, purpose, title, attempt_limit, passing_percent, status, close_at) values
  ('83000000-0000-4000-a000-000000000001', '81000000-0000-4000-a000-000000000001', tests.uid('cohort'), tests.uid('course'),
   'pretest', 'Pretest AfL', 1, 60, 'published', now() + interval '30 days'),
  ('83000000-0000-4000-a000-000000000002', '81000000-0000-4000-a000-000000000001', tests.uid('cohort'), null,
   'formative', 'ยังไม่เผยแพร่', 3, null, 'draft', null);

insert into public.assessment_attempts (id, assignment_id, user_id, attempt_no, status, started_at, submitted_at, score, max_score, passed) values
  ('84000000-0000-4000-a000-000000000001', '83000000-0000-4000-a000-000000000001', tests.uid('teacher_a1'), 1,
   'submitted', now() - interval '10 minutes', now(), 2, 3, true),
  ('84000000-0000-4000-a000-000000000002', '83000000-0000-4000-a000-000000000001', tests.uid('teacher_b1'), 1,
   'submitted', now() - interval '10 minutes', now(), 1, 3, false);

insert into public.assessment_responses (attempt_id, item_id, response_json, awarded_score) values
  ('84000000-0000-4000-a000-000000000001', '82000000-0000-4000-a000-000000000001', '{"choice":"b"}', 1),
  ('84000000-0000-4000-a000-000000000001', '82000000-0000-4000-a000-000000000002', '{"value":true}', 1),
  ('84000000-0000-4000-a000-000000000001', '82000000-0000-4000-a000-000000000003', '{"value":3}', 0);

-- ---------- structural ----------
select ok(not has_table_privilege('authenticated', 'private.instrument_answer_keys', 'select'),
  'authenticated has no SELECT on answer keys');
select ok(not has_table_privilege('anon', 'public.assessment_attempts', 'select'),
  'anon has no privileges on attempts');
select ok(not has_table_privilege('authenticated', 'public.assessment_attempts', 'insert')
      and not has_table_privilege('authenticated', 'public.assessment_attempts', 'update')
      and not has_table_privilege('authenticated', 'public.assessment_attempts', 'delete'),
  'attempts are not client-writable (no INSERT/UPDATE/DELETE grant)');
select ok(not has_table_privilege('authenticated', 'public.assessment_responses', 'insert')
      and not has_table_privilege('authenticated', 'public.assessment_responses', 'update'),
  'responses are not client-writable');
select ok(not has_column_privilege('authenticated', 'public.assessment_responses', 'awarded_score', 'select'),
  'per-item awarded_score is not selectable by clients');
select ok(not has_column_privilege('authenticated', 'public.instrument_versions', 'status', 'update'),
  'clients cannot publish a version by UPDATE (RPC only)');
select ok(not has_column_privilege('authenticated', 'public.assessment_assignments', 'instrument_version_id', 'update'),
  'an assignment cannot be re-pointed to another version');

-- ---------- anonymous ----------
select tests.as_anon();
select throws_ok($$ select id from public.assessment_attempts $$, '42501', null, 'anon cannot read attempts');
select throws_ok($$ select id from public.instrument_items $$, '42501', null, 'anon cannot read items');
reset role;

-- ---------- trainee without an attempt ----------
select tests.authenticate_as('teacher_a2');
select results_eq($$ select id from public.assessment_assignments where id::text like '83%' order by id $$,
  $$ values ('83000000-0000-4000-a000-000000000001'::uuid) $$,
  'Trainee sees the published assignment of own cohort, not the draft');
select is_empty($$ select 1 from public.instrument_items where instrument_version_id = '81000000-0000-4000-a000-000000000001' $$,
  'Trainee cannot preview items before starting an attempt');
select is_empty($$ select 1 from public.instruments $$, 'Trainee without an attempt sees no instruments');
select is_empty($$ select 1 from public.assessment_attempts $$, 'Trainee sees no one else''s attempts');
reset role;

-- ---------- trainee with a submitted attempt ----------
select tests.authenticate_as('teacher_a1');
select is((select count(*)::int from public.instrument_items where instrument_version_id = '81000000-0000-4000-a000-000000000001'),
  3, 'Trainee with an attempt can see the items (for review)');
select is_empty($$ select 1 from public.instrument_items i, jsonb_array_elements(coalesce(i.options_json -> 'options', '[]')) o
                   where o ? 'correct' or o ? 'is_correct' $$,
  'Items returned to a trainee carry no correctness flag');
select results_eq($$ select id, score, max_score, passed from public.assessment_attempts $$,
  $$ values ('84000000-0000-4000-a000-000000000001'::uuid, 2.00::numeric, 3.00::numeric, true) $$,
  'Trainee A sees only own attempt and its total score');
select is((select count(*)::int from public.assessment_responses), 3, 'Trainee sees own responses');
select throws_ok($$ select awarded_score from public.assessment_responses $$, '42501', null,
  'Trainee cannot read per-item scores');
select throws_ok($$ select answer_json from private.instrument_answer_keys $$, '42501', null,
  'Trainee cannot read answer keys');
select throws_ok($$ update public.assessment_attempts set score = 3, passed = true where id = '84000000-0000-4000-a000-000000000001' $$,
  '42501', null, 'Trainee cannot change own score');
select throws_ok($$ insert into public.assessment_attempts (assignment_id, user_id, attempt_no)
                   values ('83000000-0000-4000-a000-000000000001', tests.uid('teacher_a1'), 2) $$,
  '42501', null, 'Trainee cannot create an attempt directly');
select throws_ok($$ insert into public.assessment_responses (attempt_id, item_id, response_json)
                   values ('84000000-0000-4000-a000-000000000001', '82000000-0000-4000-a000-000000000001', '{}') $$,
  '42501', null, 'Trainee cannot insert responses directly');
select throws_ok($$ delete from public.assessment_attempts $$, '42501', null, 'Trainee cannot delete attempts');
select throws_ok($$ insert into public.instruments (owner_org_id, code, title) values (tests.uid('school_a'), 'X', 'x') $$,
  '42501', null, 'Trainee cannot author instruments');
select throws_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title)
                   values ('81000000-0000-4000-a000-000000000001', tests.uid('cohort'), 'formative', 'x') $$,
  '42501', null, 'Trainee cannot create assignments');
reset role;

-- ---------- mentor / unrelated admin ----------
select tests.authenticate_as('mentor');
select results_eq($$ select user_id from public.assessment_attempts $$,
  $$ values (tests.uid('teacher_a1')) $$, 'Mentor sees attempts of assigned trainees only');
reset role;

select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.assessment_assignments $$, 'Unrelated school admin sees no assignments');
select is_empty($$ select 1 from public.assessment_attempts $$, 'Unrelated school admin sees no attempts');
select is_empty($$ select 1 from public.instruments $$, 'Unrelated school admin sees no instruments');
reset role;

select tests.authenticate_as('supervisor');
select ok(exists (select 1 from public.instruments where id = '80000000-0000-4000-a000-000000000001'),
  'District supervisor sees district instruments');
reset role;

-- ---------- trainer (course manager + cohort assessor) ----------
select tests.authenticate_as('trainer');
select is((select count(*)::int from public.assessment_attempts), 2, 'Cohort trainer sees all cohort attempts');
select throws_ok($$ select answer_json from private.instrument_answer_keys $$, '42501', null,
  'Trainer cannot read answer keys through the API');

-- published version is immutable
select throws_ok($$ update public.instrument_items set prompt = 'แก้' where id = '82000000-0000-4000-a000-000000000001' $$,
  '23514', null, 'Items of a published version cannot be edited');
select throws_ok($$ delete from public.instrument_items where id = '82000000-0000-4000-a000-000000000002' $$,
  '23514', null, 'Items of a published version cannot be deleted');
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, display_order)
                   values ('81000000-0000-4000-a000-000000000001', 'true_false', 'เพิ่ม', 9) $$,
  '23514', null, 'Items cannot be added to a published version');

-- authoring a new draft
select throws_ok($$ insert into public.instruments (owner_org_id, code, title) values (tests.uid('district'), 'T-1', 'x') $$,
  '42501', null, 'Trainer cannot file a stand-alone instrument under the district');
select throws_ok($$ insert into public.instruments (owner_org_id, course_id, code, title)
                   values (tests.uid('school_a'), tests.uid('course'), 'T-2', 'x') $$,
  '23514', null, 'Course instrument must belong to the course owner org');
select lives_ok($$ insert into public.instruments (owner_org_id, course_id, code, title)
                   values (tests.uid('district'), tests.uid('course'), 'T-3', 'แบบทดสอบท้ายหน่วย') returning id $$,
  'Trainer creates an instrument for the managed course (INSERT ... RETURNING)');
select lives_ok($$ insert into public.instrument_versions (instrument_id)
                   values ('80000000-0000-4000-a000-000000000001') returning id $$,
  'Trainer opens a new draft version');
select results_eq($$ select version_no, status, published_at from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and version_no = 2 $$,
  $$ values (2, 'draft'::text, null::timestamptz) $$, 'version_no and draft status are server-assigned');
select throws_ok($$ insert into public.instrument_versions (instrument_id) values ('80000000-0000-4000-a000-000000000001') $$,
  '23505', null, 'Only one draft per instrument');
select lives_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'mcq_multiple', 'ข้อรูปภาพ',
                     '{"options":[{"id":"a","image_path":"80000000-0000-4000-a000-000000000001/a.png"},{"id":"b","text":"ข"}]}', 1) $$,
  'Image choices under the instrument folder are accepted');

-- shape validation
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'mcq_single', 'x', '{"options":[{"id":"a","text":"ก","correct":true},{"id":"b","text":"ข"}]}', 2) $$,
  '23514', null, 'A correctness flag inside a choice is rejected');
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'mcq_single', 'x', '{"options":[{"id":"a","text":"ก"}]}', 2) $$,
  '23514', null, 'Fewer than two choices is rejected');
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'mcq_single', 'x', '{"options":[{"id":"a","text":"ก"},{"id":"a","text":"ข"}]}', 2) $$,
  '23514', null, 'Duplicate choice ids are rejected');
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'mcq_single', 'x', '{"options":"ab"}', 2) $$,
  '23514', null, 'Non-array options are rejected (no crash)');
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'true_false', 'x', '{"answer":true}', 2) $$,
  '23514', null, 'true_false takes no options (no key smuggling)');
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, media_path, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'true_false', 'x', 'other-folder/x.png', 2) $$,
  '23514', null, 'Media outside the instrument folder is rejected');
select throws_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, display_order)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), 'essay', 'x', 2) $$,
  '23514', null, 'Unknown item types are rejected');

-- assignments
select throws_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title)
                   values ((select id from public.instrument_versions where instrument_id = '80000000-0000-4000-a000-000000000001' and status = 'draft'), tests.uid('cohort'), 'formative', 'x') $$,
  '23514', null, 'A draft version cannot be assigned');
select throws_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, course_id, purpose, title)
                   values ('81000000-0000-4000-a000-000000000001', tests.uid('cohort'), tests.uid('draft_course'), 'formative', 'x') $$,
  '23514', null, 'Assignment course must be in the cohort''s program');
select lives_ok($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, course_id, purpose, title, attempt_limit, passing_percent)
                   values ('81000000-0000-4000-a000-000000000001', tests.uid('cohort'), tests.uid('course'), 'posttest', 'Posttest', 2, 70)
                   returning id $$,
  'Trainer assigns a published version to own cohort (INSERT ... RETURNING)');
reset role;

-- ---------- answer keys (written only by definer RPCs; trigger validates) ----------
select throws_ok($$ insert into private.instrument_answer_keys (item_id, answer_json)
                   values ((select id from public.instrument_items where prompt = 'ข้อรูปภาพ'), '{"correct":["z"]}') $$,
  '23514', null, 'Key pointing at a non-existent choice is rejected');
select throws_ok($$ insert into private.instrument_answer_keys (item_id, answer_json, scoring_json)
                   values ((select id from public.instrument_items where prompt = 'ข้อรูปภาพ'), '{"correct":["a"]}', '{"mode":"bonus"}') $$,
  '23514', null, 'Unknown scoring mode is rejected');
select lives_ok($$ insert into private.instrument_answer_keys (item_id, answer_json, scoring_json)
                   values ((select id from public.instrument_items where prompt = 'ข้อรูปภาพ'), '{"correct":["a","b"]}', '{"mode":"partial"}') $$,
  'Valid multi-answer key with partial credit is accepted');
select throws_ok($$ update private.instrument_answer_keys set answer_json = '{"correct":["a"]}'
                   where item_id = '82000000-0000-4000-a000-000000000001' $$,
  '23514', null, 'Keys of a published version cannot change');
update public.instrument_items set item_type = 'true_false', options_json = '{}'
 where prompt = 'ข้อรูปภาพ';
select is_empty($$ select 1 from private.instrument_answer_keys where item_id = (select id from public.instrument_items where prompt = 'ข้อรูปภาพ') $$,
  'Changing the item type drops the stale key');

-- ---------- version / attempt invariants ----------
select throws_ok($$ update public.instrument_versions set status = 'draft' where id = '81000000-0000-4000-a000-000000000001' $$,
  '23514', null, 'A published version cannot return to draft');
select throws_ok($$ update public.instrument_versions set content_hash = 'tampered' where id = '81000000-0000-4000-a000-000000000001' $$,
  '23514', null, 'content_hash of a published version is frozen');
select throws_ok($$ insert into public.assessment_attempts (assignment_id, user_id, attempt_no, status, submitted_at)
                   values ('83000000-0000-4000-a000-000000000001', tests.uid('teacher_a2'), 1, 'submitted', now()) $$,
  '23514', null, 'A submitted attempt must carry a score');
insert into public.assessment_attempts (assignment_id, user_id, attempt_no)
values ('83000000-0000-4000-a000-000000000001', tests.uid('teacher_a2'), 1);
select throws_ok($$ insert into public.assessment_attempts (assignment_id, user_id, attempt_no)
                   values ('83000000-0000-4000-a000-000000000001', tests.uid('teacher_a2'), 2) $$,
  '23505', null, 'Only one open attempt per person and assignment');
select throws_ok($$ update public.assessment_attempts set score = 5 where id = '84000000-0000-4000-a000-000000000001' $$,
  '23514', null, 'Score cannot exceed max_score');
update public.assessment_attempts set score = 3 where id = '84000000-0000-4000-a000-000000000001';
select ok(exists (select 1 from private.audit_logs
                   where table_name = 'public.assessment_attempts'
                     and record_id = '84000000-0000-4000-a000-000000000001'
                     and action = 'UPDATE'),
  'Changes to an attempt''s evidence (score, status, times) are audited');

-- ---------- revocation ----------
update public.cohort_memberships set status = 'withdrawn'
 where cohort_id = tests.uid('cohort') and user_id = tests.uid('trainer') and cohort_role = 'trainer';
select tests.authenticate_as('trainer');
select is_empty($$ select 1 from public.assessment_attempts $$, 'Withdrawn trainer no longer sees cohort attempts');
reset role;

select * from finish();
rollback;

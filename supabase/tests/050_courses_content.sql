-- Course content visibility (published vs draft) and authoring rights
begin;
select plan(16);

select tests.authenticate_as('teacher_a1');
select results_eq($$ select id from public.courses $$, $$ values (tests.uid('course')) $$,
  'Trainee sees only the published course they are enrolled in');
select is((select count(*)::int from public.lessons), 3, 'Trainee sees 3 published lessons (draft hidden)');
select is_empty($$ select 1 from public.lesson_blocks where lesson_id = tests.uid('draft_lesson') $$,
  'Blocks of a draft lesson are hidden from trainees');
select is_empty($$ select 1 from public.courses where id = tests.uid('draft_course') $$,
  'Draft course is hidden from trainees');
select throws_ok($$ insert into public.course_units (course_id, title, display_order) values (tests.uid('course'), 'x', 9) $$,
  '42501', null, 'Trainee cannot add units');
-- UPDATE that RLS filters out affects 0 rows (no error) — verify nothing changed
select lives_ok($$ update public.lessons set title = 'hacked' where id = tests.uid('lesson1') $$, 'trainee lesson update runs');
reset role;
select isnt((select title from public.lessons where id = tests.uid('lesson1')), 'hacked', '...but changes nothing');

select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.courses $$, 'Unrelated school admin sees no courses');
reset role;

select tests.authenticate_as('trainer');
select is((select count(*)::int from public.lessons), 4, 'Trainer of the cohort sees draft lessons too');
select lives_ok($$ update public.lessons set title = 'บทที่ 1.1 (ปรับปรุง)' where id = tests.uid('lesson1') $$,
  'Trainer edits a lesson of an assigned course');
select throws_ok($$ update public.course_units set course_id = tests.uid('draft_course') where id = tests.uid('unit1') $$,
  '42501', null, 'unit.course_id is immutable for clients');
select is_empty($$ select 1 from public.courses where id = tests.uid('draft_course') $$,
  'Trainer cannot see unrelated draft course');
reset role;
select is((select title from public.lessons where id = tests.uid('lesson1')), 'บทที่ 1.1 (ปรับปรุง)', 'trainer edit persisted');

select tests.authenticate_as('supervisor');
select ok(exists (select 1 from public.courses where id = tests.uid('draft_course')), 'Supervisor sees district draft courses');
select throws_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                    values (tests.uid('lesson2'), 'link', '{"url":"http://insecure.example.test"}', 9) $$,
  '23514', null, 'Non-HTTPS link block rejected by content validation');
select throws_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                    values (tests.uid('lesson2'), 'video', '{"provider":"youtube","video_id":"<script>"}', 9) $$,
  '23514', null, 'Malformed video id rejected');
reset role;

select * from finish();
rollback;

-- Course Builder: access hint, atomic reorder, publish flow, content hardening
begin;
select plan(27);

-- ---------- course_access ----------
select tests.authenticate_as('trainer');
select is(public.course_access(tests.uid('course')), 'manage', 'Cohort trainer manages the assigned course');
select is(public.course_access(tests.uid('draft_course')), 'none', 'Trainer has no access to an unrelated draft course');
reset role;
select tests.authenticate_as('teacher_a1');
select is(public.course_access(tests.uid('course')), 'view', 'Enrolled trainee may only view');
reset role;
select tests.authenticate_as('school_admin_b');
select is(public.course_access(tests.uid('course')), 'none', 'Unrelated school admin has no access');
reset role;
select tests.authenticate_as('supervisor');
select is(public.course_access(tests.uid('draft_course')), 'manage', 'District supervisor manages district courses');
reset role;

select tests.as_anon();
select throws_ok($$ select public.reorder_course_items('unit', tests.uid('course'), array[tests.uid('unit2'), tests.uid('unit1')]) $$,
  '42501', null, 'anon cannot execute reorder_course_items');
reset role;

-- ---------- reorder ----------
select tests.authenticate_as('trainer');
select lives_ok($$ select public.reorder_course_items('unit', tests.uid('course'), array[tests.uid('unit2'), tests.uid('unit1')]) $$,
  'Trainer swaps the two units atomically');
select results_eq($$ select id from public.course_units where course_id = tests.uid('course') order by display_order $$,
  $$ values (tests.uid('unit2')), (tests.uid('unit1')) $$, 'unit order persisted');
select lives_ok($$ select public.reorder_course_items('lesson', tests.uid('unit1'), array[tests.uid('lesson2'), tests.uid('lesson1')]) $$,
  'Trainer swaps lessons inside a unit');
select results_eq($$ select id from public.lessons where unit_id = tests.uid('unit1') order by display_order $$,
  $$ values (tests.uid('lesson2')), (tests.uid('lesson1')) $$, 'lesson order persisted');
select lives_ok($$ select public.reorder_course_items('block', tests.uid('lesson1'),
                     (select array_agg(id order by display_order desc) from public.lesson_blocks where lesson_id = tests.uid('lesson1'))) $$,
  'Trainer reverses the blocks of a lesson');
select is((select block_type from public.lesson_blocks where lesson_id = tests.uid('lesson1') order by display_order limit 1),
  'video', 'block order persisted');
select throws_ok($$ select public.reorder_course_items('unit', tests.uid('course'), array[tests.uid('unit1')]) $$,
  '22023', null, 'Partial id list is rejected');
select throws_ok($$ select public.reorder_course_items('unit', tests.uid('course'), array[tests.uid('unit1'), tests.uid('unit1')]) $$,
  '22023', null, 'Duplicate ids are rejected');
select throws_ok($$ select public.reorder_course_items('unit', tests.uid('course'), array[tests.uid('unit1'), tests.uid('lesson1')]) $$,
  '22023', null, 'Ids from another parent are rejected');
select throws_ok($$ select public.reorder_course_items('course', tests.uid('course'), array[tests.uid('unit1')]) $$,
  '22023', null, 'Unknown kind is rejected');
reset role;

select tests.authenticate_as('teacher_a1');
select throws_ok($$ select public.reorder_course_items('unit', tests.uid('course'), array[tests.uid('unit1'), tests.uid('unit2')]) $$,
  '42501', null, 'Trainee cannot reorder');
reset role;
select tests.authenticate_as('school_admin_b');
select throws_ok($$ select public.reorder_course_items('lesson', tests.uid('unit1'), array[tests.uid('lesson1'), tests.uid('lesson2')]) $$,
  '42501', null, 'Unrelated admin cannot reorder');
reset role;

-- ---------- publish flow ----------
select tests.authenticate_as('trainer');
select lives_ok($$ update public.lessons set status = 'published' where id = tests.uid('draft_lesson') $$,
  'Trainer publishes the draft lesson');
reset role;
select tests.authenticate_as('teacher_a1');
select ok(exists (select 1 from public.lessons where id = tests.uid('draft_lesson')),
  'Trainee sees the lesson once published');
reset role;

-- ---------- content hardening ----------
select tests.authenticate_as('trainer');
select throws_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                    values (tests.uid('lesson2'), 'rich_text', '{"html":"<p>x</p><script>alert(1)</script>"}', 9) $$,
  '23514', null, 'rich_text with <script> rejected by the database');
select throws_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                    values (tests.uid('lesson2'), 'rich_text', '{"html":"<img src=x onerror=alert(1)>"}', 9) $$,
  '23514', null, 'rich_text with inline event handler rejected');
select throws_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                    values (tests.uid('lesson2'), 'rich_text', '{"html":"<a href=\"javascript:alert(1)\">x</a>"}', 9) $$,
  '23514', null, 'rich_text with javascript: URL rejected');
select lives_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                   values (tests.uid('lesson2'), 'rich_text',
                           '{"html":"<h2>เกณฑ์</h2><p>metadata: ข้อมูล <strong>สำคัญ</strong> <a href=\"https://example.test\" rel=\"noopener\">ลิงก์</a></p>"}', 9) $$,
  'Ordinary formatted Thai rich text is accepted');
select throws_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                    values (tests.uid('lesson2'), 'image', json_build_object('object_path', tests.uid('lesson1') || '/x.png')::jsonb, 10) $$,
  '23514', null, 'Media path must be inside the block''s own lesson folder');
select throws_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                    values (tests.uid('lesson2'), 'image', json_build_object('object_path', tests.uid('lesson2') || '/../x.png')::jsonb, 10) $$,
  '23514', null, 'Path traversal in media path is rejected');
select lives_ok($$ insert into public.lesson_blocks (lesson_id, block_type, content_json, display_order)
                   values (tests.uid('lesson2'), 'image', json_build_object('object_path', tests.uid('lesson2') || '/fig.png', 'alt', 'แผนภาพ')::jsonb, 10) $$,
  'Image block pointing into own lesson folder is accepted');
reset role;

select * from finish();
rollback;

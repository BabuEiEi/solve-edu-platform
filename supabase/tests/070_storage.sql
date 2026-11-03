-- Private storage: buckets closed, object access follows lesson/profile scope
begin;
select plan(22);

-- ---------- fixtures (as postgres) ----------
-- A lesson inside the DRAFT course the cohort trainer does not manage
insert into public.course_units (id, course_id, title, display_order)
values ('50000000-0000-4000-a000-0000000000f1', tests.uid('draft_course'), 'หน่วยร่าง', 1);
insert into public.lessons (id, unit_id, title, display_order)
values ('60000000-0000-4000-a000-0000000000f1', '50000000-0000-4000-a000-0000000000f1', 'บทร่าง', 1);

insert into storage.objects (bucket_id, name) values
  ('lesson-media', tests.uid('lesson1') || '/seed-figure.png'),
  ('lesson-media', tests.uid('draft_lesson') || '/draft-figure.png'),
  ('avatars', tests.uid('teacher_a1') || '/avatar.png');

-- ---------- bucket configuration ----------
select results_eq(
  $$ select id, public from storage.buckets where id in ('lesson-media', 'avatars') order by id $$,
  $$ values ('avatars'::text, false), ('lesson-media'::text, false) $$,
  'lesson-media and avatars exist and are private');
select ok((select file_size_limit from storage.buckets where id = 'avatars') <= 2097152,
  'avatars bucket is size-limited');
select ok((select not ('text/html' = any (allowed_mime_types)) from storage.buckets where id = 'lesson-media'),
  'lesson-media does not accept text/html (no stored XSS via uploads)');

-- ---------- anonymous ----------
select tests.as_anon();
select is_empty($$ select 1 from storage.objects where bucket_id in ('lesson-media', 'avatars') $$,
  'anon sees no lesson media or avatars');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('lesson-media', tests.uid('lesson1') || '/x.png') $$,
  '42501', null, 'anon cannot upload lesson media');
reset role;

-- ---------- trainee ----------
select tests.authenticate_as('teacher_a1');
select ok(exists (select 1 from storage.objects where name = tests.uid('lesson1') || '/seed-figure.png'),
  'Enrolled trainee can read media of a published lesson');
select is_empty($$ select 1 from storage.objects where name = tests.uid('draft_lesson') || '/draft-figure.png' $$,
  'Trainee cannot read media of a draft lesson');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('lesson-media', tests.uid('lesson1') || '/evil.png') $$,
  '42501', null, 'Trainee cannot upload into a lesson folder');
-- The Storage API sets this flag for its own deletes; RLS must still filter.
do $$ begin perform set_config('storage.allow_delete_query', 'true', true); end $$;
select lives_ok($$ delete from storage.objects where name = tests.uid('lesson1') || '/seed-figure.png' $$,
  'trainee delete runs');
do $$ begin perform set_config('storage.allow_delete_query', 'false', true); end $$;
reset role;
select ok(exists (select 1 from storage.objects where name = tests.uid('lesson1') || '/seed-figure.png'),
  '...but deletes nothing');

select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from storage.objects where bucket_id = 'lesson-media' $$,
  'Unrelated school admin cannot read any lesson media');
reset role;

-- ---------- trainer (course manager via cohort) ----------
select tests.authenticate_as('trainer');
select lives_ok($$ insert into storage.objects (bucket_id, name) values ('lesson-media', tests.uid('lesson2') || '/diagram.png') $$,
  'Trainer uploads media into a lesson of an assigned course');
select ok(exists (select 1 from storage.objects where name = tests.uid('draft_lesson') || '/draft-figure.png'),
  'Trainer can read draft lesson media (preview)');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('lesson-media', '60000000-0000-4000-a000-0000000000f1/x.png') $$,
  '42501', null, 'Trainer cannot upload into a course they do not manage');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('lesson-media', 'not-a-uuid/x.png') $$,
  '42501', null, 'Malformed path is denied (not a 22P02 crash)');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('lesson-media', 'x.png') $$,
  '42501', null, 'Object outside any lesson folder is denied');
reset role;

-- ---------- avatars ----------
select tests.authenticate_as('teacher_a1');
select lives_ok($$ insert into storage.objects (bucket_id, name) values ('avatars', tests.uid('teacher_a1') || '/new.webp') $$,
  'User uploads into own avatar folder');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('avatars', tests.uid('teacher_a2') || '/new.webp') $$,
  '42501', null, 'User cannot upload into someone else''s avatar folder');
select throws_ok($$ update public.profiles set avatar_path = tests.uid('teacher_a2') || '/a.png' where id = tests.uid('teacher_a1') $$,
  '23514', null, 'avatar_path must point into own folder');
reset role;

select tests.authenticate_as('trainer');
select ok(exists (select 1 from storage.objects where name = tests.uid('teacher_a1') || '/avatar.png'),
  'Cohort trainer can see a trainee avatar (can_view_profile)');
reset role;

select tests.authenticate_as('teacher_a2');
select is_empty($$ select 1 from storage.objects where name = tests.uid('teacher_a1') || '/avatar.png' $$,
  'Classmate cannot see another trainee''s avatar');
reset role;

-- ---------- revocation ----------
update public.cohort_memberships set status = 'withdrawn'
 where cohort_id = tests.uid('cohort') and user_id = tests.uid('trainer') and cohort_role = 'trainer';
select tests.authenticate_as('trainer');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('lesson-media', tests.uid('lesson2') || '/after.png') $$,
  '42501', null, 'Withdrawn trainer can no longer upload');
reset role;

select * from finish();
rollback;

-- assessment-media bucket: private, images only, readable after starting an attempt
begin;
select plan(16);

-- ---------- fixtures (as postgres) ----------
-- A district instrument without a course: managed by district staff, not by the cohort trainer
insert into public.instruments (id, owner_org_id, code, title)
values ('80000000-0000-4000-a000-0000000000d1', tests.uid('district'), 'DIST-ONLY', 'แบบทดสอบระดับเขต');

insert into storage.objects (bucket_id, name) values
  ('assessment-media', tests.uid('quiz') || '/figure.png'),
  ('assessment-media', '80000000-0000-4000-a000-0000000000d1/secret.png');

-- ---------- bucket configuration ----------
select results_eq($$ select public, file_size_limit <= 5242880 from storage.buckets where id = 'assessment-media' $$,
  $$ values (false, true) $$, 'assessment-media is private and size-limited');
select ok((select allowed_mime_types <@ array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
             from storage.buckets where id = 'assessment-media'),
  'assessment-media accepts images only (no html/svg)');

-- ---------- anonymous ----------
select tests.as_anon();
select is_empty($$ select 1 from storage.objects where bucket_id = 'assessment-media' $$, 'anon sees nothing');
reset role;

-- ---------- trainee ----------
select tests.authenticate_as('teacher_a1');
select is_empty($$ select 1 from storage.objects where bucket_id = 'assessment-media' $$,
  'Trainee cannot see test images before starting an attempt');
select lives_ok($$ select * from public.start_attempt(tests.uid('pretest')) $$, 'Trainee starts the pretest');
select ok(exists (select 1 from storage.objects where name = tests.uid('quiz') || '/figure.png'),
  'Trainee can see the images of the test they started');
select is_empty($$ select 1 from storage.objects where name = '80000000-0000-4000-a000-0000000000d1/secret.png' $$,
  'Trainee cannot see images of another instrument');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('assessment-media', tests.uid('quiz') || '/x.png') $$,
  '42501', null, 'Trainee cannot upload test images');
reset role;

select tests.authenticate_as('teacher_a2');
select is_empty($$ select 1 from storage.objects where bucket_id = 'assessment-media' $$,
  'Classmate without an attempt still sees nothing');
reset role;

select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from storage.objects where bucket_id = 'assessment-media' $$,
  'Unrelated admin sees nothing');
reset role;

-- ---------- authors ----------
select tests.authenticate_as('trainer');
select lives_ok($$ insert into storage.objects (bucket_id, name) values ('assessment-media', tests.uid('quiz') || '/new.png') $$,
  'Trainer uploads into an instrument of the managed course');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('assessment-media', '80000000-0000-4000-a000-0000000000d1/x.png') $$,
  '42501', null, 'Trainer cannot upload into an instrument they do not manage');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('assessment-media', 'not-a-uuid/x.png') $$,
  '42501', null, 'Malformed path is denied');
select is_empty($$ select 1 from storage.objects where name = '80000000-0000-4000-a000-0000000000d1/secret.png' $$,
  'Trainer cannot read another instrument''s images');
reset role;

select tests.authenticate_as('supervisor');
select ok(exists (select 1 from storage.objects where name = '80000000-0000-4000-a000-0000000000d1/secret.png'),
  'District supervisor reads district instrument images');
select lives_ok($$ insert into storage.objects (bucket_id, name) values ('assessment-media', '80000000-0000-4000-a000-0000000000d1/y.png') $$,
  'District supervisor uploads into a district instrument');
reset role;

select * from finish();
rollback;

-- Unused quiz images can be deleted; images any version still uses cannot
-- be deleted or overwritten (published versions included).
begin;
select plan(10);

insert into storage.objects (bucket_id, name) values
  ('assessment-media', tests.uid('quiz') || '/used-question.png'),
  ('assessment-media', tests.uid('quiz') || '/used-choice.png'),
  ('assessment-media', tests.uid('quiz') || '/unused-1.png'),
  ('assessment-media', tests.uid('quiz') || '/unused-2.png');

-- A new version of the demo quiz that uses two of the images, then published
select tests.authenticate_as('trainer');
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz'));
insert into public.instrument_items (instrument_version_id, item_type, prompt, media_path, options_json, max_score, display_order)
select v.id, 'mcq_single', 'ภาพใด', tests.uid('quiz') || '/used-question.png',
       jsonb_build_object('options', jsonb_build_array(
         jsonb_build_object('id', 'a', 'image_path', tests.uid('quiz') || '/used-choice.png'),
         jsonb_build_object('id', 'b', 'text', 'ไม่ใช่'))), 1, 1
  from public.instrument_versions v where v.instrument_id = tests.uid('quiz') and v.status = 'draft';
select public.set_item_key(i.id, '{"correct":["a"]}', '{}')
  from public.instrument_items i join public.instrument_versions v on v.id = i.instrument_version_id
 where v.instrument_id = tests.uid('quiz') and v.status = 'draft';
select public.publish_instrument_version(v.id)
  from public.instrument_versions v where v.instrument_id = tests.uid('quiz') and v.status = 'draft';
reset role;

select ok(not has_function_privilege('anon', 'authz.assessment_media_in_use(text)', 'execute'),
  'anon cannot probe image usage');

select tests.authenticate_as('trainer');
select results_eq($$ select authz.assessment_media_in_use(tests.uid('quiz') || '/used-question.png'),
                            authz.assessment_media_in_use(tests.uid('quiz') || '/used-choice.png'),
                            authz.assessment_media_in_use(tests.uid('quiz') || '/unused-1.png') $$,
  $$ values (true, true, false) $$, 'Question and choice images of a published version count as used');
select set_config('storage.allow_delete_query', 'true', true);  -- as the Storage API does
delete from storage.objects where name in (tests.uid('quiz') || '/used-question.png', tests.uid('quiz') || '/used-choice.png');
select is((select count(*)::int from storage.objects where name like tests.uid('quiz') || '/used-%'), 2,
  'The author cannot delete images that a version uses');
update storage.objects set name = tests.uid('quiz') || '/renamed.png' where name = tests.uid('quiz') || '/used-question.png';
select ok(exists (select 1 from storage.objects where name = tests.uid('quiz') || '/used-question.png'),
  'Used images cannot be overwritten or moved');
select throws_ok($$ update storage.objects set name = tests.uid('quiz') || '/used-choice.png'
                     where name = tests.uid('quiz') || '/unused-2.png' $$,
  '42501', null, 'An unused image cannot be moved onto a used path');
delete from storage.objects where name = tests.uid('quiz') || '/unused-1.png';
select is_empty(format('select 1 from storage.objects where name = %L', tests.uid('quiz') || '/unused-1.png'),
  'The author deletes an unused image');
reset role;

select tests.authenticate_as('teacher_a1');
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where name = tests.uid('quiz') || '/unused-2.png';
reset role;
select tests.authenticate_as('school_admin_b');
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where name = tests.uid('quiz') || '/unused-2.png';
reset role;
select isnt_empty(format('select 1 from storage.objects where name = %L', tests.uid('quiz') || '/unused-2.png'),
  'Trainees and unrelated admins cannot delete quiz images');

select tests.authenticate_as('teacher_a1');
select ok(not authz.assessment_media_in_use('not-a-uuid/x.png'), 'A malformed path is simply "not used" (no error)');
reset role;

-- the cleanup also keeps working for lesson-media (policies are per bucket)
select ok(exists (select 1 from pg_policies where tablename = 'objects' and policyname = 'lesson_media_delete'),
  'lesson-media delete policy unchanged');
select ok((select qual from pg_policies where tablename = 'objects' and policyname = 'assessment_media_delete')
            like '%assessment_media_in_use%', 'assessment-media delete policy checks usage');

select * from finish();
rollback;

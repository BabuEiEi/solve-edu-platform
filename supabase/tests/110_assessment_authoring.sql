-- Assessment authoring RPCs: write-only keys, publish gate, clone, reorder
begin;
select plan(39);

-- ---------- privileges ----------
select ok(not has_function_privilege('anon', 'public.set_item_key(uuid,jsonb,jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.item_key_status(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.publish_instrument_version(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.clone_instrument_version(uuid)', 'execute'),
  'anon cannot execute any authoring RPC');
select ok(not has_function_privilege('authenticated', 'private.version_content_hash(uuid)', 'execute'),
  'private helpers are not executable by clients');
select is((select prosecdef from pg_proc where oid = 'public.reorder_course_items(text,uuid,uuid[])'::regprocedure),
  false, 'reorder_course_items stays SECURITY INVOKER');

-- ---------- seed sanity ----------
select results_eq($$ select status, content_hash = private.version_content_hash(id)
                     from public.instrument_versions where id = tests.uid('quiz_v1') $$,
  $$ values ('published'::text, true) $$, 'Demo quiz is published with the canonical content hash');

-- ---------- outsiders ----------
select tests.authenticate_as('teacher_a1');
select throws_ok($$ select public.set_item_key(tests.uid('q_single'), '{"correct":["a"]}') $$,
  '42501', null, 'Trainee cannot set a key');
select throws_ok($$ select * from public.item_key_status(tests.uid('quiz_v1')) $$,
  '42501', null, 'Trainee cannot see key status');
select throws_ok($$ select public.clone_instrument_version(tests.uid('quiz_v1')) $$,
  '42501', null, 'Trainee cannot clone a version');
select throws_ok($$ select public.publish_instrument_version(tests.uid('quiz_v1')) $$,
  '42501', null, 'Trainee cannot publish');
reset role;

select tests.authenticate_as('school_admin_b');
select throws_ok($$ select public.clone_instrument_version(tests.uid('quiz_v1')) $$,
  '42501', null, 'Unrelated admin cannot clone');
select throws_ok($$ select public.set_item_key('00000000-0000-4000-a000-0000000000ff', '{"correct":true}') $$,
  '42501', null, 'Unknown item id is "not allowed" (existence not revealed)');
reset role;

-- ---------- trainer: clone → edit → publish ----------
select tests.authenticate_as('trainer');
select results_eq($$ select count(*)::int, bool_and(has_key), bool_and(key_valid) from public.item_key_status(tests.uid('quiz_v1')) $$,
  $$ values (4, true, true) $$, 'Key status of the published demo quiz: 4 items, all valid');
select is((select count(*)::int
             from information_schema.routines r
             join information_schema.parameters p on p.specific_name = r.specific_name
            where r.routine_schema = 'public' and r.routine_name = 'item_key_status'
              and p.parameter_mode = 'OUT' and p.parameter_name not in ('item_id', 'has_key', 'key_valid')),
  0, 'item_key_status returns no key content columns');
select throws_ok($$ select public.set_item_key(tests.uid('q_single'), '{"correct":["a"]}') $$,
  '23514', null, 'Keys of the published version cannot be replaced');

select lives_ok($$ select public.clone_instrument_version(tests.uid('quiz_v1')) $$, 'Trainer clones the published version');
select results_eq($$ select version_no, status from public.instrument_versions
                     where instrument_id = tests.uid('quiz') order by version_no $$,
  $$ values (1, 'published'::text), (2, 'draft'::text) $$, 'Clone is version 2, draft');
select throws_ok($$ select public.clone_instrument_version(tests.uid('quiz_v1')) $$,
  '23505', null, 'Cannot clone while a draft exists');
select results_eq($$ select count(*)::int, bool_and(has_key) from public.item_key_status(
                       (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft')) $$,
  $$ values (4, true) $$, 'Items and keys were copied into the draft');
reset role;
select is((select private.version_content_hash(id) from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft'),
          (select content_hash from public.instrument_versions where id = tests.uid('quiz_v1')),
  'Identical content gives the identical hash');
select is((select array_agg(k.answer_json order by i.display_order)
             from public.instrument_items i join private.instrument_answer_keys k on k.item_id = i.id
             join public.instrument_versions v on v.id = i.instrument_version_id
            where v.instrument_id = tests.uid('quiz') and v.status = 'draft'),
          (select array_agg(k.answer_json order by i.display_order)
             from public.instrument_items i join private.instrument_answer_keys k on k.item_id = i.id
            where i.instrument_version_id = tests.uid('quiz_v1')),
  'Cloned keys match the source keys');

select tests.authenticate_as('trainer');
-- edit the draft: new item without a key blocks publishing
select lives_ok($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                   values ((select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft'),
                           'mcq_single', 'ข้อใหม่', '{"options":[{"id":"a","text":"ก"},{"id":"b","text":"ข"},{"id":"c","text":"ค"}]}', 5) $$,
  'Trainer adds an item to the draft');
select results_eq($$ select has_key, key_valid from public.item_key_status(
                       (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft'))
                     offset 4 $$,
  $$ values (false, false) $$, 'New item shows "no key"');
select throws_ok($$ select public.publish_instrument_version(
                     (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft')) $$,
  '23514', null, 'Publishing with a missing key is refused');

select throws_ok($$ select public.set_item_key((select id from public.instrument_items where prompt = 'ข้อใหม่'), '{"correct":["a","b"]}') $$,
  '23514', null, 'mcq_single key with two answers is rejected');
select lives_ok($$ select public.set_item_key((select id from public.instrument_items where prompt = 'ข้อใหม่'), '{"correct":["c"]}') $$,
  'Trainer sets the key');
select lives_ok($$ select public.set_item_key((select id from public.instrument_items where prompt = 'ข้อใหม่'), '{"correct":["b"]}') $$,
  'Trainer replaces the key (upsert)');

-- removing the keyed choice afterwards invalidates the key
update public.instrument_items
   set options_json = '{"options":[{"id":"a","text":"ก"},{"id":"c","text":"ค"}]}'
 where prompt = 'ข้อใหม่';
select results_eq($$ select has_key, key_valid from public.item_key_status(
                       (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft'))
                     offset 4 $$,
  $$ values (true, false) $$, 'Key status flags a key whose choice was removed');
select throws_ok($$ select public.publish_instrument_version(
                     (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft')) $$,
  '23514', null, 'Publishing with a stale key is refused');
select lives_ok($$ select public.set_item_key((select id from public.instrument_items where prompt = 'ข้อใหม่'), '{"correct":["c"]}') $$,
  'Trainer fixes the key');

-- reorder the draft (last item first), then publish
select lives_ok($$ select public.reorder_course_items('item',
                     (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft'),
                     (select array_agg(id order by display_order desc) from public.instrument_items
                       where instrument_version_id = (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft'))) $$,
  'Trainer reorders the draft items');
select throws_ok($$ select public.reorder_course_items('item', tests.uid('quiz_v1'),
                     array[tests.uid('q_numeric'), tests.uid('q_truefalse'), tests.uid('q_multiple'), tests.uid('q_single')]) $$,
  '23514', null, 'Items of a published version cannot be reordered');
select lives_ok($$ select public.publish_instrument_version(
                     (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft')) $$,
  'Trainer publishes version 2');
select results_eq($$ select status, published_by, content_hash ~ '^[0-9a-f]{64}$'
                     from public.instrument_versions where instrument_id = tests.uid('quiz') and version_no = 2 $$,
  $$ values ('published'::text, tests.uid('trainer'), true) $$, 'Version 2 is published by the trainer with a sha256 hash');
select throws_ok($$ select public.publish_instrument_version(
                     (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and version_no = 2)) $$,
  '23514', null, 'A published version cannot be published again');

-- an empty draft cannot be published
select lives_ok($$ insert into public.instrument_versions (instrument_id) values (tests.uid('quiz')) $$, 'Trainer opens an empty draft');
select throws_ok($$ select public.publish_instrument_version(
                     (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft')) $$,
  '23514', null, 'An empty version cannot be published');
reset role;

-- ---------- hash excludes keys; audit has no key content ----------
select is((select private.version_content_hash(tests.uid('quiz_v1'))),
          (select content_hash from public.instrument_versions where id = tests.uid('quiz_v1')),
  'Hash is reproducible from item content alone');
select ok((select count(*) from private.audit_logs where action = 'SET_ANSWER_KEY' and actor_id = tests.uid('trainer')) = 3
      and not exists (select 1 from private.audit_logs where action = 'SET_ANSWER_KEY' and after_json::text like '%correct%'),
  'Each key change is audited without the key itself');
select ok(exists (select 1 from private.audit_logs where action = 'CLONE_VERSION' and actor_id = tests.uid('trainer')),
  'Cloning is audited');

-- ---------- revocation ----------
update public.cohort_memberships set status = 'withdrawn'
 where cohort_id = tests.uid('cohort') and user_id = tests.uid('trainer') and cohort_role = 'trainer';
select tests.authenticate_as('trainer');
select throws_ok($$ select * from public.item_key_status(tests.uid('quiz_v1')) $$,
  '42501', null, 'Withdrawn trainer loses authoring rights');
reset role;

select * from finish();
rollback;

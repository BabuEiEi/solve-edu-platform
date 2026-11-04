-- Phase 2C group A: ordering, matching, classification, choice matrix —
-- shapes, keys, responses, scoring, image paths, server-side shuffle.
begin;
select plan(42);

create temporary table fx (k text primary key, j jsonb);
insert into fx values
  ('ord',  '{"options":[{"id":"c","text":"ขั้น 3"},{"id":"a","text":"ขั้น 1"},{"id":"d","text":"ขั้น 4"},{"id":"b","text":"ขั้น 2"}]}'),
  ('mat',  '{"left":[{"id":"l1","text":"ก"},{"id":"l2","text":"ข"},{"id":"l3","text":"ค"}],
            "right":[{"id":"r3","text":"3"},{"id":"r1","text":"1"},{"id":"r4","text":"ตัวลวง"},{"id":"r2","text":"2"}]}'),
  ('cls',  '{"categories":[{"id":"c1","text":"ประเมินเพื่อการเรียนรู้"},{"id":"c2","text":"ประเมินผลสรุป"}],
            "items":[{"id":"i1","text":"ให้ข้อมูลย้อนกลับ"},{"id":"i2","text":"ถามระหว่างสอน"},{"id":"i3","text":"สอบปลายภาค"},{"id":"i4","text":"ตัดเกรด"}]}'),
  ('mtx',  '{"rows":[{"id":"w1","text":"ข้อความ 1"},{"id":"w2","text":"ข้อความ 2"},{"id":"w3","text":"ข้อความ 3"}],
            "columns":[{"id":"t","text":"ถูก"},{"id":"f","text":"ผิด"}]}');
create or replace function pg_temp.fx(p text) returns jsonb language sql stable as $$ select j from fx where k = p $$;
grant select on fx to authenticated;

-- ---------- shapes ----------
select is(private.item_shape_error('ordering', pg_temp.fx('ord')), null, 'ordering: 4 entries is a valid shape');
select isnt(private.item_shape_error('ordering', '{"options":[{"id":"a","text":"1"},{"id":"b","text":"2"}]}'), null,
  'ordering needs at least 3 entries');
select isnt(private.item_shape_error('matching', '{"left":[{"id":"l1","text":"x"},{"id":"l2","text":"y"}],"right":[{"id":"r1","text":"1"}]}'), null,
  'matching: right needs at least as many entries as left');
select isnt(private.item_shape_error('matching', pg_temp.fx('mat') || '{"pairs":{}}'), null, 'matching: no extra keys (no key smuggled in)');
select is(private.item_shape_error('classification', pg_temp.fx('cls')), null, 'classification: valid shape');
select is(private.item_shape_error('choice_matrix', pg_temp.fx('mtx')), null, 'choice_matrix: valid shape');
select isnt(private.item_shape_error('choice_matrix', jsonb_build_object('rows', pg_temp.fx('mtx') -> 'rows',
  'columns', (select jsonb_agg(jsonb_build_object('id', 'c' || g, 'text', 'x')) from generate_series(1, 7) g))), null,
  'choice_matrix: at most 6 columns');
select isnt(private.item_shape_error('classification', '{"categories":[{"id":"c1","text":"x"},{"id":"c2","text":"y"}],
  "items":[{"id":"i1","text":"a"},{"id":"i1","text":"b"}]}'), null, 'duplicate ids are refused');
select isnt(private.item_shape_error('ordering', '{"options":[{"id":"a","text":"1","correct":true},{"id":"b","text":"2"},{"id":"c","text":"3"}]}'), null,
  'an entry cannot carry the answer');
select ok(private.item_shape_error('mcq_single', '{"options":[{"id":"a","text":"x"},{"id":"b","text":"y"}]}') is null
      and private.item_shape_error('mcq_single', '{"options":[{"id":"a","text":"x"},{"id":"b","text":"y"}],"x":1}') is not null,
  'MCQ shapes unchanged');

-- ---------- keys ----------
select is(private.answer_key_error('ordering', pg_temp.fx('ord'), '{"order":["a","b","c","d"]}', '{}'), null, 'ordering key = full order');
select isnt(private.answer_key_error('ordering', pg_temp.fx('ord'), '{"order":["a","b","c","c"]}', '{}'), null,
  'ordering key must list every option exactly once');
select is(private.answer_key_error('matching', pg_temp.fx('mat'), '{"slots":{"l1":"r1","l2":"r2","l3":"r3"}}', '{}'), null,
  'matching key: every left paired');
select isnt(private.answer_key_error('matching', pg_temp.fx('mat'), '{"slots":{"l1":"r1","l2":"r1","l3":"r3"}}', '{}'), null,
  'matching key: a right entry is used once');
select isnt(private.answer_key_error('matching', pg_temp.fx('mat'), '{"slots":{"l1":"r1","l2":"r2"}}', '{}'), null,
  'matching key: no left left out');
select isnt(private.answer_key_error('classification', pg_temp.fx('cls'), '{"slots":{"i1":"c1","i2":"c1","i3":"c2","i4":"c9"}}', '{}'), null,
  'classification key: categories must exist');
select is(private.answer_key_error('choice_matrix', pg_temp.fx('mtx'), '{"slots":{"w1":"t","w2":"f","w3":"t"}}', '{"mode":"all_or_nothing"}'), null,
  'choice_matrix key with all-or-nothing scoring');
select isnt(private.answer_key_error('choice_matrix', pg_temp.fx('mtx'), '{"slots":{"w1":"t","w2":"f","w3":"t"}}', '{"mode":"half"}'), null,
  'unknown scoring mode is refused');

-- ---------- responses ----------
select is(private.response_error('ordering', pg_temp.fx('ord'), '{"order":["d","c","b","a"]}'), null, 'ordering response: a full permutation');
select isnt(private.response_error('ordering', pg_temp.fx('ord'), '{"order":["a","b"]}'), null, 'ordering response must be complete');
select is(private.response_error('classification', pg_temp.fx('cls'), '{"slots":{"i1":"c2"}}'), null,
  'slot responses may leave slots empty');
select isnt(private.response_error('matching', pg_temp.fx('mat'), '{"slots":{"l9":"r1"}}'), null, 'unknown slot is refused');
select isnt(private.response_error('matching', pg_temp.fx('mat'), '{"slots":{"l1":"l2"}}'), null,
  'a value must be one of that slot''s choices');

-- ---------- scoring ----------
select results_eq($$ select private.score_response('ordering', '{"order":["a","b","c","d"]}', '{}', '{"order":["a","b","d","c"]}'),
                            private.score_response('ordering', '{"order":["a","b","c","d"]}', '{"mode":"all_or_nothing"}', '{"order":["a","b","d","c"]}') $$,
  $$ values (0.5::numeric, 0::numeric) $$, 'ordering: partial = positions right / n (default); all-or-nothing = 0');
select is(round(private.score_response('matching', '{"slots":{"l1":"r1","l2":"r2","l3":"r3"}}', '{}', '{"slots":{"l1":"r1","l2":"r2","l3":"r4"}}'), 3),
  0.667, 'matching: 2 of 3 pairs');
select results_eq($$ select private.score_response('classification', '{"slots":{"i1":"c1","i2":"c1","i3":"c2","i4":"c2"}}', '{"mode":"all_or_nothing"}',
                                                   '{"slots":{"i1":"c1","i2":"c1","i3":"c2","i4":"c1"}}'),
                            private.score_response('classification', '{"slots":{"i1":"c1","i2":"c1","i3":"c2","i4":"c2"}}', '{"mode":"all_or_nothing"}',
                                                   '{"slots":{"i1":"c1","i2":"c1","i3":"c2","i4":"c2"}}') $$,
  $$ values (0::numeric, 1::numeric) $$, 'classification: all-or-nothing');
select is(private.score_response('choice_matrix', '{"slots":{"w1":"t","w2":"f","w3":"t"}}', '{}', '{"slots":{}}'), 0::numeric,
  'empty slot answers score 0');

-- ---------- image paths in any list ----------
select tests.authenticate_as('trainer');
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz'));
create temporary table v as select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft';
select throws_ok(format($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                           values (%L, 'matching', 'x', %L, 9) $$,
                        (select id from v),
                        jsonb_build_object('left', jsonb_build_array(jsonb_build_object('id', 'l1', 'image_path', 'other-folder/x.png'),
                                                                     jsonb_build_object('id', 'l2', 'text', 'y')),
                                           'right', pg_temp.fx('mat') -> 'right')),
  '23514', null, 'Images in the left list must be under the quiz folder too');

-- ---------- authoring flow ----------
insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
select (select id from v), t, 'ข้อ ' || t, pg_temp.fx(k), n
  from (values ('ordering', 'ord', 1), ('matching', 'mat', 2), ('classification', 'cls', 3), ('choice_matrix', 'mtx', 4)) x(t, k, n);
select lives_ok(format($$ select public.set_item_key(i.id, k.a, '{}')
                            from public.instrument_items i
                            join (values ('ordering', '{"order":["a","b","c","d"]}'::jsonb),
                                         ('matching', '{"slots":{"l1":"r1","l2":"r2","l3":"r3"}}'),
                                         ('classification', '{"slots":{"i1":"c1","i2":"c1","i3":"c2","i4":"c2"}}'),
                                         ('choice_matrix', '{"slots":{"w1":"t","w2":"f","w3":"t"}}')) k(t, a) on k.t = i.item_type
                           where i.instrument_version_id = %L $$, (select id from v)),
  'Trainer sets the four keys');
select is((select count(*)::int from public.item_key_status((select id from v)) where has_key and key_valid), 4,
  'All four keys are valid');
select lives_ok(format('select public.publish_instrument_version(%L)', (select id from v)), 'The version publishes');
create temporary table a (k text primary key, id uuid);
grant select, insert on a to authenticated;
with r as (insert into public.assessment_assignments
             (instrument_version_id, cohort_id, purpose, title, close_at, status)
           values ((select id from v), tests.uid('cohort'), 'formative', 'ไม่สลับ', now() + interval '1 day', 'published') returning id)
insert into a select 'plain', id from r;
with r as (insert into public.assessment_assignments
             (instrument_version_id, cohort_id, purpose, title, close_at, status, shuffle_items, shuffle_choices)
           values ((select id from v), tests.uid('cohort'), 'formative', 'สลับ', now() + interval '1 day', 'published', true, true) returning id)
insert into a select 'shuffled', id from r;
reset role;

-- images are found in every list (folder check and "still in use" both rely on this)
select is((select array_agg(p order by p) from private.options_media_paths(
            '{"categories":[{"id":"c1","text":"x"}],"items":[{"id":"i1","image_path":"Q/item.png"}],"right":[{"id":"r1","image_path":"Q/right.png"}]}') p),
          array['Q/item.png', 'Q/right.png'], 'Image paths are collected from every list of an item');

-- ---------- presentation ----------
select tests.authenticate_as('teacher_a1');
create temporary table p1 as select attempt_id, presentation from public.start_attempt((select id from a where k = 'plain'));
create temporary table items as
  select i.id, i.item_type, i.display_order from public.instrument_items i where i.instrument_version_id = (select id from v);
select is((select presentation -> 'items' from p1),
          (select jsonb_agg(id order by display_order) from items),
  'Without shuffle_items the items keep the authored order');
select is((select array_agg(k order by k) from p1, jsonb_object_keys(p1.presentation -> 'lists') k),
          (select array_agg(id::text order by id::text) from items where item_type in ('ordering', 'matching')),
  'Without shuffle_choices only ordering and matching lists are shuffled');
select ok((select (presentation -> 'lists' -> (select id::text from items where item_type = 'ordering') -> 'options')
                    <> '["a","b","c","d"]'::jsonb
              and (select array_agg(x order by x) from jsonb_array_elements_text(
                     presentation -> 'lists' -> (select id::text from items where item_type = 'ordering') -> 'options') x)
                    = array['a','b','c','d']
             from p1),
  'The ordering list is a permutation that never starts in the correct order');
select ok((select presentation -> 'lists' -> (select id::text from items where item_type = 'matching') ? 'right'
              and not presentation -> 'lists' -> (select id::text from items where item_type = 'matching') ? 'left' from p1),
  'Matching: the right column is shuffled, the left only on request');
select is((select presentation_json from public.assessment_attempts where id = (select attempt_id from p1)),
          (select presentation from p1), 'The presentation is stored on the attempt (and readable by its owner)');
select is((select presentation from public.start_attempt((select id from a where k = 'plain'))), (select presentation from p1),
  'Resuming shows the same order');

create temporary table p2 as select presentation from public.start_attempt((select id from a where k = 'shuffled'));
select is((select array_agg(x order by x) from p2, jsonb_array_elements_text(p2.presentation -> 'items') x),
          (select array_agg(id::text order by id::text) from items),
  'With shuffle_items the items are a permutation of all items');
select is((select count(*)::int from p2, jsonb_each(p2.presentation -> 'lists') kv, jsonb_object_keys(kv.value) l), 5,
  'With shuffle_choices: ordering, matching (right + left), classification items, matrix rows');

-- ---------- submit ----------
select results_eq(format($$ select score, max_score from public.submit_attempt(%L, jsonb_build_object(
                            %L, '{"order":["a","b","d","c"]}'::jsonb,
                            %L, '{"slots":{"l1":"r1","l2":"r2","l3":"r4"}}'::jsonb,
                            %L, '{"slots":{"i1":"c1","i2":"c1","i3":"c2","i4":"c2"}}'::jsonb,
                            %L, '{"slots":{"w1":"t"}}'::jsonb)) $$,
                         (select attempt_id from p1),
                         (select id from items where item_type = 'ordering'),
                         (select id from items where item_type = 'matching'),
                         (select id from items where item_type = 'classification'),
                         (select id from items where item_type = 'choice_matrix')),
  $$ values (2.50::numeric, 4.00::numeric) $$, 'Server scores the mix: 0.5 + 0.67 + 1 + 0.33 = 2.50 of 4');
reset role;

-- 200 fresh builds: an ordering list never starts in the correct order (without the rule, ~1 in 24 would)
select ok((select bool_and(private.build_presentation((select id from v), false, false)
                             -> 'lists' -> (select id::text from items where item_type = 'ordering') -> 'options'
                           <> '["a","b","c","d"]'::jsonb)
             from generate_series(1, 200)),
  'Ordering never starts solved (200 builds)');

select * from finish();
rollback;

-- Phase 2C group B: dropdown, cloze, image labelling — shapes, keys,
-- responses, Thai answer matching, scoring, shuffle.
begin;
select plan(36);

create temporary table fx (k text primary key, j jsonb);
insert into fx values
  ('dd',  '{"text":"การประเมิน {{b1}} ใช้ {{b2}} เพื่อปรับการสอน",
            "blanks":[{"id":"b1","options":[{"id":"a","text":"ระหว่างเรียน"},{"id":"b","text":"ปลายภาค"}]},
                      {"id":"b2","options":[{"id":"x","text":"ข้อมูลย้อนกลับ"},{"id":"y","text":"เกรด"},{"id":"z","text":"การจัดอันดับ"}]}]}'),
  ('cz',  '{"text":"{{b1}} คือการประเมินเพื่อการเรียนรู้ ผ่านเกณฑ์ {{b2}} %",
            "blanks":[{"id":"b1"},{"id":"b2","kind":"number"}]}'),
  ('lb',  '{"markers":[{"id":"m1","x":20,"y":30},{"id":"m2","x":55.5,"y":40},{"id":"m3","x":80,"y":75}],
            "labels":[{"id":"p","text":"เป้าหมาย"},{"id":"q","text":"หลักฐาน"},{"id":"r","text":"ข้อมูลย้อนกลับ"},{"id":"s","text":"ตัวลวง"}]}');
create or replace function pg_temp.fx(p text) returns jsonb language sql stable as $$ select j from fx where k = p $$;
grant select on fx to authenticated;
create temporary table ck (j jsonb);
insert into ck values ('{"blanks":{"b1":{"accept":["AfL","การประเมินเพื่อการเรียนรู้"]},"b2":{"value":80,"tolerance":0}}}');
create or replace function pg_temp.ck() returns jsonb language sql stable as $$ select j from ck $$;
grant select on ck to authenticated;

-- ---------- shapes ----------
select is(private.item_shape_error('dropdown', pg_temp.fx('dd')), null, 'dropdown: valid shape');
select isnt(private.item_shape_error('dropdown', jsonb_set(pg_temp.fx('dd'), '{text}', '"มีแค่ {{b1}}"')), null,
  'dropdown: every blank must appear in the text');
select isnt(private.item_shape_error('dropdown', jsonb_set(pg_temp.fx('dd'), '{text}', '"{{B1}} และ {{b2}}"')), null,
  'dropdown: malformed placeholders are refused');
select isnt(private.item_shape_error('dropdown', jsonb_set(pg_temp.fx('dd'), '{blanks,0,options,0,image_path}', '"q/x.png"')), null,
  'dropdown options are text only');
select is(private.item_shape_error('cloze', pg_temp.fx('cz')), null, 'cloze: text and number blanks');
select isnt(private.item_shape_error('cloze', jsonb_set(pg_temp.fx('cz'), '{blanks,0,kind}', '"date"')), null,
  'cloze: blank kind is text or number');
select isnt(private.item_shape_error('cloze', jsonb_set(pg_temp.fx('cz'), '{blanks,0,accept}', '["AfL"]')), null,
  'cloze: an answer cannot sit in the item');
select is(private.item_shape_error('image_labelling', pg_temp.fx('lb')), null, 'image_labelling: valid shape');
select isnt(private.item_shape_error('image_labelling', jsonb_set(pg_temp.fx('lb'), '{markers,0,x}', '120')), null,
  'image_labelling: markers are percentages of the image');
select isnt(private.item_shape_error('image_labelling', jsonb_set(pg_temp.fx('lb'), '{labels,0,image_path}', '"q/x.png"')), null,
  'image_labelling: labels are text only');

-- ---------- keys ----------
select is(private.answer_key_error('dropdown', pg_temp.fx('dd'), '{"slots":{"b1":"a","b2":"x"}}', '{}'), null, 'dropdown key');
select isnt(private.answer_key_error('dropdown', pg_temp.fx('dd'), '{"slots":{"b1":"x","b2":"x"}}', '{}'), null,
  'dropdown key: a blank takes only its own options');
select is(private.answer_key_error('cloze', pg_temp.fx('cz'), pg_temp.ck(), '{}'), null, 'cloze key: accepted texts and a number');
select isnt(private.answer_key_error('cloze', pg_temp.fx('cz'), '{"blanks":{"b1":{"accept":["  "]},"b2":{"value":80}}}', '{}'), null,
  'cloze key: an accepted answer cannot be blank');
select isnt(private.answer_key_error('cloze', pg_temp.fx('cz'), '{"blanks":{"b1":{"accept":["AfL"]},"b2":{"accept":["80"]}}}', '{}'), null,
  'cloze key: a number blank needs a value');
select isnt(private.answer_key_error('cloze', pg_temp.fx('cz'), '{"blanks":{"b1":{"accept":["AfL"]}}}', '{}'), null,
  'cloze key: every blank needs an answer');
select is(private.answer_key_error('image_labelling', pg_temp.fx('lb'), '{"slots":{"m1":"p","m2":"q","m3":"q"}}', '{}'), null,
  'image_labelling key: a label may be used for two markers');

-- ---------- responses ----------
select is(private.response_error('cloze', pg_temp.fx('cz'), '{"blanks":{"b1":"afl"}}'), null, 'cloze response may leave blanks empty');
select isnt(private.response_error('cloze', pg_temp.fx('cz'), '{"blanks":{"b2":"80"}}'), null, 'a number blank takes a number');
select isnt(private.response_error('cloze', pg_temp.fx('cz'), jsonb_build_object('blanks', jsonb_build_object('b1', repeat('ก', 201)))), null,
  'typed answers are at most 200 characters');
select is(private.response_error('dropdown', pg_temp.fx('dd'), '{"slots":{"b2":"y"}}'), null, 'dropdown response');

-- ---------- Thai answer matching ----------
select is(private.normalize_answer('น้ำ'), private.normalize_answer('น' || chr(x'0E49'::int) || chr(x'0E4D'::int) || chr(x'0E32'::int)),
  '"ำ" and "ํา" match');
select is(private.normalize_answer('น' || chr(x'0E4D'::int) || chr(x'0E49'::int) || chr(x'0E32'::int)), private.normalize_answer('น้ำ'),
  'tone mark typed before or after "ํ" match');
select is(private.normalize_answer('ร้อยละ ๘๐'), 'ร้อยละ 80', 'Thai digits become 0-9');
select is(private.normalize_answer('  Formative' || chr(x'200B'::int) || E'\t  Assessment '), 'formative assessment',
  'invisible characters, extra spaces and case are ignored');
select isnt(private.normalize_answer('ข้าว'), private.normalize_answer('ขาว'), 'different words stay different (no fuzzy spelling)');

-- ---------- scoring ----------
select is(private.score_response('cloze', pg_temp.ck(), '{}', '{"blanks":{"b1":" afl ","b2":79}}'), 0.5,
  'cloze partial: right text, wrong number = 1/2');
select is(private.score_response('cloze', pg_temp.ck(), '{"mode":"all_or_nothing"}',
            jsonb_build_object('blanks', jsonb_build_object('b1', 'การประเมิน' || chr(x'200B'::int) || 'เพื่อการเรียนรู้', 'b2', 80))), 1::numeric,
  'cloze all-or-nothing: Thai answer with an invisible character still matches');
select is(private.score_response('dropdown', '{"slots":{"b1":"a","b2":"x"}}', '{}', '{"slots":{"b1":"a","b2":"y"}}'), 0.5,
  'dropdown partial');
select is(round(private.score_response('image_labelling', '{"slots":{"m1":"p","m2":"q","m3":"r"}}', '{}', '{"slots":{"m1":"p","m2":"q","m3":"s"}}'), 3),
  0.667, 'image_labelling partial');

-- ---------- authoring + taking ----------
select tests.authenticate_as('trainer');
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz'));
create temporary table v as select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft';
select throws_ok(format($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                           values (%L, 'image_labelling', 'ติดป้าย', %L, 9) $$, (select id from v), pg_temp.fx('lb')),
  '23514', null, 'image_labelling needs its image');
insert into public.instrument_items (instrument_version_id, item_type, prompt, media_path, options_json, display_order)
values ((select id from v), 'dropdown', 'เลือกคำ', null, pg_temp.fx('dd'), 1),
       ((select id from v), 'cloze', 'เติมคำ', null, pg_temp.fx('cz'), 2),
       ((select id from v), 'image_labelling', 'ติดป้าย', tests.uid('quiz') || '/diagram.png', pg_temp.fx('lb'), 3);
select lives_ok(format($$ select public.set_item_key(i.id, k.a, '{}')
                            from public.instrument_items i
                            join (values ('dropdown', '{"slots":{"b1":"a","b2":"x"}}'::jsonb),
                                         ('cloze', (select j from ck)),
                                         ('image_labelling', '{"slots":{"m1":"p","m2":"q","m3":"r"}}')) k(t, a) on k.t = i.item_type
                           where i.instrument_version_id = %L $$, (select id from v)),
  'Trainer sets the three keys');
select is((select count(*)::int from public.item_key_status((select id from v)) where has_key and key_valid), 3, 'All keys valid');
select lives_ok(format('select public.publish_instrument_version(%L)', (select id from v)), 'The version publishes');
create temporary table a (id uuid);
grant select, insert on a to authenticated;
with r as (insert into public.assessment_assignments
             (instrument_version_id, cohort_id, purpose, title, close_at, status, shuffle_choices)
           values ((select id from v), tests.uid('cohort'), 'formative', 'กลุ่ม ข', now() + interval '1 day', 'published', true) returning id)
insert into a select id from r;
reset role;

select tests.authenticate_as('teacher_a1');
create temporary table p as select attempt_id, presentation from public.start_attempt((select id from a));
create temporary table items as
  select i.id, i.item_type from public.instrument_items i where i.instrument_version_id = (select id from v);
select is((select array_agg(l order by l) from p, jsonb_object_keys(p.presentation -> 'lists' -> (select id::text from items where item_type = 'dropdown')) l)
            || (select array_agg(l order by l) from p, jsonb_object_keys(p.presentation -> 'lists' -> (select id::text from items where item_type = 'image_labelling')) l),
          array['blank:b1', 'blank:b2', 'labels'],
  'With shuffle_choices: each dropdown blank and the labels are shuffled; cloze has nothing to shuffle');
select results_eq(format($$ select score, max_score from public.submit_attempt(%L, jsonb_build_object(
                            %L, '{"slots":{"b1":"a","b2":"y"}}'::jsonb,
                            %L, '{"blanks":{"b1":"ＡｆＬ","b2":80}}'::jsonb,
                            %L, '{"slots":{"m1":"p","m2":"q"}}'::jsonb)) $$,
                         (select attempt_id from p),
                         (select id from items where item_type = 'dropdown'),
                         (select id from items where item_type = 'cloze'),
                         (select id from items where item_type = 'image_labelling')),
  $$ values (2.17::numeric, 3.00::numeric) $$,
  'Server scores 0.5 + 1 (full-width "ＡｆＬ" matches) + 0.67 = 2.17 of 3');
reset role;

select * from finish();
rollback;

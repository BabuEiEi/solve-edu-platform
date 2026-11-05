-- Phase 2D step 1: import items + keys into a draft — all or nothing, the
-- caller's own rights, row number on errors.
begin;
select plan(24);

create temporary table fx (k text primary key, j jsonb);
insert into fx values
  ('good', $j$[
    {"item_type":"mcq_single","prompt":"ข้อใดเป็นเป้าหมายของ AfL","max_score":1,
     "options_json":{"options":[{"id":"a","text":"ตัดเกรด"},{"id":"b","text":"ปรับการสอน"}]},"answer":{"correct":["b"]}},
    {"item_type":"mcq_multiple","prompt":"ข้อมูลป้อนกลับที่ดี","max_score":2,"scoring_mode":"partial",
     "options_json":{"options":[{"id":"a","text":"ทันเวลา"},{"id":"b","text":"บอกแค่คะแนน"},{"id":"c","text":"นำไปใช้ได้"}]},
     "answer":{"correct":["a","c"]}},
    {"item_type":"true_false","prompt":"ควรแจ้งเกณฑ์ก่อนเริ่ม","options_json":{},"answer":{"correct":true}},
    {"item_type":"numeric","prompt":"40 คน ผ่าน 30 คน ร้อยละเท่าใด","options_json":{"unit":"%"},"answer":{"value":75,"tolerance":0}}
  ]$j$);
create or replace function pg_temp.fx(p text) returns jsonb language sql stable as $$ select j from fx where k = p $$;
grant select on fx to authenticated;

-- The DETAIL of the error a statement raises (or 'no error').
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text; v_detail text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_detail = pg_exception_detail;
  return v_state || ' ' || coalesce(v_detail, '');
end $$;
grant execute on function pg_temp.err(text) to authenticated;

-- ---------- shape of the function ----------
select ok(not has_function_privilege('anon', 'public.import_instrument_items(uuid, jsonb)', 'execute'), 'anon cannot import');
select is((select prosecdef from pg_proc where oid = 'public.import_instrument_items(uuid, jsonb)'::regprocedure), false,
  'runs with the caller''s rights (RLS, triggers and set_item_key decide)');

-- ---------- a draft to import into ----------
select tests.authenticate_as('trainer');
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz'));
create temporary table v as select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft';
grant select on v to authenticated;
insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
values ((select id from v), 'true_false', 'ข้อที่มีอยู่แล้ว', '{}', 1);
select public.set_item_key((select id from public.instrument_items where prompt = 'ข้อที่มีอยู่แล้ว'), '{"correct":false}');
reset role;

-- ---------- who ----------
select tests.authenticate_as('mentor');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v), pg_temp.fx('good'))), '42501 ',
  'mentor cannot import');
reset role;
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v), pg_temp.fx('good'))), '42501 ',
  'trainee cannot import');
reset role;
select tests.authenticate_as('school_admin_b');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v), pg_temp.fx('good'))), '42501 ',
  'unrelated admin cannot import');
reset role;

-- ---------- a bad row: nothing is saved, the error names the row ----------
select tests.authenticate_as('trainer');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            jsonb_set(pg_temp.fx('good'), '{2,answer}', '{"correct":["z"]}'))),
          '23514 แถวที่ 3', 'a key naming a missing choice: check_violation on row 3');
select is((select count(*)::int from public.instrument_items where instrument_version_id = (select id from v)), 1,
  'all or nothing: rows 1–2 were not kept');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            pg_temp.fx('good') || '[{"item_type":"cloze","prompt":"x","options_json":{},"answer":{}}]'::jsonb)),
          '22023 แถวที่ 5', 'newer item types cannot be imported (yet)');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            pg_temp.fx('good') #- '{0,answer}')),
          '22023 แถวที่ 1', 'every row needs its answer');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            jsonb_set(pg_temp.fx('good'), '{1,media_path}', '"x/y.png"'))),
          '22023 แถวที่ 2', 'unknown fields are refused (no images in an import)');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            jsonb_set(pg_temp.fx('good'), '{3,max_score}', '"สิบ"'))),
          '22P02 แถวที่ 4', 'a score that is not a number');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            jsonb_set(pg_temp.fx('good'), '{0,options_json}', '{"options":[{"id":"a","text":"มีตัวเดียว"}]}'))),
          '23514 แถวที่ 1', 'item shape is checked by the existing trigger');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            jsonb_set(pg_temp.fx('good'), '{0,scoring_mode}', '"partial"'))),
          '23514 แถวที่ 1', 'single-answer items take no scoring mode');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v), '[]')), '22023 ',
  'an empty file');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v),
            (select jsonb_agg(pg_temp.fx('good') -> 2) from generate_series(1, 201)))), '22023 ',
  'at most 200 rows');
select is((select count(*)::int from public.instrument_items where instrument_version_id = (select id from v)), 1,
  'still only the item that was there before');

-- ---------- a good file ----------
select is(public.import_instrument_items((select id from v), pg_temp.fx('good')), 4, 'imports four rows');
select results_eq($$ select display_order, item_type, prompt, max_score, scoring_mode from public.instrument_items
                      where instrument_version_id = (select id from v) order by display_order $$,
  $$ values (1, 'true_false', 'ข้อที่มีอยู่แล้ว', 1.00::numeric, null::text),
            (2, 'mcq_single', 'ข้อใดเป็นเป้าหมายของ AfL', 1.00, null),
            (3, 'mcq_multiple', 'ข้อมูลป้อนกลับที่ดี', 2.00, 'partial'),
            (4, 'true_false', 'ควรแจ้งเกณฑ์ก่อนเริ่ม', 1.00, null),
            (5, 'numeric', '40 คน ผ่าน 30 คน ร้อยละเท่าใด', 1.00, null) $$,
  'appended after the existing item, in file order; score defaults to 1; mode kept');
select is((select count(*)::int from public.item_key_status((select id from v)) where has_key and key_valid), 5,
  'every imported item has a valid key');
reset role;
select is((select count(*)::int from private.audit_logs
            where action = 'SET_ANSWER_KEY' and after_json ->> 'instrument_version_id' = (select id::text from v)), 5,
  'each key is audited (by set_item_key)');
select ok(not exists (select 1 from private.audit_logs
                       where after_json ->> 'instrument_version_id' = (select id::text from v)
                         and after_json::text ~ '"correct"|"value"'),
  'the audit trail holds no key content');

select tests.authenticate_as('trainer');
select lives_ok(format('select public.publish_instrument_version(%L)', (select id from v)), 'the version publishes right after');
select is(pg_temp.err(format('select public.import_instrument_items(%L, %L)', (select id from v), pg_temp.fx('good'))),
  '23514 ', 'a published version takes no import (no row blamed)');
reset role;
select is((select count(*)::int from public.instrument_items where instrument_version_id = (select id from v)), 5,
  'published version unchanged');

select * from finish();
rollback;

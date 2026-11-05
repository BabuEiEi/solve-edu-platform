-- Phase 3 step 1: rubrics — versioned instruments of criteria × levels.
begin;
select plan(26);

create temporary table fx (k text primary key, j jsonb);
insert into fx values
  ('crit', '{"description":"ดูจากแผนการสอน",
             "levels":[{"id":"l1","label":"ปรับปรุง","score":1},
                       {"id":"l2","label":"พอใช้","score":2,"description":"มีเป้าหมายแต่ไม่ชัด"},
                       {"id":"l3","label":"ดี","score":3},
                       {"id":"l4","label":"ดีมาก","score":4,"description":"เป้าหมายชัด วัดได้"}]}');
create or replace function pg_temp.fx(p text) returns jsonb language sql stable as $$ select j from fx where k = p $$;
grant select on fx to authenticated;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $$;
grant execute on function pg_temp.err(text) to authenticated;

-- ---------- shape of a criterion ----------
select is(private.item_shape_error('rubric_criterion', pg_temp.fx('crit')), null, 'four levels with descriptions');
select is(private.item_shape_error('rubric_criterion', '{"levels":[{"id":"a","label":"ไม่ผ่าน","score":0},{"id":"b","label":"ผ่าน","score":1}]}'), null,
  'two levels; the lowest may score 0');
select isnt(private.item_shape_error('rubric_criterion', '{"levels":[{"id":"a","label":"x","score":1}]}'), null, 'at least 2 levels');
select isnt(private.item_shape_error('rubric_criterion', (select jsonb_build_object('levels', jsonb_agg(jsonb_build_object('id', 'l' || n, 'label', 'x', 'score', n))) from generate_series(1, 7) n)),
  null, 'at most 6 levels');
select isnt(private.item_shape_error('rubric_criterion', jsonb_set(pg_temp.fx('crit'), '{levels,1,score}', '1')), null, 'level scores differ');
select isnt(private.item_shape_error('rubric_criterion', jsonb_set(pg_temp.fx('crit'), '{levels,1,id}', '"l1"')), null, 'level ids differ');
select isnt(private.item_shape_error('rubric_criterion', jsonb_set(pg_temp.fx('crit'), '{levels,0,label}', '"  "')), null, 'a level needs a label');
select isnt(private.item_shape_error('rubric_criterion', jsonb_set(pg_temp.fx('crit'), '{levels,0,score}', '"1"')), null, 'scores are numbers');
select isnt(private.item_shape_error('rubric_criterion', jsonb_set(pg_temp.fx('crit'), '{levels,0,score}', '-1')), null, 'scores are not negative');
select isnt(private.item_shape_error('rubric_criterion', '{"levels":[{"id":"a","label":"x","score":0},{"id":"b","label":"y","score":0.0}]}'), null,
  'the highest level scores more than 0 (and scores differ)');
select isnt(private.item_shape_error('rubric_criterion', jsonb_set(pg_temp.fx('crit'), '{correct}', '"l4"')), null,
  'nothing else in a criterion (no key-like fields)');
select is(private.item_shape_error('mcq_single', '{"options":[{"id":"a","text":"ก"},{"id":"b","text":"ข"}]}'), null,
  'quiz shapes still checked by the base checker');

-- ---------- a rubric instrument ----------
select tests.authenticate_as('trainer');
insert into public.instruments (owner_org_id, course_id, code, title, instrument_type)
values (tests.uid('district'), tests.uid('course'), 'RUB-1', 'เกณฑ์ตรวจแผนการสอน (ทดสอบ)', 'rubric');
insert into public.instrument_versions (instrument_id) select id from public.instruments where code = 'RUB-1';
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz')); -- a quiz draft, for the mix-up check
create temporary table r as
  select ins.id as instrument_id, v.id as version_id
    from public.instruments ins join public.instrument_versions v on v.instrument_id = ins.id
   where ins.code = 'RUB-1' and v.status = 'draft';
grant select on r to authenticated;
select is(pg_temp.err(format($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, max_score, display_order)
                               values (%L, 'rubric_criterion', 'การกำหนดเป้าหมาย', %L, 999, 1) $$, (select version_id from r), pg_temp.fx('crit'))),
  'no error', 'trainer adds a criterion');
select is((select max_score from public.instrument_items where instrument_version_id = (select version_id from r)), 4.00,
  'max score is set by the server from the levels (999 sent, 4 kept)');
select lives_ok(format($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                          values (%L, 'rubric_criterion', 'การใช้หลักฐาน', '{"levels":[{"id":"a","label":"ไม่มี","score":0},{"id":"b","label":"มี","score":2}]}', 2) $$,
                       (select version_id from r)), 'a second criterion');
select is(pg_temp.err(format($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                               values (%L, 'true_false', 'ข้อสอบ', '{}', 3) $$, (select version_id from r))),
  '23514', 'a rubric holds no quiz items');
select is(pg_temp.err(format($$ insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
                               values (%L, 'rubric_criterion', 'เกณฑ์ในแบบทดสอบ', %L, 99) $$,
                             (select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft'),
                             pg_temp.fx('crit'))),
  '23514', 'a quiz (draft) holds no criteria');
select is(pg_temp.err(format($$ update public.instrument_items set scoring_mode = 'partial'
                               where instrument_version_id = %L and display_order = 1 $$, (select version_id from r))),
  '23514', 'a criterion has no scoring mode');
select is(pg_temp.err(format($$ select public.set_item_key(i.id, '{"correct":["l4"]}')
                               from public.instrument_items i where i.instrument_version_id = %L and i.display_order = 1 $$,
                             (select version_id from r))),
  '23514', 'a criterion takes no answer key');
select ok((select count(*) from public.instruments where id = (select instrument_id from r)) = 1
          and not has_column_privilege('authenticated', 'public.instruments', 'instrument_type', 'UPDATE'),
  'the instrument type is set on creation only');

-- ---------- publish: no keys needed, then frozen ----------
select lives_ok(format('select public.publish_instrument_version(%L)', (select version_id from r)), 'a rubric publishes without answer keys');
select is(pg_temp.err(format($$ update public.instrument_items set prompt = 'แก้หลังเผยแพร่' where instrument_version_id = %L $$, (select version_id from r))),
  '23514', 'a published rubric cannot change');
select is(pg_temp.err(format($$ insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title, close_at, status)
                               values (%L, %L, 'formative', 'Rubric เป็นแบบทดสอบ', now() + interval '1 day', 'published') $$,
                             (select version_id from r), tests.uid('cohort'))),
  '23514', 'a rubric cannot be assigned as a test');
create temporary table nv as select public.clone_instrument_version((select version_id from r)) as id;
select results_eq($$ select prompt, max_score from public.instrument_items where instrument_version_id = (select id from nv) order by display_order $$,
  $$ values ('การกำหนดเป้าหมาย'::text, 4.00::numeric), ('การใช้หลักฐาน', 2.00) $$, 'a new draft copies the criteria');
reset role;

-- ---------- who ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err(format($$ insert into public.instruments (owner_org_id, course_id, code, title, instrument_type)
                               values (%L, %L, 'RUB-X', 'x', 'rubric') $$, tests.uid('district'), tests.uid('course'))),
  '42501', 'a trainee cannot create a rubric');
select is_empty(format('select 1 from public.instrument_items where instrument_version_id = %L', (select version_id from r)),
  'a trainee does not see an unassigned rubric');
reset role;

select * from finish();
rollback;

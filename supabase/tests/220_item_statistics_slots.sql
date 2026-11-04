-- Phase 2C step 6: item analysis per part (position / slot / blank), checked
-- against hand-computed values, and never a key.
--
-- Five trainees, first attempts. Keys: ordering a b c d · dropdown b1=a b2=x ·
-- cloze b1 ∈ {AfL, การประเมินเพื่อการเรียนรู้}, b2 = 80.
--        ordering    dropdown       cloze
--   U1   a b c d     b1 a  b2 x     b1 "afl"  b2 80
--   U2   a b d c     b1 a           b2 80
--   U3   b a c d     b1 b  b2 x     b1 "ประเมิน"  b2 80
--   U4   a c b d     b2 y           b1 "การประเมินเพื่อการเรียนรู้"  b2 79
--   U5   (none)      b1 a  b2 z     (none)
-- right   pos 1–4: .6 .4 .4 .6   b1 .6  b2 .4   b1 .4  b2 .6
-- answered        4  4  4  4      4      4       3      4
begin;
select plan(16);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-000000000221', 'slot.four@example.test', now(), '{"full_name":"ครู ช่องสี่ (สมมติ)"}'),
  ('99999999-0000-4000-a000-000000000222', 'slot.five@example.test', now(), '{"full_name":"ครู ช่องห้า (สมมติ)"}');
update public.profiles set status = 'active' where id::text like '99999999-0000-4000-a000-00000000022_';
insert into public.cohort_memberships (cohort_id, user_id, cohort_role)
select tests.uid('cohort'), id, 'trainee' from public.profiles where id::text like '99999999-0000-4000-a000-00000000022_';

create temporary table fx (k text primary key, j jsonb);
insert into fx values
  ('ord', '{"options":[{"id":"c","text":"สะท้อนผล"},{"id":"a","text":"ตั้งเป้า"},{"id":"d","text":"ปรับการสอน"},{"id":"b","text":"เก็บหลักฐาน"}]}'),
  ('dd',  '{"text":"ประเมิน {{b1}} เพื่อ {{b2}}",
            "blanks":[{"id":"b1","options":[{"id":"a","text":"ระหว่างเรียน"},{"id":"b","text":"ปลายภาค"}]},
                      {"id":"b2","options":[{"id":"x","text":"ปรับการสอน"},{"id":"y","text":"ตัดเกรด"},{"id":"z","text":"จัดอันดับ"}]}]}'),
  ('cz',  '{"text":"{{b1}} ผ่านเกณฑ์ {{b2}} %","blanks":[{"id":"b1"},{"id":"b2","kind":"number"}]}');
create or replace function pg_temp.fx(p text) returns jsonb language sql stable as $$ select j from fx where k = p $$;
grant select on fx to authenticated;

-- ---------- the per-part rule ----------
select results_eq($$ select slot_id, answered, hit from private.slot_hits('ordering', '{"order":["a","b","c","d"]}', '{"order":["a","c","b","d"]}') order by 1 $$,
  $$ values ('1', true, true), ('2', true, false), ('3', true, false), ('4', true, true) $$,
  'ordering: one part per position, right when the right entry is there');
select results_eq($$ select slot_id, answered, hit from private.slot_hits('ordering', '{"order":["a","b","c"]}', 'null') order by 1 $$,
  $$ values ('1', false, false), ('2', false, false), ('3', false, false) $$,
  'ordering not answered: every position unanswered and wrong');
select results_eq($$ select slot_id, answered, hit from private.slot_hits('matching', '{"slots":{"l1":"r1","l2":"r2"}}', '{"slots":{"l2":"r1"}}') order by 1 $$,
  $$ values ('l1', false, false), ('l2', true, false) $$,
  'slot types: a slot left out is unanswered');
select results_eq($$ select slot_id, answered, hit from private.slot_hits('cloze',
                      '{"blanks":{"b1":{"accept":["น้ำ"]},"b2":{"value":30,"tolerance":1}}}',
                      '{"blanks":{"b1":"   ","b2":31}}') order by 1 $$,
  $$ values ('b1', false, false), ('b2', true, true) $$,
  'cloze: a blank of only spaces is unanswered; numbers use the tolerance');
select is(private.score_response('cloze', '{"blanks":{"b1":{"accept":["น้ำ"]},"b2":{"value":30,"tolerance":1}}}', '{}',
                                 '{"blanks":{"b1":"   ","b2":31}}'), 0.5,
  'score_response uses the same rule (1 of 2 blanks)');
select is_empty($$ select 1 from private.slot_hits('mcq_single', '{"correct":["a"]}', '{"choice":"a"}') $$,
  'one-part types have no parts');

-- ---------- labels and numbering ----------
select results_eq($$ select slot_id, ord, label from private.slot_labels('dropdown',
                      '{"text":"{{b1}} แล้ว {{b2}}","blanks":[{"id":"b2","options":[]},{"id":"b1","options":[]}]}') order by ord $$,
  $$ values ('b1', 1, null::text), ('b2', 2, null::text) $$,
  'blanks are numbered by where they appear in the text, not by storage order');
select results_eq($$ select slot_id, ord, label from private.slot_labels('matching',
                      '{"left":[{"id":"l1","text":"p"},{"id":"l2","image_path":"q/x.png"}],"right":[]}') order by ord $$,
  $$ values ('l1', 1, 'p'), ('l2', 2, null::text) $$,
  'matching parts carry the left entry''s text (none for an image)');

-- ---------- end to end ----------
select tests.authenticate_as('trainer');
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz'));
create temporary table v as select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft';
insert into public.instrument_items (instrument_version_id, item_type, prompt, media_path, options_json, display_order)
values ((select id from v), 'ordering', 'เรียงขั้น', null, pg_temp.fx('ord'), 1),
       ((select id from v), 'dropdown', 'เลือกคำ', null, pg_temp.fx('dd'), 2),
       ((select id from v), 'cloze', 'เติมคำ', null, pg_temp.fx('cz'), 3);
do $$ begin
  perform public.set_item_key(i.id, k.a, '{}')
     from public.instrument_items i
     join (values ('ordering', '{"order":["a","b","c","d"]}'::jsonb),
                  ('dropdown', '{"slots":{"b1":"a","b2":"x"}}'),
                  ('cloze', '{"blanks":{"b1":{"accept":["AfL","การประเมินเพื่อการเรียนรู้"]},"b2":{"value":80,"tolerance":0}}}')) k(t, a)
       on k.t = i.item_type
    where i.instrument_version_id = (select id from v);
  perform public.publish_instrument_version((select id from v));
end $$;
create temporary table a (id uuid);
grant select, insert on a to authenticated;
with r as (insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title, close_at, status, attempt_limit)
           values ((select id from v), tests.uid('cohort'), 'formative', 'รายช่อง', now() + interval '1 day', 'published', 2) returning id)
insert into a select id from r;
create temporary table ids as
  select i.item_type, i.id::text as id from public.instrument_items i where i.instrument_version_id = (select id from v);
grant select on ids to authenticated;
reset role;

create temporary table body (k text primary key, ord jsonb, dd jsonb, cz jsonb);
insert into body values
  ('u1', '["a","b","c","d"]', '{"b1":"a","b2":"x"}', '{"b1":"afl","b2":80}'),
  ('u2', '["a","b","d","c"]', '{"b1":"a"}',          '{"b2":80}'),
  ('u3', '["b","a","c","d"]', '{"b1":"b","b2":"x"}', '{"b1":"ประเมิน","b2":80}'),
  ('u4', '["a","c","b","d"]', '{"b2":"y"}',          '{"b1":"การประเมินเพื่อการเรียนรู้","b2":79}'),
  ('u5', null,                '{"b1":"a","b2":"z"}', null);
grant select on body to authenticated;
create temporary table sink (x int);
grant insert on sink to authenticated;
create or replace function pg_temp.take(p text) returns void language sql as $$
  insert into sink select 1 from public.submit_attempt(
    (select attempt_id from public.start_attempt((select id from a))),
    (select jsonb_strip_nulls(jsonb_build_object(
              (select id from ids where item_type = 'ordering'), case when b.ord is not null then jsonb_build_object('order', b.ord) end,
              (select id from ids where item_type = 'dropdown'), jsonb_build_object('slots', b.dd),
              (select id from ids where item_type = 'cloze'), case when b.cz is not null then jsonb_build_object('blanks', b.cz) end))
       from body b where b.k = p));
$$;
grant execute on function pg_temp.take(text) to authenticated;

select tests.authenticate_as('teacher_a1');  do $$ begin perform pg_temp.take('u1'); end $$; reset role;
select tests.authenticate_as('teacher_a2');  do $$ begin perform pg_temp.take('u2'); end $$; reset role;
select tests.authenticate_as('teacher_b1');  do $$ begin perform pg_temp.take('u3'); end $$; reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000221'); do $$ begin perform pg_temp.take('u4'); end $$; reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-000000000222'); do $$ begin perform pg_temp.take('u5'); end $$;
do $$ begin perform pg_temp.take('u1'); end $$;  -- U5 retakes with everything right: still the first attempt counts
reset role;

select tests.authenticate_as('trainer');
create temporary table s as select public.item_statistics((select id from a)) as j;
create temporary table parts as
  select e ->> 'item_type' as t, (p ->> 'no')::int as no, p ->> 'slot_id' as slot_id,
         (p ->> 'correct_rate')::numeric as rate, (p ->> 'answered')::int as answered, p
    from s, jsonb_array_elements(s.j -> 'items') e, jsonb_array_elements(e -> 'slots') p;
reset role;

select results_eq($$ select no, slot_id, rate, answered from parts where t = 'ordering' order by no $$,
  $$ values (1, '1', 0.600, 4), (2, '2', 0.400, 4), (3, '3', 0.400, 4), (4, '4', 0.600, 4) $$,
  'ordering: right and answered per position');
select results_eq($$ select no, slot_id, rate, answered from parts where t = 'dropdown' order by no $$,
  $$ values (1, 'b1', 0.600, 4), (2, 'b2', 0.400, 4) $$,
  'dropdown: right and answered per blank');
select results_eq($$ select no, slot_id, rate, answered from parts where t = 'cloze' order by no $$,
  $$ values (1, 'b1', 0.400, 3), (2, 'b2', 0.600, 4) $$,
  'cloze: Thai typed answers matched as in scoring; a missing blank is unanswered');
select is((select (e ->> 'p')::numeric from s, jsonb_array_elements(s.j -> 'items') e where e ->> 'item_type' = 'ordering'), 0.500,
  'item p equals the mean of its parts (partial scoring)');
select is((select array_agg(distinct k order by k) from parts, jsonb_object_keys(parts.p) k),
          array['answered', 'correct_rate', 'label', 'no', 'slot_id'],
  'each part reports only its id, number, text, rate and answered count');
select ok((select j::text from s) !~ '"order"|"slots": \{|"blanks"|accept|"value"|tolerance|answer_json|การประเมินเพื่อการเรียนรู้',
  'no key and no typed answers in the output');

select tests.authenticate_as('mentor');
select throws_ok(format('select public.item_statistics(%L)', (select id from a)), '42501', null,
  'mentor still cannot run item analysis');
reset role;
select tests.authenticate_as('teacher_a1');
select throws_ok(format('select public.item_statistics(%L)', (select id from a)), '42501', null,
  'trainee still cannot run item analysis');
reset role;

select * from finish();
rollback;

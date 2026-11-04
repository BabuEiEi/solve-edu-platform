-- Phase 2C.1 step 3: the scoring mode is on the item (readable, not secret);
-- the answer key holds only the answer and stays write-only.
begin;
select plan(13);

-- ---------- moved data and shape ----------
select is((select scoring_mode from public.instrument_items where id = tests.uid('q_multiple')), 'all_or_nothing',
  'demo multi-answer item: mode moved from the key to the item');
select is((select count(*)::int from private.instrument_answer_keys where scoring_json <> '{}'::jsonb), 0,
  'no key carries a scoring mode any more');
select throws_ok($$ update private.instrument_answer_keys set scoring_json = '{"mode":"partial"}' where item_id = tests.uid('q_single') $$,
  '23514', null, 'a key cannot take a scoring mode');

select tests.authenticate_as('trainer');
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz'));
create temporary table v as select id from public.instrument_versions where instrument_id = tests.uid('quiz') and status = 'draft';
insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order, scoring_mode)
values ((select id from v), 'mcq_multiple', 'เลือกหลายข้อ',
        '{"options":[{"id":"a","text":"ก"},{"id":"b","text":"ข"},{"id":"c","text":"ค"},{"id":"d","text":"ง"}]}', 1, 'partial'),
       ((select id from v), 'ordering', 'เรียงลำดับ',
        '{"options":[{"id":"c","text":"3"},{"id":"a","text":"1"},{"id":"d","text":"4"},{"id":"b","text":"2"}]}', 2, 'all_or_nothing'),
       ((select id from v), 'mcq_single', 'เลือกข้อเดียว',
        '{"options":[{"id":"a","text":"ก"},{"id":"b","text":"ข"}]}', 3, null);
select throws_ok(format($$ update public.instrument_items set scoring_mode = 'half' where instrument_version_id = %L and display_order = 2 $$,
                        (select id from v)), '23514', null, 'unknown mode is refused');
select throws_ok(format($$ update public.instrument_items set scoring_mode = 'partial' where instrument_version_id = %L and display_order = 3 $$,
                        (select id from v)), '23514', null, 'single-answer items take no mode');
select throws_ok(format($$ select public.set_item_key(i.id, '{"correct":["a"]}', '{"mode":"partial"}')
                             from public.instrument_items i where i.instrument_version_id = %L and i.display_order = 1 $$,
                        (select id from v)), '23514', null, 'set_item_key no longer takes a mode');
select is((select scoring_mode from public.instrument_items where instrument_version_id = (select id from v) and display_order = 2),
          'all_or_nothing', 'the author reads the mode back (the key stays unreadable)');
do $$ begin
  perform public.set_item_key(i.id, k.a)
     from public.instrument_items i
     join (values (1, '{"correct":["a","b","d"]}'::jsonb), (2, '{"order":["a","b","c","d"]}'), (3, '{"correct":["b"]}')) k(n, a)
       on k.n = i.display_order
    where i.instrument_version_id = (select id from v);
end $$;
reset role;

-- a trainee cannot change it (RLS: no row to update)
select tests.authenticate_as('teacher_a1');
update public.instrument_items set scoring_mode = 'partial' where instrument_version_id = (select id from v) and display_order = 2;
reset role;
select is((select scoring_mode from public.instrument_items where instrument_version_id = (select id from v) and display_order = 2),
          'all_or_nothing', 'a trainee cannot change the mode');

select tests.authenticate_as('trainer');
do $$ begin perform public.publish_instrument_version((select id from v)); end $$;
select throws_ok(format($$ update public.instrument_items set scoring_mode = 'partial' where instrument_version_id = %L and display_order = 2 $$,
                        (select id from v)), '23514', null, 'a published item''s mode cannot change');
create temporary table a (id uuid);
grant select, insert on a to authenticated;
with r as (insert into public.assessment_assignments (instrument_version_id, cohort_id, purpose, title, close_at, status)
           values ((select id from v), tests.uid('cohort'), 'formative', 'โหมดคะแนน', now() + interval '1 day', 'published') returning id)
insert into a select id from r;
create temporary table ids as
  select i.display_order as n, i.id::text as id from public.instrument_items i where i.instrument_version_id = (select id from v);
grant select on ids to authenticated;
reset role;

-- ---------- scoring follows the item's mode ----------
-- multi (partial): a,b of a,b,d → 2/3 · ordering (all-or-nothing): two swapped → 0 · single right → 1
select tests.authenticate_as('teacher_a1');
select results_eq(format($$ select score, max_score from public.submit_attempt(
                              (select attempt_id from public.start_attempt(%L)),
                              jsonb_build_object(%L, '{"choices":["a","b"]}'::jsonb,
                                                 %L, '{"order":["a","b","d","c"]}'::jsonb,
                                                 %L, '{"choice":"b"}'::jsonb)) $$,
                         (select id from a), (select id from ids where n = 1), (select id from ids where n = 2), (select id from ids where n = 3)),
  $$ values (1.67::numeric, 3.00::numeric) $$,
  'scores use the item''s mode: 0.67 (partial) + 0 (all-or-nothing) + 1');
reset role;
select results_eq($$ select r.awarded_score from public.assessment_responses r
                      join public.instrument_items i on i.id = r.item_id order by i.display_order $$,
  $$ values (0.67::numeric), (0.00::numeric), (1.00::numeric) $$, 'per item');

-- ---------- a new draft copies the mode ----------
select tests.authenticate_as('trainer');
create temporary table nv as select public.clone_instrument_version((select id from v)) as id;
select results_eq($$ select display_order, scoring_mode from public.instrument_items
                      where instrument_version_id = (select id from nv) order by display_order $$,
  $$ values (1, 'partial'::text), (2, 'all_or_nothing'), (3, null) $$, 'clone copies each item''s mode');
select is((select count(*)::int from public.item_key_status((select id from nv)) where has_key and key_valid), 3,
  'clone copies the keys (answer only)');
reset role;

select * from finish();
rollback;

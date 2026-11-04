-- The stored order of an item must not give its answer away (trainees can
-- read options_json once they start).
begin;
select plan(8);

select isnt(private.answer_key_error('ordering', '{"options":[{"id":"a","text":"1"},{"id":"b","text":"2"},{"id":"c","text":"3"}]}',
                                     '{"order":["a","b","c"]}', '{}'), null,
  'ordering: a key equal to the stored order is refused');
select is(private.answer_key_error('ordering', '{"options":[{"id":"b","text":"2"},{"id":"a","text":"1"},{"id":"c","text":"3"}]}',
                                   '{"order":["a","b","c"]}', '{}'), null,
  'ordering: stored shuffled is fine');
select isnt(private.answer_key_error('matching', '{"left":[{"id":"l1","text":"x"},{"id":"l2","text":"y"}],"right":[{"id":"r1","text":"1"},{"id":"r2","text":"2"},{"id":"r3","text":"3"}]}',
                                     '{"slots":{"l1":"r1","l2":"r2"}}', '{}'), null,
  'matching: every partner stored next to its left entry is refused');
select is(private.answer_key_error('matching', '{"left":[{"id":"l1","text":"x"},{"id":"l2","text":"y"}],"right":[{"id":"r1","text":"1"},{"id":"r3","text":"3"},{"id":"r2","text":"2"}]}',
                                   '{"slots":{"l1":"r1","l2":"r2"}}', '{}'), null,
  'matching: one pair out of place is enough');

-- through the API: set_item_key refuses; an edit that lines the list up invalidates the key
select tests.authenticate_as('trainer');
insert into public.instrument_versions (instrument_id) values (tests.uid('quiz'));
insert into public.instrument_items (instrument_version_id, item_type, prompt, options_json, display_order)
select v.id, 'ordering', 'เรียง', '{"options":[{"id":"b","text":"2"},{"id":"a","text":"1"},{"id":"c","text":"3"}]}', 1
  from public.instrument_versions v where v.instrument_id = tests.uid('quiz') and v.status = 'draft';
create temporary table it as
  select i.id, i.instrument_version_id as v from public.instrument_items i
    join public.instrument_versions v on v.id = i.instrument_version_id
   where v.instrument_id = tests.uid('quiz') and v.status = 'draft';
select lives_ok(format($$ select public.set_item_key(%L, '{"order":["a","b","c"]}', '{}') $$, (select id from it)),
  'A key for a shuffled list is accepted');
update public.instrument_items set options_json = '{"options":[{"id":"a","text":"1"},{"id":"b","text":"2"},{"id":"c","text":"3"}]}'
 where id = (select id from it);
select results_eq(format('select has_key, key_valid from public.item_key_status(%L)', (select v from it)),
  $$ values (true, false) $$, 'Lining the list up with the key makes it invalid (publishing is blocked)');
select throws_ok(format('select public.publish_instrument_version(%L)', (select v from it)), '23514', null,
  'The version cannot be published');
reset role;

-- the demo seed itself does not leak
select is((select count(*)::int
             from public.instrument_items i
             join public.instrument_versions v on v.id = i.instrument_version_id and v.status = 'published'
             join private.instrument_answer_keys k on k.item_id = i.id
            where i.item_type in ('ordering', 'matching')
              and private.answer_key_error(i.item_type, i.options_json, k.answer_json, k.scoring_json) is not null), 0,
  'No published (seeded) ordering/matching item stores its answer in its order');

select * from finish();
rollback;

-- Phase 2C.1 step 1: Thai marks typed in any order still match; different
-- words stay different (no fuzzy spelling).
begin;
select plan(14);

create or replace function pg_temp.u(variadic p int[]) returns text language sql immutable as $$
  select string_agg(chr(c), '' order by i) from unnest(p) with ordinality x(c, i)
$$;
-- ก 0E01 · ท 0E17 · น 0E19 · ป 0E1B · ง 0E07 · ี 0E35 · ิ 0E34 · ั 0E31 · ุ 0E38
-- ่ 0E48 · ้ 0E49 · ํ 0E4D · า 0E32 · ์ 0E4C · ร 0E23 · จ 0E08 · ด 0E14

select is(private.normalize_answer(pg_temp.u(x'0E17'::int, x'0E48'::int, x'0E35'::int)),
          private.normalize_answer('ที่'), '"ที่": tone typed before the vowel matches');
select is(private.normalize_answer(pg_temp.u(x'0E01'::int, x'0E49'::int, x'0E38'::int, x'0E07'::int)),
          private.normalize_answer('กุ้ง'), '"กุ้ง": tone typed before the lower vowel matches');
select is(private.normalize_answer(pg_temp.u(x'0E1B'::int, x'0E49'::int, x'0E31'::int, x'0E19'::int)),
          private.normalize_answer('ปั้น'), '"ปั้น": tone typed before ั matches');
select is(private.normalize_answer(pg_temp.u(x'0E19'::int, x'0E33'::int, x'0E49'::int)),
          private.normalize_answer('น้ำ'), '"นำ้" (ำ typed before the tone) matches "น้ำ"');
select is(private.normalize_answer(pg_temp.u(x'0E19'::int, x'0E4D'::int, x'0E49'::int, x'0E32'::int)),
          private.normalize_answer('น้ำ'), 'ํ typed before the tone still matches (rule from 2C)');
select is(private.normalize_answer(pg_temp.u(x'0E01'::int, x'0E48'::int, x'0E48'::int, x'0E32'::int)),
          private.normalize_answer('ก่า'), 'a tone mark typed twice counts once');
select is(private.normalize_answer(pg_temp.u(x'0E17'::int, x'0E35'::int, x'0E48'::int, x'0E35'::int)),
          private.normalize_answer('ที่'), 'a vowel typed twice around the tone counts once');

select isnt(private.normalize_answer('ไก่'), private.normalize_answer('ไก้'), 'different tone marks stay different');
select isnt(private.normalize_answer('ปิน'), private.normalize_answer('ปิ่น'), 'a missing tone mark is still wrong');
select isnt(private.normalize_answer('ปีน'), private.normalize_answer('ปิน'), 'different vowels stay different');

select is(private.normalize_answer('จันทร์ ที่ 1 กุ้ง สิ้น AfL'), 'จันทร์ ที่ 1 กุ้ง สิ้น afl',
  'text already typed in the usual order is unchanged');
select ok((select bool_and(private.normalize_answer(private.normalize_answer(w)) = private.normalize_answer(w))
             from unnest(array['ที่', 'กุ้ง', 'น้ำ', pg_temp.u(x'0E19'::int, x'0E33'::int, x'0E49'::int), 'สิ้น', 'ปั้น']) w),
  'normalising twice gives the same result');

select is(private.score_response('cloze', '{"blanks":{"b1":{"accept":["ที่ปรึกษา"]}}}', '{}',
            jsonb_build_object('blanks', jsonb_build_object('b1',
              pg_temp.u(x'0E17'::int, x'0E48'::int, x'0E35'::int) || 'ปรึกษา'))), 1::numeric,
  'scoring: a cloze answer typed with the marks swapped gets the point');
select is(private.score_response('cloze', '{"blanks":{"b1":{"accept":["ไก่"]}}}', '{}', '{"blanks":{"b1":"ไก้"}}'), 0::numeric,
  'scoring: a wrong tone mark gets no point');

select * from finish();
rollback;

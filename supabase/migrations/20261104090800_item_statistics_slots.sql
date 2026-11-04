-- =====================================================================
-- Phase 2C / step 6 — item analysis per slot
--
-- The new item types are made of parts (positions, pairs, rows, blanks,
-- markers). item_statistics now also reports, for each part, the share of
-- people (first attempt) who got that part right and how many answered it.
-- It never says WHICH choice is right: no per-part choice counts are
-- returned, only rates.
--
-- private.slot_hits decides right/wrong per part. score_response now uses
-- it too, so the score a trainee gets and the analysis staff see cannot
-- disagree.
-- =====================================================================

-- One row per part of the key: answered? right?
--   ordering                      part = position (1..n)
--   matching … image_labelling    part = slot id
--   cloze                         part = blank id (typed text / number)
create function private.slot_hits(p_type text, p_answer jsonb, p_response jsonb)
returns table (slot_id text, answered boolean, hit boolean)
language sql
immutable
set search_path = ''
as $$
  select k.i::text, r.v is not null, coalesce(r.v = k.v, false)
    from jsonb_array_elements_text(p_answer -> 'order') with ordinality k(v, i)
    left join lateral (
      select e.v from jsonb_array_elements_text(
               case when jsonb_typeof(p_response -> 'order') = 'array' then p_response -> 'order' else '[]'::jsonb end)
             with ordinality e(v, i)
       where e.i = k.i) r on true
   where p_type = 'ordering'
  union all
  select kv.key,
         coalesce(jsonb_typeof(p_response -> 'slots' -> kv.key) = 'string', false),
         coalesce((p_response -> 'slots' ->> kv.key) = kv.value, false)
    from jsonb_each_text(case when jsonb_typeof(p_answer -> 'slots') = 'object' then p_answer -> 'slots' else '{}'::jsonb end) kv
   where p_type in ('matching', 'classification', 'choice_matrix', 'dropdown', 'image_labelling')
  union all
  select kv.key,
         coalesce(case jsonb_typeof(p_response -> 'blanks' -> kv.key)
                    when 'number' then true
                    when 'string' then private.normalize_answer(p_response -> 'blanks' ->> kv.key) <> ''
                    else false end, false),
         coalesce(case when kv.value ? 'value' then
                         jsonb_typeof(p_response -> 'blanks' -> kv.key) = 'number'
                         and abs((p_response -> 'blanks' ->> kv.key)::numeric - (kv.value ->> 'value')::numeric)
                             <= coalesce((kv.value ->> 'tolerance')::numeric, 0)
                       else
                         jsonb_typeof(p_response -> 'blanks' -> kv.key) = 'string'
                         and exists (select 1 from jsonb_array_elements_text(kv.value -> 'accept') a
                                      where private.normalize_answer(a) = private.normalize_answer(p_response -> 'blanks' ->> kv.key)
                                        and private.normalize_answer(a) <> '')
                  end, false)
    from jsonb_each(case when jsonb_typeof(p_answer -> 'blanks') = 'object' then p_answer -> 'blanks' else '{}'::jsonb end) kv
   where p_type = 'cloze'
$$;

-- The parts of an item in the order the trainee meets them, with the text
-- staff can show next to the rate (null when the part has no text, e.g. a
-- blank or a marker: the page numbers those instead).
create function private.slot_labels(p_type text, p_options jsonb)
returns table (slot_id text, ord integer, label text)
language sql
immutable
set search_path = ''
as $$
  select o.i::text, o.i::integer, null::text
    from jsonb_array_elements(coalesce(p_options -> 'options', '[]'::jsonb)) with ordinality o(e, i)
   where p_type = 'ordering'
  union all
  select s.e ->> 'id', s.i::integer, s.e ->> 'text'
    from jsonb_array_elements(coalesce(p_options -> case p_type when 'matching' then 'left'
                                                                when 'classification' then 'items'
                                                                when 'choice_matrix' then 'rows' end,
                                       '[]'::jsonb)) with ordinality s(e, i)
   where p_type in ('matching', 'classification', 'choice_matrix')
  union all
  select m.e ->> 'id', m.i::integer, null
    from jsonb_array_elements(coalesce(p_options -> 'markers', '[]'::jsonb)) with ordinality m(e, i)
   where p_type = 'image_labelling'
  union all
  -- blanks: numbered by where they appear in the text ("ช่องที่ 1, 2, …")
  select b.id, (row_number() over (order by nullif(b.at, 0), b.i))::integer, null
    from (select e ->> 'id' as id, i,
                 strpos(coalesce(p_options ->> 'text', ''), '{{' || (e ->> 'id') || '}}') as at
            from jsonb_array_elements(coalesce(p_options -> 'blanks', '[]'::jsonb)) with ordinality x(e, i)) b
   where p_type in ('dropdown', 'cloze')
$$;

create or replace function private.score_response(
  p_type text, p_answer jsonb, p_scoring jsonb, p_response jsonb
) returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text[];
  v_sel text[];
  v_hit integer;
  v_n integer;
begin
  case p_type
    when 'mcq_single' then
      return case when (p_response ->> 'choice') = (p_answer -> 'correct' ->> 0) then 1 else 0 end;
    when 'mcq_multiple' then
      select array_agg(e) into v_key from jsonb_array_elements_text(p_answer -> 'correct') e;
      select array_agg(e) into v_sel from jsonb_array_elements_text(p_response -> 'choices') e;
      if coalesce(p_scoring ->> 'mode', 'all_or_nothing') = 'partial' then
        v_hit := (select count(*) from unnest(v_sel) s where s = any (v_key));
        return greatest(0, v_hit - (cardinality(v_sel) - v_hit))::numeric / cardinality(v_key);
      end if;
      return case when v_sel <@ v_key and v_key <@ v_sel then 1 else 0 end;
    when 'ordering', 'matching', 'classification', 'choice_matrix', 'dropdown', 'image_labelling', 'cloze' then
      select count(*), count(*) filter (where h.hit) into v_n, v_hit
        from private.slot_hits(p_type, p_answer, p_response) h;
    when 'true_false' then
      return case when (p_response -> 'value') = (p_answer -> 'correct') then 1 else 0 end;
    when 'numeric' then
      return case
        when abs((p_response ->> 'value')::numeric - (p_answer ->> 'value')::numeric)
             <= coalesce((p_answer ->> 'tolerance')::numeric, 0) then 1
        else 0 end;
    else
      raise exception 'no scorer for item type %', p_type;
  end case;
  -- ordering, slot types and cloze (partial is their default)
  if v_n = 0 then
    return 0;
  end if;
  if coalesce(p_scoring ->> 'mode', 'partial') = 'all_or_nothing' then
    return case when v_hit = v_n then 1 else 0 end;
  end if;
  return v_hit::numeric / v_n;
end;
$$;

create or replace function public.item_statistics(p_assignment uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_a public.assessment_assignments%rowtype;
  v_min constant integer := 5;
  v_n integer;
  v_g integer;
  v_out jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_a from public.assessment_assignments a where a.id = p_assignment;
  if not found or not authz.is_cohort_assessor(v_a.cohort_id) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  select count(distinct t.user_id) into v_n
    from public.assessment_attempts t where t.assignment_id = p_assignment and t.status = 'submitted';
  if v_n < v_min then
    return jsonb_build_object('n', v_n, 'min_n', v_min, 'suppressed', true, 'basis', 'first_attempt');
  end if;
  v_g := greatest(1, round(v_n * 0.27)::integer);  -- upper / lower group size

  with firsts as (
    select distinct on (t.user_id) t.id as attempt_id, t.user_id, t.score as total
      from public.assessment_attempts t
     where t.assignment_id = p_assignment and t.status = 'submitted'
     order by t.user_id, t.attempt_no
  ),
  items as (
    select i.id, i.display_order, i.item_type, i.prompt, i.max_score, i.options_json
      from public.instrument_items i where i.instrument_version_id = v_a.instrument_version_id
  ),
  cells as (
    select f.user_id, f.total, i.id as item_id, i.max_score,
           coalesce(r.awarded_score, 0) as pts,
           coalesce(r.awarded_score, 0) / i.max_score as frac,
           coalesce(r.response_json, 'null'::jsonb) as resp
      from firsts f
     cross join items i
      left join public.assessment_responses r on r.attempt_id = f.attempt_id and r.item_id = i.id
  ),
  ranks as (
    select f.user_id,
           row_number() over (order by f.total desc, f.user_id) as hi,
           row_number() over (order by f.total asc, f.user_id) as lo
      from firsts f
  ),
  per_item as (
    select c.item_id,
           avg(c.frac) as p,
           avg(c.frac) filter (where k.hi <= v_g) - avg(c.frac) filter (where k.lo <= v_g) as d,
           corr(c.frac, c.total - c.pts) as r_it,
           var_pop(c.pts) as var_pts,
           count(*) filter (where c.resp = 'null'::jsonb) as blank,
           bool_and(c.frac in (0, 1)) as dichotomous
      from cells c join ranks k on k.user_id = c.user_id
     group by c.item_id
  ),
  picks as (
    select x.item_id, jsonb_object_agg(x.opt, x.cnt) as counts
      from (
        select c.item_id, o.opt, count(*) as cnt
          from cells c
         cross join lateral (
           select c.resp ->> 'choice' as opt where jsonb_typeof(c.resp -> 'choice') = 'string'
           union all
           select e from jsonb_array_elements_text(
             case when jsonb_typeof(c.resp -> 'choices') = 'array' then c.resp -> 'choices' else '[]'::jsonb end) e
           union all
           select (c.resp -> 'value')::text where jsonb_typeof(c.resp -> 'value') = 'boolean'
         ) o
         group by c.item_id, o.opt
      ) x
     group by x.item_id
  ),
  -- per part: right / answered over everyone's first attempt (rates only)
  part_rates as (
    select c.item_id, h.slot_id,
           avg(case when h.hit then 1 else 0 end) as correct_rate,
           count(*) filter (where h.answered) as answered
      from cells c
      join items i on i.id = c.item_id
      join private.instrument_answer_keys ak on ak.item_id = c.item_id
     cross join lateral private.slot_hits(i.item_type, ak.answer_json, c.resp) h
     group by c.item_id, h.slot_id
  ),
  parts as (
    select i.id as item_id,
           jsonb_agg(jsonb_build_object(
                       'slot_id', l.slot_id,
                       'no', l.ord,
                       'label', l.label,
                       'correct_rate', round(pr.correct_rate, 3),
                       'answered', pr.answered)
                     order by l.ord) as slots
      from items i
     cross join lateral private.slot_labels(i.item_type, i.options_json) l
      join part_rates pr on pr.item_id = i.id and pr.slot_id = l.slot_id
     group by i.id
  ),
  test as (
    select count(*) as k, sum(pi.var_pts) as sum_var, bool_and(pi.dichotomous) as dichotomous
      from per_item pi
  ),
  totals as (
    select avg(f.total) as mean, stddev_pop(f.total) as sd, var_pop(f.total) as var
      from firsts f
  )
  select jsonb_build_object(
           'n', v_n,
           'min_n', v_min,
           'suppressed', false,
           'basis', 'first_attempt',
           'group_size', v_g,
           'k', test.k,
           'max_score', (select sum(i.max_score) from items i),
           'mean_score', round(totals.mean, 2),
           'sd_score', round(totals.sd, 2),
           'reliability', case when test.k > 1 and totals.var > 0
                               then round(test.k::numeric / (test.k - 1) * (1 - test.sum_var / totals.var), 3) end,
           'reliability_kind', case when test.dichotomous then 'kr20' else 'alpha' end,
           'items', (
             select jsonb_agg(jsonb_build_object(
                      'item_id', i.id,
                      'display_order', i.display_order,
                      'item_type', i.item_type,
                      'prompt', i.prompt,
                      'max_score', i.max_score,
                      'p', round(pi.p, 3),
                      'd', round(pi.d, 3),
                      'r_it', round(pi.r_it::numeric, 3),
                      'blank', pi.blank,
                      'choices', coalesce(pk.counts, '{}'::jsonb),
                      'slots', coalesce(pt.slots, '[]'::jsonb))
                    order by i.display_order)
               from items i
               join per_item pi on pi.item_id = i.id
               left join picks pk on pk.item_id = i.id
               left join parts pt on pt.item_id = i.id
           ))
    into v_out
    from test, totals;
  return v_out;
end;
$$;

revoke all on function private.slot_hits(text, jsonb, jsonb) from public;
revoke all on function private.slot_labels(text, jsonb) from public;
revoke execute on function public.item_statistics(uuid) from public, anon;
grant execute on function public.item_statistics(uuid) to authenticated;

comment on function private.slot_hits(text, jsonb, jsonb) is 'ถูก/ผิดรายส่วน (ตำแหน่ง/ช่อง/จุด) ของข้อแบบใหม่ — ใช้ทั้งให้คะแนนและวิเคราะห์ข้อสอบ';
comment on function private.slot_labels(text, jsonb) is 'ส่วนของข้อตามลำดับที่ผู้เรียนเห็น + ข้อความ (ถ้ามี) สำหรับวิเคราะห์ข้อสอบ';
comment on function public.item_statistics(uuid) is 'วิเคราะห์ข้อสอบ (p, D 27%, r item-total, ตัวเลือกที่ถูกเลือก, KR-20/α, สัดส่วนถูกรายส่วนของข้อแบบใหม่) จากครั้งแรกของแต่ละคน — เฉพาะผู้ดูแลรุ่น; น้อยกว่า 5 คนไม่แสดง; ไม่เปิดเผยเฉลย';

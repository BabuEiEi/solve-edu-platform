-- =====================================================================
-- Phase 2B.1 / step 3 — cohort results and item analysis on the server
--
-- assignment_results(assignment)  one row per person (SECURITY INVOKER: the
--   caller's own RLS decides the rows — assessors see the cohort, a mentor
--   their mentees, nobody else anything). Replaces fetching every attempt.
-- item_statistics(assignment)     aggregates only, for cohort assessors:
--   difficulty p, discrimination D (upper/lower 27 %), corrected item-total
--   correlation, choices picked (no key: which option is correct is never
--   returned), KR-20 / Cronbach's alpha. Uses each person's FIRST submitted
--   attempt. Below 5 people nothing but the count is returned.
-- =====================================================================

create function public.assignment_results(p_assignment uuid)
returns table (user_id uuid, name text, on_roster boolean, used integer, extra integer,
               in_progress boolean, submitted integer, auto_submitted integer,
               first_score numeric, first_max numeric,
               best_score numeric, best_max numeric, best_passed boolean,
               last_submitted_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  with a as (
    select x.id, x.cohort_id from public.assessment_assignments x where x.id = p_assignment
  ),
  roster as (
    select cm.user_id
      from public.cohort_memberships cm join a on cm.cohort_id = a.cohort_id
     where cm.cohort_role = 'trainee' and cm.status = 'active'
    union
    select ma.trainee_id
      from public.mentor_assignments ma join a on ma.cohort_id = a.cohort_id
     where ma.mentor_id = (select auth.uid()) and ma.ended_at is null
  ),
  t as (
    select t.user_id, t.attempt_no, t.status, t.score, t.max_score, t.passed, t.submitted_at, t.auto_submitted
      from public.assessment_attempts t join a on t.assignment_id = a.id
  ),
  people as (
    select r.user_id, true as on_roster from roster r
    union
    select distinct t.user_id, false from t where t.user_id not in (select r.user_id from roster r)
  ),
  sub as (select * from t where t.status = 'submitted'),
  firsts as (
    select distinct on (s.user_id) s.user_id, s.score, s.max_score
      from sub s order by s.user_id, s.attempt_no
  ),
  bests as (
    select distinct on (s.user_id) s.user_id, s.score, s.max_score, s.passed
      from sub s order by s.user_id, s.score / nullif(s.max_score, 0) desc nulls last, s.attempt_no
  )
  select p.user_id,
         coalesce(nullif(pr.display_name, ''), pr.full_name, ''),
         p.on_roster,
         (select count(*) from t where t.user_id = p.user_id)::integer,
         (select count(*) from public.assessment_extra_attempts x
           where x.assignment_id = p_assignment and x.user_id = p.user_id)::integer,
         exists (select 1 from t where t.user_id = p.user_id and t.status = 'in_progress'),
         (select count(*) from sub s where s.user_id = p.user_id)::integer,
         (select count(*) from sub s where s.user_id = p.user_id and s.auto_submitted)::integer,
         f.score, f.max_score, b.score, b.max_score, b.passed,
         (select max(s.submitted_at) from sub s where s.user_id = p.user_id)
    from people p
    left join public.profiles pr on pr.id = p.user_id
    left join firsts f on f.user_id = p.user_id
    left join bests b on b.user_id = p.user_id;
$$;

create function public.item_statistics(p_assignment uuid)
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
    select i.id, i.display_order, i.item_type, i.prompt, i.max_score
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
                      'choices', coalesce(pk.counts, '{}'::jsonb))
                    order by i.display_order)
               from items i
               join per_item pi on pi.item_id = i.id
               left join picks pk on pk.item_id = i.id
           ))
    into v_out
    from test, totals;
  return v_out;
end;
$$;

revoke execute on function public.assignment_results(uuid) from public, anon;
revoke execute on function public.item_statistics(uuid) from public, anon;
grant execute on function public.assignment_results(uuid) to authenticated;
grant execute on function public.item_statistics(uuid) to authenticated;

comment on function public.assignment_results(uuid) is 'ผลรายบุคคลของการมอบหมาย (ครั้งแรก/สูงสุด/สถานะ/สิทธิ์เพิ่ม) — SECURITY INVOKER: RLS ของผู้เรียกกำหนดแถว';
comment on function public.item_statistics(uuid) is 'วิเคราะห์ข้อสอบ (p, D 27%, r item-total, ตัวเลือกที่ถูกเลือก, KR-20/α) จากครั้งแรกของแต่ละคน — เฉพาะผู้ดูแลรุ่น; น้อยกว่า 5 คนไม่แสดง; ไม่เปิดเผยเฉลย';

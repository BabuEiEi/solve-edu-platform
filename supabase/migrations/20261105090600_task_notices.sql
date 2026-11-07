-- =====================================================================
-- Phase 3b / step 2 — in-app notices for tasks (owner decision: no email)
--
--   task_review_reads       "this trainee has opened this released review"
--   mark_task_results_seen  marks the caller's own released reviews of one
--                           task as opened (idempotent)
--   task_notice_counts      numbers for the menu badges:
--                             unread_results  released reviews not opened yet
--                             revise          tasks returned for revision with
--                                             attempts left and no draft open
--                             waiting         people whose latest submitted
--                                             attempt waits for a review, among
--                                             the work the caller may review
--
-- Both functions are SECURITY INVOKER: they see only what the caller's own
-- RLS already shows, so a count can never reveal more than the pages do.
-- =====================================================================

create table public.task_review_reads (
  review_id uuid not null references public.task_reviews (id) on delete cascade,
  user_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (review_id, user_id)
);
comment on table public.task_review_reads is 'ผู้เรียนเปิดดูผลตรวจที่ส่งแล้วหรือยัง (ป้ายแจ้งเตือนในเมนู) · เจ้าของงานเท่านั้นที่เพิ่มแถวของตนได้';

create function authz.owns_released_task_review(p_review uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_active_user() and exists (
    select 1 from public.task_reviews r
      join public.task_submissions s on s.id = r.submission_id
     where r.id = p_review and r.status = 'released' and s.user_id = (select auth.uid())
  );
$$;
revoke execute on all functions in schema authz from public, anon;
grant execute on all functions in schema authz to authenticated, service_role;

alter table public.task_review_reads enable row level security;
grant select on public.task_review_reads to authenticated;
grant insert (review_id) on public.task_review_reads to authenticated;
create policy task_review_reads_select on public.task_review_reads
  for select to authenticated using (user_id = (select auth.uid()));
create policy task_review_reads_insert on public.task_review_reads
  for insert to authenticated
  with check (user_id = (select auth.uid()) and authz.owns_released_task_review(review_id));

create function public.mark_task_results_seen(p_allocation uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  insert into public.task_review_reads (review_id)
  select r.id
    from public.task_reviews r
    join public.task_submissions s on s.id = r.submission_id
   where s.allocation_id = p_allocation and s.user_id = auth.uid() and r.status = 'released'
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.task_notice_counts()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    -- Only PUBLISHED tasks count: an archived task leaves every page, so a
    -- badge for it could never be cleared.
    'unread_results', (
      select count(*) from public.task_reviews r
        join public.task_submissions s on s.id = r.submission_id
        join public.task_allocations a on a.id = s.allocation_id
        join public.tasks t on t.id = a.task_id and t.status = 'published'
       where r.status = 'released' and s.user_id = auth.uid()
         and not exists (select 1 from public.task_review_reads x where x.review_id = r.id and x.user_id = auth.uid())),
    'revise', (
      select count(*) from (
        select distinct on (s.allocation_id) s.id, s.allocation_id, a.task_id
          from public.task_submissions s
          join public.task_allocations a on a.id = s.allocation_id
         where s.user_id = auth.uid() and s.status = 'submitted'
         order by s.allocation_id, s.attempt_no desc) l
        join public.tasks t on t.id = l.task_id and t.status = 'published'
       where (select count(*) from public.task_submissions m
               where m.allocation_id = l.allocation_id and m.user_id = auth.uid()) < t.max_attempts
         and not exists (select 1 from public.task_submissions d
                          where d.allocation_id = l.allocation_id and d.user_id = auth.uid() and d.status = 'draft')
         and (select r.outcome from public.task_reviews r
               where r.submission_id = l.id and r.status = 'released'
               order by r.released_at desc, r.id desc limit 1) = 'revise'),
    'waiting', (
      select count(*) from (
        select distinct on (s.allocation_id, s.user_id) s.id
          from public.task_submissions s
          join public.task_allocations a on a.id = s.allocation_id
          join public.tasks t on t.id = a.task_id and t.status = 'published'
         where s.status = 'submitted' and s.user_id <> auth.uid()
         order by s.allocation_id, s.user_id, s.attempt_no desc) l
       where not exists (select 1 from public.task_reviews r where r.submission_id = l.id and r.status = 'released'))
  );
$$;

revoke execute on function public.mark_task_results_seen(uuid) from public, anon;
revoke execute on function public.task_notice_counts() from public, anon;
grant execute on function public.mark_task_results_seen(uuid) to authenticated;
grant execute on function public.task_notice_counts() to authenticated;

comment on function public.mark_task_results_seen(uuid) is 'ทำเครื่องหมายว่าผู้เรียนเปิดดูผลตรวจที่ส่งแล้วของภาระงานนี้ (ของตนเองเท่านั้น, ซ้ำได้) — คืนจำนวนที่เพิ่งทำเครื่องหมาย';
comment on function public.task_notice_counts() is 'ตัวเลขป้ายเมนู: unread_results, revise, waiting — SECURITY INVOKER เห็นเท่าที่ RLS ของผู้เรียกให้เห็น';

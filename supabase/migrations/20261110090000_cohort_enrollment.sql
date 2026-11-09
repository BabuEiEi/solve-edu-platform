-- Phase 4g step 1: putting people into cohorts and courses.
--
-- Owner decisions (2569-11-09):
--   * each cohort says how people may join by themselves:
--       closed (default) · approval (a request a manager accepts) · open (join at once)
--     with optional seats and an enrollment window
--   * every active account sees the cohorts open for joining (programme,
--     cohort, courses, dates — never other people)
--   * course enrollment is per course; a cohort manager enrolls people, and a
--     trainee of the cohort may enroll themself in a course of its programme
--   * Staff (platform_support) manages programmes, cohorts, members and
--     enrollments too — but does NOT become an assessor: results and reviews
--     stay with the cohort's own staff (authz.is_cohort_assessor is untouched)
--
-- New error codes: SE011 = the cohort is full · SE012 = not open for joining now
-- · SE013 = not a trainee of this cohort / course not in its programme

-- ---------------------------------------------------------------------
-- Cohort settings and the "requested" membership
-- ---------------------------------------------------------------------
alter table public.cohorts
  add column enrollment_mode text not null default 'closed'
    check (enrollment_mode in ('closed', 'approval', 'open')),
  add column seat_limit integer check (seat_limit is null or seat_limit between 1 and 10000),
  add column enroll_from timestamptz,
  add column enroll_until timestamptz,
  add constraint cohorts_enroll_window check (enroll_until is null or enroll_from is null or enroll_until > enroll_from);
comment on column public.cohorts.enrollment_mode is 'สมัครเข้ารุ่นเอง: closed (ปิด) | approval (ต้องอนุมัติ) | open (เข้าได้ทันที) — 4g';
comment on column public.cohorts.seat_limit is 'จำนวนผู้เข้าอบรมสูงสุด (null = ไม่จำกัด) — นับเฉพาะผู้เข้าอบรมที่ active';
grant insert (enrollment_mode, seat_limit, enroll_from, enroll_until),
      update (enrollment_mode, seat_limit, enroll_from, enroll_until)
  on public.cohorts to authenticated;

alter table public.cohort_memberships drop constraint cohort_memberships_status_check;
alter table public.cohort_memberships add constraint cohort_memberships_status_check
  check (status in ('invited', 'requested', 'active', 'withdrawn'));
comment on column public.cohort_memberships.status is
  'invited | requested (ขอเข้ารุ่นเอง รออนุมัติ — ไม่มีสิทธิ์ใด) | active | withdrawn';

-- ---------------------------------------------------------------------
-- Staff manages programmes and cohorts (not results)
-- ---------------------------------------------------------------------
alter policy programs_select on public.programs
  using (
    authz.is_platform_admin()
    or authz.is_platform_support()
    or authz.has_org_role(owner_org_id, array['district_admin', 'supervisor'])
    or authz.can_view_program(id)
  );
alter policy programs_insert on public.programs
  with check (
    authz.is_platform_admin()
    or authz.is_platform_support()
    or authz.has_org_role(owner_org_id, array['district_admin', 'supervisor'])
  );
alter policy programs_update on public.programs
  using (authz.can_manage_program(id) or authz.is_platform_support())
  with check (authz.can_manage_program(id) or authz.is_platform_support());

alter policy cohorts_select on public.cohorts
  using (authz.can_manage_program(program_id) or authz.is_platform_support() or authz.can_view_cohort(id));
alter policy cohorts_insert on public.cohorts
  with check (authz.can_manage_program(program_id) or authz.is_platform_support());
alter policy cohorts_update on public.cohorts
  using (authz.can_manage_cohort(id) or authz.is_platform_support())
  with check (authz.can_manage_cohort(id) or authz.is_platform_support());

alter policy program_courses_select on public.program_courses
  using (authz.can_view_program(program_id) or authz.is_platform_support());
alter policy program_courses_insert on public.program_courses
  with check (
    (authz.can_manage_program(program_id) or authz.is_platform_support())
    and exists (
      select 1 from public.courses c
       where c.id = course_id
         and (c.status = 'published' or authz.can_manage_course(c.id))
    )
  );
alter policy program_courses_update on public.program_courses
  using (authz.can_manage_program(program_id) or authz.is_platform_support())
  with check (authz.can_manage_program(program_id) or authz.is_platform_support());
alter policy program_courses_delete on public.program_courses
  using (authz.can_manage_program(program_id) or authz.is_platform_support());

-- Staff sees published courses (to put them in a programme) — not drafts, not lessons
alter policy courses_select on public.courses
  using (
    authz.is_platform_admin()
    or authz.has_org_role(owner_org_id, array['district_admin', 'supervisor'])
    or (status = 'published' and authz.is_platform_support())
    or authz.can_view_course(id)
  );

alter policy cohort_memberships_select on public.cohort_memberships
  using (
    user_id = (select auth.uid())
    or authz.can_manage_cohort(cohort_id)
    or authz.is_platform_support()
    or authz.is_cohort_member(cohort_id, array['trainer'])
  );
alter policy cohort_memberships_insert on public.cohort_memberships
  with check (
    (authz.can_grant_cohort_role(cohort_id, cohort_role) or authz.is_platform_support())
    and (user_id <> (select auth.uid()) or authz.is_platform_admin())
  );
alter policy cohort_memberships_update on public.cohort_memberships
  using (authz.can_grant_cohort_role(cohort_id, cohort_role) or authz.is_platform_support())
  with check (authz.can_grant_cohort_role(cohort_id, cohort_role) or authz.is_platform_support());

alter policy mentor_assignments_select on public.mentor_assignments
  using (
    ((mentor_id = (select auth.uid()) or trainee_id = (select auth.uid())) and authz.is_active_user())
    or authz.can_manage_cohort(cohort_id)
    or authz.is_platform_support()
  );
alter policy mentor_assignments_insert on public.mentor_assignments
  with check (authz.can_manage_cohort(cohort_id) or authz.is_platform_support());
alter policy mentor_assignments_update on public.mentor_assignments
  using (authz.can_manage_cohort(cohort_id) or authz.is_platform_support())
  with check (authz.can_manage_cohort(cohort_id) or authz.is_platform_support());

alter policy course_enrollments_select on public.course_enrollments
  using (authz.can_view_enrollment(id) or authz.is_platform_support());
alter policy course_enrollments_insert on public.course_enrollments
  with check (authz.can_manage_cohort(cohort_id) or authz.is_platform_support());
alter policy course_enrollments_update on public.course_enrollments
  using (authz.can_manage_cohort(cohort_id) or authz.is_platform_support())
  with check (authz.can_manage_cohort(cohort_id) or authz.is_platform_support());

-- ---------------------------------------------------------------------
-- Helpers (private: called only from the definer functions below)
-- ---------------------------------------------------------------------
-- open for joining right now? (mode, cohort and programme status, window)
create function private.cohort_open_for_joining(p_cohort uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cohorts c join public.programs p on p.id = c.program_id
     where c.id = p_cohort
       and c.enrollment_mode in ('approval', 'open')
       and c.status in ('open', 'in_progress')
       and p.status = 'active'
       and (c.enroll_from is null or now() >= c.enroll_from)
       and (c.enroll_until is null or now() < c.enroll_until)
  );
$$;
revoke all on function private.cohort_open_for_joining(uuid) from public, anon, authenticated;

create function private.cohort_seats_left(p_cohort uuid)
returns integer -- null = no limit
language sql stable security definer
set search_path = ''
as $$
  select case when c.seat_limit is null then null
              else greatest(c.seat_limit - (select count(*)::int from public.cohort_memberships m
                                             where m.cohort_id = c.id and m.cohort_role = 'trainee' and m.status = 'active'), 0)
         end
    from public.cohorts c where c.id = p_cohort;
$$;
revoke all on function private.cohort_seats_left(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- list_open_cohorts — what an active person may join (no other people shown)
-- ---------------------------------------------------------------------
create function public.list_open_cohorts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or not authz.is_active_user() then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'cohort_id', c.id, 'cohort_code', c.code, 'cohort_name', c.name,
             'start_at', c.start_at, 'end_at', c.end_at,
             'enrollment_mode', c.enrollment_mode, 'enroll_until', c.enroll_until,
             'seats_left', private.cohort_seats_left(c.id),
             'program_name', p.name, 'fiscal_year', p.fiscal_year, 'owner_org', o.name,
             'courses', coalesce((select jsonb_agg(jsonb_build_object('id', co.id, 'title', co.title) order by pc.display_order, co.title)
                                    from public.program_courses pc join public.courses co on co.id = pc.course_id
                                   where pc.program_id = p.id and co.status = 'published'), '[]'::jsonb),
             'my_status', (select m.status from public.cohort_memberships m
                            where m.cohort_id = c.id and m.user_id = v_me and m.cohort_role = 'trainee'))
           order by c.start_at nulls last, p.name, c.name)
      from public.cohorts c
      join public.programs p on p.id = c.program_id
      join public.organizations o on o.id = p.owner_org_id
     where private.cohort_open_for_joining(c.id)), '[]'::jsonb);
end;
$$;
revoke execute on function public.list_open_cohorts() from public, anon;
grant execute on function public.list_open_cohorts() to authenticated;

-- ---------------------------------------------------------------------
-- request_cohort_join — join (open) or ask to join (approval)
-- ---------------------------------------------------------------------
-- → 'active' | 'requested'. Someone the cohort's staff removed (withdrawn)
-- may only ask again — never rejoin an open cohort by themselves.
create function public.request_cohort_join(p_cohort uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_mode text;
  v_row public.cohort_memberships%rowtype;
  v_status text;
begin
  if v_me is null or not authz.is_active_user() then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  -- one decision at a time per cohort (seats)
  select c.enrollment_mode into v_mode from public.cohorts c where c.id = p_cohort for update;
  if v_mode is null or not private.cohort_open_for_joining(p_cohort) then
    raise exception 'not open for joining' using errcode = 'SE012';
  end if;

  select * into v_row from public.cohort_memberships m
   where m.cohort_id = p_cohort and m.user_id = v_me and m.cohort_role = 'trainee' for update;
  if v_row.status in ('active', 'requested') then
    return v_row.status; -- nothing to do (pressed twice)
  end if;

  v_status := case when v_mode = 'open' and v_row.id is null then 'active' else 'requested' end;
  if v_status = 'active' and coalesce(private.cohort_seats_left(p_cohort), 1) < 1 then
    raise exception 'cohort full' using errcode = 'SE011';
  end if;

  if v_row.id is null then
    insert into public.cohort_memberships (cohort_id, user_id, cohort_role, status, approved_by)
    values (p_cohort, v_me, 'trainee', v_status, null);
  else
    update public.cohort_memberships set status = v_status, approved_by = null where id = v_row.id;
  end if;
  return v_status;
end;
$$;
revoke execute on function public.request_cohort_join(uuid) from public, anon;
grant execute on function public.request_cohort_join(uuid) to authenticated;

-- the person takes back a request that is still waiting
create function public.cancel_cohort_request(p_cohort uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  update public.cohort_memberships set status = 'withdrawn'
   where cohort_id = p_cohort and user_id = auth.uid() and cohort_role = 'trainee' and status = 'requested';
end;
$$;
revoke execute on function public.cancel_cohort_request(uuid) from public, anon;
grant execute on function public.cancel_cohort_request(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- decide_cohort_request — the cohort's managers (or Staff) accept or decline
-- ---------------------------------------------------------------------
create function public.decide_cohort_request(p_membership uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.cohort_memberships%rowtype;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from public.cohort_memberships m where m.id = p_membership;
  if v_row.id is null
     or not (authz.can_grant_cohort_role(v_row.cohort_id, 'trainee') or authz.is_platform_support()) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.cohorts c where c.id = v_row.cohort_id for update; -- seats: one decision at a time
  select * into v_row from public.cohort_memberships m where m.id = p_membership for update;
  if v_row.status <> 'requested' then
    raise exception 'no waiting request' using errcode = 'invalid_parameter_value';
  end if;
  if p_accept and coalesce(private.cohort_seats_left(v_row.cohort_id), 1) < 1 then
    raise exception 'cohort full' using errcode = 'SE011';
  end if;
  update public.cohort_memberships
     set status = case when p_accept then 'active' else 'withdrawn' end,
         approved_by = case when p_accept then v_actor else approved_by end
   where id = p_membership;
  return case when p_accept then 'active' else 'withdrawn' end;
end;
$$;
revoke execute on function public.decide_cohort_request(uuid, boolean) from public, anon;
grant execute on function public.decide_cohort_request(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- enroll_in_course — one course of the cohort's programme, per person
-- ---------------------------------------------------------------------
-- p_user null = the caller (a trainee of the cohort; published courses only).
-- Otherwise the cohort's managers (or Staff) enroll an active trainee.
-- → the enrollment id (an earlier withdrawn enrollment is made active again)
create function public.enroll_in_course(p_cohort uuid, p_course uuid, p_user uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_user uuid := coalesce(p_user, auth.uid());
  v_self boolean := p_user is null or p_user = auth.uid();
  v_id uuid;
begin
  if v_actor is null or not authz.is_active_user() then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not v_self and not (authz.can_manage_cohort(p_cohort) or authz.is_platform_support()) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.cohort_memberships m
                  where m.cohort_id = p_cohort and m.user_id = v_user
                    and m.cohort_role = 'trainee' and m.status = 'active') then
    raise exception 'not a trainee of this cohort' using errcode = 'SE013';
  end if;
  if not exists (select 1 from public.cohorts c
                   join public.program_courses pc on pc.program_id = c.program_id
                   join public.courses co on co.id = pc.course_id
                  where c.id = p_cohort and co.id = p_course
                    and (co.status = 'published' or not v_self)) then
    raise exception 'course not in this cohort''s programme' using errcode = 'SE013';
  end if;

  select e.id into v_id from public.course_enrollments e
   where e.cohort_id = p_cohort and e.course_id = p_course and e.user_id = v_user for update;
  if v_id is null then
    insert into public.course_enrollments (cohort_id, course_id, user_id)
    values (p_cohort, p_course, v_user) returning id into v_id;
  else
    update public.course_enrollments set status = 'active' where id = v_id and status = 'withdrawn';
  end if;
  return v_id;
end;
$$;
revoke execute on function public.enroll_in_course(uuid, uuid, uuid) from public, anon;
grant execute on function public.enroll_in_course(uuid, uuid, uuid) to authenticated;

comment on function public.list_open_cohorts() is 'รุ่นที่เปิดรับสมัครตอนนี้ (ทุกบัญชีที่ใช้งานได้) — ไม่มีรายชื่อคนอื่น (4g)';
comment on function public.request_cohort_join(uuid) is 'สมัครเข้ารุ่นเอง: open = เข้าทันที (เช็กที่นั่ง) · approval = รออนุมัติ · เคยถูกถอน = ต้องขออนุมัติใหม่ (4g)';
comment on function public.decide_cohort_request(uuid, boolean) is 'ผู้จัดการรุ่น/Staff ตอบคำขอเข้ารุ่น (เช็กที่นั่ง) (4g)';
comment on function public.enroll_in_course(uuid, uuid, uuid) is 'ลงทะเบียนหลักสูตรของโครงการให้ผู้เข้าอบรมของรุ่น: ตนเอง (หลักสูตรที่เผยแพร่) หรือผู้จัดการรุ่น/Staff (4g)';

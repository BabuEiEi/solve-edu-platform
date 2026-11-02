-- =====================================================================
-- SolveEdu Platform — Migration 06: GRANTs, RLS policies, trusted RPCs
--
-- Model: GRANT decides WHICH COLUMNS a role may touch at all;
--        RLS decides WHICH ROWS. Both are required.
-- anon receives nothing in Phase 1 (no public content yet).
-- =====================================================================

-- Start from zero on every table in public
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Enable RLS everywhere (and force it for the table owner's non-superuser use)
alter table public.profiles                  enable row level security;
alter table public.organizations             enable row level security;
alter table public.organization_memberships  enable row level security;
alter table public.platform_role_assignments enable row level security;
alter table public.programs                  enable row level security;
alter table public.cohorts                   enable row level security;
alter table public.cohort_memberships        enable row level security;
alter table public.mentor_assignments        enable row level security;
alter table public.courses                   enable row level security;
alter table public.program_courses           enable row level security;
alter table public.course_units              enable row level security;
alter table public.lessons                   enable row level security;
alter table public.lesson_blocks             enable row level security;
alter table public.course_enrollments        enable row level security;
alter table public.lesson_progress           enable row level security;

-- =====================================================================
-- profiles
--   * contact_email is NOT column-granted for SELECT → use get_profile_contact()
--   * users may edit only their own descriptive fields
--   * status changes only through admin_set_profile_status()
--   * INSERT happens only via the auth.users trigger
-- =====================================================================
grant select (id, full_name, display_name, avatar_path, requested_org_id, status, created_at, updated_at)
  on public.profiles to authenticated;
grant update (full_name, display_name, avatar_path, contact_email, requested_org_id)
  on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using (authz.can_view_profile(id));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- =====================================================================
-- organizations
-- =====================================================================
grant select on public.organizations to authenticated;
grant insert (code, name, org_type, parent_id, active) on public.organizations to authenticated;
grant update (code, name, parent_id, active) on public.organizations to authenticated;

-- Org names are not personal data; active orgs are visible to signed-in users
-- (needed for the "requested organization" picker at sign-up).
create policy organizations_select on public.organizations
  for select to authenticated
  using (active or authz.can_manage_org(id));

-- Platform admin: anything. District admin: schools/other under own subtree.
create policy organizations_insert on public.organizations
  for insert to authenticated
  with check (
    authz.is_platform_admin()
    or (org_type in ('school', 'other')
        and parent_id is not null
        and authz.has_org_role(parent_id, array['district_admin']))
  );

create policy organizations_update on public.organizations
  for update to authenticated
  using (
    authz.is_platform_admin()
    or (org_type in ('school', 'other') and authz.has_org_role(id, array['district_admin']))
  )
  with check (
    authz.is_platform_admin()
    or (org_type in ('school', 'other')
        and parent_id is not null
        and authz.has_org_role(parent_id, array['district_admin']))
  );

-- =====================================================================
-- organization_memberships (grant / revoke = insert / set ended_at)
-- =====================================================================
grant select on public.organization_memberships to authenticated;
grant insert (user_id, organization_id, org_role, started_at) on public.organization_memberships to authenticated;
grant update (ended_at) on public.organization_memberships to authenticated;

create policy org_memberships_select on public.organization_memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or authz.is_platform_admin()
    or authz.has_org_role(organization_id, array['district_admin', 'school_admin', 'supervisor'])
  );

create policy org_memberships_insert on public.organization_memberships
  for insert to authenticated
  with check (
    authz.can_grant_org_role(organization_id, org_role)
    and (user_id <> (select auth.uid()) or authz.is_platform_admin())
    and started_at <= now() + interval '1 minute'
  );

create policy org_memberships_revoke on public.organization_memberships
  for update to authenticated
  using (authz.can_grant_org_role(organization_id, org_role))
  with check (authz.can_grant_org_role(organization_id, org_role));

-- =====================================================================
-- platform_role_assignments (platform admins only; no self-grant)
-- =====================================================================
grant select on public.platform_role_assignments to authenticated;
grant insert (user_id, role) on public.platform_role_assignments to authenticated;
grant update (revoked_at) on public.platform_role_assignments to authenticated;

create policy platform_roles_select on public.platform_role_assignments
  for select to authenticated
  using (user_id = (select auth.uid()) or authz.is_platform_admin());

create policy platform_roles_insert on public.platform_role_assignments
  for insert to authenticated
  with check (authz.is_platform_admin() and user_id <> (select auth.uid()));

create policy platform_roles_revoke on public.platform_role_assignments
  for update to authenticated
  using (authz.is_platform_admin())
  with check (authz.is_platform_admin());

-- =====================================================================
-- programs
-- =====================================================================
grant select on public.programs to authenticated;
grant insert (code, name, description, fiscal_year, owner_org_id, status, start_at, end_at)
  on public.programs to authenticated;
grant update (code, name, description, fiscal_year, status, start_at, end_at)
  on public.programs to authenticated;

create policy programs_select on public.programs
  for select to authenticated
  using (authz.can_view_program(id));

create policy programs_insert on public.programs
  for insert to authenticated
  with check (
    authz.is_platform_admin()
    or authz.has_org_role(owner_org_id, array['district_admin', 'supervisor'])
  );

create policy programs_update on public.programs
  for update to authenticated
  using (authz.can_manage_program(id))
  with check (authz.can_manage_program(id));

-- =====================================================================
-- cohorts (program_id is immutable for clients)
-- =====================================================================
grant select on public.cohorts to authenticated;
grant insert (program_id, code, name, start_at, end_at, status) on public.cohorts to authenticated;
grant update (code, name, start_at, end_at, status) on public.cohorts to authenticated;

create policy cohorts_select on public.cohorts
  for select to authenticated
  using (authz.can_view_cohort(id));

create policy cohorts_insert on public.cohorts
  for insert to authenticated
  with check (authz.can_manage_program(program_id));

create policy cohorts_update on public.cohorts
  for update to authenticated
  using (authz.can_manage_cohort(id))
  with check (authz.can_manage_cohort(id));

-- =====================================================================
-- cohort_memberships
-- =====================================================================
grant select on public.cohort_memberships to authenticated;
grant insert (cohort_id, user_id, cohort_role, status) on public.cohort_memberships to authenticated;
grant update (status) on public.cohort_memberships to authenticated;

create policy cohort_memberships_select on public.cohort_memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or authz.can_manage_cohort(cohort_id)
    or authz.is_cohort_member(cohort_id, array['trainer'])
  );

create policy cohort_memberships_insert on public.cohort_memberships
  for insert to authenticated
  with check (
    authz.can_grant_cohort_role(cohort_id, cohort_role)
    and (user_id <> (select auth.uid()) or authz.is_platform_admin())
  );

create policy cohort_memberships_update on public.cohort_memberships
  for update to authenticated
  using (authz.can_grant_cohort_role(cohort_id, cohort_role))
  with check (authz.can_grant_cohort_role(cohort_id, cohort_role));

-- =====================================================================
-- mentor_assignments
-- =====================================================================
grant select on public.mentor_assignments to authenticated;
grant insert (cohort_id, mentor_id, trainee_id) on public.mentor_assignments to authenticated;
grant update (ended_at) on public.mentor_assignments to authenticated;

create policy mentor_assignments_select on public.mentor_assignments
  for select to authenticated
  using (
    ((mentor_id = (select auth.uid()) or trainee_id = (select auth.uid())) and authz.is_active_user())
    or authz.can_manage_cohort(cohort_id)
  );

create policy mentor_assignments_insert on public.mentor_assignments
  for insert to authenticated
  with check (authz.can_manage_cohort(cohort_id));

create policy mentor_assignments_update on public.mentor_assignments
  for update to authenticated
  using (authz.can_manage_cohort(cohort_id))
  with check (authz.can_manage_cohort(cohort_id));

-- =====================================================================
-- courses (owner_org_id immutable for clients)
-- =====================================================================
grant select on public.courses to authenticated;
grant insert (code, title, summary, description, duration_minutes, status, owner_org_id)
  on public.courses to authenticated;
grant update (code, title, summary, description, duration_minutes, status)
  on public.courses to authenticated;

create policy courses_select on public.courses
  for select to authenticated
  using (authz.can_view_course(id));

create policy courses_insert on public.courses
  for insert to authenticated
  with check (authz.can_create_course_in_org(owner_org_id));

create policy courses_update on public.courses
  for update to authenticated
  using (authz.can_manage_course(id))
  with check (authz.can_manage_course(id));

-- =====================================================================
-- program_courses
-- =====================================================================
grant select on public.program_courses to authenticated;
grant insert (program_id, course_id, display_order) on public.program_courses to authenticated;
grant update (display_order) on public.program_courses to authenticated;
grant delete on public.program_courses to authenticated;

create policy program_courses_select on public.program_courses
  for select to authenticated
  using (authz.can_view_program(program_id));

create policy program_courses_insert on public.program_courses
  for insert to authenticated
  with check (
    authz.can_manage_program(program_id)
    and exists (
      select 1 from public.courses c
       where c.id = course_id
         and (c.status = 'published' or authz.can_manage_course(c.id))
    )
  );

create policy program_courses_update on public.program_courses
  for update to authenticated
  using (authz.can_manage_program(program_id))
  with check (authz.can_manage_program(program_id));

create policy program_courses_delete on public.program_courses
  for delete to authenticated
  using (authz.can_manage_program(program_id));

-- =====================================================================
-- course_units / lessons / lesson_blocks
-- Draft content is visible to course managers only.
-- Parent FK columns are immutable for clients (not in UPDATE grant).
-- =====================================================================
grant select on public.course_units to authenticated;
grant insert (course_id, title, description, display_order, status) on public.course_units to authenticated;
grant update (title, description, display_order, status) on public.course_units to authenticated;
grant delete on public.course_units to authenticated;

create policy course_units_select on public.course_units
  for select to authenticated
  using (authz.can_view_unit(id));
create policy course_units_insert on public.course_units
  for insert to authenticated
  with check (authz.can_manage_course(course_id));
create policy course_units_update on public.course_units
  for update to authenticated
  using (authz.can_manage_course(course_id))
  with check (authz.can_manage_course(course_id));
create policy course_units_delete on public.course_units
  for delete to authenticated
  using (authz.can_manage_course(course_id));

grant select on public.lessons to authenticated;
grant insert (unit_id, title, learning_objectives, display_order, required, status) on public.lessons to authenticated;
grant update (title, learning_objectives, display_order, required, status) on public.lessons to authenticated;
grant delete on public.lessons to authenticated;

create policy lessons_select on public.lessons
  for select to authenticated
  using (authz.can_view_lesson(id));
create policy lessons_insert on public.lessons
  for insert to authenticated
  with check (authz.can_manage_unit(unit_id));
create policy lessons_update on public.lessons
  for update to authenticated
  using (authz.can_manage_unit(unit_id))
  with check (authz.can_manage_unit(unit_id));
create policy lessons_delete on public.lessons
  for delete to authenticated
  using (authz.can_manage_unit(unit_id));

grant select on public.lesson_blocks to authenticated;
grant insert (lesson_id, block_type, content_json, display_order) on public.lesson_blocks to authenticated;
grant update (block_type, content_json, display_order) on public.lesson_blocks to authenticated;
grant delete on public.lesson_blocks to authenticated;

create policy lesson_blocks_select on public.lesson_blocks
  for select to authenticated
  using (authz.can_view_lesson(lesson_id));
create policy lesson_blocks_insert on public.lesson_blocks
  for insert to authenticated
  with check (authz.can_manage_lesson(lesson_id));
create policy lesson_blocks_update on public.lesson_blocks
  for update to authenticated
  using (authz.can_manage_lesson(lesson_id))
  with check (authz.can_manage_lesson(lesson_id));
create policy lesson_blocks_delete on public.lesson_blocks
  for delete to authenticated
  using (authz.can_manage_lesson(lesson_id));

-- =====================================================================
-- course_enrollments
-- =====================================================================
grant select on public.course_enrollments to authenticated;
grant insert (cohort_id, course_id, user_id) on public.course_enrollments to authenticated;
grant update (status) on public.course_enrollments to authenticated;

create policy course_enrollments_select on public.course_enrollments
  for select to authenticated
  using (authz.can_view_enrollment(id));

create policy course_enrollments_insert on public.course_enrollments
  for insert to authenticated
  with check (authz.can_manage_cohort(cohort_id));

create policy course_enrollments_update on public.course_enrollments
  for update to authenticated
  using (authz.can_manage_cohort(cohort_id))
  with check (authz.can_manage_cohort(cohort_id));

-- =====================================================================
-- lesson_progress (trainee writes own; server stamps timestamps)
-- =====================================================================
grant select on public.lesson_progress to authenticated;
grant insert (enrollment_id, lesson_id, status, progress_percent) on public.lesson_progress to authenticated;
grant update (status, progress_percent) on public.lesson_progress to authenticated;

create policy lesson_progress_select on public.lesson_progress
  for select to authenticated
  using (authz.can_view_enrollment(enrollment_id));

create policy lesson_progress_insert on public.lesson_progress
  for insert to authenticated
  with check (authz.owns_active_enrollment(enrollment_id));

create policy lesson_progress_update on public.lesson_progress
  for update to authenticated
  using (authz.owns_active_enrollment(enrollment_id))
  with check (authz.owns_active_enrollment(enrollment_id));

-- =====================================================================
-- Trusted RPCs (exposed in public; SECURITY DEFINER with explicit checks)
-- =====================================================================

-- Approve / suspend a user. Writes an audit entry with a reason.
create or replace function public.admin_set_profile_status(
  p_target uuid,
  p_status text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('pending', 'active', 'suspended') then
    raise exception 'invalid status: %', p_status using errcode = 'invalid_parameter_value';
  end if;
  if p_target = v_actor then
    raise exception 'cannot change own status' using errcode = 'insufficient_privilege';
  end if;
  if not authz.can_admin_user(p_target) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- Only platform admins may change the status of platform-role holders.
  if not authz.is_platform_admin() and exists (
    select 1 from public.platform_role_assignments r
     where r.user_id = p_target and r.revoked_at is null
  ) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  -- Holders of admin/supervisor roles may only be changed by a district
  -- admin governing that org (school admins manage teachers only).
  if not authz.is_platform_admin() and exists (
    select 1 from public.organization_memberships tm
     where tm.user_id = p_target and tm.ended_at is null
       and tm.org_role in ('district_admin', 'supervisor', 'school_admin')
       and not (tm.org_role <> 'district_admin'
                and authz.has_org_role(tm.organization_id, array['district_admin']))
  ) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  select to_jsonb(p) into v_before from public.profiles p where p.id = p_target;
  if v_before is null then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;

  update public.profiles set status = p_status where id = p_target;

  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json, reason)
  values (v_actor, 'SET_STATUS', 'public.profiles', p_target,
          jsonb_build_object('status', v_before ->> 'status'),
          jsonb_build_object('status', p_status),
          p_reason);
end;
$$;

-- Contact email of a person the caller administers (or self).
create or replace function public.get_profile_contact(p_target uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if p_target <> auth.uid() and not authz.can_admin_user(p_target) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select contact_email into v_email from public.profiles where id = p_target;
  return v_email;
end;
$$;

revoke execute on function public.admin_set_profile_status(uuid, text, text) from public, anon;
revoke execute on function public.get_profile_contact(uuid) from public, anon;
grant execute on function public.admin_set_profile_status(uuid, text, text) to authenticated;
grant execute on function public.get_profile_contact(uuid) to authenticated;

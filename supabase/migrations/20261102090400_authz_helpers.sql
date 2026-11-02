-- =====================================================================
-- SolveEdu Platform — Migration 05: Authorization helper functions
--
-- Why SECURITY DEFINER here?
--   RLS policies on table A that read table B (which has its own RLS)
--   cause recursion and hidden-row bugs. These helpers run as the owner,
--   read membership tables directly, and ONLY ever answer questions about
--   the CURRENT caller (auth.uid()). They return booleans, never rows.
--
-- Safety measures:
--   * schema `authz` is NOT listed in [api].schemas → not callable via REST
--   * `set search_path = ''` + fully-qualified names
--   * EXECUTE revoked from PUBLIC, granted to authenticated/service_role
--   * every scope check requires the caller's profile status = 'active'
-- =====================================================================

-- ---------------------------------------------------------------------
-- Caller state
-- ---------------------------------------------------------------------
create or replace function authz.is_active_user()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid()) and p.status = 'active'
  );
$$;

create or replace function authz.is_platform_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_active_user() and exists (
    select 1 from public.platform_role_assignments r
     where r.user_id = (select auth.uid())
       and r.role = 'platform_admin'
       and r.revoked_at is null
  );
$$;

-- Caller holds one of p_roles on p_org OR on any ancestor of p_org.
-- (A district admin therefore governs every school below the district.)
create or replace function authz.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  with recursive anc(id, parent_id, depth) as (
    select o.id, o.parent_id, 0 from public.organizations o where o.id = p_org
    union all
    select o.id, o.parent_id, a.depth + 1
      from public.organizations o join anc a on o.id = a.parent_id
     where a.depth < 50
  )
  select authz.is_active_user() and exists (
    select 1
      from public.organization_memberships m
      join anc on anc.id = m.organization_id
     where m.user_id = (select auth.uid())
       and m.ended_at is null
       and m.org_role = any (p_roles)
  );
$$;

-- Which org roles may the caller grant on p_org?
--   platform_admin  → any role
--   district_admin  → supervisor, school_admin, teacher (in subtree)
--   school_admin    → teacher (in own school)
-- district_admin itself can only be granted by a platform admin.
create or replace function authz.can_grant_org_role(p_org uuid, p_role text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin()
      or (p_role in ('supervisor', 'school_admin', 'teacher')
          and authz.has_org_role(p_org, array['district_admin']))
      or (p_role = 'teacher'
          and authz.has_org_role(p_org, array['school_admin']));
$$;

create or replace function authz.can_manage_org(p_org uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin() or authz.has_org_role(p_org, array['district_admin']);
$$;

-- ---------------------------------------------------------------------
-- Programs & cohorts
-- ---------------------------------------------------------------------
create or replace function authz.is_cohort_member(p_cohort uuid, p_roles text[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_active_user() and exists (
    select 1 from public.cohort_memberships cm
     where cm.cohort_id = p_cohort
       and cm.user_id = (select auth.uid())
       and cm.status = 'active'
       and cm.cohort_role = any (p_roles)
  );
$$;

create or replace function authz.can_manage_program(p_program uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin() or exists (
    select 1 from public.programs pr
     where pr.id = p_program
       and authz.has_org_role(pr.owner_org_id, array['district_admin', 'supervisor'])
  );
$$;

create or replace function authz.can_view_program(p_program uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_program(p_program) or (authz.is_active_user() and exists (
    select 1
      from public.cohorts c
      join public.cohort_memberships cm on cm.cohort_id = c.id
     where c.program_id = p_program
       and cm.user_id = (select auth.uid())
       and cm.status = 'active'
  ));
$$;

create or replace function authz.can_manage_cohort(p_cohort uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.cohorts c
            where c.id = p_cohort and authz.can_manage_program(c.program_id)
         )
      or authz.is_cohort_member(p_cohort, array['coordinator']);
$$;

create or replace function authz.can_view_cohort(p_cohort uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_cohort(p_cohort)
      or authz.is_cohort_member(p_cohort, array['trainee', 'trainer', 'mentor', 'coordinator']);
$$;

-- Program managers may grant any cohort role; coordinators may not create
-- other coordinators (no lateral escalation).
create or replace function authz.can_grant_cohort_role(p_cohort uuid, p_role text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.cohorts c
            where c.id = p_cohort and authz.can_manage_program(c.program_id)
         )
      or (p_role in ('trainee', 'trainer', 'mentor')
          and authz.is_cohort_member(p_cohort, array['coordinator']));
$$;

create or replace function authz.is_mentor_of(p_trainee uuid, p_cohort uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_active_user() and exists (
    select 1 from public.mentor_assignments ma
     where ma.mentor_id = (select auth.uid())
       and ma.trainee_id = p_trainee
       and (p_cohort is null or ma.cohort_id = p_cohort)
       and ma.ended_at is null
  );
$$;

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
-- Caller may administer (approve/suspend) the target person.
create or replace function authz.can_admin_user(p_target uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin() or (authz.is_active_user() and exists (
    select org_id
      from (
        select m.organization_id as org_id
          from public.organization_memberships m
         where m.user_id = p_target and m.ended_at is null
        union
        select p.requested_org_id
          from public.profiles p
         where p.id = p_target and p.requested_org_id is not null
      ) target_orgs
     where authz.has_org_role(target_orgs.org_id, array['district_admin', 'school_admin'])
  ));
$$;

-- Caller may see the target's basic profile (name, avatar, status).
create or replace function authz.can_view_profile(p_target uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_target = (select auth.uid())
      or authz.can_admin_user(p_target)
      or (authz.is_active_user() and (
            -- supervisors / admins over the target's organizations
            exists (
              select 1 from public.organization_memberships tm
               where tm.user_id = p_target and tm.ended_at is null
                 and authz.has_org_role(tm.organization_id, array['district_admin', 'supervisor', 'school_admin'])
            )
            -- cohort: staff see members; members see staff (trainees never see other trainees)
         or exists (
              select 1
                from public.cohort_memberships me
                join public.cohort_memberships them on them.cohort_id = me.cohort_id
               where me.user_id = (select auth.uid()) and me.status = 'active'
                 and them.user_id = p_target and them.status = 'active'
                 and (me.cohort_role in ('trainer', 'coordinator')
                      or them.cohort_role in ('trainer', 'coordinator', 'mentor'))
            )
            -- mentors see their assigned trainees
         or authz.is_mentor_of(p_target, null)
            -- program managers see participants of their programs
         or exists (
              select 1
                from public.cohort_memberships them
                join public.cohorts c on c.id = them.cohort_id
               where them.user_id = p_target
                 and authz.can_manage_program(c.program_id)
            )
      ));
$$;

-- ---------------------------------------------------------------------
-- Courses & content
-- ---------------------------------------------------------------------
create or replace function authz.can_create_course_in_org(p_org uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin() or authz.has_org_role(p_org, array['district_admin', 'supervisor']);
$$;

-- Managers: platform admin, district admin/supervisor of the owner org,
-- or an active TRAINER of a cohort whose program uses this course.
create or replace function authz.can_manage_course(p_course uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin()
      or exists (
           select 1 from public.courses c
            where c.id = p_course
              and authz.has_org_role(c.owner_org_id, array['district_admin', 'supervisor'])
         )
      or (authz.is_active_user() and exists (
           select 1
             from public.program_courses pc
             join public.cohorts co on co.program_id = pc.program_id
             join public.cohort_memberships cm on cm.cohort_id = co.id
            where pc.course_id = p_course
              and cm.user_id = (select auth.uid())
              and cm.status = 'active'
              and cm.cohort_role = 'trainer'
         ));
$$;

-- Viewers of PUBLISHED courses: enrolled trainees and cohort staff.
create or replace function authz.can_view_course(p_course uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_course(p_course)
      or (authz.is_active_user()
          and exists (select 1 from public.courses c where c.id = p_course and c.status = 'published')
          and (
                exists (
                  select 1 from public.course_enrollments e
                   where e.course_id = p_course
                     and e.user_id = (select auth.uid())
                     and e.status in ('active', 'completed')
                )
             or exists (
                  select 1
                    from public.program_courses pc
                    join public.cohorts co on co.program_id = pc.program_id
                    join public.cohort_memberships cm on cm.cohort_id = co.id
                   where pc.course_id = p_course
                     and cm.user_id = (select auth.uid())
                     and cm.status = 'active'
                     and cm.cohort_role in ('trainer', 'mentor', 'coordinator')
                )
          ));
$$;

create or replace function authz.can_view_unit(p_unit uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.course_units u
     where u.id = p_unit
       and (authz.can_manage_course(u.course_id)
            or (u.status = 'published' and authz.can_view_course(u.course_id)))
  );
$$;

create or replace function authz.can_manage_unit(p_unit uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.course_units u
     where u.id = p_unit and authz.can_manage_course(u.course_id)
  );
$$;

create or replace function authz.can_view_lesson(p_lesson uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.lessons l
      join public.course_units u on u.id = l.unit_id
     where l.id = p_lesson
       and (authz.can_manage_course(u.course_id)
            or (l.status = 'published' and u.status = 'published'
                and authz.can_view_course(u.course_id)))
  );
$$;

create or replace function authz.can_manage_lesson(p_lesson uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.lessons l
      join public.course_units u on u.id = l.unit_id
     where l.id = p_lesson and authz.can_manage_course(u.course_id)
  );
$$;

-- ---------------------------------------------------------------------
-- Enrollment & progress
-- ---------------------------------------------------------------------
create or replace function authz.owns_active_enrollment(p_enrollment uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_active_user() and exists (
    select 1 from public.course_enrollments e
     where e.id = p_enrollment
       and e.user_id = (select auth.uid())
       and e.status = 'active'
  );
$$;

create or replace function authz.can_view_enrollment(p_enrollment uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.course_enrollments e
     where e.id = p_enrollment
       and (
             (e.user_id = (select auth.uid()) and authz.is_active_user())
          or authz.can_manage_cohort(e.cohort_id)
          or authz.is_cohort_member(e.cohort_id, array['trainer'])
          or authz.is_mentor_of(e.user_id, e.cohort_id)
       )
  );
$$;

-- ---------------------------------------------------------------------
-- Privileges on helpers
-- ---------------------------------------------------------------------
revoke execute on all functions in schema authz from public, anon;
grant execute on all functions in schema authz to authenticated, service_role;

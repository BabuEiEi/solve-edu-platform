-- =====================================================================
-- SolveEdu Platform — Migration 10: row-based SELECT policies
--
-- Bug (found by the Course Builder integration tests): INSERT ... RETURNING
-- (supabase-js `.insert().select()`) must also satisfy the SELECT policy for
-- the NEW row. The Phase 1 policies called helpers such as
-- authz.can_view_course(id), which re-read the row BY ID from inside a
-- STABLE function — the new row is not visible to that snapshot yet, so the
-- statement failed with 42501 for legitimate authors.
--
-- Fix: decide from the row's own columns (owner/parent ids, status).
-- Semantics are unchanged: each expression is the inlined equivalent of the
-- old helper (see PERMISSIONS.md §2). Tests: supabase/tests/085_*.sql.
-- =====================================================================

-- courses: == authz.can_view_course(id), with can_manage_course's owner-org
-- branch evaluated on the row itself.
alter policy courses_select on public.courses
  using (
    authz.is_platform_admin()
    or authz.has_org_role(owner_org_id, array['district_admin', 'supervisor'])
    or authz.can_view_course(id)
  );

-- course_units: == authz.can_view_unit(id)
alter policy course_units_select on public.course_units
  using (
    authz.can_manage_course(course_id)
    or (status = 'published' and authz.can_view_course(course_id))
  );

-- lessons: == authz.can_view_lesson(id)
alter policy lessons_select on public.lessons
  using (
    authz.can_manage_unit(unit_id)
    or (status = 'published' and authz.can_view_unit(unit_id))
  );

-- programs: == authz.can_view_program(id), manager branch on the row
alter policy programs_select on public.programs
  using (
    authz.is_platform_admin()
    or authz.has_org_role(owner_org_id, array['district_admin', 'supervisor'])
    or authz.can_view_program(id)
  );

-- cohorts: == authz.can_view_cohort(id), manager branch on the row
alter policy cohorts_select on public.cohorts
  using (
    authz.can_manage_program(program_id)
    or authz.can_view_cohort(id)
  );

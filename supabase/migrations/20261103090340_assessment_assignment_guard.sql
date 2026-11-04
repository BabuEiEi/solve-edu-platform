-- =====================================================================
-- Phase 2B / step 6 — assignment settings stay consistent with evidence
--
-- Once anyone has started an attempt, the settings that give stored results
-- their meaning are frozen:
--   passing_percent  attempts.passed was decided against it at submit time
--   purpose          pretest / posttest / formative is how results are reported
--   course_id        results are grouped by course
--   status → draft   would hide a running test (and its results) from trainees
-- Window, attempt limit, title and instructions remain editable (extend a
-- deadline, allow a retake). SQLSTATE SE004.
-- =====================================================================

create or replace function private.assessment_assignments_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.assessment_attempts t where t.assignment_id = old.id) then
    return new;
  end if;
  if new.passing_percent is distinct from old.passing_percent
     or new.purpose is distinct from old.purpose
     or new.course_id is distinct from old.course_id then
    raise exception 'passing_percent, purpose and course are fixed once an attempt exists'
      using errcode = 'SE004';
  end if;
  if new.status = 'draft' and old.status <> 'draft' then
    raise exception 'an assignment with attempts cannot return to draft' using errcode = 'SE004';
  end if;
  return new;
end;
$$;

create trigger assessment_assignments_lock
  before update of passing_percent, purpose, course_id, status on public.assessment_assignments
  for each row execute function private.assessment_assignments_lock();

revoke all on function private.assessment_assignments_lock() from public;

comment on function private.assessment_assignments_lock() is
  'หลังมีผู้เริ่มทำแล้ว ห้ามแก้เกณฑ์ผ่าน/ประเภท/หลักสูตร และห้ามย้อนเป็นฉบับร่าง (SE004)';

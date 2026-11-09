-- Phase 4d: an archived quiz or rubric cannot be put to new use.
--
-- Until now only the screens hid the "assign" and "choose rubric" buttons; the
-- database checked "a published version" only, so a direct API call (or the
-- assign page opened by its address) could still assign an archived quiz.
--
-- Rules:
--   * an assessment assignment that is created, moved to another version, or
--     (re)published needs its quiz to be active
--   * a task that gets a rubric (a new task, or a different rubric) needs the
--     rubric to be active
--   * what already uses it keeps working: published assignments stay open, a
--     task keeps the rubric it has, results already given stay
--   * bringing the quiz or rubric back (status 'active') lifts the block
--
-- SE010 = archived; the screen says "bring it back first".
-- The checks run after the existing *_validate triggers (trigger names sort
-- after them), so the permission and "published version" errors come first.

-- Status of the instrument a version belongs to. FOR SHARE: an archive that is
-- running at the same moment either finishes first (and is seen) or waits
-- until this change is committed (and then the use already exists, as above).
create function private.instrument_status_for_use(p_version uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select i.status into v_status
    from public.instrument_versions v
    join public.instruments i on i.id = v.instrument_id
   where v.id = p_version
     for share of i;
  return v_status;
end;
$$;

create function private.assessment_assignments_validate_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT'
      or new.instrument_version_id is distinct from old.instrument_version_id
      or (new.status = 'published' and old.status is distinct from 'published'))
     and private.instrument_status_for_use(new.instrument_version_id) = 'archived' then
    raise exception 'this quiz is archived: bring it back before assigning it' using errcode = 'SE010';
  end if;
  return new;
end;
$$;

create trigger assessment_assignments_validate_active
  before insert or update of instrument_version_id, status on public.assessment_assignments
  for each row execute function private.assessment_assignments_validate_active();

create function private.tasks_validate_rubric_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.rubric_version_id is not null
     and (tg_op = 'INSERT' or new.rubric_version_id is distinct from old.rubric_version_id)
     and private.instrument_status_for_use(new.rubric_version_id) = 'archived' then
    raise exception 'this rubric is archived: bring it back before using it' using errcode = 'SE010';
  end if;
  return new;
end;
$$;

create trigger tasks_validate_rubric_active
  before insert or update of rubric_version_id on public.tasks
  for each row execute function private.tasks_validate_rubric_active();

revoke all on function private.instrument_status_for_use(uuid) from public, anon, authenticated;
revoke all on function private.assessment_assignments_validate_active() from public, anon, authenticated;
revoke all on function private.tasks_validate_rubric_active() from public, anon, authenticated;

-- =====================================================================
-- SolveEdu Platform — Migration 03: Programs, Cohorts, Memberships
-- =====================================================================

create table public.programs (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  name         text not null,
  description  text,
  fiscal_year  integer not null check (fiscal_year between 2500 and 2700), -- ปีงบประมาณ พ.ศ.
  owner_org_id uuid not null references public.organizations (id) on delete restrict,
  status       text not null default 'draft'
                 check (status in ('draft', 'active', 'closed', 'archived')),
  start_at     timestamptz,
  end_at       timestamptz,
  created_by   uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint programs_code_unique unique (owner_org_id, code),
  constraint programs_period check (end_at is null or start_at is null or end_at >= start_at)
);

create index programs_owner_org_idx on public.programs (owner_org_id);

create trigger programs_set_updated_at
  before update on public.programs
  for each row execute function private.set_updated_at();

create table public.cohorts (
  id         uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs (id) on delete restrict,
  code       text not null,
  name       text not null,
  start_at   timestamptz,
  end_at     timestamptz,
  status     text not null default 'draft'
               check (status in ('draft', 'open', 'in_progress', 'closed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cohorts_code_unique unique (program_id, code),
  constraint cohorts_period check (end_at is null or start_at is null or end_at >= start_at)
);

create index cohorts_program_idx on public.cohorts (program_id);

create trigger cohorts_set_updated_at
  before update on public.cohorts
  for each row execute function private.set_updated_at();

-- One person may hold several roles in the same cohort (e.g. trainer + mentor)
create table public.cohort_memberships (
  id          uuid primary key default gen_random_uuid(),
  cohort_id   uuid not null references public.cohorts (id) on delete restrict,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  cohort_role text not null check (cohort_role in ('trainee', 'trainer', 'mentor', 'coordinator')),
  status      text not null default 'active' check (status in ('invited', 'active', 'withdrawn')),
  approved_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint cohort_memberships_unique unique (cohort_id, user_id, cohort_role)
);

create index cohort_memberships_user_idx on public.cohort_memberships (user_id, cohort_id) where status = 'active';
create index cohort_memberships_cohort_idx on public.cohort_memberships (cohort_id, user_id) where status = 'active';

create trigger cohort_memberships_set_updated_at
  before update on public.cohort_memberships
  for each row execute function private.set_updated_at();

create trigger cohort_memberships_audit
  after insert or update or delete on public.cohort_memberships
  for each row execute function private.audit_row();

create table public.mentor_assignments (
  id          uuid primary key default gen_random_uuid(),
  cohort_id   uuid not null references public.cohorts (id) on delete restrict,
  mentor_id   uuid not null references public.profiles (id) on delete cascade,
  trainee_id  uuid not null references public.profiles (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  ended_at    timestamptz,
  assigned_by uuid default auth.uid() references public.profiles (id) on delete set null,
  constraint mentor_assignments_distinct check (mentor_id <> trainee_id),
  constraint mentor_assignments_period check (ended_at is null or ended_at >= assigned_at)
);

create unique index mentor_assignments_active_unique
  on public.mentor_assignments (cohort_id, mentor_id, trainee_id)
  where ended_at is null;
create index mentor_assignments_mentor_idx on public.mentor_assignments (mentor_id, cohort_id) where ended_at is null;
create index mentor_assignments_trainee_idx on public.mentor_assignments (trainee_id, cohort_id) where ended_at is null;

create trigger mentor_assignments_one_way_end
  before update on public.mentor_assignments
  for each row execute function private.enforce_one_way_end('ended_at');

create trigger mentor_assignments_audit
  after insert or update or delete on public.mentor_assignments
  for each row execute function private.audit_row();

-- Invariant: mentor holds an active 'mentor' membership and trainee an
-- active 'trainee' membership in the SAME cohort. Enforced in the DB so it
-- holds regardless of which client/service writes the row.
create or replace function private.mentor_assignments_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.cohort_memberships
     where cohort_id = new.cohort_id and user_id = new.mentor_id
       and cohort_role = 'mentor' and status = 'active'
  ) then
    raise exception 'mentor_id is not an active mentor of this cohort'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.cohort_memberships
     where cohort_id = new.cohort_id and user_id = new.trainee_id
       and cohort_role = 'trainee' and status = 'active'
  ) then
    raise exception 'trainee_id is not an active trainee of this cohort'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function private.mentor_assignments_validate() from public;

create trigger mentor_assignments_validate
  before insert on public.mentor_assignments
  for each row execute function private.mentor_assignments_validate();

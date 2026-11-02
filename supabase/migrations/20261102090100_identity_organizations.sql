-- =====================================================================
-- SolveEdu Platform — Migration 02: Identity & Organizations
-- profiles, organizations, organization_memberships, platform_role_assignments
-- =====================================================================

-- ---------------------------------------------------------------------
-- profiles: 1:1 with auth.users. NO password, NO role column.
-- Roles live in membership tables so one person can hold several roles
-- in different organizations / programs.
-- ---------------------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  full_name        text not null default '',
  display_name     text,
  avatar_path      text,          -- Storage object path (never a public URL)
  contact_email    text,          -- not selectable by other users (column grant)
  requested_org_id uuid,          -- org the user asked to join at sign-up (FK added below)
  status           text not null default 'pending'
                     check (status in ('pending', 'active', 'suspended')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint profiles_full_name_len check (char_length(full_name) <= 200),
  constraint profiles_display_name_len check (display_name is null or char_length(display_name) <= 100)
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- organizations: district / school / other, hierarchical via parent_id
-- ---------------------------------------------------------------------
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name       text not null,
  org_type   text not null check (org_type in ('district', 'school', 'other')),
  parent_id  uuid references public.organizations (id) on delete restrict,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_code_unique unique (org_type, code),
  constraint organizations_not_own_parent check (parent_id is null or parent_id <> id)
);

create index organizations_parent_idx on public.organizations (parent_id);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

-- Prevent cycles in the hierarchy (A -> B -> A)
create or replace function private.organizations_prevent_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if new.parent_id is null then
    return new;
  end if;

  with recursive anc(id, parent_id, depth) as (
    select o.id, o.parent_id, 1
      from public.organizations o
     where o.id = new.parent_id
    union all
    select o.id, o.parent_id, a.depth + 1
      from public.organizations o
      join anc a on o.id = a.parent_id
     where a.depth < 50
  )
  select exists (select 1 from anc where anc.id = new.id) into v_found;

  if v_found then
    raise exception 'organization hierarchy cycle detected (id=%, parent_id=%)', new.id, new.parent_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger organizations_prevent_cycle
  before insert or update of parent_id on public.organizations
  for each row execute function private.organizations_prevent_cycle();

alter table public.profiles
  add constraint profiles_requested_org_fk
  foreign key (requested_org_id) references public.organizations (id) on delete set null;

create index profiles_requested_org_idx on public.profiles (requested_org_id);
create index profiles_status_idx on public.profiles (status);

-- ---------------------------------------------------------------------
-- organization_memberships: role of a person inside an organization.
-- Active = ended_at IS NULL. Revocation = set ended_at (history kept).
-- ---------------------------------------------------------------------
create table public.organization_memberships (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  org_role        text not null
                    check (org_role in ('district_admin', 'supervisor', 'school_admin', 'teacher')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  granted_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint org_memberships_period check (ended_at is null or ended_at >= started_at)
);

create unique index org_memberships_active_unique
  on public.organization_memberships (user_id, organization_id, org_role)
  where ended_at is null;
create index org_memberships_user_org_idx on public.organization_memberships (user_id, organization_id) where ended_at is null;
create index org_memberships_org_user_idx on public.organization_memberships (organization_id, user_id) where ended_at is null;

-- ---------------------------------------------------------------------
-- platform_role_assignments: system-level roles (NOT district admin)
-- ---------------------------------------------------------------------
create table public.platform_role_assignments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('platform_admin', 'platform_support')),
  granted_by uuid default auth.uid() references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint platform_roles_period check (revoked_at is null or revoked_at >= granted_at)
);

create unique index platform_roles_active_unique
  on public.platform_role_assignments (user_id, role)
  where revoked_at is null;

-- ---------------------------------------------------------------------
-- Revocation is one-way: an end timestamp can be set once, never cleared
-- or moved, and never set in the future.
-- ---------------------------------------------------------------------
create or replace function private.enforce_one_way_end()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text := tg_argv[0];
  v_old timestamptz := (to_jsonb(old) ->> v_col)::timestamptz;
  v_new timestamptz := (to_jsonb(new) ->> v_col)::timestamptz;
begin
  if v_old is not null and v_new is distinct from v_old then
    raise exception '% cannot be changed once set', v_col using errcode = 'check_violation';
  end if;
  if v_new is not null and v_new > now() + interval '1 minute' then
    raise exception '% cannot be in the future', v_col using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger org_memberships_one_way_end
  before update on public.organization_memberships
  for each row execute function private.enforce_one_way_end('ended_at');

create trigger platform_roles_one_way_end
  before update on public.platform_role_assignments
  for each row execute function private.enforce_one_way_end('revoked_at');

-- Audit every permission change
create trigger org_memberships_audit
  after insert or update or delete on public.organization_memberships
  for each row execute function private.audit_row();

create trigger platform_roles_audit
  after insert or update or delete on public.platform_role_assignments
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- Profile lifecycle: create profile when an auth user is created.
-- User-supplied metadata is used ONLY for the display name — never for
-- role or status (SEC: user_metadata is user-controlled).
-- ---------------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, contact_email, status)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), 200),
    new.email,
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Users may only change requested_org_id while still pending.
create or replace function private.profiles_guard_requested_org()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.requested_org_id is distinct from old.requested_org_id
     and old.status <> 'pending'
     and current_user = 'authenticated' then
    raise exception 'requested_org_id can only be changed while status is pending'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_requested_org
  before update of requested_org_id on public.profiles
  for each row execute function private.profiles_guard_requested_org();

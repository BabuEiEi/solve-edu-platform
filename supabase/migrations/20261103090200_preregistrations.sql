-- =====================================================================
-- SolveEdu Platform — Migration 11: CSV pre-registration (ลงทะเบียนล่วงหน้า)
--
-- An admin imports a roster (email, name, org, role[, cohort]). Rows stay
-- 'pending' until the person signs in with a VERIFIED email equal to the
-- roster email; public.claim_my_preregistrations() then grants the
-- membership(s) and activates the profile. No service role is involved: the
-- RPC only ever acts on auth.uid(), and reads the email from auth.users
-- (email_confirmed_at is set by GoTrue) — never from user-editable
-- metadata or profiles.contact_email.
-- =====================================================================

create table public.preregistrations (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  full_name       text not null default '',
  organization_id uuid not null references public.organizations (id) on delete restrict,
  org_role        text not null default 'teacher'
                    check (org_role in ('district_admin', 'supervisor', 'school_admin', 'teacher')),
  cohort_id       uuid references public.cohorts (id) on delete restrict,
  cohort_role     text check (cohort_role in ('trainee', 'trainer', 'mentor', 'coordinator')),
  status          text not null default 'pending' check (status in ('pending', 'claimed', 'cancelled')),
  batch_id        uuid,
  imported_by     uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  claimed_by      uuid references public.profiles (id) on delete set null,
  claimed_at      timestamptz,
  constraint prereg_email_normalised check (email = lower(btrim(email))),
  constraint prereg_email_format check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  constraint prereg_name_len check (char_length(full_name) <= 200),
  constraint prereg_cohort_pair check ((cohort_id is null) = (cohort_role is null)),
  constraint prereg_claim_state check ((status = 'claimed') = (claimed_by is not null and claimed_at is not null))
);

create unique index prereg_pending_unique
  on public.preregistrations (email, organization_id, org_role, coalesce(cohort_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'pending';
create index prereg_email_pending_idx on public.preregistrations (email) where status = 'pending';
create index prereg_org_idx on public.preregistrations (organization_id, status);

create trigger preregistrations_audit
  after insert or update or delete on public.preregistrations
  for each row execute function private.audit_row();

-- Server-stamped evidence: clients cannot choose who/when/status on insert.
create or replace function private.preregistrations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.claimed_by := null;
    new.claimed_at := null;
    new.imported_by := coalesce(auth.uid(), new.imported_by);
  elsif old.status <> 'pending' then
    raise exception 'only pending pre-registrations can change' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger preregistrations_guard
  before insert or update on public.preregistrations
  for each row execute function private.preregistrations_guard();

alter table public.preregistrations enable row level security;

-- Contains emails (PII): visible to the importer and to admins of the org only.
grant select on public.preregistrations to authenticated;
grant insert (email, full_name, organization_id, org_role, cohort_id, cohort_role, batch_id)
  on public.preregistrations to authenticated;
grant update (status) on public.preregistrations to authenticated;

create policy preregistrations_select on public.preregistrations
  for select to authenticated
  using (
    imported_by = (select auth.uid())
    or authz.is_platform_admin()
    or authz.has_org_role(organization_id, array['district_admin', 'school_admin'])
  );

-- Same rights as granting the role directly (no privilege laundering).
create policy preregistrations_insert on public.preregistrations
  for insert to authenticated
  with check (
    authz.can_grant_org_role(organization_id, org_role)
    and (cohort_id is null or authz.can_grant_cohort_role(cohort_id, cohort_role))
  );

-- Cancel only (pending → cancelled); claiming happens through the RPC.
create policy preregistrations_cancel on public.preregistrations
  for update to authenticated
  using (status = 'pending' and authz.can_grant_org_role(organization_id, org_role))
  with check (status = 'cancelled' and authz.can_grant_org_role(organization_id, org_role));

-- ---------------------------------------------------------------------
-- claim_my_preregistrations() → number of roster rows applied
-- ---------------------------------------------------------------------
create or replace function public.claim_my_preregistrations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_row record;
  v_count integer := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  -- Verified email only. Unverified accounts claim nothing.
  select lower(btrim(u.email)) into v_email
    from auth.users u
   where u.id = v_uid and u.email_confirmed_at is not null and u.email is not null;
  if v_email is null then
    return 0;
  end if;

  for v_row in
    select * from public.preregistrations
     where email = v_email and status = 'pending'
     order by created_at
     for update
  loop
    -- The importer must still hold the right to grant (rights may be revoked
    -- between import and first login). Evaluated as the importer, not the claimant.
    if v_row.imported_by is null
       or not private.importer_may_grant(v_row.imported_by, v_row.organization_id, v_row.org_role,
                                         v_row.cohort_id, v_row.cohort_role) then
      continue;
    end if;

    insert into public.organization_memberships (user_id, organization_id, org_role, granted_by)
    values (v_uid, v_row.organization_id, v_row.org_role, v_row.imported_by)
    on conflict (user_id, organization_id, org_role) where ended_at is null do nothing;

    if v_row.cohort_id is not null then
      insert into public.cohort_memberships (cohort_id, user_id, cohort_role, approved_by)
      values (v_row.cohort_id, v_uid, v_row.cohort_role, v_row.imported_by)
      on conflict (cohort_id, user_id, cohort_role) do update set status = 'active'
        where public.cohort_memberships.status <> 'active';
    end if;

    -- Activate a pending profile; never reactivate a suspended one.
    update public.profiles
       set status = 'active',
           full_name = case when full_name = '' then v_row.full_name else full_name end
     where id = v_uid and status = 'pending';

    update public.preregistrations
       set status = 'claimed', claimed_by = v_uid, claimed_at = now()
     where id = v_row.id;

    insert into private.audit_logs (actor_id, action, table_name, record_id, after_json)
    values (v_uid, 'CLAIM_PREREGISTRATION', 'public.preregistrations', v_row.id,
            jsonb_build_object('organization_id', v_row.organization_id, 'org_role', v_row.org_role,
                               'cohort_id', v_row.cohort_id, 'imported_by', v_row.imported_by));
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Can `p_importer` (not the caller) still grant this role? Mirrors the helpers
-- in authz, which only answer for auth.uid(), by temporarily evaluating them
-- as the importer inside this transaction.
create or replace function private.importer_may_grant(
  p_importer uuid, p_org uuid, p_org_role text, p_cohort uuid, p_cohort_role text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text := current_setting('request.jwt.claims', true);
  v_ok boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_importer, 'role', 'authenticated')::text, true);
  v_ok := authz.can_grant_org_role(p_org, p_org_role)
          and (p_cohort is null or authz.can_grant_cohort_role(p_cohort, p_cohort_role));
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return coalesce(v_ok, false);
end;
$$;

revoke all on function private.importer_may_grant(uuid, uuid, text, uuid, text) from public;
revoke execute on function public.claim_my_preregistrations() from public, anon;
grant execute on function public.claim_my_preregistrations() to authenticated;

comment on table public.preregistrations is 'รายชื่อลงทะเบียนล่วงหน้าจาก CSV — ผูกบัญชีเมื่อผู้ใช้ล็อกอินด้วยอีเมลที่ยืนยันแล้วตรงกัน (claim_my_preregistrations)';
comment on function public.claim_my_preregistrations() is 'ผูกสิทธิ์ตามรายชื่อล่วงหน้าให้ผู้เรียก (auth.uid()) เฉพาะอีเมลที่ยืนยันแล้วใน auth.users; ตรวจสิทธิ์ผู้นำเข้าซ้ำ';

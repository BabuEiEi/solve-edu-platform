-- Phase 4f: accounts are approved centrally.
--
-- Owner decisions (2569-11-09):
--   * the school-admin role (school_admin) is removed entirely: it grants
--     nothing and can no longer be given (memberships, roster import)
--   * "Staff" = the existing platform role platform_support (it had no powers):
--     approves, suspends and edits (name, code) every account that holds no
--     platform role and is not a district admin — never deletes an account,
--     never appoints anyone (platform roles stay platform-admin only)
--   * a district admin still manages the people of their district
--   * approving a pending account (pending → active) makes the person a
--     teacher of the school they asked for, when they have no school yet;
--     active accounts left in that state before this change get it now
--
-- Production had no school_admin memberships, no preregistrations and no
-- organization memberships at all when this was written; the guard below stops
-- the migration instead of guessing if that is no longer true.

do $$
begin
  if exists (select 1 from public.organization_memberships where org_role = 'school_admin')
     or exists (select 1 from public.preregistrations where org_role = 'school_admin') then
    raise exception 'school_admin rows exist: decide what they become before removing the role';
  end if;
end;
$$;

alter table public.organization_memberships drop constraint organization_memberships_org_role_check;
alter table public.organization_memberships add constraint organization_memberships_org_role_check
  check (org_role in ('district_admin', 'supervisor', 'teacher'));
alter table public.preregistrations drop constraint preregistrations_org_role_check;
alter table public.preregistrations add constraint preregistrations_org_role_check
  check (org_role in ('district_admin', 'supervisor', 'teacher'));
comment on column public.organization_memberships.org_role is
  'district_admin|supervisor|teacher — สิทธิ์ครอบคลุมหน่วยงานลูกทั้งหมด (school_admin ถูกยกเลิกใน Phase 4f)';

-- ---------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------
create function authz.is_platform_support()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_active_user() and exists (
    select 1 from public.platform_role_assignments r
     where r.user_id = (select auth.uid())
       and r.role = 'platform_support'
       and r.revoked_at is null
  );
$$;
revoke execute on function authz.is_platform_support() from public, anon;
grant execute on function authz.is_platform_support() to authenticated, service_role;
comment on function authz.is_platform_support() is 'ผู้เรียกเป็นผู้ช่วยดูแลระบบ (Staff) ที่ใช้งานได้';

-- ---------------------------------------------------------------------
-- Who administers whom
-- ---------------------------------------------------------------------
-- platform admin: everyone · Staff: everyone without a platform role ·
-- district admin: people of (or asking to join) an organization in their district
create or replace function authz.can_admin_user(p_target uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin()
      or (authz.is_platform_support()
          and not exists (select 1 from public.platform_role_assignments r
                           where r.user_id = p_target and r.revoked_at is null))
      or (authz.is_active_user() and exists (
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
             where authz.has_org_role(target_orgs.org_id, array['district_admin'])
          ));
$$;

-- May the caller manage (status, name, code, school) this account?
--   * they administer the target, and
--   * a platform-role holder is managed by a platform admin only, and
--   * a district admin by a platform admin only, and
--   * a supervisor by a platform admin, Staff, or a district admin above them
create or replace function authz.may_manage_account(p_target uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_admin_user(p_target)
     and (authz.is_platform_admin()
          or (not exists (select 1 from public.platform_role_assignments r
                           where r.user_id = p_target and r.revoked_at is null)
              and not exists (select 1 from public.organization_memberships tm
                               where tm.user_id = p_target and tm.ended_at is null
                                 and (tm.org_role = 'district_admin'
                                      or (tm.org_role = 'supervisor'
                                          and not authz.is_platform_support()
                                          and not authz.has_org_role(tm.organization_id, array['district_admin']))))));
$$;
comment on function authz.may_manage_account(uuid) is
  'ผู้เรียกจัดการบัญชีนี้ได้ไหม (สถานะ ชื่อ รหัส สังกัด): ผู้ดูแลระบบ = ทุกคน · Staff = ทุกคนที่ไม่มีบทบาทระดับระบบและไม่ใช่ผู้ดูแลเขต · ผู้ดูแลเขต = คนในเขต (ไม่รวมผู้ดูแลเขต) (4f)';

-- Which org roles may the caller grant on p_org? (no school_admin any more)
--   platform_admin → any · district_admin → supervisor, teacher (in subtree)
-- Staff gives a school only through the approval / change-school functions,
-- which check the person first.
create or replace function authz.can_grant_org_role(p_org uuid, p_role text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.is_platform_admin()
      or (p_role in ('supervisor', 'teacher')
          and authz.has_org_role(p_org, array['district_admin']));
$$;

-- can_view_profile: the same function, without school_admin (patched in place, so its
-- cohort / mentor / program rules stay exactly as they are)
do $$
declare
  v_src text;
  v_old constant text := $q$array['district_admin', 'supervisor', 'school_admin']$q$;
begin
  select pg_get_functiondef('authz.can_view_profile(uuid)'::regprocedure) into v_src;
  if (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'can_view_profile changed: update this migration';
  end if;
  execute replace(v_src, v_old, $q$array['district_admin', 'supervisor']$q$);
end;
$$;

alter policy org_memberships_select on public.organization_memberships
  using (
    user_id = (select auth.uid())
    or authz.is_platform_admin()
    or authz.is_platform_support()
    or authz.has_org_role(organization_id, array['district_admin', 'supervisor'])
  );

alter policy preregistrations_select on public.preregistrations
  using (
    imported_by = (select auth.uid())
    or authz.is_platform_admin()
    or authz.has_org_role(organization_id, array['district_admin'])
  );

-- ---------------------------------------------------------------------
-- Approval adds the school that was asked for
-- ---------------------------------------------------------------------
-- (private: called only from the definer functions below)
create function private.join_requested_school(p_target uuid, p_by uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select p.requested_org_id into v_org from public.profiles p where p.id = p_target;
  if v_org is null
     -- only an active SCHOOL: a person still pending may point requested_org_id at any
     -- organization (a district, a closed school) — never make them a "teacher" of that
     or not exists (select 1 from public.organizations o
                     where o.id = v_org and o.org_type = 'school' and o.active)
     or exists (select 1 from public.organization_memberships m
                 where m.user_id = p_target and m.ended_at is null) then
    return null; -- nothing (usable) asked for, or already placed somewhere: leave it to a person
  end if;
  insert into public.organization_memberships (user_id, organization_id, org_role, granted_by)
  values (p_target, v_org, 'teacher', p_by)
  returning id into v_id; -- audited by the table's own trigger (org_memberships_audit)
  return v_id;
end;
$$;
revoke all on function private.join_requested_school(uuid, uuid) from public, anon, authenticated;

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
  if not authz.may_manage_account(p_target) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  select to_jsonb(p) into v_before from public.profiles p where p.id = p_target for update;
  if v_before is null then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  if v_before ->> 'status' = 'deleted' then
    raise exception 'a deleted account cannot be restored' using errcode = 'check_violation';
  end if;

  update public.profiles set status = p_status where id = p_target;

  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json, reason)
  values (v_actor, 'SET_STATUS', 'public.profiles', p_target,
          jsonb_build_object('status', v_before ->> 'status'),
          jsonb_build_object('status', p_status),
          p_reason);

  if v_before ->> 'status' = 'pending' and p_status = 'active' then
    perform private.join_requested_school(p_target, v_actor);
  end if;
end;
$$;
revoke execute on function public.admin_set_profile_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_profile_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- The account list: platform admin, Staff, district admins
-- ---------------------------------------------------------------------
do $$
declare
  v_src text;
begin
  select pg_get_functiondef('public.admin_list_accounts(text, text, integer, integer)'::regprocedure) into v_src;
  if position($q$m.org_role in ('district_admin', 'school_admin')$q$ in v_src) = 0 then
    raise exception 'admin_list_accounts changed: update this migration';
  end if;
  v_src := replace(v_src,
    $q$if not v_admin and not (authz.is_active_user() and exists ($q$,
    $q$if not v_admin and not authz.is_platform_support() and not (authz.is_active_user() and exists ($q$);
  v_src := replace(v_src, $q$m.org_role in ('district_admin', 'school_admin')$q$, $q$m.org_role = 'district_admin'$q$);
  execute v_src;
end;
$$;

-- ---------------------------------------------------------------------
-- Accounts approved before this change, still without a school
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.id from public.profiles p
     where p.status = 'active' and p.requested_org_id is not null
       and not exists (select 1 from public.organization_memberships m
                        where m.user_id = p.id and m.ended_at is null)
  loop
    perform private.join_requested_school(r.id, null);
  end loop;
end;
$$;

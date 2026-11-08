-- =====================================================================
-- Phase 4a / step 1 — personal codes (รหัสประจำตัว) and account editing
--
--   profiles.user_code        unique (case-insensitive), optional, set by
--                             admins (not by the person) or by a roster import
--   authz.may_manage_account  the one rule for "may the caller manage this
--                             account" (status, name, code) — extracted from
--                             admin_set_profile_status, unchanged in meaning
--   admin_update_profile      admins edit name / display name / code; audited
--   preregistrations.user_code  roster CSV may carry the code; applied on
--                             claim if the person has none and it is free
-- Sign-in stays e-mail / Google; the code is an identifier for lists,
-- search and CSV only.
-- =====================================================================

-- ---------------------------------------------------------------------
-- columns
-- ---------------------------------------------------------------------
alter table public.profiles add column user_code text;
alter table public.profiles add constraint profiles_user_code_format
  check (user_code is null or user_code ~ '^[0-9A-Za-zก-๙._-]{1,50}$');
create unique index profiles_user_code_unique on public.profiles (lower(user_code)) where user_code is not null;

-- readable wherever the profile is readable; NOT in the self-update grant
grant select (user_code) on public.profiles to authenticated;

alter table public.preregistrations add column user_code text;
alter table public.preregistrations add constraint prereg_user_code_format
  check (user_code is null or user_code ~ '^[0-9A-Za-zก-๙._-]{1,50}$');
grant insert (user_code) on public.preregistrations to authenticated;

comment on column public.profiles.user_code is 'รหัสประจำตัว (เช่น รหัสครู) ไม่ซ้ำ ไม่สนตัวพิมพ์ · ผู้ดูแลกำหนด (admin_update_profile) หรือมาจากการนำเข้ารายชื่อ · ไม่ใช้เข้าสู่ระบบ';
comment on column public.preregistrations.user_code is 'รหัสประจำตัวจากไฟล์นำเข้า · ใส่ให้โปรไฟล์ตอนผูกบัญชี ถ้าโปรไฟล์ยังไม่มีรหัสและรหัสนี้ยังไม่ถูกใช้';

-- ---------------------------------------------------------------------
-- authz.may_manage_account — who may manage whose account
--   * the caller administers the target (authz.can_admin_user), and
--   * holders of platform roles: platform admins only, and
--   * holders of admin/supervisor org roles: a platform admin, or a district
--     admin governing that org (school admins manage teachers only)
-- Self is decided by each caller (status: never; profile: platform admin).
-- ---------------------------------------------------------------------
create function authz.may_manage_account(p_target uuid)
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
                                 and tm.org_role in ('district_admin', 'supervisor', 'school_admin')
                                 and not (tm.org_role <> 'district_admin'
                                          and authz.has_org_role(tm.organization_id, array['district_admin'])))));
$$;
revoke execute on function authz.may_manage_account(uuid) from public, anon;
grant execute on function authz.may_manage_account(uuid) to authenticated, service_role;

-- same behaviour as before, now through the shared rule
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

-- ---------------------------------------------------------------------
-- admin_update_profile — name, display name, personal code
-- ---------------------------------------------------------------------
create function public.admin_update_profile(
  p_target uuid,
  p_full_name text,
  p_display_name text default null,
  p_user_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if not ((p_target = v_actor and authz.is_platform_admin())
          or (p_target <> v_actor and authz.may_manage_account(p_target))) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_full_name), '') = '' then
    raise exception 'full name is required' using errcode = 'check_violation';
  end if;

  select jsonb_build_object('full_name', p.full_name, 'display_name', p.display_name, 'user_code', p.user_code)
    into v_before
    from public.profiles p where p.id = p_target;
  if v_before is null then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;

  update public.profiles p
     set full_name = btrim(p_full_name),
         display_name = nullif(btrim(coalesce(p_display_name, '')), ''),
         user_code = nullif(btrim(coalesce(p_user_code, '')), '')
   where p.id = p_target
  returning jsonb_build_object('full_name', p.full_name, 'display_name', p.display_name, 'user_code', p.user_code)
    into v_after;

  if v_after is distinct from v_before then
    insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json)
    values (v_actor, 'UPDATE_PROFILE', 'public.profiles', p_target, v_before, v_after);
  end if;
  return v_after || jsonb_build_object('id', p_target);
end;
$$;

revoke execute on function public.admin_update_profile(uuid, text, text, text) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- claim: also apply the roster's personal code (never overwrite, never steal)
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

    -- Personal code: only if the person has none and nobody else holds it.
    -- A race with another claim of the same code skips the code, not the claim.
    if v_row.user_code is not null then
      begin
        update public.profiles p
           set user_code = v_row.user_code
         where p.id = v_uid and p.user_code is null
           and not exists (select 1 from public.profiles q
                            where lower(q.user_code) = lower(v_row.user_code) and q.id <> v_uid);
      exception when unique_violation then
        null;
      end;
    end if;

    update public.preregistrations
       set status = 'claimed', claimed_by = v_uid, claimed_at = now()
     where id = v_row.id;

    insert into private.audit_logs (actor_id, action, table_name, record_id, after_json)
    values (v_uid, 'CLAIM_PREREGISTRATION', 'public.preregistrations', v_row.id,
            jsonb_build_object('organization_id', v_row.organization_id, 'org_role', v_row.org_role,
                               'cohort_id', v_row.cohort_id, 'imported_by', v_row.imported_by,
                               'user_code', v_row.user_code));
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function authz.may_manage_account(uuid) is 'ผู้เรียกจัดการบัญชีนี้ได้ไหม (สถานะ ชื่อ รหัส): ดูแลหน่วยงานของเป้าหมาย · ผู้มีบทบาทระดับระบบ = ผู้ดูแลระบบเท่านั้น · ผู้บริหาร/ศน./ผู้ดูแลเขต = ผู้ดูแลระบบหรือผู้ดูแลเขตที่ปกครอง';
comment on function public.admin_update_profile(uuid, text, text, text) is 'ผู้ดูแลแก้ชื่อ ชื่อที่แสดง และรหัสประจำตัว (ตาม may_manage_account; ผู้ดูแลระบบแก้ของตนเองได้) · บันทึก audit · รหัสซ้ำ = 23505';

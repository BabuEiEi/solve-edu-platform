-- =====================================================================
-- Phase 4a / step 3 — delete an account, keep its results anonymised
-- (owner decision; matches the published privacy policy)
--
--   admin_delete_account(id, confirm_email)   platform admin only, never self,
--     never a platform-role holder (revoke the role first). Typed e-mail.
--     In one transaction:
--       profile → "ผู้ใช้ที่ถูกลบ", no display name / code / contact e-mail /
--                 avatar / requested org, status 'deleted' (blocked everywhere:
--                 every rule requires status 'active')
--       organisation memberships ended, cohort memberships withdrawn,
--       mentor pairings ended
--       roster rows that carried the e-mail: e-mail / name / code replaced
--       audit rows about the person: personal keys removed
--       one DELETE_ACCOUNT audit row (no personal data)
--   Results (attempts, answers, scores, submissions, reviews) stay, attached
--   to the anonymised profile, so cohort statistics do not change.
--   The Edge Function delete-account then soft-deletes the sign-in (Supabase
--   Auth: e-mail and identities hashed, sessions revoked) and removes the
--   avatar files. Calling again on a deleted account just repeats that part.
-- =====================================================================

alter table public.profiles drop constraint profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('pending', 'active', 'suspended', 'deleted'));
comment on column public.profiles.status is 'pending|active|suspended|deleted — deleted = ลบบัญชีแล้ว (ไม่ระบุตัว ย้อนคืนไม่ได้) · เปลี่ยนสถานะอื่นผ่าน admin_set_profile_status';

-- a deleted account never comes back through the status function
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
  if v_before ->> 'status' = 'deleted' then
    raise exception 'a deleted account cannot be restored' using errcode = 'check_violation';
  end if;

  update public.profiles set status = p_status where id = p_target;

  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json, reason)
  values (v_actor, 'SET_STATUS', 'public.profiles', p_target,
          jsonb_build_object('status', v_before ->> 'status'),
          jsonb_build_object('status', p_status),
          p_reason);
end;
$$;

-- a deleted account is not edited either
create or replace function public.admin_update_profile(
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

  select jsonb_build_object('full_name', p.full_name, 'display_name', p.display_name, 'user_code', p.user_code,
                          'status', p.status)
    into v_before
    from public.profiles p where p.id = p_target;
  if v_before is null then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  if v_before ->> 'status' = 'deleted' then
    raise exception 'a deleted account cannot be edited' using errcode = 'check_violation';
  end if;
  v_before := v_before - 'status';

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

-- The roster guard: after a row is claimed or cancelled, only its personal
-- fields may still change (clients can update `status` only, so this is
-- reachable only by admin_delete_account).
create or replace function private.preregistrations_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.claimed_by := null;
    new.claimed_at := null;
    new.imported_by := coalesce(auth.uid(), new.imported_by);
  elsif old.status <> 'pending'
        and (new.status, new.organization_id, new.org_role, new.cohort_id, new.cohort_role,
             new.claimed_by, new.claimed_at, new.imported_by, new.batch_id)
            is distinct from
            (old.status, old.organization_id, old.org_role, old.cohort_id, old.cohort_role,
             old.claimed_by, old.claimed_at, old.imported_by, old.batch_id) then
    raise exception 'only pending pre-registrations can change' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create function public.admin_delete_account(p_target uuid, p_confirm_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_email text;
  v_prereg uuid[];
  v_orgs int;
  v_cohorts int;
  v_mentors int;
  v_roster int;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if not authz.is_platform_admin() or p_target = v_actor then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.platform_role_assignments r where r.user_id = p_target and r.revoked_at is null) then
    raise exception 'revoke the platform role first' using errcode = 'insufficient_privilege';
  end if;

  select * into v_profile from public.profiles p where p.id = p_target for update;
  if not found then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  if v_profile.status = 'deleted' then
    return jsonb_build_object('deleted', true, 'already_deleted', true);
  end if;

  select lower(btrim(u.email)) into v_email from auth.users u where u.id = p_target;
  if v_email is null or lower(btrim(coalesce(p_confirm_email, ''))) is distinct from v_email then
    raise exception 'type the e-mail of the account to confirm' using errcode = 'invalid_parameter_value';
  end if;

  update public.profiles p
     set full_name = 'ผู้ใช้ที่ถูกลบ', display_name = null, user_code = null, contact_email = null,
         avatar_path = null, requested_org_id = null, status = 'deleted'
   where p.id = p_target;

  update public.organization_memberships m set ended_at = now()
   where m.user_id = p_target and m.ended_at is null;
  get diagnostics v_orgs = row_count;
  update public.cohort_memberships m set status = 'withdrawn'
   where m.user_id = p_target and m.status <> 'withdrawn';
  get diagnostics v_cohorts = row_count;
  update public.mentor_assignments a set ended_at = now()
   where (a.mentor_id = p_target or a.trainee_id = p_target) and a.ended_at is null;
  get diagnostics v_mentors = row_count;

  -- roster rows that carried the e-mail (pending ones are cancelled)
  select coalesce(array_agg(r.id), '{}') into v_prereg
    from public.preregistrations r where r.email = v_email or r.claimed_by = p_target;
  update public.preregistrations r
     set status = case when r.status = 'pending' then 'cancelled' else r.status end
   where r.id = any (v_prereg) and r.status = 'pending';
  update public.preregistrations r
     set email = 'deleted.' || r.id || '@deleted.invalid', full_name = '', user_code = null
   where r.id = any (v_prereg);
  get diagnostics v_roster = row_count;

  -- audit rows about the person keep what happened, not who it was
  update private.audit_logs a
     set before_json = a.before_json - array['full_name', 'display_name', 'user_code', 'contact_email', 'avatar_path', 'email'],
         after_json = a.after_json - array['full_name', 'display_name', 'user_code', 'contact_email', 'avatar_path', 'email']
   where a.record_id = p_target or a.actor_id = p_target
      or (a.table_name = 'public.preregistrations' and a.record_id = any (v_prereg));

  insert into private.audit_logs (actor_id, action, table_name, record_id, after_json)
  values (v_actor, 'DELETE_ACCOUNT', 'public.profiles', p_target,
          jsonb_build_object('org_memberships_ended', v_orgs, 'cohort_memberships_withdrawn', v_cohorts,
                             'mentor_pairings_ended', v_mentors, 'roster_rows_scrubbed', v_roster));

  return jsonb_build_object('deleted', true, 'already_deleted', false);
end;
$$;

revoke execute on function public.admin_delete_account(uuid, text) from public, anon;
grant execute on function public.admin_delete_account(uuid, text) to authenticated;

comment on function public.admin_delete_account(uuid, text) is 'ผู้ดูแลระบบลบบัญชี (พิมพ์อีเมลยืนยัน; ไม่ใช่ตนเอง/ผู้มีบทบาทระดับระบบ): ลบข้อมูลส่วนตัว ยุติสิทธิ์ทั้งหมด สถานะ deleted · ผลการอบรมคงอยู่แบบไม่ระบุตัว · Edge Function delete-account ปิดการเข้าสู่ระบบและลบรูปโปรไฟล์ต่อ';

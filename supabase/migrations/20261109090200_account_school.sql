-- Phase 4f step 2: change the school of an account (the "แก้ไข" form).
--
-- admin_set_school(target, school) — one school per person as teacher:
--   * who: whoever may manage the account (authz.may_manage_account) — the
--     platform admin, Staff, or a district admin for people of their district
--   * a district admin (not platform admin, not Staff) may only pick a school
--     of their own district
--   * the school must be an active organization of type 'school'
--   * the person's other current teacher memberships end (history kept);
--     their other roles (supervisor, district admin) are left alone
--   * school null = no school (current teacher memberships end)
--   * every change is audited by the membership table's trigger
-- → the person's current memberships [{organization_id, name, org_role}]

create function public.admin_set_school(p_target uuid, p_school uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_status text;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if not authz.may_manage_account(p_target) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  select p.status into v_status from public.profiles p where p.id = p_target for update;
  if v_status is null then
    raise exception 'profile not found' using errcode = 'no_data_found';
  end if;
  if v_status = 'deleted' then
    raise exception 'a deleted account cannot be changed' using errcode = 'check_violation';
  end if;

  if p_school is not null then
    if not exists (select 1 from public.organizations o
                    where o.id = p_school and o.org_type = 'school' and o.active) then
      raise exception 'not an active school' using errcode = 'invalid_parameter_value';
    end if;
    if not authz.is_platform_admin() and not authz.is_platform_support()
       and not authz.has_org_role(p_school, array['district_admin']) then
      raise exception 'school outside your district' using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- end the teacher memberships elsewhere (one school per person)
  update public.organization_memberships m
     set ended_at = now()
   where m.user_id = p_target and m.ended_at is null and m.org_role = 'teacher'
     and m.organization_id is distinct from p_school;

  if p_school is not null and not exists (
       select 1 from public.organization_memberships m
        where m.user_id = p_target and m.ended_at is null
          and m.org_role = 'teacher' and m.organization_id = p_school) then
    insert into public.organization_memberships (user_id, organization_id, org_role, granted_by)
    values (p_target, p_school, 'teacher', v_actor);
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('organization_id', m.organization_id, 'name', o.name, 'org_role', m.org_role)
                     order by o.name, m.org_role)
      from public.organization_memberships m
      join public.organizations o on o.id = m.organization_id
     where m.user_id = p_target and m.ended_at is null), '[]'::jsonb);
end;
$$;

revoke execute on function public.admin_set_school(uuid, uuid) from public, anon;
grant execute on function public.admin_set_school(uuid, uuid) to authenticated;
comment on function public.admin_set_school(uuid, uuid) is
  'เปลี่ยนโรงเรียน (บทบาทครู) ของบัญชี: ผู้ที่จัดการบัญชีนั้นได้ · ผู้ดูแลเขตเลือกได้เฉพาะโรงเรียนในเขต · null = ไม่มีโรงเรียน · บทบาทอื่นไม่ถูกแตะ (4f)';

-- The account list says which rows may have their school changed (same rule as the function)
do $$
declare
  v_src text;
  v_old constant text := $q$'can_delete', v_admin and g.id <> v_actor$q$;
  v_org_old constant text := $q$jsonb_build_object('name', o.name, 'role', m.org_role)$q$;
begin
  select pg_get_functiondef('public.admin_list_accounts(text, text, integer, integer)'::regprocedure) into v_src;
  if position(v_old in v_src) = 0 or position(v_org_old in v_src) = 0 then
    raise exception 'admin_list_accounts changed: update this migration';
  end if;
  -- each current organization carries its id (the form preselects the school)
  v_src := replace(v_src, v_org_old, $q$jsonb_build_object('id', o.id, 'name', o.name, 'role', m.org_role)$q$);
  execute replace(v_src, v_old,
    $q$'can_set_school', g.status <> 'deleted' and authz.may_manage_account(g.id),
               $q$ || v_old);
end;
$$;

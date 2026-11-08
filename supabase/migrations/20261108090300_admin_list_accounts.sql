-- =====================================================================
-- Phase 4a / step 4 — the account list for "จัดการบัญชี"
--
--   admin_list_accounts(search, status, limit, offset) → {total, rows[]}
--     only people the caller administers (authz.can_admin_user — the same
--     rule as get_profile_contact, so no wider than before); search over
--     name, display name, personal code and e-mail; paged on the server.
--     Each row says what the caller may do with it (can_manage, can_delete),
--     so the page never offers what the database would refuse.
--   E-mail is shown only to those administrators (and never for a deleted
--   account, whose sign-in e-mail is a hash).
-- =====================================================================

create function public.admin_list_accounts(
  p_search text default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_admin boolean;
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  v_admin := authz.is_platform_admin();
  if not v_admin and not (authz.is_active_user() and exists (
        select 1 from public.organization_memberships m
         where m.user_id = v_actor and m.ended_at is null and m.org_role in ('district_admin', 'school_admin'))) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
  if p_status is not null and p_status not in ('pending', 'active', 'suspended', 'deleted') then
    raise exception 'unknown status' using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset < 0 then
    raise exception 'limit 1-200, offset >= 0' using errcode = 'invalid_parameter_value';
  end if;
  if v_q is not null and char_length(v_q) > 100 then
    raise exception 'search too long' using errcode = 'invalid_parameter_value';
  end if;

  with visible as (
    select p.*, u.email, u.last_sign_in_at
      from public.profiles p
      join auth.users u on u.id = p.id
     where (v_admin or authz.can_admin_user(p.id))
       and (p_status is null or p.status = p_status)
       and (v_q is null
            or p.full_name ilike '%' || v_q || '%'
            or coalesce(p.display_name, '') ilike '%' || v_q || '%'
            or coalesce(p.user_code, '') ilike '%' || v_q || '%'
            or (p.status <> 'deleted' and coalesce(u.email, '') ilike '%' || v_q || '%'))
  ), page as (
    select * from visible
     order by case status when 'pending' then 0 when 'active' then 1 when 'suspended' then 2 else 3 end,
              full_name, id
     limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from visible),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id,
               'full_name', g.full_name,
               'display_name', g.display_name,
               'user_code', g.user_code,
               'email', case when g.status = 'deleted' then null else g.email end,
               'status', g.status,
               'created_at', g.created_at,
               'last_sign_in_at', g.last_sign_in_at,
               'requested_org', (select o.name from public.organizations o where o.id = g.requested_org_id),
               'orgs', coalesce((select jsonb_agg(jsonb_build_object('name', o.name, 'role', m.org_role) order by o.name, m.org_role)
                                   from public.organization_memberships m
                                   join public.organizations o on o.id = m.organization_id
                                  where m.user_id = g.id and m.ended_at is null), '[]'::jsonb),
               'platform_roles', coalesce((select jsonb_agg(r.role order by r.role) from public.platform_role_assignments r
                                            where r.user_id = g.id and r.revoked_at is null), '[]'::jsonb),
               'is_self', g.id = v_actor,
               'can_manage', g.status <> 'deleted' and g.id <> v_actor and authz.may_manage_account(g.id),
               'can_edit', g.status <> 'deleted'
                           and ((g.id = v_actor and v_admin) or (g.id <> v_actor and authz.may_manage_account(g.id))),
               'can_delete', v_admin and g.id <> v_actor and g.status <> 'deleted'
                             and not exists (select 1 from public.platform_role_assignments r
                                              where r.user_id = g.id and r.revoked_at is null))
             order by case g.status when 'pending' then 0 when 'active' then 1 when 'suspended' then 2 else 3 end,
                      g.full_name, g.id)
        from page g), '[]'::jsonb))
  into v_result;
  return v_result;
end;
$$;

revoke execute on function public.admin_list_accounts(text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_accounts(text, text, integer, integer) to authenticated;

comment on function public.admin_list_accounts(text, text, integer, integer) is 'รายชื่อบัญชีสำหรับหน้า "จัดการบัญชี": เฉพาะคนที่ผู้เรียกดูแล (can_admin_user) · ค้นหาชื่อ/รหัส/อีเมล · แบ่งหน้า · บอก can_manage / can_edit / can_delete ต่อแถว · ไม่แสดงอีเมลของบัญชีที่ลบแล้ว';

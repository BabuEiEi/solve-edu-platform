-- Phase 4a step 4: the account list — only people the caller administers,
-- search over name / code / e-mail, paging, and per-row rights that match
-- what the database would allow.
begin;
select plan(22);

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $$;
grant execute on function pg_temp.err(text) to authenticated, anon;
create or replace function pg_temp.ids(p jsonb) returns text language sql as $$
  select string_agg(r ->> 'id', ',' order by r ->> 'id') from jsonb_array_elements(p -> 'rows') r $$;
grant execute on function pg_temp.ids(jsonb) to authenticated;
create or replace function pg_temp.row_of(p jsonb, p_id uuid) returns jsonb language sql as $$
  select r from jsonb_array_elements(p -> 'rows') r where r ->> 'id' = p_id::text $$;
grant execute on function pg_temp.row_of(jsonb, uuid) to authenticated;

update public.profiles set user_code = 'T-A1' where id = tests.uid('teacher_a1');

select ok(not has_function_privilege('anon', 'public.admin_list_accounts(text,text,integer,integer)', 'execute'), 'anon cannot call it');
select is((select proconfig from pg_proc where oid = 'public.admin_list_accounts(text,text,integer,integer)'::regprocedure), array['search_path=""'],
  'it pins an empty search_path');

-- ---------- who may list ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err($$ select public.admin_list_accounts() $$), '42501', 'a teacher cannot list accounts');
reset role;
select tests.authenticate_as('mentor');
select is(pg_temp.err($$ select public.admin_list_accounts() $$), '42501', 'a mentor cannot either');
reset role;

select tests.authenticate_as('school_admin_b'); -- a teacher of school B now (4f removed school admins)
select is(pg_temp.err($$ select public.admin_list_accounts() $$), '42501', 'a former school admin cannot list accounts any more');
reset role;

-- ---------- scope: Staff (4f) ----------
select tests.authenticate_as('staff');
select ok(public.admin_list_accounts() -> 'rows' @> jsonb_build_array(jsonb_build_object('id', tests.uid('teacher_a1')))
      and public.admin_list_accounts() -> 'rows' @> jsonb_build_array(jsonb_build_object('id', tests.uid('teacher_b1'))),
  'Staff sees teachers of every school');
select is(pg_temp.row_of(public.admin_list_accounts(), tests.uid('platform_admin')), null,
  '… but not the platform admin (a platform role holder)');
select is((pg_temp.row_of(public.admin_list_accounts(), tests.uid('teacher_a1')) ->> 'can_delete')::boolean, false,
  'Staff may manage a teacher but never delete accounts');
select is((pg_temp.row_of(public.admin_list_accounts(), tests.uid('teacher_a1')) ->> 'can_manage')::boolean, true,
  '… can_manage is true for a teacher');
select is((pg_temp.row_of(public.admin_list_accounts(), tests.uid('district_admin')) ->> 'can_manage')::boolean, false,
  '… false for a district admin');
select is((public.admin_list_accounts(p_search => 't-a1') -> 'rows' -> 0 ->> 'id'), tests.uid('teacher_a1')::text,
  'Staff finds a teacher by code, ignoring case');
select is((public.admin_list_accounts(p_search => 'teacher.a1@') -> 'rows' -> 0 ->> 'email'), 'teacher.a1@example.test',
  '… and by e-mail, which is shown to the administrator');
reset role;

-- ---------- platform admin ----------
select tests.authenticate_as('platform_admin');
select is((public.admin_list_accounts() ->> 'total')::int, (select count(*)::int from public.profiles), 'the platform admin sees everybody');
select is((pg_temp.row_of(public.admin_list_accounts(), tests.uid('platform_admin')) ->> 'is_self')::boolean, true, 'their own row is marked');
select is((pg_temp.row_of(public.admin_list_accounts(), tests.uid('platform_admin')) - array['id','full_name','display_name','user_code','email','status','created_at','last_sign_in_at','requested_org','orgs','platform_roles','is_self']),
  '{"can_edit": true, "can_delete": false, "can_manage": false, "can_set_school": true}'::jsonb,
  'self: may edit own name/code, never manage or delete self');
select is((pg_temp.row_of(public.admin_list_accounts(), tests.uid('teacher_b1')) ->> 'can_delete')::boolean, true, 'may delete a teacher');
select is(pg_temp.row_of(public.admin_list_accounts(), tests.uid('district_admin')) -> 'orgs',
  jsonb_build_array(jsonb_build_object('id', tests.uid('district'), 'name', (select name from public.organizations where id = tests.uid('district')), 'role', 'district_admin')),
  'current organisations and roles are listed');
select is(jsonb_array_length(public.admin_list_accounts(p_limit => 2) -> 'rows'), 2, 'paging: limit');
select isnt(pg_temp.ids(public.admin_list_accounts(p_limit => 2)), pg_temp.ids(public.admin_list_accounts(p_limit => 2, p_offset => 2)),
  'paging: the next page is different');
select is(pg_temp.err($$ select public.admin_list_accounts(p_limit => 500) $$), '22023', 'at most 200 per page');
select is(pg_temp.err($$ select public.admin_list_accounts(p_status => 'gone') $$), '22023', 'unknown status refused');
reset role;

-- ---------- a deleted account: listed, but without e-mail and without actions ----------
select tests.authenticate_as('platform_admin');
select public.admin_delete_account(tests.uid('teacher_b1'), 'teacher.b1@example.test');
select is(pg_temp.row_of(public.admin_list_accounts(p_status => 'deleted'), tests.uid('teacher_b1')) - array['id','created_at','last_sign_in_at','requested_org'],
  '{"email": null, "full_name": "ผู้ใช้ที่ถูกลบ", "display_name": null, "user_code": null, "status": "deleted", "orgs": [], "platform_roles": [], "is_self": false, "can_manage": false, "can_edit": false, "can_delete": false, "can_set_school": false}'::jsonb,
  'a deleted account shows no e-mail and offers nothing');
reset role;

select * from finish();
rollback;

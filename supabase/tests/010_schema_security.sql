-- Structural security invariants: RLS everywhere, minimal grants,
-- private schema closed, definer functions hardened.
begin;
select plan(13);

select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  'every table in public has RLS enabled'
);

select is_empty(
  $$ select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon' $$,
  'anon has no table privileges in public (Phase 1 has no public content)'
);

select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated cannot use schema private');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon cannot use schema private');
select ok(not has_schema_privilege('anon', 'authz', 'usage'), 'anon cannot use schema authz');

select ok(not has_column_privilege('authenticated', 'public.profiles', 'contact_email', 'select'),
  'contact_email is not selectable by authenticated');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'status', 'update'),
  'profile status is not client-updatable');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'insert'),
  'clients cannot insert profiles directly');

select is_empty(
  $$ select n.nspname || '.' || p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef
        and n.nspname in ('public', 'authz', 'private')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') $$,
  'every SECURITY DEFINER function pins search_path'
);

select ok(not has_function_privilege('anon', 'public.admin_set_profile_status(uuid,text,text)', 'execute'),
  'anon cannot execute admin_set_profile_status');
select ok(not has_function_privilege('anon', 'public.get_profile_contact(uuid)', 'execute'),
  'anon cannot execute get_profile_contact');

-- Profile lifecycle trigger ignores user-supplied role metadata
insert into auth.users (id, email, raw_user_meta_data)
values ('99999999-0000-4000-a000-000000000001', 'sneaky@example.test',
        '{"full_name":"ผู้ทดสอบ","role":"admin","status":"active"}');

select results_eq(
  $$ select full_name, status from public.profiles where id = '99999999-0000-4000-a000-000000000001' $$,
  $$ values ('ผู้ทดสอบ'::text, 'pending'::text) $$,
  'new auth user gets a pending profile; metadata role/status ignored'
);
select is_empty(
  $$ select 1 from public.platform_role_assignments where user_id = '99999999-0000-4000-a000-000000000001'
     union all
     select 1 from public.organization_memberships where user_id = '99999999-0000-4000-a000-000000000001' $$,
  'new user has no roles'
);

select * from finish();
rollback;

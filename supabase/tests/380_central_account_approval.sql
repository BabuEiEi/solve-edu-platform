-- Phase 4f: central approval. No school admins; Staff (platform_support)
-- approves and manages accounts without platform roles; approving adds the
-- school that was asked for; Staff never deletes or appoints.
begin;
select plan(34);

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
create or replace function pg_temp.schools_of(p_user uuid) returns text language sql as $$
  select coalesce(string_agg(o.code || ':' || m.org_role, ',' order by o.code), '')
    from public.organization_memberships m join public.organizations o on o.id = m.organization_id
   where m.user_id = p_user and m.ended_at is null $$;

-- people who signed up and asked for a school (as postgres)
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000e1', 'asks.school.b@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000e2', 'asks.nothing@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000e3', 'already.placed@example.test', now(), '{}');
update public.profiles set requested_org_id = tests.uid('school_b') where id = '99999999-0000-4000-a000-0000000000e1';
update public.profiles set requested_org_id = tests.uid('school_b') where id = '99999999-0000-4000-a000-0000000000e3';
insert into public.organization_memberships (user_id, organization_id, org_role, granted_by)
values ('99999999-0000-4000-a000-0000000000e3', tests.uid('school_a'), 'teacher', tests.uid('district_admin'));

-- ---------- the functions themselves ----------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname, p.proname) in (('authz', 'is_platform_support'), ('authz', 'can_admin_user'), ('authz', 'may_manage_account'),
                                             ('authz', 'can_grant_org_role'), ('authz', 'can_view_profile'),
                                             ('private', 'join_requested_school'), ('public', 'admin_set_profile_status'),
                                             ('public', 'admin_list_accounts'))
              and p.prosecdef and p.proconfig = array['search_path=""']), 8,
  'every changed SECURITY DEFINER function pins an empty search_path');
select ok(not has_function_privilege('authenticated', 'private.join_requested_school(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'private.join_requested_school(uuid,uuid)', 'execute'),
  'nobody can add a school by calling the helper directly');
select ok(not has_function_privilege('anon', 'authz.is_platform_support()', 'execute'), 'anon cannot call is_platform_support');
select is((select count(*)::int from pg_proc where prosrc like '%school_admin%'
             and pronamespace in ('authz'::regnamespace, 'public'::regnamespace, 'private'::regnamespace)), 0,
  'no function grants anything to school_admin any more');

-- ---------- the role is gone ----------
select is(pg_temp.err($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                         values ('99999999-0000-4000-a000-0000000000e2', '10000000-0000-4000-a000-000000000002', 'school_admin') $$),
  '23514', 'school_admin cannot be stored any more (database owner included)');
select is(pg_temp.err($$ insert into public.preregistrations (email, organization_id, org_role)
                         values ('x@example.test', '10000000-0000-4000-a000-000000000002', 'school_admin') $$),
  '23514', '… nor imported');

-- ---------- Staff approves; the school asked for is added ----------
select tests.authenticate_as('staff');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000e1', 'active', 'ยืนยันแล้ว') $$),
  'no error', 'Staff approves a person who asked for school B');
reset role;
select is(pg_temp.schools_of('99999999-0000-4000-a000-0000000000e1'), 'DEMO-SCH-B:teacher', '… who becomes a teacher of school B');
select is((select granted_by from public.organization_memberships where user_id = '99999999-0000-4000-a000-0000000000e1'),
  tests.uid('staff'), '… granted by the approver');
select ok(exists (select 1 from private.audit_logs
                   where table_name = 'public.organization_memberships' and action = 'INSERT' and actor_id = tests.uid('staff')
                     and after_json ->> 'user_id' = '99999999-0000-4000-a000-0000000000e1'),
  '… and the new membership is audited');

select tests.authenticate_as('staff');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000e1', 'suspended', 'x') $$),
  'no error', 'Staff suspends that person');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000e1', 'active', 'x') $$),
  'no error', '… and brings them back');
reset role;
select is(pg_temp.schools_of('99999999-0000-4000-a000-0000000000e1'), 'DEMO-SCH-B:teacher',
  'only the first approval (pending → active) adds a school: no duplicate on re-activation');

select tests.authenticate_as('staff');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000e2', 'active', 'x') $$),
  'no error', 'a person who asked for nothing is approved too');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000e3', 'active', 'x') $$),
  'no error', 'and a person already placed in a school');
reset role;
select is(pg_temp.schools_of('99999999-0000-4000-a000-0000000000e2'), '', '… asked for nothing → no school');
select is(pg_temp.schools_of('99999999-0000-4000-a000-0000000000e3'), 'DEMO-SCH-A:teacher',
  '… already placed → left as it was (not moved to the school asked for)');

-- ---------- what Staff may not do ----------
select tests.authenticate_as('staff');
select is(pg_temp.err($$ select public.admin_set_profile_status(tests.uid('platform_admin'), 'suspended', 'x') $$),
  '42501', 'Staff cannot suspend the platform admin');
select is(pg_temp.err($$ select public.admin_set_profile_status(tests.uid('district_admin'), 'suspended', 'x') $$),
  '42501', 'nor a district admin');
select is(pg_temp.err($$ select public.admin_set_profile_status(tests.uid('supervisor'), 'suspended', 'x') $$),
  'no error', 'but may suspend a supervisor');
select is(pg_temp.err($$ select public.admin_delete_account(tests.uid('teacher_b1'), 'teacher.b1@example.test') $$),
  '42501', 'Staff never deletes an account');
select is(pg_temp.err($$ insert into public.platform_role_assignments (user_id, role) values (tests.uid('teacher_a1'), 'platform_support') $$),
  '42501', 'Staff cannot appoint Staff');
select is(pg_temp.err($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                         values (tests.uid('teacher_a1'), tests.uid('district'), 'district_admin') $$),
  '42501', 'nor grant an organization role directly');
select is_empty($$ select 1 from public.preregistrations $$, 'Staff does not read the roster import (e-mails)');
reset role;

-- ---------- a revoked Staff member has no power left ----------
update public.platform_role_assignments set revoked_at = now()
 where user_id = tests.uid('staff') and role = 'platform_support';
select tests.authenticate_as('staff');
select is(pg_temp.err($$ select public.admin_set_profile_status(tests.uid('teacher_a2'), 'suspended', 'x') $$),
  '42501', 'once revoked, Staff can no longer manage accounts');
select is(pg_temp.err($$ select public.admin_list_accounts() $$), '42501', '… nor list them');
reset role;

-- ---------- the district admin still approves in the district ----------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000e4', 'district.newcomer@example.test', now(), '{}');
update public.profiles set requested_org_id = tests.uid('school_a') where id = '99999999-0000-4000-a000-0000000000e4';
select tests.authenticate_as('district_admin');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000e4', 'active', 'x') $$),
  'no error', 'the district admin approves a person who asked for a school of the district');
reset role;
select is(pg_temp.schools_of('99999999-0000-4000-a000-0000000000e4'), 'DEMO-SCH-A:teacher', '… who joins that school');

-- ---------- a teacher (e.g. a former school admin) approves nobody ----------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000e5', 'waiting@example.test', now(), '{}');
update public.profiles set requested_org_id = tests.uid('school_a') where id = '99999999-0000-4000-a000-0000000000e5';
select tests.authenticate_as('school_admin_a');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000e5', 'active', 'x') $$),
  '42501', 'a teacher of school A (formerly its school admin) cannot approve someone asking for school A');
select is_empty($$ select 1 from public.profiles where id = '99999999-0000-4000-a000-0000000000e5' $$,
  '… and cannot even see them');
reset role;
select is((select status from public.profiles where id = '99999999-0000-4000-a000-0000000000e5'), 'pending', '… who stays pending');

-- ---------- accounts approved before 4f (the migration ran the same helper for each) ----------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000e6', 'approved.before@example.test', now(), '{}');
update public.profiles set status = 'active', requested_org_id = tests.uid('school_b')
 where id = '99999999-0000-4000-a000-0000000000e6';
select isnt(private.join_requested_school('99999999-0000-4000-a000-0000000000e6', null), null,
  'an active account with a school asked for and none given gets it');
select is(pg_temp.schools_of('99999999-0000-4000-a000-0000000000e6'), 'DEMO-SCH-B:teacher', '… as a teacher');
select is(private.join_requested_school('99999999-0000-4000-a000-0000000000e6', null), null,
  'running it again adds nothing (safe to repeat)');

select * from finish();
rollback;

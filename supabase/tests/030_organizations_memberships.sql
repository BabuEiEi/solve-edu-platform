-- Organization scope, role-grant hierarchy, revocation, hierarchy integrity
begin;
select plan(17);

-- ---------- school scope isolation ----------
select tests.authenticate_as('school_admin_a');
select is_empty($$ select 1 from public.organization_memberships where organization_id = tests.uid('school_b') $$,
  'School admin A cannot read school B memberships');
select is_empty($$ select 1 from public.profiles where id = tests.uid('teacher_b1') $$,
  'School admin A cannot read school B teacher');
select lives_ok($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                   values (tests.uid('trainer'), tests.uid('school_a'), 'teacher') $$,
  'School admin A can grant teacher in school A');
select throws_ok($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                    values (tests.uid('trainer'), tests.uid('school_b'), 'teacher') $$,
  '42501', null, 'School admin A cannot grant teacher in school B');
select throws_ok($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                    values (tests.uid('teacher_a2'), tests.uid('school_a'), 'school_admin') $$,
  '42501', null, 'School admin cannot grant school_admin');
select throws_ok($$ insert into public.organizations (code, name, org_type, parent_id)
                    values ('X', 'X', 'school', tests.uid('district')) $$,
  '42501', null, 'School admin cannot create organizations');
reset role;

select is((select granted_by from public.organization_memberships
            where user_id = tests.uid('trainer') and organization_id = tests.uid('school_a')),
          tests.uid('school_admin_a'), 'granted_by is stamped from auth.uid()');
select ok(exists (select 1 from private.audit_logs
                   where table_name = 'public.organization_memberships' and action = 'INSERT'
                     and actor_id = tests.uid('school_admin_a')),
  'membership grant is audited');

-- ---------- district scope ----------
select tests.authenticate_as('district_admin');
select is((select count(*)::int from public.organization_memberships
            where organization_id in (tests.uid('school_a'), tests.uid('school_b')) and ended_at is null),
          7, 'District admin sees memberships of all schools in the district');
select throws_ok($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                    values (tests.uid('supervisor'), tests.uid('district'), 'district_admin') $$,
  '42501', null, 'District admin cannot grant district_admin (platform admin only)');
select lives_ok($$ insert into public.organizations (code, name, org_type, parent_id)
                   values ('DEMO-SCH-C', 'โรงเรียนสาธิต ค', 'school', tests.uid('district')) $$,
  'District admin can create a school under own district');

-- revoke school admin A
select lives_ok($$ update public.organization_memberships set ended_at = now()
                    where user_id = tests.uid('school_admin_a') and organization_id = tests.uid('school_a') $$,
  'District admin revokes school admin A');
reset role;

select tests.authenticate_as('school_admin_a');
select is_empty($$ select 1 from public.profiles where id = tests.uid('teacher_a1') $$,
  'After revocation, former school admin can no longer read school A teachers');
reset role;

select throws_ok($$ update public.organization_memberships set ended_at = null
                    where user_id = tests.uid('school_admin_a') $$,
  '23514', null, 'ended_at cannot be cleared once set (no silent re-activation)');

-- ---------- hierarchy integrity ----------
select throws_ok($$ update public.organizations set parent_id = tests.uid('school_a') where id = tests.uid('district') $$,
  '23514', null, 'organization hierarchy cycle is rejected');

-- ---------- platform roles ----------
select tests.authenticate_as('platform_admin');
select throws_ok($$ insert into public.platform_role_assignments (user_id, role) values (tests.uid('platform_admin'), 'platform_support') $$,
  '42501', null, 'Platform admin cannot self-grant additional platform roles');
select lives_ok($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                   values (tests.uid('supervisor'), tests.uid('district'), 'district_admin') $$,
  'Platform admin can grant district_admin');
reset role;

select * from finish();
rollback;

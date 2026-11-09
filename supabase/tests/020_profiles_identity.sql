-- Identity & profile isolation + self-escalation attempts + status workflow
begin;
select plan(24);

-- ---------- anonymous ----------
select tests.as_anon();
select throws_ok($$ select * from public.profiles $$, '42501', null, 'anon cannot read profiles');
select throws_ok($$ select * from public.organization_memberships $$, '42501', null, 'anon cannot read memberships');
select throws_ok($$ select public.get_profile_contact('00000000-0000-4000-a000-000000000008') $$,
  '42501', null, 'anon cannot call get_profile_contact');
reset role;

-- ---------- trainee isolation ----------
select tests.authenticate_as('teacher_a1');
select ok(exists (select 1 from public.profiles where id = tests.uid('teacher_a1')), 'A1 reads own profile');
select is_empty($$ select 1 from public.profiles where id = tests.uid('teacher_a2') $$,
  'A1 cannot read classmate A2 (same cohort, same school)');
select is_empty($$ select 1 from public.profiles where id = tests.uid('teacher_b1') $$,
  'A1 cannot read B1 (other school)');
select ok(exists (select 1 from public.profiles where id = tests.uid('trainer')), 'A1 can see the cohort trainer');
select throws_ok($$ select contact_email from public.profiles $$, '42501', null,
  'contact_email column is not selectable');
select is(public.get_profile_contact(tests.uid('teacher_a1')), 'teacher.a1@example.test', 'A1 can read own contact via RPC');
select throws_ok($$ select public.get_profile_contact(tests.uid('teacher_a2')) $$, '42501', null,
  'A1 cannot read A2 contact');

-- ---------- self-escalation ----------
select throws_ok($$ update public.profiles set status = 'suspended' where id = tests.uid('teacher_a1') $$,
  '42501', null, 'A1 cannot update own status column');
select throws_ok($$ insert into public.platform_role_assignments (user_id, role) values (tests.uid('teacher_a1'), 'platform_admin') $$,
  '42501', null, 'A1 cannot self-assign platform_admin');
select throws_ok($$ insert into public.organization_memberships (user_id, organization_id, org_role)
                    values (tests.uid('teacher_a1'), tests.uid('school_a'), 'district_admin') $$,
  '42501', null, 'A1 cannot grant self an admin role');
select throws_ok($$ select public.admin_set_profile_status(tests.uid('teacher_a2'), 'suspended', 'x') $$,
  '42501', null, 'A1 cannot suspend another user');
select throws_ok($$ update public.profiles set requested_org_id = tests.uid('school_b') where id = tests.uid('teacher_a1') $$,
  '42501', null, 'active user cannot change requested_org_id');
select lives_ok($$ update public.profiles set display_name = 'ครูเอ' where id = tests.uid('teacher_a1') $$,
  'A1 can edit own display_name');
select is((select count(*)::int from public.profiles where display_name = 'ครูเอ'), 1, 'own display_name updated');
reset role;

-- ---------- approval workflow (4f: platform admin, Staff, district admin — no school admins) ----------
-- school_admin_a / _b were the demo school admins; the role is gone, they are teachers now
select tests.authenticate_as('school_admin_a');
select throws_ok($$ select public.admin_set_profile_status(tests.uid('newcomer'), 'active', 'try') $$,
  '42501', null, 'a teacher of school A (formerly its school admin) cannot approve a newcomer of school A');
reset role;

select tests.authenticate_as('staff');
select ok(exists (select 1 from public.profiles where id = tests.uid('newcomer') and status = 'pending'),
  'Staff sees the pending newcomer');
select lives_ok($$ select public.admin_set_profile_status(tests.uid('newcomer'), 'active', 'ยืนยันตัวตนแล้ว') $$,
  'Staff approves newcomer');
select throws_ok($$ select public.admin_set_profile_status(tests.uid('district_admin'), 'suspended', 'x') $$,
  '42501', null, 'Staff cannot suspend a district admin');
select throws_ok($$ select public.admin_set_profile_status(tests.uid('staff'), 'suspended', 'x') $$,
  '42501', null, 'cannot change own status');
reset role;

select is((select status from public.profiles where id = tests.uid('newcomer')), 'active', 'newcomer is active');
select is(
  (select count(*)::int from private.audit_logs
    where action = 'SET_STATUS' and record_id = tests.uid('newcomer')
      and actor_id = tests.uid('staff') and reason = 'ยืนยันตัวตนแล้ว'),
  1, 'status change written to audit log with actor and reason');

select * from finish();
rollback;

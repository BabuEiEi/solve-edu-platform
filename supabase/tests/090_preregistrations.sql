-- CSV pre-registration: import rights, verified-email claim, no escalation
begin;
select plan(26);

-- fixtures (as postgres): people who signed up themselves
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000a1', 'new.teacher@example.test', now(), '{"full_name":"ครูใหม่"}'),
  ('99999999-0000-4000-a000-0000000000a2', 'unverified@example.test', null, '{}'),
  ('99999999-0000-4000-a000-0000000000a3', 'other.person@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000a4', 'cohort.person@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000a5', 'late.admin@example.test', now(), '{}');

-- ---------- import rights (4f: the district admin imports; there are no school admins) ----------
select tests.authenticate_as('school_admin_a'); -- a teacher of school A now
select throws_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                    values ('x@example.test', tests.uid('school_a'), 'teacher') $$,
  '42501', null, 'A teacher of school A (formerly its school admin) cannot import');
reset role;
select tests.authenticate_as('district_admin');
select lives_ok($$ insert into public.preregistrations (email, full_name, organization_id, org_role)
                   values ('new.teacher@example.test', 'ครูใหม่', tests.uid('school_a'), 'teacher') $$,
  'District admin imports a teacher for school A');
select lives_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                   values ('unverified@example.test', tests.uid('school_a'), 'teacher') $$,
  'District admin imports a second row');
select lives_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                   values ('late.admin@example.test', tests.uid('school_a'), 'teacher') $$,
  'District admin imports a row that will lose its importer rights');
select throws_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                    values ('x@example.test', tests.uid('district'), 'district_admin') $$,
  '42501', null, 'District admin cannot pre-register a district admin (no privilege laundering)');
select throws_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                    values ('new.teacher@example.test', tests.uid('school_a'), 'teacher') $$,
  '23505', null, 'Duplicate pending row is rejected');
select throws_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                    values ('Mixed.Case@Example.test', tests.uid('school_a'), 'teacher') $$,
  '23514', null, 'Email must be normalised (lower-case)');
select throws_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                    values ('not-an-email', tests.uid('school_a'), 'teacher') $$,
  '23514', null, 'Malformed email rejected');
select throws_ok($$ insert into public.preregistrations (email, organization_id, org_role, status)
                    values ('forged@example.test', tests.uid('school_a'), 'teacher', 'claimed') $$,
  '42501', null, 'Client cannot set status/claimed fields');
reset role;

select tests.authenticate_as('teacher_a1');
select throws_ok($$ insert into public.preregistrations (email, organization_id, org_role)
                    values ('y@example.test', tests.uid('school_a'), 'teacher') $$,
  '42501', null, 'A plain teacher cannot import');
select is_empty($$ select 1 from public.preregistrations $$, 'A plain teacher cannot read the roster (emails are PII)');
reset role;
select tests.authenticate_as('school_admin_b');
select is_empty($$ select 1 from public.preregistrations $$, 'A teacher of school B (formerly its admin) cannot read the roster');
reset role;
select tests.as_anon();
select throws_ok($$ select * from public.preregistrations $$, '42501', null, 'anon cannot read the roster');
select throws_ok($$ select public.claim_my_preregistrations() $$, '42501', null, 'anon cannot claim');
reset role;

-- cohort roster row, imported by the platform admin
select tests.authenticate_as('platform_admin');
select lives_ok($$ insert into public.preregistrations (email, organization_id, org_role, cohort_id, cohort_role)
                   values ('cohort.person@example.test', tests.uid('school_b'), 'teacher', tests.uid('cohort'), 'trainee') $$,
  'Platform admin imports a roster row with a cohort');
reset role;

-- ---------- claim ----------
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a1');
select is(public.claim_my_preregistrations(), 1, 'Verified email matching the roster: 1 row applied');
reset role;
select ok(
  exists (select 1 from public.profiles where id = '99999999-0000-4000-a000-0000000000a1' and status = 'active')
  and exists (select 1 from public.organization_memberships
               where user_id = '99999999-0000-4000-a000-0000000000a1'
                 and organization_id = tests.uid('school_a') and org_role = 'teacher' and ended_at is null),
  'profile activated and teacher membership created');
select ok(exists (select 1 from public.preregistrations p
                   join public.organization_memberships m on m.user_id = p.claimed_by
                  where p.email = 'new.teacher@example.test' and p.status = 'claimed'
                    and p.claimed_at is not null and m.granted_by = tests.uid('district_admin')),
  'row marked claimed; membership.granted_by is the importer, not the claimant');

select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a1');
select is(public.claim_my_preregistrations(), 0, 'Claiming again is idempotent');
reset role;

select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a2');
select is(public.claim_my_preregistrations(), 0, 'UNVERIFIED email claims nothing');
reset role;
select is((select status from public.profiles where id = '99999999-0000-4000-a000-0000000000a2'), 'pending',
  'unverified user stays pending');

select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a3');
select is(public.claim_my_preregistrations(), 0, 'Verified user whose email is not on any roster claims nothing');
reset role;

select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a4');
select is(public.claim_my_preregistrations(), 1, 'Roster row with a cohort is applied');
reset role;
select ok(exists (select 1 from public.cohort_memberships
                   where cohort_id = tests.uid('cohort') and user_id = '99999999-0000-4000-a000-0000000000a4'
                     and cohort_role = 'trainee' and status = 'active' and approved_by = tests.uid('platform_admin')),
  'trainee cohort membership created, approved_by = importer');
select ok(exists (select 1 from private.audit_logs
                   where action = 'CLAIM_PREREGISTRATION' and actor_id = '99999999-0000-4000-a000-0000000000a4'),
  'claim is audited');

-- importer loses the right between import and first login
update public.organization_memberships set ended_at = now()
 where user_id = tests.uid('district_admin') and organization_id = tests.uid('district');
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000a5');
select is(public.claim_my_preregistrations(), 0, 'Importer who lost the right: row is NOT applied');
reset role;

select * from finish();
rollback;

-- Phase 4a step 1: personal codes — admins set them within their scope,
-- nobody sets their own (except the platform admin), unique ignoring case,
-- strict format, audited; roster import carries them without overwriting.
begin;
select plan(44);

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
create or replace function pg_temp.code_of(p_key text) returns text language sql as $$
  select user_code from public.profiles where id = tests.uid(p_key) $$;
create or replace function pg_temp.set_code(p_key text, p_code text) returns text language sql as $$
  select pg_temp.err(format('select public.admin_update_profile(%L, (select full_name from public.profiles where id = %L), null, %L)',
                            tests.uid(p_key), tests.uid(p_key), p_code)) $$;
grant execute on function pg_temp.set_code(text, text) to authenticated;

-- ---------- privileges ----------
select ok(has_column_privilege('authenticated', 'public.profiles', 'user_code', 'select'), 'signed-in users may read the code where they may read the profile');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'user_code', 'update'), 'nobody updates a code directly (only through the admin function)');
select ok(not has_function_privilege('anon', 'public.admin_update_profile(uuid,text,text,text)', 'execute'), 'anon cannot call admin_update_profile');
select is((select proconfig from pg_proc where oid = 'public.admin_update_profile(uuid,text,text,text)'::regprocedure), array['search_path=""'],
  'admin_update_profile (SECURITY DEFINER) pins an empty search_path');

-- ---------- a teacher ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err($$ update public.profiles set user_code = 'ME-1' where id = auth.uid() $$), '42501', 'a teacher cannot set their own code directly');
select is(pg_temp.set_code('teacher_a1', 'ME-1'), '42501', '… nor through the admin function');
select is(pg_temp.set_code('teacher_a2', 'X-1'), '42501', 'a teacher cannot set a colleague''s code');
select is(pg_temp.err($$ update public.profiles set full_name = 'ครู ก1 (แก้เอง)' where id = auth.uid() $$), 'no error', 'a teacher still edits their own name');
reset role;

-- ---------- Staff (4f: platform_support; there are no school admins) ----------
select tests.authenticate_as('school_admin_a'); -- a teacher of school A now
select is(pg_temp.set_code('teacher_a1', 'T-001'), '42501', 'a teacher of school A (formerly its school admin) cannot set codes');
reset role;
select tests.authenticate_as('staff');
select is(pg_temp.set_code('teacher_a1', 'T-001'), 'no error', 'Staff sets the code of a teacher of school A');
reset role;
select is(pg_temp.code_of('teacher_a1'), 'T-001', '… and it is stored');
select is((select after_json ->> 'user_code' from private.audit_logs
            where action = 'UPDATE_PROFILE' and record_id = tests.uid('teacher_a1') order by id desc limit 1), 'T-001',
  'the change is audited (before and after)');
select tests.authenticate_as('staff');
select is(pg_temp.set_code('teacher_b1', 'T-009'), 'no error', 'Staff is not limited to one school');
select is(pg_temp.set_code('district_admin', 'D-9'), '42501', 'Staff cannot edit a district admin');
select is(pg_temp.set_code('staff', 'ST-1'), '42501', 'nor their own code');
select is(pg_temp.err(format('select public.admin_update_profile(%L, %L)', tests.uid('teacher_a1'), '   ')), '23514',
  'a full name is required');
reset role;
select tests.authenticate_as('staff');
select is(pg_temp.set_code('teacher_b1', '   '), 'no error', '(Staff clears the code it set, for the tests below)');
reset role;

-- ---------- the second rule: people who hold admin or platform roles ----------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000d1', 'co.admin@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000d2', 'support.person@example.test', now(), '{}');
update public.profiles set status = 'active' where id in ('99999999-0000-4000-a000-0000000000d1', '99999999-0000-4000-a000-0000000000d2');
insert into public.organization_memberships (user_id, organization_id, org_role, granted_by) values
  ('99999999-0000-4000-a000-0000000000d1', tests.uid('school_a'), 'supervisor', tests.uid('district_admin')),
  ('99999999-0000-4000-a000-0000000000d2', tests.uid('school_a'), 'teacher', tests.uid('district_admin'));
insert into public.platform_role_assignments (user_id, role, granted_by)
values ('99999999-0000-4000-a000-0000000000d2', 'platform_support', tests.uid('platform_admin'));
select tests.authenticate_as('staff');
select is(pg_temp.err($$ select public.admin_update_profile('99999999-0000-4000-a000-0000000000d2', 'ผู้สนับสนุน', null, 'PS-1') $$),
  '42501', 'Staff cannot edit another Staff member (a platform role holder)');
select is(pg_temp.err($$ select public.admin_update_profile('99999999-0000-4000-a000-0000000000d1', 'ศน.โรงเรียน', null, 'SV-2') $$),
  'no error', 'Staff may edit a supervisor');
reset role;
select tests.authenticate_as('teacher_a2');
select is(pg_temp.err($$ select public.admin_update_profile('99999999-0000-4000-a000-0000000000d1', 'ศน.โรงเรียน', null, 'SV-3') $$),
  '42501', 'a teacher of the same school may not');
reset role;
select tests.authenticate_as('district_admin');
select is(pg_temp.err($$ select public.admin_update_profile('99999999-0000-4000-a000-0000000000d1', 'ศน.โรงเรียน', null, 'SV-4') $$),
  'no error', 'the district admin governing the school may edit that supervisor');
reset role;

-- ---------- uniqueness and format ----------
select tests.authenticate_as('staff');
select is(pg_temp.set_code('teacher_b1', 't-001'), '23505', 'codes are unique ignoring case (t-001 vs T-001)');
select is(pg_temp.set_code('teacher_b1', 'T 002'), '23514', 'no spaces');
select is(pg_temp.set_code('teacher_b1', repeat('9', 51)), '23514', 'at most 50 characters');
select is(pg_temp.set_code('teacher_b1', 'ครู.๐๐๒_b-1'), 'no error', 'Thai letters and digits, dot, underscore and hyphen are allowed');
select is(pg_temp.set_code('teacher_b1', '   '), 'no error', 'blank clears the code');
reset role;
select is(pg_temp.code_of('teacher_b1'), null, '… to null');

-- ---------- district admin and platform admin ----------
select tests.authenticate_as('district_admin');
select is(pg_temp.set_code('supervisor', 'S-001'), 'no error', 'the district admin edits a supervisor of the district');
select is(pg_temp.set_code('school_admin_a', 'SA-001'), 'no error', '… and a teacher under it');
select is(pg_temp.set_code('platform_admin', 'P-1'), '42501', 'but not the platform admin');
select is(pg_temp.set_code('district_admin', 'D-1'), '42501', 'nor their own code');
reset role;
select tests.authenticate_as('platform_admin');
select is(pg_temp.set_code('platform_admin', 'P-001'), 'no error', 'the platform admin may set their own code');
select is(pg_temp.set_code('district_admin', 'D-001'), 'no error', '… and anyone else''s');
select is(pg_temp.set_code('district_admin', 'D-001'), 'no error', 'saving the same values again is fine');
reset role;
select is((select count(*)::int from private.audit_logs where action = 'UPDATE_PROFILE' and record_id = tests.uid('district_admin')), 1,
  'an unchanged save writes no second audit row');

-- ---------- roster import carries the code ----------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000c1', 'coded.teacher@example.test', now(), '{}'),
  ('99999999-0000-4000-a000-0000000000c2', 'taken.code@example.test', now(), '{}');
select tests.authenticate_as('district_admin');
select is(pg_temp.err($$ insert into public.preregistrations (email, organization_id, org_role, user_code)
                         values ('coded.teacher@example.test', tests.uid('school_a'), 'teacher', 'T-100') $$),
  'no error', 'a roster row may carry a code');
select is(pg_temp.err($$ insert into public.preregistrations (email, organization_id, org_role, user_code)
                         values ('bad.code@example.test', tests.uid('school_a'), 'teacher', 'T 100') $$),
  '23514', 'a malformed roster code is refused');
select is(pg_temp.err($$ insert into public.preregistrations (email, organization_id, org_role, user_code)
                         values ('taken.code@example.test', tests.uid('school_a'), 'teacher', 't-001') $$),
  'no error', 'a code already held by someone else can be imported (it is checked on claim)');
reset role;

select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000c1');
select is(public.claim_my_preregistrations(), 1, 'the person claims the row');
reset role;
select is((select user_code || '/' || status from public.profiles where id = '99999999-0000-4000-a000-0000000000c1'), 'T-100/active',
  '… and gets the code with the role');

select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000c2');
select is(public.claim_my_preregistrations(), 1, 'a claim whose code is taken still succeeds');
reset role;
select is((select coalesce(user_code, 'none') from public.profiles where id = '99999999-0000-4000-a000-0000000000c2'), 'none',
  '… but the code is not stolen from its holder');

-- someone who already has a code keeps it
select tests.authenticate_as('district_admin');
insert into public.preregistrations (email, organization_id, org_role, user_code)
values ('teacher.a1@example.test', tests.uid('school_a'), 'teacher', 'T-555');
reset role;
select tests.authenticate_as('teacher_a1');
select is(public.claim_my_preregistrations(), 1, 'a person who already has a code claims a row with another code');
reset role;
select is(pg_temp.code_of('teacher_a1'), 'T-001', '… and keeps the code they had (never overwritten)');

select * from finish();
rollback;

-- Phase 4f step 2: admin_set_school — one school per person (as teacher),
-- changed by whoever manages the account; a district admin only within the
-- district; other roles untouched; audited.
begin;
select plan(24);

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
  select coalesce(string_agg(o.code || ':' || m.org_role, ',' order by o.code, m.org_role), '')
    from public.organization_memberships m join public.organizations o on o.id = m.organization_id
   where m.user_id = p_user and m.ended_at is null $$;

-- another district with a school, and an inactive school (as postgres)
insert into public.organizations (id, code, name, org_type, parent_id, active) values
  ('10000000-0000-4000-a000-0000000000f1', 'OTHER-DIST', 'เขตอื่น (สมมติ)', 'district', null, true),
  ('10000000-0000-4000-a000-0000000000f2', 'OTHER-SCH', 'โรงเรียนเขตอื่น (สมมติ)', 'school', '10000000-0000-4000-a000-0000000000f1', true),
  ('10000000-0000-4000-a000-0000000000f3', 'CLOSED-SCH', 'โรงเรียนที่ปิดแล้ว (สมมติ)', 'school', tests.uid('district'), false);

-- ---------- the function itself ----------
select ok(not has_function_privilege('anon', 'public.admin_set_school(uuid,uuid)', 'execute'), 'anon cannot call it');
select is((select proconfig from pg_proc where oid = 'public.admin_set_school(uuid,uuid)'::regprocedure), array['search_path=""'],
  'it pins an empty search_path');

-- ---------- Staff moves a teacher ----------
select tests.authenticate_as('staff');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_a1'), tests.uid('school_b'))), 'no error',
  'Staff moves teacher A1 to school B');
reset role;
select is(pg_temp.schools_of(tests.uid('teacher_a1')), 'DEMO-SCH-B:teacher', '… one school: B (A ended)');
select ok(exists (select 1 from public.organization_memberships
                   where user_id = tests.uid('teacher_a1') and organization_id = tests.uid('school_a') and ended_at is not null),
  'the school A membership is kept as history');
select is((select count(*)::int from private.audit_logs
            where table_name = 'public.organization_memberships' and actor_id = tests.uid('staff')
              and coalesce(after_json, before_json) ->> 'user_id' = tests.uid('teacher_a1')::text), 2,
  'both changes are audited with Staff as the actor (end A, start B)');

select tests.authenticate_as('staff');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_a1'), tests.uid('school_b'))), 'no error',
  'choosing the same school again is fine');
reset role;
select is((select count(*)::int from public.organization_memberships where user_id = tests.uid('teacher_a1') and ended_at is null), 1,
  '… and adds nothing');

select tests.authenticate_as('staff');
select is(public.admin_set_school(tests.uid('teacher_a2'), null), '[]'::jsonb, 'null = no school (returns no memberships)');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_a2'), tests.uid('district'))), '22023',
  'a district is not a school');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_a2'), '10000000-0000-4000-a000-0000000000f3')), '22023',
  'nor is a closed school');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_a2'), '10000000-0000-4000-a000-0000000000f2')), 'no error',
  'Staff may pick a school of any district');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('district_admin'), tests.uid('school_a'))), '42501',
  'Staff cannot change a district admin');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('platform_admin'), tests.uid('school_a'))), '42501',
  'nor the platform admin');
reset role;

-- ---------- other roles stay ----------
select tests.authenticate_as('staff');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('supervisor'), tests.uid('school_a'))), 'no error',
  'Staff gives the supervisor a school');
reset role;
select is(pg_temp.schools_of(tests.uid('supervisor')), 'DEMO-DIST:supervisor,DEMO-SCH-A:teacher',
  '… the supervisor role is kept, the school is added');

-- ---------- district admin: own district only ----------
select tests.authenticate_as('district_admin');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_b1'), tests.uid('school_a'))), 'no error',
  'the district admin moves a teacher between schools of the district');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_b1'), '10000000-0000-4000-a000-0000000000f2')), '42501',
  '… but not into a school of another district');
reset role;
select is(pg_temp.schools_of(tests.uid('teacher_b1')), 'DEMO-SCH-A:teacher', '… so B1 stays in school A');

-- ---------- nobody else ----------
select tests.authenticate_as('school_admin_a'); -- a teacher now
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('teacher_a2'), tests.uid('school_a'))), '42501',
  'a teacher (formerly a school admin) cannot change anyone''s school');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('school_admin_a'), tests.uid('school_b'))), '42501',
  '… not even their own');
reset role;

-- ---------- the account list says so ----------
select tests.authenticate_as('staff');
select is((select r ->> 'can_set_school' from jsonb_array_elements(public.admin_list_accounts() -> 'rows') r
            where r ->> 'id' = tests.uid('teacher_a2')::text), 'true', 'the list offers it for a teacher');
select is((select r ->> 'can_set_school' from jsonb_array_elements(public.admin_list_accounts() -> 'rows') r
            where r ->> 'id' = tests.uid('district_admin')::text), 'false', '… not for a district admin');
reset role;

-- ---------- a deleted account ----------
select tests.authenticate_as('platform_admin');
select public.admin_delete_account(tests.uid('mentor'), 'mentor@example.test');
select is(pg_temp.err(format('select public.admin_set_school(%L, %L)', tests.uid('mentor'), tests.uid('school_a'))), '23514',
  'a deleted account cannot be given a school');
reset role;

select * from finish();
rollback;

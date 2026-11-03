-- =====================================================================
-- Test helpers (committed once; other test files ROLLBACK).
-- Requires the demo seed (supabase/seed.sql) — run `supabase db reset --local` first.
-- =====================================================================
begin;
create extension if not exists pgtap with schema extensions;

create schema if not exists tests;
grant usage on schema tests to anon, authenticated;

-- Seed identities by short key
create or replace function tests.uid(p_key text)
returns uuid
language sql immutable
as $$
  select case p_key
    when 'platform_admin' then '00000000-0000-4000-a000-000000000001'
    when 'district_admin' then '00000000-0000-4000-a000-000000000002'
    when 'supervisor'     then '00000000-0000-4000-a000-000000000003'
    when 'school_admin_a' then '00000000-0000-4000-a000-000000000004'
    when 'school_admin_b' then '00000000-0000-4000-a000-000000000005'
    when 'trainer'        then '00000000-0000-4000-a000-000000000006'
    when 'mentor'         then '00000000-0000-4000-a000-000000000007'
    when 'teacher_a1'     then '00000000-0000-4000-a000-000000000008'
    when 'teacher_a2'     then '00000000-0000-4000-a000-000000000009'
    when 'teacher_b1'     then '00000000-0000-4000-a000-000000000010'
    when 'newcomer'       then '00000000-0000-4000-a000-000000000011'
    -- organizations / program objects
    when 'district'       then '10000000-0000-4000-a000-000000000001'
    when 'school_a'       then '10000000-0000-4000-a000-000000000002'
    when 'school_b'       then '10000000-0000-4000-a000-000000000003'
    when 'program'        then '20000000-0000-4000-a000-000000000001'
    when 'cohort'         then '30000000-0000-4000-a000-000000000001'
    when 'course'         then '40000000-0000-4000-a000-000000000001'
    when 'draft_course'   then '40000000-0000-4000-a000-000000000002'
    when 'unit1'          then '50000000-0000-4000-a000-000000000001'
    when 'unit2'          then '50000000-0000-4000-a000-000000000002'
    when 'lesson1'        then '60000000-0000-4000-a000-000000000001'
    when 'lesson2'        then '60000000-0000-4000-a000-000000000002'
    when 'lesson3'        then '60000000-0000-4000-a000-000000000003'
    when 'draft_lesson'   then '60000000-0000-4000-a000-000000000004'
    when 'enr_a1'         then '70000000-0000-4000-a000-000000000001'
    when 'enr_a2'         then '70000000-0000-4000-a000-000000000002'
    when 'enr_b1'         then '70000000-0000-4000-a000-000000000003'
    -- assessment demo
    when 'quiz'           then 'a1000000-0000-4000-a000-000000000001'
    when 'quiz_v1'        then 'a2000000-0000-4000-a000-000000000001'
    when 'q_single'       then 'a3000000-0000-4000-a000-000000000001'
    when 'q_multiple'     then 'a3000000-0000-4000-a000-000000000002'
    when 'q_truefalse'    then 'a3000000-0000-4000-a000-000000000003'
    when 'q_numeric'      then 'a3000000-0000-4000-a000-000000000004'
    when 'pretest'        then 'a4000000-0000-4000-a000-000000000001'
    when 'formative'      then 'a4000000-0000-4000-a000-000000000002'
  end::uuid
$$;

-- Become a signed-in user for the rest of the transaction
create or replace function tests.authenticate_as(p_key text)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', tests.uid(p_key), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Same, for a user created inside a test (arbitrary uuid)
create or replace function tests.authenticate_as_id(p_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function tests.as_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end;
$$;

grant execute on all functions in schema tests to anon, authenticated;

select plan(2);
select ok(tests.uid('teacher_a1') is not null, 'test helpers installed');
select ok(
  (select count(*) from public.profiles where id = tests.uid('platform_admin')) = 1,
  'demo seed is present (run supabase db reset --local first)'
);
select * from finish();
commit;

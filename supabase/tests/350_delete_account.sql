-- Phase 4a step 3: deleting an account — platform admin only, typed e-mail,
-- personal data gone everywhere (profile, roster, audit), every right ended,
-- results kept anonymised, and the account can never come back.
begin;
select plan(25);

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

-- ---------- a person with a footprint ----------
-- teacher at school A, trainee of the demo cohort with a mentor, from a roster
-- row with a code, with a pre-test attempt
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('99999999-0000-4000-a000-0000000000f1', 'erase.me@example.test', now(), '{"full_name":"ครูลบฉัน"}'),
  ('99999999-0000-4000-a000-0000000000f2', 'support.only@example.test', now(), '{}');
insert into public.platform_role_assignments (user_id, role, granted_by)
values ('99999999-0000-4000-a000-0000000000f2', 'platform_support', tests.uid('platform_admin'));
select tests.authenticate_as('district_admin');
insert into public.preregistrations (email, full_name, organization_id, org_role, cohort_id, cohort_role, user_code)
values ('erase.me@example.test', 'ครูลบฉัน', tests.uid('school_a'), 'teacher', tests.uid('cohort'), 'trainee', 'ER-1');
reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000f1');
select is(public.claim_my_preregistrations(), 1, 'the person claims the roster row (role, cohort, code)');
select lives_ok($$ select public.start_attempt('a4000000-0000-4000-a000-000000000001') $$, 'and starts the pre-test');
reset role;
insert into public.mentor_assignments (cohort_id, mentor_id, trainee_id, assigned_by)
values (tests.uid('cohort'), tests.uid('mentor'), '99999999-0000-4000-a000-0000000000f1', tests.uid('district_admin'));

-- an audit row about SOMEONE ELSE that the person once wrote (e.g. as an admin)
insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json)
values ('99999999-0000-4000-a000-0000000000f1', 'UPDATE_PROFILE', 'public.profiles', tests.uid('teacher_a2'),
        '{"user_code": null}', '{"user_code": "KEEP-A2", "full_name": "ครู ก2 (สมมติ)"}');

-- ---------- who may delete ----------
select ok(not has_function_privilege('anon', 'public.admin_delete_account(uuid,text)', 'execute'), 'anon cannot call it');
select is((select proconfig from pg_proc where oid = 'public.admin_delete_account(uuid,text)'::regprocedure), array['search_path=""'],
  'it pins an empty search_path');
select tests.authenticate_as('district_admin');
select is(pg_temp.err($$ select public.admin_delete_account('99999999-0000-4000-a000-0000000000f1', 'erase.me@example.test') $$),
  '42501', 'a district admin cannot delete accounts (platform admin only)');
reset role;
select tests.authenticate_as('platform_admin');
select is(pg_temp.err(format('select public.admin_delete_account(%L, %L)', tests.uid('platform_admin'), 'admin@example.test')),
  '42501', 'the platform admin cannot delete their own account');
select is(pg_temp.err($$ select public.admin_delete_account('99999999-0000-4000-a000-0000000000f2', 'support.only@example.test') $$),
  '42501', 'nor someone holding a platform role (revoke it first)');
select is(pg_temp.err($$ select public.admin_delete_account('99999999-0000-4000-a000-0000000000f1', 'someone.else@example.test') $$),
  '22023', 'the typed e-mail must be the account''s');
select is(public.admin_delete_account('99999999-0000-4000-a000-0000000000f1', '  ERASE.me@Example.test ') ->> 'already_deleted',
  'false', 'typed e-mail ignores case and spaces; the account is deleted');
reset role;

-- ---------- what is gone ----------
select is((select full_name || '|' || coalesce(display_name, '-') || '|' || coalesce(user_code, '-') || '|' || coalesce(contact_email, '-')
                  || '|' || coalesce(avatar_path, '-') || '|' || coalesce(requested_org_id::text, '-') || '|' || status
             from public.profiles where id = '99999999-0000-4000-a000-0000000000f1'),
  'ผู้ใช้ที่ถูกลบ|-|-|-|-|-|deleted', 'the profile keeps no personal data and is marked deleted');
select is((select count(*)::int from public.organization_memberships where user_id = '99999999-0000-4000-a000-0000000000f1' and ended_at is null), 0,
  'every organisation membership has ended');
select is((select string_agg(distinct status, ',') from public.cohort_memberships where user_id = '99999999-0000-4000-a000-0000000000f1'), 'withdrawn',
  'cohort membership withdrawn');
select is((select count(*)::int from public.mentor_assignments where trainee_id = '99999999-0000-4000-a000-0000000000f1' and ended_at is null), 0,
  'mentor pairing ended');
select is((select email || '|' || full_name || '|' || coalesce(user_code, '-') || '|' || status from public.preregistrations
            where claimed_by = '99999999-0000-4000-a000-0000000000f1'),
  (select 'deleted.' || id || '@deleted.invalid||-|claimed' from public.preregistrations where claimed_by = '99999999-0000-4000-a000-0000000000f1'),
  'the roster row no longer carries e-mail, name or code');
select is((select count(*)::int from private.audit_logs
            where coalesce(before_json::text, '') || coalesce(after_json::text, '') ~* '(erase\.me|ครูลบฉัน|ER-1)'), 0,
  'no audit row holds the e-mail, the name or the code any more');
select is((select count(*)::int from private.audit_logs
            where action = 'DELETE_ACCOUNT' and record_id = '99999999-0000-4000-a000-0000000000f1' and actor_id = tests.uid('platform_admin')), 1,
  'the deletion itself is audited (who, when, what was ended)');

select is((select after_json ->> 'user_code' from private.audit_logs
            where actor_id = '99999999-0000-4000-a000-0000000000f1' and record_id = tests.uid('teacher_a2')), 'KEEP-A2',
  'audit rows about other people that the deleted person wrote keep their content (only rows about the person are scrubbed)');

-- ---------- what stays ----------
select is((select count(*)::int from public.assessment_attempts where user_id = '99999999-0000-4000-a000-0000000000f1'), 1,
  'the attempt stays (anonymised through the profile): cohort statistics do not change');

-- ---------- never back ----------
select tests.authenticate_as('platform_admin');
select is(public.admin_delete_account('99999999-0000-4000-a000-0000000000f1', 'anything') ->> 'already_deleted', 'true',
  'calling again is harmless (the Edge Function may retry the sign-in part)');
select is(pg_temp.err($$ select public.admin_set_profile_status('99999999-0000-4000-a000-0000000000f1', 'active') $$),
  '23514', 'a deleted account cannot be re-activated');
select is(pg_temp.err($$ select public.admin_update_profile('99999999-0000-4000-a000-0000000000f1', 'ชื่อใหม่') $$),
  '23514', 'nor renamed');
reset role;
select tests.authenticate_as_id('99999999-0000-4000-a000-0000000000f1');
select is(pg_temp.err($$ select public.start_attempt('a4000000-0000-4000-a000-000000000002') $$), '42501',
  'if a session lingers, the deleted account can do nothing');
select is((select count(*)::int from public.courses), 0, '… and sees no course');
select is(pg_temp.err($$ update public.profiles set status = 'active' where id = auth.uid() $$), '42501',
  'nor change its own status');
reset role;
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err($$ update public.profiles set status = 'deleted' where id = auth.uid() $$), '42501',
  'nobody marks an account deleted by hand');
reset role;

select * from finish();
rollback;

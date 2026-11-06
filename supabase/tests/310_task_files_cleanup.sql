-- Phase 3b step 3: what the nightly clean-up may remove — only orphans
-- older than a day and files of drafts idle for 30 days; never submitted
-- work, never recent work; only the server key may ask; every removal audited.
begin;
select plan(27);

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate;
  return v_state;
end $$;
grant execute on function pg_temp.err(text) to authenticated, anon, service_role;
create temporary table ids (k text primary key, id uuid);
grant select, insert on ids to authenticated, service_role;
create or replace function pg_temp.id(p text) returns uuid language sql stable as $$ select id from ids where k = p $$;
grant execute on function pg_temp.id(text) to authenticated, service_role;
create or replace function pg_temp.obj(p_sub uuid, p_file text, p_age interval) returns text language sql as $$
  insert into storage.objects (bucket_id, name, created_at, metadata)
  values ('task-files', p_sub || '/' || p_file, now() - p_age, '{"size": 12, "mimetype": "application/pdf"}')
  returning name $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
insert into ids values ('alloc', 'b2000000-0000-4000-a000-000000000001');

-- ---------- who may call ----------
select ok(not has_function_privilege('anon', 'public.task_files_cleanup_orphans(interval,integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.task_files_cleanup_orphans(interval,integer)', 'execute'),
  'orphans: neither anon nor signed-in users may call');
select ok(not has_function_privilege('anon', 'public.task_files_cleanup_stale_drafts(interval,integer,boolean)', 'execute')
      and not has_function_privilege('authenticated', 'public.task_files_cleanup_stale_drafts(interval,integer,boolean)', 'execute'),
  'stale drafts: neither anon nor signed-in users may call');
select ok(not has_function_privilege('anon', 'public.task_files_cleanup_record(text[])', 'execute')
      and not has_function_privilege('authenticated', 'public.task_files_cleanup_record(text[])', 'execute'),
  'record: neither anon nor signed-in users may call');
select ok(has_function_privilege('service_role', 'public.task_files_cleanup_orphans(interval,integer)', 'execute')
      and has_function_privilege('service_role', 'public.task_files_cleanup_stale_drafts(interval,integer,boolean)', 'execute')
      and has_function_privilege('service_role', 'public.task_files_cleanup_record(text[])', 'execute'),
  'the server key (service_role) may call all three');
select is((select bool_or(prosecdef) from pg_proc
            where proname in ('task_files_cleanup_orphans', 'task_files_cleanup_stale_drafts', 'task_files_cleanup_record')),
  false, 'all three run with the caller''s rights (no SECURITY DEFINER)');
select ok(not has_table_privilege('service_role', 'private.audit_logs', 'select')
      and not has_table_privilege('service_role', 'private.audit_logs', 'update')
      and not has_table_privilege('service_role', 'private.audit_logs', 'delete'),
  'service_role may only add audit rows, not read, change or delete them');

-- ---------- work in progress ----------
-- A1: a draft with one file, both idle 40 days            -> stale
-- A2: a draft idle 40 days but with a file added today     -> active
-- B1: SUBMITTED work, everything 40 days old               -> never touched
select tests.authenticate_as('teacher_a1');
insert into ids values ('d1', public.start_task_submission(pg_temp.id('alloc')));
update public.task_submissions set text_response = 'ร่างที่ไม่มีใครแตะ' where id = pg_temp.id('d1');
reset role;
select tests.authenticate_as('teacher_a2');
insert into ids values ('d2', public.start_task_submission(pg_temp.id('alloc')));
reset role;
select tests.authenticate_as('teacher_b1');
insert into ids values ('s3', public.start_task_submission(pg_temp.id('alloc')));
reset role;

insert into public.task_submission_files (submission_id, object_path, file_name)
values (pg_temp.id('d1'), pg_temp.obj(pg_temp.id('d1'), 'old.pdf', '40 days'), 'old.pdf'),
       (pg_temp.id('d2'), pg_temp.obj(pg_temp.id('d2'), 'old.pdf', '40 days'), 'old.pdf'),
       (pg_temp.id('d2'), pg_temp.obj(pg_temp.id('d2'), 'today.pdf', '1 minute'), 'today.pdf'),
       (pg_temp.id('s3'), pg_temp.obj(pg_temp.id('s3'), 'sent.pdf', '40 days'), 'sent.pdf');
select tests.authenticate_as('teacher_b1');
do $$ begin perform public.submit_task_submission(pg_temp.id('s3')); end $$;
reset role;
-- orphans: one old (no row), one fresh (no row), one in another bucket
select pg_temp.obj(pg_temp.id('d1'), 'lost.pdf', '2 days');
select pg_temp.obj(pg_temp.id('d1'), 'uploading.pdf', '10 minutes');
insert into storage.objects (bucket_id, name, created_at) values ('assessment-media', pg_temp.id('d1') || '/x.png', now() - interval '9 days');

-- age the work (triggers off for the back-dating only)
set local session_replication_role = replica;
update public.task_submissions set updated_at = now() - interval '40 days', created_at = now() - interval '40 days'
 where id in (pg_temp.id('d1'), pg_temp.id('d2'), pg_temp.id('s3'));
update public.task_submission_files set created_at = now() - interval '40 days' where file_name in ('old.pdf', 'sent.pdf');
set local session_replication_role = origin;

-- ---------- orphans ----------
select pg_temp.as_service();
select results_eq(
  'select object_path from public.task_files_cleanup_orphans()',
  array[pg_temp.id('d1') || '/lost.pdf'],
  'orphans: only the task file with no row, older than 24 h (not the fresh upload, not linked files, not other buckets)');
select is((select count(*)::int from public.task_files_cleanup_orphans(interval '1 hour')), 1,
  'a shorter age still keeps an upload of 10 minutes ago');
select is(pg_temp.err($$select * from public.task_files_cleanup_orphans(interval '5 minutes')$$), '22023',
  'an age under 1 hour is refused (an upload in progress must survive)');
select is(pg_temp.err($$select * from public.task_files_cleanup_orphans(interval '1 day', 5000)$$), '22023',
  'a batch over 1000 is refused');

-- ---------- stale drafts ----------
select results_eq(
  'select object_path from public.task_files_cleanup_stale_drafts(p_dry_run => true)',
  array[pg_temp.id('d1') || '/old.pdf'],
  'dry run lists only the idle draft''s file');
select is((select count(*)::int from public.task_submission_files), 4, 'dry run removes nothing');
select is(pg_temp.err($$select * from public.task_files_cleanup_stale_drafts(interval '1 day')$$), '22023',
  'an idle time under 7 days is refused');
select results_eq(
  'select object_path from public.task_files_cleanup_stale_drafts()',
  array[pg_temp.id('d1') || '/old.pdf'],
  'the real run returns the path for the function to delete');
reset role;
select is((select count(*)::int from public.task_submission_files where submission_id = pg_temp.id('d1')), 0,
  'the idle draft''s file row is gone');
select is((select text_response from public.task_submissions where id = pg_temp.id('d1')), 'ร่างที่ไม่มีใครแตะ',
  '… but the draft itself (its text) stays');
select is((select count(*)::int from public.task_submission_files where submission_id = pg_temp.id('d2')), 2,
  'a draft with a recent file keeps all its files (the old one too)');
select is((select count(*)::int from public.task_submission_files where submission_id = pg_temp.id('s3')), 1,
  'submitted work keeps its file, however old');
select is((select count(*)::int from private.audit_logs
            where table_name = 'public.task_submission_files' and action = 'DELETE' and actor_id is null
              and before_json ->> 'object_path' = pg_temp.id('d1') || '/old.pdf'
              and reason like 'cleanup: files of a draft untouched for%'), 1,
  'the removal is in the audit log, with the row as it was');
select pg_temp.as_service();
select is((select count(*)::int from public.task_files_cleanup_stale_drafts()), 0, 'a second run finds nothing');
select is((select count(*)::int from public.task_files_cleanup_orphans() o where o.object_path = pg_temp.id('d1') || '/old.pdf'), 1,
  'the object left behind is now an orphan, so a failed storage delete is retried next night');

-- ---------- record ----------
select is(public.task_files_cleanup_record(array[pg_temp.id('d1') || '/lost.pdf']), 0,
  'record: an object still in storage is not logged as removed');
reset role;
-- the Storage API would remove the object; here it is simulated with triggers off
set local session_replication_role = replica;
delete from storage.objects where bucket_id = 'task-files' and name = pg_temp.id('d1') || '/lost.pdf';
set local session_replication_role = origin;
select pg_temp.as_service();
select is(public.task_files_cleanup_record(array[pg_temp.id('d1') || '/lost.pdf', pg_temp.id('d1') || '/lost.pdf',
                                                   pg_temp.id('d2') || '/today.pdf', '../etc/passwd']), 1,
  'record: logs the removed object once; not a linked file, not a malformed path');
reset role;
select is((select record_id from private.audit_logs where table_name = 'storage.objects' and before_json ->> 'name' = pg_temp.id('d1') || '/lost.pdf'),
  pg_temp.id('d1'), 'the log row points at the attempt the file belonged to');

-- ---------- signed-in users cannot reach the functions at all ----------
select tests.authenticate_as('teacher_a1');
select is(pg_temp.err($$select * from public.task_files_cleanup_orphans()$$), '42501', 'a trainee calling orphans: refused');
select is(pg_temp.err($$select * from public.task_files_cleanup_stale_drafts()$$), '42501', 'a trainee calling stale drafts: refused');
reset role;
select tests.authenticate_as('platform_admin');
select is(pg_temp.err($$select public.task_files_cleanup_record(array['x'])$$), '42501', 'even the platform admin: refused');
reset role;

select * from finish();
rollback;

// @vitest-environment node
/**
 * The real Edge Function against Supabase Local (run through
 * scripts/supabase-local/test-functions.sh, which serves the functions with a
 * one-off random CRON_SECRET). Real uploads through the Storage API; SQL only
 * to back-date them, since nobody can wait 30 days in a test.
 */
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeAll } from 'vitest'
import { supabaseAs } from '../integration/helpers.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const cronSecret = process.env.SOLVEEDU_CRON_SECRET
const run = env.url && env.apiKey && env.secret && cronSecret ? describe : describe.skip
const ALLOCATION = 'b2000000-0000-4000-a000-000000000001' // demo task, open to the demo cohort
const pdf = () =>
  new Blob([new TextEncoder().encode('%PDF-1.4\n% fictitious test file\n')], { type: 'application/pdf' })

/** SQL as the database owner, LOCAL container only. */
function sql(text) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_solve-edu-platform',
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input: text, encoding: 'utf8' }
  ).trim()
}
const exists = (path) =>
  sql(`select count(*) from storage.objects where bucket_id = 'task-files' and name = '${path}';`) === '1'

function call(body, headers = { 'x-cron-secret': cronSecret }, method = 'POST') {
  return fetch(`${env.url}/functions/v1/cleanup-task-files`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
}

run('Edge Function cleanup-task-files (Supabase Local)', () => {
  const p = {}

  beforeAll(async () => {
    sql(
      'truncate public.task_review_reads, public.task_review_scores, public.task_reviews, public.task_submission_files, public.task_submissions;'
    )
    // A1: an idle draft with a linked file, plus an upload whose row was never written, plus one in progress
    const a1 = supabaseAs(env, 'teacher_a1')
    const d1 = (await a1.rpc('start_task_submission', { p_allocation: ALLOCATION })).data
    expect(
      (await a1.from('task_submissions').update({ text_response: 'ร่างเก่า' }).eq('id', d1)).error
    ).toBeNull()
    for (const name of ['old', 'lost', 'uploading']) {
      p[name] = `${d1}/${name}.pdf`
      expect((await a1.storage.from('task-files').upload(p[name], pdf())).error).toBeNull()
    }
    expect(
      (
        await a1
          .from('task_submission_files')
          .insert({ submission_id: d1, object_path: p.old, file_name: 'old.pdf' })
      ).error
    ).toBeNull()
    // A2: an active draft with a linked file
    const a2 = supabaseAs(env, 'teacher_a2')
    const d2 = (await a2.rpc('start_task_submission', { p_allocation: ALLOCATION })).data
    p.active = `${d2}/active.pdf`
    expect((await a2.storage.from('task-files').upload(p.active, pdf())).error).toBeNull()
    expect(
      (
        await a2
          .from('task_submission_files')
          .insert({ submission_id: d2, object_path: p.active, file_name: 'a.pdf' })
      ).error
    ).toBeNull()
    // B1: submitted work, which will be made very old too
    const b1 = supabaseAs(env, 'teacher_b1')
    const s3 = (await b1.rpc('start_task_submission', { p_allocation: ALLOCATION })).data
    p.sent = `${s3}/sent.pdf`
    expect((await b1.storage.from('task-files').upload(p.sent, pdf())).error).toBeNull()
    expect(
      (
        await b1
          .from('task_submission_files')
          .insert({ submission_id: s3, object_path: p.sent, file_name: 's.pdf' })
      ).error
    ).toBeNull()
    expect((await b1.rpc('submit_task_submission', { p_submission: s3 })).error).toBeNull()

    sql(`begin;
set local session_replication_role = replica;
update public.task_submissions set updated_at = now() - interval '40 days' where id in ('${d1}', '${s3}');
update public.task_submission_files set created_at = now() - interval '40 days' where submission_id in ('${d1}', '${s3}');
update storage.objects set created_at = now() - interval '40 days'
 where bucket_id = 'task-files' and name in ('${p.old}', '${p.lost}', '${p.sent}');
commit;`)
    p.d1 = d1
  })

  it('refuses callers without the secret, and other methods', async () => {
    expect((await call({}, {})).status).toBe(401)
    expect((await call({}, { 'x-cron-secret': 'wrong' })).status).toBe(401)
    const withUserToken = await call({}, { authorization: `Bearer ${env.apiKey}` })
    expect(withUserToken.status).toBe(401)
    expect((await call(null, { 'x-cron-secret': cronSecret }, 'GET')).status).toBe(405)
    expect(exists(p.lost) && exists(p.old)).toBe(true)
  })

  it('dry run lists exactly the old orphan and the idle draft file, and removes nothing', async () => {
    const res = await call({ dry_run: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dry_run: true, orphans: [p.lost], stale_draft_files: [p.old] })
    expect([p.old, p.lost, p.uploading, p.active, p.sent].every(exists)).toBe(true)
  })

  it('the real run removes them through the Storage API and keeps everything else', async () => {
    const res = await call({})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      dry_run: false,
      stale_draft_files_removed: 1,
      orphans_removed: 1,
      orphans_logged: 1,
      failed: [],
    })
    expect(exists(p.old)).toBe(false)
    expect(exists(p.lost)).toBe(false)
    expect(exists(p.uploading)).toBe(true) // fresh upload, row may still come
    expect(exists(p.active)).toBe(true)
    expect(exists(p.sent)).toBe(true) // submitted work is never touched
    expect(sql(`select text_response from public.task_submissions where id = '${p.d1}';`)).toBe('ร่างเก่า')
    expect(
      sql(`select count(*) from private.audit_logs
            where reason like 'cleanup:%' and (before_json ->> 'object_path' = '${p.old}' or before_json ->> 'name' = '${p.lost}');`)
    ).toBe('2')
  })

  it('the trainee sees the draft without the removed file and can go on working', async () => {
    const a1 = supabaseAs(env, 'teacher_a1')
    const files = await a1.from('task_submission_files').select('object_path').eq('submission_id', p.d1)
    expect(files.error).toBeNull()
    expect(files.data).toEqual([])
    expect((await a1.rpc('start_task_submission', { p_allocation: ALLOCATION })).data).toBe(p.d1)
  })

  it('a second run finds nothing to do', async () => {
    expect(await (await call({})).json()).toMatchObject({
      stale_draft_files_removed: 0,
      orphans_removed: 0,
      failed: [],
    })
  })
})

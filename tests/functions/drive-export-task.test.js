// @vitest-environment node
/**
 * The real Edge Function drive-export-task (Edge runtime in Docker) against
 * Supabase Local and the FAKE Google from tests/fake-google.js, which runs
 * here and checks the signed service-account assertion. Run through
 * scripts/supabase-local/test-functions.sh.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseAs, jwtFor, U } from '../integration/helpers.js'
import { createFakeGoogle } from '../fake-google.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const port = Number(process.env.FAKE_GOOGLE_PORT)
const run = env.url && env.apiKey && env.secret && port ? describe : describe.skip
const ALLOCATION = 'b2000000-0000-4000-a000-000000000001'
const ORIGIN = 'http://127.0.0.1:5173'
const bytes = (text) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n`)

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

function press(who, body = { allocation_id: ALLOCATION }, extra = {}) {
  const headers = { 'content-type': 'application/json', apikey: env.apiKey, origin: ORIGIN, ...extra }
  if (who) headers.authorization = `Bearer ${jwtFor(env.secret, U[who])}`
  return fetch(`${env.url}/functions/v1/drive-export-task`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/** Submit work with files as a trainee, through the real API. */
async function submit(who, files, { submitIt = true } = {}) {
  const db = supabaseAs(env, who)
  const id = (await db.rpc('start_task_submission', { p_allocation: ALLOCATION })).data
  for (const [name, text] of files) {
    const path = `${id}/${crypto.randomUUID()}.pdf`
    expect(
      (await db.storage.from('task-files').upload(path, new Blob([bytes(text)], { type: 'application/pdf' })))
        .error
    ).toBeNull()
    expect(
      (
        await db
          .from('task_submission_files')
          .insert({ submission_id: id, object_path: path, file_name: name })
      ).error
    ).toBeNull()
  }
  await db.from('task_submissions').update({ text_response: 'งาน' }).eq('id', id)
  if (submitIt) expect((await db.rpc('submit_task_submission', { p_submission: id })).error).toBeNull()
  return id
}

run('Edge Function drive-export-task (Supabase Local + fake Google)', () => {
  let google
  let server

  beforeAll(async () => {
    google = createFakeGoogle({
      publicKeyPem: readFileSync(process.env.FAKE_GOOGLE_PUBLIC_KEY_FILE, 'utf8'),
      clientEmail: process.env.FAKE_GOOGLE_EMAIL,
      baseUrl: `http://host.docker.internal:${port}`,
    })
    server = await google.listen(port)
    sql(
      'truncate public.task_drive_copies, public.task_drive_exports, public.task_review_reads, public.task_review_scores, public.task_reviews, public.task_submission_files, public.task_submissions;'
    )
    await submit('teacher_a1', [
      ['แผนการสอน.pdf', 'แผนของครู ก1'],
      ['ใบงาน.pdf', 'ใบงานของครู ก1'],
    ])
    await submit('teacher_a2', [['แผนการสอน.pdf', 'แผนของครู ก2']])
    await submit('teacher_b1', [['ร่าง.pdf', 'ยังไม่ส่ง']], { submitIt: false })
  })
  afterAll(() => server?.close())

  it('refuses: no session, trainee, mentor, bad body, GET', async () => {
    expect((await press(null)).status).toBe(401)
    expect((await press('teacher_a1')).status).toBe(403)
    expect((await press('mentor')).status).toBe(403)
    expect((await press('trainer', { allocation_id: 'nope' })).status).toBe(400)
    const get = await fetch(`${env.url}/functions/v1/drive-export-task`, { headers: { apikey: env.apiKey } })
    expect(get.status).toBe(405)
    expect(google.uploaded()).toHaveLength(0)
    expect(sql('select count(*) from public.task_drive_exports;')).toBe('0') // refused presses record nothing
  })

  // CORS is not checked here: the local API gateway (Kong) adds its own
  // "access-control-allow-origin: *" to function responses, hiding ours. The
  // allow-list is unit-tested (tests/unit/edge-shared.test.js); on the real
  // project the function's own headers are what the browser gets.

  it('the trainer copies every submitted file into course / cohort / task / trainee / attempt', async () => {
    const res = await press('trainer')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ status: 'done', copied: 3, skipped: 0, failed: 0, remaining: 0 })
    expect(body.folder_url).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+$/)
    const files = google.uploaded()
    expect(files).toHaveLength(3) // not B1's draft
    const paths = files.map((f) => google.pathOf(f.id))
    expect(new Set(paths.map((p) => p.slice(0, 3).join(' / ')))).toEqual(
      new Set([
        `${sql("select title from public.courses where id = (select course_id from public.tasks where id = (select task_id from public.task_allocations where id = '" + ALLOCATION + "'));")} / ${sql("select name from public.cohorts where id = '30000000-0000-4000-a000-000000000001';")} / ส่งแผนการสอน AfL 1 คาบ (ทดลอง)`,
      ])
    )
    expect(paths.every((p) => p.length === 6 && /^รอบที่ 1 \(ส่ง \d{4}-\d{2}-\d{2}\)$/.test(p[4]))).toBe(true)
    expect(new Set(paths.map((p) => p[3])).size).toBe(2) // one folder per trainee
    const a1plan = files.find(
      (f) =>
        google.pathOf(f.id)[3] ===
          sql(`select full_name from public.profiles where id = '${U.teacher_a1}';`) &&
        f.name === 'แผนการสอน.pdf'
    )
    expect(new TextDecoder().decode(a1plan.bytes)).toContain('แผนของครู ก1') // the real file's bytes
    expect(
      sql(
        `select status || '/' || files_copied || '/' || (requested_by = '${U.trainer}') from public.task_drive_exports;`
      )
    ).toBe('done/3/true')
    expect(sql('select count(*) from public.task_drive_copies;')).toBe('3')
    // a signed-in trainer can read the record through the API
    const seen = await supabaseAs(env, 'trainer')
      .from('task_drive_exports')
      .select('status, files_copied')
      .eq('allocation_id', ALLOCATION)
    expect(seen.data).toEqual([{ status: 'done', files_copied: 3 }])
  })

  it('pressing again makes no duplicate; a file deleted from Drive comes back', async () => {
    expect(await (await press('trainer')).json()).toMatchObject({ status: 'done', copied: 0, skipped: 3 })
    expect(google.uploaded()).toHaveLength(3)
    google.uploaded()[0].trashed = true
    expect(await (await press('trainer')).json()).toMatchObject({ status: 'done', copied: 1, skipped: 2 })
    expect(google.uploaded().filter((f) => !f.trashed)).toHaveLength(3)
  })

  it('when Drive refuses, the run is closed with the reason and the next press is not blocked', async () => {
    google.uploaded().find((f) => !f.trashed).trashed = true
    google.fail.upload = 403
    const body = await (await press('trainer')).json()
    expect(body).toMatchObject({ status: 'partial', copied: 0, skipped: 2, failed: 1 })
    expect(
      sql("select status || ' | ' || error from public.task_drive_exports order by started_at desc limit 1;")
    ).toMatch(/^partial \| drive_forbidden: upload \(HTTP 403\)$/)
    google.fail.upload = 0
    expect(await (await press('trainer')).json()).toMatchObject({ status: 'done', copied: 1, skipped: 2 })
    expect(sql("select count(*) from public.task_drive_exports where status = 'running';")).toBe('0')
  })

  it('Google never sees our database keys; trainees see none of this', async () => {
    expect(google.log.every((l) => !/sb_|service_role/.test(l))).toBe(true)
    const asTrainee = await supabaseAs(env, 'teacher_a1').from('task_drive_exports').select('id')
    expect(asTrainee.data).toEqual([])
  })
})

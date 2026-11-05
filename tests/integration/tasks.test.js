// @vitest-environment node
/**
 * Integration (Phase 3 step 2): a task opened to the cohort, a trainee's
 * attempt with a file through the real Storage API, submit, and who can
 * open the file afterwards.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, serverNow, IDS } from './helpers.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const COHORT = '30000000-0000-4000-a000-000000000001'
const pdf = new Blob([new TextEncoder().encode('%PDF-1.4\n% fictitious test file\n')], {
  type: 'application/pdf',
})

run('Tasks: submit work with a file (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  let allocationId
  let submissionId
  const path = () => `${submissionId}/plan.pdf`

  it('trainer creates, publishes and opens a task to the cohort', async () => {
    const db = supabaseAs(env, 'trainer')
    const task = await db
      .from('tasks')
      .insert({ course_id: IDS.course, title: 'ส่งแผนการสอน (integration)', status: 'published' })
      .select('id, status, max_attempts')
      .single()
    expect(task.error).toBeNull()
    expect(task.data.max_attempts).toBe(3)
    const due = new Date((await serverNow(env)) + 86_400_000).toISOString()
    const alloc = await db
      .from('task_allocations')
      .insert({ task_id: task.data.id, cohort_id: COHORT, due_at: due })
      .select('id')
      .single()
    expect(alloc.error).toBeNull()
    allocationId = alloc.data.id
  })

  it('trainee starts, uploads a PDF, links it, writes text and submits', async () => {
    const db = supabaseAs(env, 'teacher_a1')
    const started = await db.rpc('start_task_submission', { p_allocation: allocationId })
    expect(started.error).toBeNull()
    submissionId = started.data
    const up = await db.storage.from('task-files').upload(path(), pdf)
    expect(up.error).toBeNull()
    const row = await db
      .from('task_submission_files')
      .insert({ submission_id: submissionId, object_path: path(), file_name: 'แผนการสอน.pdf' })
      .select('size_bytes, mime_type')
      .single()
    expect(row.error).toBeNull()
    expect(row.data).toMatchObject({ mime_type: 'application/pdf' })
    expect(row.data.size_bytes).toBeGreaterThan(0)
    expect(
      (await db.from('task_submissions').update({ text_response: 'แผนเรื่องเศษส่วน' }).eq('id', submissionId))
        .error
    ).toBeNull()
    const sent = await db.rpc('submit_task_submission', { p_submission: submissionId })
    expect(sent.error).toBeNull()
    expect(sent.data).toMatchObject({ status: 'submitted', is_late: false })
  })

  it("the bucket refuses other file types and other people's folders", async () => {
    const db = supabaseAs(env, 'teacher_a2')
    const mine = (await db.rpc('start_task_submission', { p_allocation: allocationId })).data
    const exe = new Blob([new Uint8Array([0x4d, 0x5a])], { type: 'application/x-msdownload' })
    expect((await db.storage.from('task-files').upload(`${mine}/tool.exe`, exe)).error).toBeTruthy()
    expect((await db.storage.from('task-files').upload(`${submissionId}/sneak.pdf`, pdf)).error).toBeTruthy()
    expect((await db.storage.from('task-files').upload(`${mine}/ok.pdf`, pdf)).error).toBeNull()
  })

  it('after submitting, the owner can no longer delete the file', async () => {
    const res = await supabaseAs(env, 'teacher_a1').storage.from('task-files').remove([path()])
    expect(res.data ?? []).toEqual([])
    const still = await supabaseAs(env, 'trainer').storage.from('task-files').createSignedUrl(path(), 60)
    expect(still.error).toBeNull()
  })

  it("trainer and the mentee's mentor can open the file; another trainee and an outsider cannot", async () => {
    for (const who of ['trainer', 'mentor']) {
      const { data, error } = await supabaseAs(env, who)
        .storage.from('task-files')
        .createSignedUrl(path(), 60)
      expect(error, who).toBeNull()
      expect((await fetch(data.signedUrl)).status, who).toBe(200)
    }
    for (const who of ['teacher_a2', 'school_admin_b']) {
      const { error } = await supabaseAs(env, who).storage.from('task-files').createSignedUrl(path(), 60)
      expect(error, who).toBeTruthy()
    }
  })
})

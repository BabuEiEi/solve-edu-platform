// @vitest-environment node
/**
 * Integration (Phase 3 step 2): a task opened to the cohort, a trainee's
 * attempt with a file through the real Storage API, submit, and who can
 * open the file afterwards.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { supabaseAs, serverNow, IDS, U } from './helpers.js'
import { createReviewService } from '../../src/features/reviews/service.js'
import { planZip, buildZip, SUMMARY_FILE } from '../../src/features/reviews/zip.js'

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

  it('trainer reviews (feedback only, no rubric): draft hidden, released result visible, revise opens attempt 2', async () => {
    const trainer = supabaseAs(env, 'trainer')
    const draft = await trainer.rpc('save_task_review', {
      p_submission: submissionId,
      p_scores: {},
      p_feedback: 'เพิ่มหลักฐานการประเมิน',
      p_outcome: 'revise',
    })
    expect(draft.error).toBeNull()
    const learner = supabaseAs(env, 'teacher_a1')
    const hidden = await learner.from('task_reviews').select('id').eq('submission_id', submissionId)
    expect(hidden.data).toEqual([])
    const direct = await learner
      .from('task_reviews')
      .update({ outcome: 'passed' })
      .eq('id', draft.data)
      .select('id')
    expect(direct.error?.code).toBe('42501')
    const released = await trainer.rpc('release_task_review', { p_review: draft.data })
    expect(released.error).toBeNull()
    expect(released.data).toMatchObject({ status: 'released', outcome: 'revise', score: null })
    const seen = await learner
      .from('task_reviews')
      .select('outcome, feedback, released_at')
      .eq('submission_id', submissionId)
    expect(seen.data).toEqual([
      expect.objectContaining({ outcome: 'revise', feedback: 'เพิ่มหลักฐานการประเมิน' }),
    ])
    const next = await learner.rpc('start_task_submission', { p_allocation: allocationId })
    expect(next.error).toBeNull()
    expect(next.data).not.toBe(submissionId)
  })

  it('zip (4e): the trainer gets every submitted attempt with its file, answer and result; others get only what RLS shows', async () => {
    const reviews = createReviewService(supabaseAs(env, 'trainer'))
    const data = await reviews.zipData(allocationId)
    expect(data.task.title).toBe('ส่งแผนการสอน (integration)')
    const mine = data.submissions.filter((x) => x.user_id === U.teacher_a1)
    expect(mine.map((x) => x.attempt_no)).toEqual([1]) // attempt 2 is a draft: not in
    expect(mine[0].profiles).toHaveProperty('user_code')
    const plan = planZip(data)
    const out = await buildZip(plan, {
      signedUrls: (paths) => reviews.signedUrls(paths, 120),
      fetchBytes: async (url) => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(String(res.status))
        return new Uint8Array(await res.arrayBuffer())
      },
    })
    expect(out.failed).toEqual([])
    const files = unzipSync(out.bytes)
    const pdfName = Object.keys(files).find((n) => n.endsWith('/แผนการสอน.pdf'))
    expect(pdfName).toMatch(/\/รอบที่ 1 \(ส่ง \d{4}-\d{2}-\d{2}\)\/แผนการสอน\.pdf$/)
    expect(strFromU8(files[pdfName]).startsWith('%PDF-1.4')).toBe(true)
    const answer = Object.keys(files).find((n) => n.endsWith('/คำตอบ.txt'))
    expect(strFromU8(files[answer])).toContain('แผนเรื่องเศษส่วน')
    // the summary sheet itself is read back in tests/unit/zip.test.js (needs DOMParser)
    expect(files[SUMMARY_FILE].length).toBeGreaterThan(0)
    const rows = plan.summaryRows.slice(1)
    expect(rows.find((r) => r[2] === 1)?.[7]).toBe('ส่งกลับแก้ไข')
    expect(rows.some((r) => r[7] === 'ยังไม่ส่ง')).toBe(true) // the roster's others

    // another trainee of the cohort: sees the task but none of A1's work
    const peer = await createReviewService(supabaseAs(env, 'teacher_a2')).zipData(allocationId)
    expect(peer.submissions.filter((x) => x.user_id === U.teacher_a1)).toEqual([])
    // an outsider: nothing at all
    expect(await createReviewService(supabaseAs(env, 'school_admin_b')).zipData(allocationId)).toBeNull()
  })
})

// @vitest-environment node
/**
 * Integration: time limits and server-saved answers through the real Data
 * API (Supabase Local) with the real clock — concurrent save/submit, a late
 * submit after the deadline, and the pg_cron job finalising an abandoned
 * attempt.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, serverNow, U, IDS } from './helpers.js'
import { createAssignmentService } from '../../src/features/assignments/service.js'
import { createAssessmentService } from '../../src/features/assessments/service.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const COHORT = '30000000-0000-4000-a000-000000000001'
const VERSION = 'a2000000-0000-4000-a000-000000000001'
const Q = {
  single: 'a3000000-0000-4000-a000-000000000001',
  multiple: 'a3000000-0000-4000-a000-000000000002',
  truefalse: 'a3000000-0000-4000-a000-000000000003',
  numeric: 'a3000000-0000-4000-a000-000000000004',
}
const ALL_RIGHT = {
  [Q.single]: { choice: 'b' },
  [Q.multiple]: { choices: ['a', 'b', 'd'] },
  [Q.truefalse]: { value: true },
  [Q.numeric]: { value: 75 },
}
const ONE_RIGHT = { [Q.single]: { choice: 'b' } }
const KEY_MARKERS = /"correct"|answer_json|scoring_json|tolerance|is_correct|awarded_score/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

run('Attempt timing (Supabase Local, real clock)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const staff = () => createAssignmentService(supabaseAs(env, 'trainer'))
  const learner = (key) => createAssessmentService(supabaseAs(env, key))

  /** A published assignment of the demo quiz; closes `closeInMs` from now (null = no close). */
  const assign = async (title, { closeInMs = null, grace = 0, limit = 1, minutes = null } = {}) =>
    (
      await staff().create({
        versionId: VERSION,
        cohortId: COHORT,
        courseId: IDS.course,
        status: 'published',
        title,
        purpose: 'formative',
        attempt_limit: limit,
        passing_percent: 50,
        time_limit_minutes: minutes,
        grace_minutes: grace,
        open_at: null,
        close_at: closeInMs === null ? null : new Date((await serverNow(env)) + closeInMs).toISOString(),
        instructions: null,
      })
    ).id

  it('start returns deadline + server clock; saves and resume carry the answers; nothing leaks', async () => {
    const id = await assign('จับเวลา 30 นาที', { minutes: 30, grace: 5 })
    const a1 = learner('teacher_a1')
    const t = await a1.start(id)
    expect(new Date(t.deadline_at) - new Date(t.started_at)).toBe(30 * 60_000)
    expect(Math.abs(new Date(t.server_now) - (await serverNow(env)))).toBeLessThan(5_000)
    expect(await a1.saveDraft(t.attempt_id, ONE_RIGHT)).toMatchObject({ finalized: false })
    const resumed = await a1.start(id)
    expect(resumed).toMatchObject({ attempt_id: t.attempt_id, resumed: true, draft: ONE_RIGHT })
    expect(JSON.stringify(resumed)).not.toMatch(KEY_MARKERS)
    await expect(learner('teacher_a2').saveDraft(t.attempt_id, {})).rejects.toMatchObject({ code: '42501' })
  })

  it('saves racing a submit: one submit wins, later saves get SE003, responses written once', async () => {
    const id = await assign('แข่งกันบันทึก', { minutes: 30, grace: 5 })
    const a2 = learner('teacher_a2')
    const t = await a2.start(id)
    const calls = [
      ...Array.from({ length: 5 }, () => learner('teacher_a2').saveDraft(t.attempt_id, ONE_RIGHT)),
      learner('teacher_a2').submit(t.attempt_id, ALL_RIGHT),
      learner('teacher_a2').submit(t.attempt_id, ALL_RIGHT),
    ]
    const settled = await Promise.allSettled(calls)
    const submits = settled.slice(5)
    expect(submits.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(submits.find((r) => r.status === 'rejected').reason.code).toBe('SE003')
    for (const r of settled.slice(0, 5)) {
      if (r.status === 'rejected') expect(r.reason.code).toBe('SE003')
    }
    const row = (await staff().listAttempts(id)).find((x) => x.id === t.attempt_id)
    expect(row).toMatchObject({ status: 'submitted', auto_submitted: false, score: 5 })
  })

  it('after the deadline a late submit is ignored and the saved answers are scored (once, under a burst)', async () => {
    const id = await assign('ปิดใน 4 วินาที', { closeInMs: 4_000, grace: 0 })
    const a1 = learner('teacher_a1')
    const t = await a1.start(id)
    await a1.saveDraft(t.attempt_id, ONE_RIGHT)
    await sleep(5_000)
    const settled = await Promise.allSettled([
      learner('teacher_a1').submit(t.attempt_id, ALL_RIGHT),
      learner('teacher_a1').submit(t.attempt_id, ALL_RIGHT),
      learner('teacher_a1').saveDraft(t.attempt_id, ALL_RIGHT),
      learner('teacher_a1').start(id),
    ])
    // Whoever gets the lock first finalises from the saved answers. The others then see a
    // submitted attempt: submit/save → SE003; start → no open attempt and the window is
    // closed → SE001 (or, if it won the lock, timed_out).
    const [s1, s2, save, start] = settled
    for (const r of [s1, s2, save]) if (r.status === 'rejected') expect(r.reason.code).toBe('SE003')
    if (start.status === 'rejected') expect(start.reason.code).toBe('SE001')
    else expect(start.value).toMatchObject({ attempt_id: t.attempt_id, timed_out: true })
    const row = (await staff().listAttempts(id)).find((x) => x.id === t.attempt_id)
    expect(row).toMatchObject({ status: 'submitted', auto_submitted: true, score: 1, item_count: 4 })
    expect((await staff().listAttempts(id)).filter((x) => x.user_id === U.teacher_a1)).toHaveLength(1)
  })

  it('a trainer grants one extra attempt; the trainee can start again', async () => {
    const id = await assign('ให้สิทธิ์เพิ่ม', { minutes: 30 })
    const a2 = learner('teacher_a2')
    await a2.submit((await a2.start(id)).attempt_id, {})
    await expect(a2.start(id)).rejects.toMatchObject({ code: 'SE002' })
    await expect(
      createAssignmentService(supabaseAs(env, 'mentor')).grantExtraAttempt(id, U.teacher_a2, 'x')
    ).rejects.toThrow()
    await staff().grantExtraAttempt(id, U.teacher_a2, 'สัญญาณขาด')
    expect((await a2.start(id)).attempt_no).toBe(2)
    expect((await staff().listExtraAttempts(id)).map((x) => x.user_id)).toEqual([U.teacher_a2])
  })

  it('pg_cron finalises an abandoned attempt from its saved answers', { timeout: 120_000 }, async () => {
    const id = await assign('ทิ้งไว้ไม่ส่ง', { closeInMs: 2_000, grace: 0 })
    const b1 = learner('teacher_b1')
    const t = await b1.start(id)
    await b1.saveDraft(t.attempt_id, ALL_RIGHT)
    // The job runs every minute; nobody touches the attempt again.
    let row
    for (let i = 0; i < 50; i++) {
      await sleep(2_000)
      row = (await staff().listAttempts(id)).find((x) => x.id === t.attempt_id)
      if (row.status === 'submitted') break
    }
    expect(row).toMatchObject({ status: 'submitted', auto_submitted: true, score: 5 })
  })
})

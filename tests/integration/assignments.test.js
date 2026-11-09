// @vitest-environment node
/**
 * Integration: assigning a test to a cohort and reading the cohort's results
 * through the real Data API (Supabase Local) — the embeds, FK hints and
 * per-role row filtering the staff pages depend on.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, U, IDS } from './helpers.js'
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
const KEY_MARKERS = /"correct"|answer_json|scoring_json|tolerance|is_correct|awarded_score/

run('Assignments and cohort results (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const as = (key) => createAssignmentService(supabaseAs(env, key))
  let assignmentId

  it('trainer sees the cohorts of the course and assigns a published version', async () => {
    const cohorts = await as('trainer').listCohortsForCourse(IDS.course)
    expect(cohorts.map((c) => c.id)).toContain(COHORT)
    expect(cohorts.find((c) => c.id === COHORT).program_name).toBeTruthy()

    const version = await as('trainer').getVersion(VERSION)
    expect(version).toMatchObject({ status: 'published', instruments: { course_id: IDS.course } })

    const created = await as('trainer').create({
      versionId: VERSION,
      cohortId: COHORT,
      courseId: IDS.course,
      status: 'published',
      title: 'หลังเรียน (ทดสอบผลรุ่น)',
      purpose: 'posttest',
      attempt_limit: 2,
      passing_percent: 60,
      open_at: null,
      close_at: '2027-03-31T16:59:00Z',
      instructions: null,
    })
    assignmentId = created.id
    const row = await as('trainer').get(assignmentId)
    expect(row).toMatchObject({
      status: 'published',
      cohorts: { id: COHORT },
      instrument_versions: { version_no: 1 },
    })
  })

  it('trainees take it: A1 submits, A2 only starts', async () => {
    const a1 = createAssessmentService(supabaseAs(env, 'teacher_a1'))
    const started = await a1.start(assignmentId)
    await a1.submit(started.attempt_id, {})
    await createAssessmentService(supabaseAs(env, 'teacher_a2')).start(assignmentId)
  })

  it('trainer: one results row per trainee (assignment_results), names included', async () => {
    const rows = await as('trainer').results(assignmentId)
    expect(rows.map((r) => r.user_id).sort()).toEqual([U.teacher_a1, U.teacher_a2, U.teacher_b1].sort())
    expect(rows.every((r) => r.name && r.on_roster)).toBe(true)
    expect(rows.find((r) => r.user_id === U.teacher_a1)).toMatchObject({
      used: 1,
      submitted: 1,
      best_score: 0,
    })
    expect(rows.find((r) => r.user_id === U.teacher_a2)).toMatchObject({
      used: 1,
      submitted: 0,
      in_progress: true,
    })
    expect(rows.find((r) => r.user_id === U.teacher_b1)).toMatchObject({ used: 0, best_score: null })
    expect(JSON.stringify(rows)).not.toMatch(KEY_MARKERS)
  })

  it('item analysis: assessors only; fewer than 5 people → only the count', async () => {
    expect(await as('trainer').itemStatistics(assignmentId)).toEqual({
      n: 1,
      min_n: 5,
      suppressed: true,
      basis: 'first_attempt',
    })
    await expect(as('mentor').itemStatistics(assignmentId)).rejects.toMatchObject({ code: '42501' })
    await expect(as('teacher_a1').itemStatistics(assignmentId)).rejects.toMatchObject({ code: '42501' })
  })

  it('trainer: every attempt, no per-item data on the wire', async () => {
    const attempts = await as('trainer').listAttempts(assignmentId)
    expect(attempts.map((t) => [t.user_id, t.status]).sort()).toEqual(
      [
        [U.teacher_a1, 'submitted'],
        [U.teacher_a2, 'in_progress'],
      ].sort()
    )
    expect(attempts.find((t) => t.user_id === U.teacher_a1).profiles.full_name).toBeTruthy()
    expect(JSON.stringify(attempts)).not.toMatch(KEY_MARKERS)
  })

  it('mentor: only the assigned trainee, in the results and in the attempts', async () => {
    expect((await as('mentor').results(assignmentId)).map((r) => r.user_id)).toEqual([U.teacher_a1])
    expect((await as('mentor').listAttempts(assignmentId)).map((t) => t.user_id)).toEqual([U.teacher_a1])
    await expect(as('mentor').update(assignmentId, { title: 'x' })).rejects.toThrow()
  })

  it('settings: pass mark frozen after attempts (SE004); deadline still editable', async () => {
    await expect(as('trainer').update(assignmentId, { passing_percent: 40 })).rejects.toMatchObject({
      code: 'SE004',
    })
    const close = new Date(Date.now() + 86_400_000).toISOString()
    await as('trainer').update(assignmentId, { close_at: close, attempt_limit: 3 })
    const row = await as('trainer').get(assignmentId)
    expect(row.attempt_limit).toBe(3)
    expect(new Date(row.close_at).getTime()).toBe(new Date(close).getTime())
    await expect(as('trainer').remove(assignmentId)).rejects.toThrow() // published: not deletable
  })

  it('an archived quiz cannot be assigned (SE010, Thai message); bringing it back lifts the block', async () => {
    // AFL-102-TYPES: no other integration file uses it (files run in parallel on one database)
    const TYPES_QUIZ = 'a1000000-0000-4000-a000-000000000002'
    const TYPES_VERSION = 'a2000000-0000-4000-a000-000000000002'
    const client = supabaseAs(env, 'trainer')
    const setStatus = async (status) => {
      const { error } = await client.from('instruments').update({ status }).eq('id', TYPES_QUIZ)
      expect(error).toBeNull()
    }
    const draft = () =>
      as('trainer').create({
        versionId: TYPES_VERSION,
        cohortId: COHORT,
        courseId: IDS.course,
        status: 'draft',
        title: 'ร่างจากแบบทดสอบที่เก็บถาวร (ทดสอบ)',
        purpose: 'formative',
        attempt_limit: 1,
        passing_percent: null,
        open_at: null,
        close_at: null,
        instructions: null,
      })
    await setStatus('archived')
    try {
      expect((await as('trainer').getVersion(TYPES_VERSION)).instruments.status).toBe('archived')
      await expect(draft()).rejects.toMatchObject({ code: 'SE010', message: expect.stringContaining('นำกลับมาใช้') })
    } finally {
      await setStatus('active')
    }
    const created = await draft()
    await as('trainer').remove(created.id) // a draft nobody used: deletable, so the data ends as it began
  })

  it('outsiders see nothing', async () => {
    expect(await as('school_admin_b').get(assignmentId)).toBeNull()
    expect(await as('school_admin_b').listAttempts(assignmentId)).toEqual([])
    expect(await as('school_admin_b').results(assignmentId)).toEqual([])
    expect((await as('teacher_a2').listAttempts(assignmentId)).map((t) => t.user_id)).toEqual([U.teacher_a2])
  })
})

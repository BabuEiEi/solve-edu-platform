// @vitest-environment node
/**
 * Integration (Phase 4g step 1): joining a cohort and enrolling in a course
 * through the real Data API — the RPCs are reachable, their error codes reach
 * the browser, and RLS still hides what it should. Uses its own cohort, so the
 * other files (running at the same time on the same database) are not touched.
 * The joiner is school_admin_a (other files use it only where trainee status does not
 * matter); school_admin_b, an "outsider" elsewhere, only meets the full cohort (no row).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, IDS } from './helpers.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const PROGRAM = '20000000-0000-4000-a000-000000000001'

run('Cohort joining and course enrollment (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  let cohortId

  it('Staff creates a cohort that is closed until it says otherwise', async () => {
    const staff = supabaseAs(env, 'staff')
    const { data, error } = await staff
      .from('cohorts')
      .insert({
        program_id: PROGRAM,
        code: `INT-${Date.now()}`,
        name: 'รุ่นทดสอบ integration',
        status: 'open',
      })
      .select('id, enrollment_mode, seat_limit')
      .single()
    expect(error).toBeNull()
    expect(data).toMatchObject({ enrollment_mode: 'closed', seat_limit: null })
    cohortId = data.id
    const res = await supabaseAs(env, 'school_admin_a').rpc('request_cohort_join', { p_cohort: cohortId })
    expect(res.error?.code).toBe('SE012')
  })

  it('opened with one seat: the first person joins at once, the next is told it is full', async () => {
    const staff = supabaseAs(env, 'staff')
    expect(
      (await staff.from('cohorts').update({ enrollment_mode: 'open', seat_limit: 1 }).eq('id', cohortId))
        .error
    ).toBeNull()
    const list = await supabaseAs(env, 'school_admin_a').rpc('list_open_cohorts')
    expect(list.error).toBeNull()
    const mine = list.data.find((c) => c.cohort_id === cohortId)
    expect(mine).toMatchObject({ enrollment_mode: 'open', seats_left: 1, my_status: null })
    expect(JSON.stringify(list.data)).not.toMatch(/@example\.test/) // nobody's e-mail

    expect(
      (await supabaseAs(env, 'school_admin_a').rpc('request_cohort_join', { p_cohort: cohortId })).data
    ).toBe('active')
    const full = await supabaseAs(env, 'school_admin_b').rpc('request_cohort_join', { p_cohort: cohortId })
    expect(full.error?.code).toBe('SE011')
  })

  it('the member enrolls in one course; nobody else can enroll them; anonymous gets nothing', async () => {
    const member = supabaseAs(env, 'school_admin_a')
    const enrolled = await member.rpc('enroll_in_course', { p_cohort: cohortId, p_course: IDS.course })
    expect(enrolled.error).toBeNull()
    const mine = await member
      .from('course_enrollments')
      .select('id, course_id, cohort_id')
      .eq('cohort_id', cohortId)
    expect(mine.data).toEqual([{ id: enrolled.data, course_id: IDS.course, cohort_id: cohortId }])

    const other = await supabaseAs(env, 'teacher_a1').rpc('enroll_in_course', {
      p_cohort: cohortId,
      p_course: IDS.course,
      p_user: '00000000-0000-4000-a000-000000000004',
    })
    expect(other.error?.code).toBe('42501')
    const anon = await supabaseAs(env, null).rpc('list_open_cohorts')
    expect(anon.error).toBeTruthy()
  })
})

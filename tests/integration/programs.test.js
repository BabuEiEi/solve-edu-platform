// @vitest-environment node
/**
 * Integration (Phase 4g step 2): the programme service through the real Data
 * API — Staff creates a programme, puts a course in it and opens a cohort; a
 * teacher cannot; the service turns a refused write into a Thai error. Uses its
 * own programme so the other files (same database, run in parallel) are untouched.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, IDS } from './helpers.js'
import { createProgramService } from '../../src/features/programs/service.js'
import { buildCohortPayload, buildProgramPayload } from '../../src/features/programs/logic.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const DISTRICT = '10000000-0000-4000-a000-000000000001'

run('Programmes and cohorts service (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const as = (key) => createProgramService(supabaseAs(env, key))
  let programId

  it('Staff creates a programme, adds a published course, and a cohort open with approval', async () => {
    const staff = as('staff')
    const code = `INT-P-${Date.now()}`
    programId = (
      await staff.createProgram(
        buildProgramPayload(
          {
            code,
            name: 'โครงการ integration',
            fiscal_year: '2570',
            status: 'active',
            owner_org_id: DISTRICT,
          },
          { isNew: true }
        )
      )
    ).id
    expect((await staff.listCourses()).map((c) => c.id)).toContain(IDS.course)
    await staff.addCourse(programId, IDS.course, 1)
    await staff.createCohort(
      programId,
      buildCohortPayload({
        code: 'I1',
        name: 'รุ่น integration',
        status: 'open',
        enrollment_mode: 'approval',
        seat_limit: '10',
      })
    )
    const p = await staff.getProgram(programId)
    expect(p.program_courses.map((pc) => pc.course_id)).toEqual([IDS.course])
    expect(p.cohorts[0]).toMatchObject({ code: 'I1', enrollment_mode: 'approval', seat_limit: 10 })
  })

  it('a teacher cannot see that programme nor change it; the refusal is a Thai message', async () => {
    const teacher = as('teacher_a1')
    expect(await teacher.getProgram(programId)).toBeNull()
    await expect(teacher.updateProgram(programId, { name: 'x' })).rejects.toThrow(
      'ไม่พบข้อมูล หรือท่านไม่มีสิทธิ์แก้ไข'
    )
    await expect(
      teacher.createProgram(
        buildProgramPayload(
          { code: 'NOPE', name: 'x', fiscal_year: '2570', status: 'draft', owner_org_id: DISTRICT },
          { isNew: true }
        )
      )
    ).rejects.toThrow('ไม่มีสิทธิ์')
  })
})

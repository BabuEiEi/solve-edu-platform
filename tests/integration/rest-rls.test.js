// @vitest-environment node
/**
 * Integration: real service layer → PostgREST (same engine as Supabase Data API) → RLS.
 * Runs only when SOLVEEDU_REST_URL + SOLVEEDU_JWT_SECRET are set (scripts/db-local/test-rest.sh).
 * Uses the demo seed; mutates data, so the runner resets a dedicated database first.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { PostgrestClient } from '@supabase/postgrest-js'
import { createProfileService } from '../../src/features/profiles/service.js'
import { createAdminService } from '../../src/features/admin/service.js'
import { createCourseService } from '../../src/features/courses/service.js'
import { createProgramService } from '../../src/features/programs/service.js'

const URL = process.env.SOLVEEDU_REST_URL
const SECRET = process.env.SOLVEEDU_JWT_SECRET
const run = URL && SECRET ? describe : describe.skip

const U = {
  teacher_a1: '00000000-0000-4000-a000-000000000008',
  school_admin_a: '00000000-0000-4000-a000-000000000004',
  school_admin_b: '00000000-0000-4000-a000-000000000005',
  newcomer: '00000000-0000-4000-a000-000000000011',
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function jwtFor(sub, role = 'authenticated') {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ sub, role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
const clientAs = (key) =>
  new PostgrestClient(URL, { headers: key ? { Authorization: `Bearer ${jwtFor(U[key])}` } : {} })

run('REST + RLS integration (local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))

  it('anon cannot read profiles through the API', async () => {
    const { error } = await clientAs(null).from('profiles').select('id')
    expect(error?.code).toBe('42501')
  })

  it('select("*") on profiles is refused (contact_email is column-protected)', async () => {
    const { error } = await clientAs('teacher_a1').from('profiles').select('*')
    expect(error?.code).toBe('42501')
  })

  it('trainee context loads with embedded org and cohort names', async () => {
    const ctx = await createProfileService(clientAs('teacher_a1')).getMyContext(U.teacher_a1)
    expect(ctx.profile.status).toBe('active')
    expect(ctx.orgMemberships[0].organizations.name).toBe('โรงเรียนสาธิต ก (สมมติ)')
    expect(ctx.cohortMemberships.map((m) => m.cohort_role)).toEqual(['trainee'])
    expect(ctx.cohortMemberships[0].cohorts.code).toBe('C1')
    expect(ctx.platformRoles).toEqual([])
  })

  it('trainee sees only the published enrolled course and no draft lessons', async () => {
    const svc = createCourseService(clientAs('teacher_a1'))
    const courses = await svc.listVisibleCourses()
    expect(courses.map((c) => c.code)).toEqual(['AFL-101'])
    const outline = await svc.getCourseOutline(courses[0].id)
    const lessons = outline.course_units.flatMap((u) => u.lessons)
    expect(lessons).toHaveLength(3)
    expect(lessons.every((l) => l.status === 'published')).toBe(true)
    const mine = await svc.listMyEnrollments(U.teacher_a1)
    expect(mine).toHaveLength(1)
    expect(mine[0].lesson_progress[0].status).toBe('completed')
  })

  it('trainee sees the program of own cohort', async () => {
    const programs = await createProgramService(clientAs('teacher_a1')).listVisiblePrograms()
    expect(programs.map((p) => p.code)).toEqual(['AFL-2570'])
    expect(programs[0].cohorts.map((c) => c.code)).toEqual(['C1'])
  })

  it('approval queue is scoped by requested organization', async () => {
    const a = await createAdminService(clientAs('school_admin_a')).listProfilesByStatus('pending')
    expect(a.map((p) => p.id)).toEqual([U.newcomer])
    expect(a[0].organizations.name).toBe('โรงเรียนสาธิต ก (สมมติ)')
    const b = await createAdminService(clientAs('school_admin_b')).listProfilesByStatus('pending')
    expect(b).toEqual([])
  })

  it('out-of-scope approval is denied; in-scope approval succeeds', async () => {
    await expect(
      createAdminService(clientAs('school_admin_b')).setProfileStatus(U.newcomer, 'active')
    ).rejects.toThrow('ไม่มีสิทธิ์')
    await createAdminService(clientAs('school_admin_a')).setProfileStatus(U.newcomer, 'active')
    const after = await createAdminService(clientAs('school_admin_a')).listProfilesByStatus('active')
    expect(after.some((p) => p.id === U.newcomer)).toBe(true)
  })

  it('trainee cannot call the admin RPC on anyone', async () => {
    await expect(
      createAdminService(clientAs('teacher_a1')).setProfileStatus(U.school_admin_a, 'suspended', 'test')
    ).rejects.toThrow('ไม่มีสิทธิ์')
  })

  it('authz/private schemas are not reachable through the API', async () => {
    const r1 = await clientAs('teacher_a1').schema('private').from('audit_logs').select('id')
    expect(r1.error).toBeTruthy()
    const r2 = await clientAs('teacher_a1').rpc('is_platform_admin')
    expect(r2.error).toBeTruthy()
  })
})

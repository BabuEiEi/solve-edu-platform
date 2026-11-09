// @vitest-environment node
/**
 * Integration: real service layer → PostgREST (same engine as Supabase Data API) → RLS.
 * Runs only when SOLVEEDU_REST_URL + SOLVEEDU_JWT_SECRET are set (scripts/db-local/test-rest.sh).
 * Uses the demo seed; mutates data, so the runner resets a dedicated database first.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { PostgrestClient } from '@supabase/postgrest-js'
import { createProfileService } from '../../src/features/profiles/service.js'
import { createAdminService } from '../../src/features/admin/service.js'
import { createCourseService } from '../../src/features/courses/service.js'
import { createProgramService } from '../../src/features/programs/service.js'
import { U, jwtFor } from './helpers.js'

const URL = process.env.SOLVEEDU_REST_URL
const SECRET = process.env.SOLVEEDU_JWT_SECRET
// Supabase Local routes through Kong, which also wants the publishable key.
const API_KEY = process.env.SOLVEEDU_API_KEY
const run = URL && SECRET ? describe : describe.skip

const clientAs = (key) =>
  new PostgrestClient(URL, {
    headers: {
      ...(API_KEY ? { apikey: API_KEY } : {}),
      ...(key ? { Authorization: `Bearer ${jwtFor(SECRET, U[key])}` } : {}),
    },
  })

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

  it('approval queue: Staff sees the newcomer and the school asked for; a former school admin sees nobody (4f)', async () => {
    const staff = await createAdminService(clientAs('staff')).listProfilesByStatus('pending')
    expect(staff.map((p) => p.id)).toEqual([U.newcomer])
    expect(staff[0].organizations.name).toBe('โรงเรียนสาธิต ก (สมมติ)')
    expect(await createAdminService(clientAs('school_admin_a')).listProfilesByStatus('pending')).toEqual([])
  })

  it('active list embeds only current memberships (Staff)', async () => {
    const rows = await createAdminService(clientAs('staff')).listProfilesByStatus('active')
    const a1 = rows.find((p) => p.id === U.teacher_a1)
    expect(a1.organization_memberships.map((m) => [m.org_role, m.organizations.name])).toEqual([
      ['teacher', 'โรงเรียนสาธิต ก (สมมติ)'],
    ])
    expect(rows.some((p) => p.id === U.platform_admin)).toBe(false) // a platform role holder is not Staff's to manage
  })

  it('a teacher cannot approve; Staff approves and the person joins the school they asked for', async () => {
    await expect(
      createAdminService(clientAs('school_admin_a')).setProfileStatus(U.newcomer, 'active')
    ).rejects.toThrow('ไม่มีสิทธิ์')
    await createAdminService(clientAs('staff')).setProfileStatus(U.newcomer, 'active')
    const after = await createAdminService(clientAs('staff')).listProfilesByStatus('active')
    const newcomer = after.find((p) => p.id === U.newcomer)
    expect(newcomer.organization_memberships.map((m) => [m.org_role, m.organizations.name])).toEqual([
      ['teacher', 'โรงเรียนสาธิต ก (สมมติ)'],
    ])
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

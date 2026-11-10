/**
 * Phase 4g step 3: the cohort members page — requests, search and add with a
 * role, remove, and enrollment per course (one, or everyone at once).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('../../src/shared/ui/dialog.js', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }))
import { confirmDialog } from '../../src/shared/ui/dialog.js'
import {
  canManageCohort,
  grantableCohortRoles,
  renderCohortMembersView,
  rosterView,
} from '../../src/features/programs/members.js'
import { createProgramService } from '../../src/features/programs/service.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
const submit = (form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const person = (id, name, code = null) => ({ id, full_name: name, display_name: null, user_code: code })
const member = (id, userId, role, status = 'active', name = userId) => ({
  id,
  user_id: userId,
  cohort_role: role,
  status,
  created_at: '2026-11-09T01:00:00Z',
  profiles: person(userId, name),
})
const COURSES = [
  { id: 'K1', title: 'หลักสูตร 1', status: 'published' },
  { id: 'K2', title: 'หลักสูตร 2', status: 'published' },
]
const roster = () => ({
  cohort: {
    id: 'C1',
    program_id: 'P1',
    code: 'C1',
    name: 'รุ่น 1',
    status: 'open',
    enrollment_mode: 'approval',
    programs: {
      id: 'P1',
      name: 'โครงการ',
      status: 'active',
      program_courses: COURSES.map((c, i) => ({ course_id: c.id, display_order: i + 1, courses: c })),
    },
  },
  members: [
    member('M1', 'U1', 'trainer', 'active', 'วิทยากร ก'),
    member('M2', 'U2', 'trainee', 'active', XSS),
    member('M3', 'U3', 'trainee', 'active', 'ครู ข'),
    member('M4', 'U4', 'trainee', 'requested', 'ผู้ขอเข้า'),
    member('M5', 'U5', 'trainee', 'withdrawn', 'ออกไปแล้ว'),
  ],
  enrollments: [
    { id: 'E1', user_id: 'U2', course_id: 'K1', status: 'active' },
    { id: 'E2', user_id: 'U3', course_id: 'K1', status: 'withdrawn' },
  ],
})

describe('logic', () => {
  it('rosterView: active members by role, waiting requests, a grid of active trainees × courses', () => {
    const v = rosterView(roster(), COURSES)
    expect(v.byRole.trainer.map((m) => m.id)).toEqual(['M1'])
    expect(v.byRole.trainee.map((m) => m.id)).toEqual(['M2', 'M3']) // not the request, not the withdrawn
    expect(v.requests.map((m) => m.id)).toEqual(['M4'])
    expect(v.grid[0].cells.map((c) => c.enrollment?.id ?? null)).toEqual(['E1', null])
    expect(v.grid[1].cells[0].enrollment.status).toBe('withdrawn')
    expect(v.activeIds.has('U1:trainer')).toBe(true)
  })

  it("who manages: programme administrators and the cohort's own coordinator; a coordinator cannot make coordinators", () => {
    expect(canManageCohort({ canAdministerPrograms: true }, {}, 'C1')).toBe(true)
    const coordinator = {
      cohortMemberships: [{ cohort_id: 'C1', cohort_role: 'coordinator', status: 'active' }],
    }
    expect(canManageCohort({}, coordinator, 'C1')).toBe(true)
    expect(canManageCohort({}, coordinator, 'C2')).toBe(false)
    const trainer = { cohortMemberships: [{ cohort_id: 'C1', cohort_role: 'trainer', status: 'active' }] }
    expect(canManageCohort({}, trainer, 'C1')).toBe(false)
    expect(grantableCohortRoles({})).not.toContain('coordinator')
    expect(grantableCohortRoles({ canAdministerPrograms: true })).toContain('coordinator')
  })

  it('search: characters with a meaning in a PostgREST filter are removed; at least 2 letters', async () => {
    const or = vi.fn(() => q)
    const q = {
      select: () => q,
      eq: () => q,
      or,
      order: () => q,
      limit: async () => ({ data: [], error: null }),
    }
    const service = createProgramService({ from: () => q })
    await service.searchPeople('ครู,(x).ilike.*%"')
    const filter = or.mock.calls[0][0]
    const typed = filter.slice('full_name.ilike.*'.length, filter.indexOf('*,')) // what remains of the person's text
    expect(typed).not.toMatch(/[(),"%*]/)
    expect(typed).toContain('ครู')
    expect(filter.split(',')).toHaveLength(3) // still exactly the three conditions
    await expect(service.searchPeople(' a ')).rejects.toThrow('อย่างน้อย 2 ตัวอักษร')
  })
})

describe('page', () => {
  afterEach(() => {
    document.body.replaceChildren()
    confirmDialog.mockReset()
  })
  const programs = (over = {}) => ({
    getCohortRoster: vi.fn(async () => roster()),
    searchPeople: vi.fn(async () => [person('U9', 'คนใหม่', 'T-9'), person('U1', 'วิทยากร ก')]),
    addMember: vi.fn(async () => ({})),
    setMemberStatus: vi.fn(async () => ({})),
    decideRequest: vi.fn(async () => 'active'),
    enroll: vi.fn(async () => 'E9'),
    withdrawEnrollment: vi.fn(async () => ({})),
    ...over,
  })
  const open = async ({
    caps = { canAdministerPrograms: true, canApproveUsers: true },
    context = {},
    services = programs(),
  } = {}) => {
    const el = document.createElement('div')
    document.body.append(el)
    await renderCohortMembersView(
      el,
      { services: { programs: services }, caps, context },
      { id: 'P1', cohortId: 'C1' }
    )
    return { el, services }
  }

  it('names are text; requests can be accepted, and declining asks first', async () => {
    const { el, services } = await open()
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain(XSS)
    expect(el.querySelector('[data-request-id=M4]')).not.toBeNull()
    el.querySelector('[data-action=accept][data-id=M4]').click()
    await settle()
    expect(services.decideRequest).toHaveBeenCalledWith('M4', true)
    expect(el.textContent).toContain('รับเข้ารุ่นแล้ว')
    confirmDialog.mockResolvedValueOnce(false)
    el.querySelector('[data-action=decline][data-id=M4]').click()
    await settle()
    expect(services.decideRequest).toHaveBeenCalledTimes(1)
    confirmDialog.mockResolvedValueOnce(true)
    el.querySelector('[data-action=decline][data-id=M4]').click()
    await settle()
    expect(services.decideRequest).toHaveBeenLastCalledWith('M4', false)
  })

  it('search and add with a role; a role the person already holds is not offered again', async () => {
    const { el, services } = await open()
    el.querySelector('form[data-form=people-search] [name=q]').value = 'ครู'
    submit(el.querySelector('form[data-form=people-search]'))
    await settle()
    expect(services.searchPeople).toHaveBeenCalledWith('ครู', { withEmail: true })
    const trainerOption = el.querySelector('[data-person-id=U1] option[value=trainer]')
    expect(trainerOption.disabled).toBe(true)
    expect(trainerOption.textContent).toContain('อยู่แล้ว')
    const form = el.querySelector('[data-person-id=U9] form[data-form=add-member]')
    form.querySelector('select').value = 'mentor'
    submit(form)
    await settle()
    expect(services.addMember).toHaveBeenCalledWith('C1', 'U9', 'mentor')
    expect(el.textContent).toContain('เพิ่มเป็นครูพี่เลี้ยงแล้ว')
  })

  it('remove asks first; enroll one; take one back; enroll everyone missing in a course', async () => {
    const { el, services } = await open()
    confirmDialog.mockResolvedValueOnce(true)
    el.querySelector('[data-member-id=M3] [data-action=remove]').click()
    await settle()
    expect(services.setMemberStatus).toHaveBeenCalledWith('M3', 'withdrawn')

    el.querySelector('[data-trainee=U2] [data-cell=K2] [data-action=enroll]').click()
    await settle()
    expect(services.enroll).toHaveBeenCalledWith('C1', 'K2', 'U2')

    confirmDialog.mockResolvedValueOnce(true)
    el.querySelector('[data-trainee=U2] [data-cell=K1] [data-action=unenroll]').click()
    await settle()
    expect(services.withdrawEnrollment).toHaveBeenCalledWith('E1')

    services.enroll.mockClear()
    el.querySelector('[data-action=enroll-all][data-course=K1]').click()
    await settle()
    expect(services.enroll.mock.calls).toEqual([['C1', 'K1', 'U3']]) // U2 already in; U3 had withdrawn
    expect(el.textContent).toContain('ลงทะเบียนแล้ว 1 คน')
  })

  it('a refusal from the server is shown in Thai and the page stays usable', async () => {
    const services = programs({ enroll: vi.fn(async () => Promise.reject({ code: 'SE013' })) })
    const { el } = await open({ services })
    el.querySelector('[data-trainee=U2] [data-cell=K2] [data-action=enroll]').click()
    await settle()
    expect(el.textContent).toContain('ลงทะเบียนได้เฉพาะผู้เข้าอบรมของรุ่นนี้')
    expect(el.querySelector('[data-enrollments]')).not.toBeNull()
  })

  it('a trainer of the cohort (not a manager) sees the members but no buttons', async () => {
    const context = { cohortMemberships: [{ cohort_id: 'C1', cohort_role: 'trainer', status: 'active' }] }
    const { el } = await open({ caps: {}, context })
    expect(el.querySelector('[data-members]')).not.toBeNull()
    expect(
      el.querySelector(
        '[data-add-people], [data-action=accept], [data-action=remove], [data-action=enroll], [data-action=enroll-all]'
      )
    ).toBeNull()
  })

  it('a cohort of another programme in the address is not shown', async () => {
    const el = document.createElement('div')
    await renderCohortMembersView(
      el,
      { services: { programs: programs() }, caps: {}, context: {} },
      { id: 'OTHER', cohortId: 'C1' }
    )
    expect(el.textContent).toContain('ไม่พบรุ่นนี้')
  })
})

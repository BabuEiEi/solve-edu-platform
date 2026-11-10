/**
 * Phase 4g step 2: programmes and cohorts pages — form → columns with Thai
 * errors, who is offered what, and the "who sees this cohort" sentence.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('../../src/shared/ui/dialog.js', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }))
import { confirmDialog } from '../../src/shared/ui/dialog.js'
import {
  buildCohortPayload,
  buildProgramPayload,
  currentFiscalYear,
  joiningHint,
  ownerOrgChoices,
} from '../../src/features/programs/logic.js'
import {
  renderNewProgramView,
  renderProgramDetailView,
  renderProgramsView,
} from '../../src/features/programs/views.js'
import { deriveCapabilities } from '../../src/core/permissions.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
const submit = (form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

describe('logic', () => {
  it('Thai fiscal year starts in October (Bangkok time)', () => {
    expect(currentFiscalYear(new Date('2026-09-30T16:59:00Z'))).toBe(2569) // 23:59 on 30 Sep in Bangkok
    expect(currentFiscalYear(new Date('2026-09-30T17:00:00Z'))).toBe(2570) // 00:00 on 1 Oct in Bangkok
  })

  it('programme: code, name, year, status, dates checked; owner only when new', () => {
    const base = {
      code: 'AFL-2570',
      name: ' พัฒนาครู ',
      fiscal_year: '2570',
      status: 'active',
      description: '',
    }
    expect(buildProgramPayload(base)).toEqual({
      code: 'AFL-2570',
      name: 'พัฒนาครู',
      description: null,
      fiscal_year: 2570,
      status: 'active',
      start_at: null,
      end_at: null,
    })
    expect(() => buildProgramPayload({ ...base, code: 'AFL 2570' })).toThrow('รหัสโครงการ')
    expect(() => buildProgramPayload({ ...base, fiscal_year: '2026' })).toThrow('ปีงบประมาณ')
    expect(() => buildProgramPayload({ ...base, status: 'gone' })).toThrow('สถานะโครงการ')
    expect(() =>
      buildProgramPayload({ ...base, start_at: '2027-01-02T00:00', end_at: '2027-01-01T00:00' })
    ).toThrow('วันสิ้นสุดโครงการต้องไม่ก่อนวันเริ่มโครงการ')
    expect(() => buildProgramPayload(base, { isNew: true })).toThrow('หน่วยงานเจ้าของ')
    expect(buildProgramPayload({ ...base, owner_org_id: 'D' }, { isNew: true }).owner_org_id).toBe('D')
  })

  it('cohort: joining settings — mode, seats (blank = no limit), window order', () => {
    const base = { code: 'C1', name: 'รุ่น 1', status: 'open', enrollment_mode: 'approval', seat_limit: '' }
    expect(buildCohortPayload(base)).toMatchObject({
      enrollment_mode: 'approval',
      seat_limit: null,
      enroll_from: null,
    })
    expect(buildCohortPayload({ ...base, seat_limit: '30' }).seat_limit).toBe(30)
    expect(() => buildCohortPayload({ ...base, seat_limit: '0' })).toThrow('จำนวนที่นั่ง')
    expect(() => buildCohortPayload({ ...base, seat_limit: '2.5' })).toThrow('จำนวนที่นั่ง')
    expect(() => buildCohortPayload({ ...base, enrollment_mode: 'everyone' })).toThrow('การรับสมัคร')
    expect(() =>
      buildCohortPayload({ ...base, enroll_from: '2027-01-02T00:00', enroll_until: '2027-01-02T00:00' })
    ).toThrow('วันปิดรับสมัครต้องหลังวันเปิดรับสมัคร')
    expect(buildCohortPayload({ ...base, enroll_until: '2027-01-02T08:30' }).enroll_until).toBe(
      '2027-01-02T08:30:00+07:00'
    )
  })

  it('the joining sentence follows the same rule as the database', () => {
    const now = new Date('2027-01-10T00:00:00Z')
    const active = { status: 'active' }
    const open = { enrollment_mode: 'open', status: 'open' }
    expect(joiningHint(active, { ...open, enrollment_mode: 'closed' }, now).open).toBe(false)
    expect(joiningHint(active, open, now)).toMatchObject({ open: true })
    expect(joiningHint({ status: 'draft' }, open, now).text).toContain('โครงการยังไม่อยู่ในสถานะ "ดำเนินการ"')
    expect(joiningHint(active, { ...open, status: 'draft' }, now).text).toContain('รุ่นต้องอยู่ในสถานะ')
    expect(joiningHint(active, { ...open, enroll_until: '2027-01-01T00:00:00Z' }, now).text).toContain(
      'เลยวันปิดรับสมัคร'
    )
    expect(joiningHint(active, { ...open, enroll_from: '2027-02-01T00:00:00Z' }, now).text).toContain(
      'ยังไม่ถึงวันเปิดรับสมัคร'
    )
  })

  it('owner organizations: everything for the platform admin and Staff; own and below for a district admin', () => {
    const orgs = [
      { id: 'D', parent_id: null },
      { id: 'A', parent_id: 'D' },
      { id: 'X', parent_id: 'E' },
    ]
    expect(ownerOrgChoices(orgs, {}, { isPlatformSupport: true })).toHaveLength(3)
    const district = { orgMemberships: [{ organization_id: 'D', org_role: 'district_admin' }] }
    expect(ownerOrgChoices(orgs, district, {}).map((o) => o.id)).toEqual(['D', 'A'])
    const teacher = { orgMemberships: [{ organization_id: 'A', org_role: 'teacher' }] }
    expect(ownerOrgChoices(orgs, teacher, {})).toEqual([])
  })

  it('caps: Staff administers programmes but is not a programme manager (no results/review menus)', () => {
    const staff = deriveCapabilities({
      profile: { status: 'active' },
      platformRoles: [{ role: 'platform_support' }],
    })
    expect(staff.canAdministerPrograms).toBe(true)
    expect(staff.canManagePrograms).toBe(false)
    const teacher = deriveCapabilities({
      profile: { status: 'active' },
      orgMemberships: [{ org_role: 'teacher' }],
    })
    expect(teacher.canAdministerPrograms).toBe(false)
  })
})

// ---------- pages ----------
const PROGRAM = {
  id: 'P1',
  code: 'AFL-2570',
  name: XSS,
  description: null,
  fiscal_year: 2570,
  status: 'active',
  start_at: null,
  end_at: null,
  owner_org_id: 'D',
  organizations: { name: 'เขตสาธิต' },
  cohorts: [
    {
      id: 'C1',
      program_id: 'P1',
      code: 'C1',
      name: 'รุ่น 1',
      status: 'open',
      enrollment_mode: 'open',
      seat_limit: 30,
      start_at: null,
      end_at: null,
      enroll_from: null,
      enroll_until: null,
    },
  ],
  program_courses: [
    {
      course_id: 'K1',
      display_order: 1,
      courses: { id: 'K1', code: 'AFL-101', title: 'หลักสูตร 1', status: 'published' },
    },
  ],
}
const COURSES = [
  { id: 'K1', code: 'AFL-101', title: 'หลักสูตร 1', status: 'published' },
  { id: 'K2', code: 'AFL-102', title: 'หลักสูตร 2', status: 'published' },
]

describe('pages', () => {
  afterEach(() => {
    document.body.replaceChildren()
    confirmDialog.mockReset()
  })
  const programsService = (over = {}) => ({
    listVisiblePrograms: vi.fn(async () => [PROGRAM]),
    getProgram: vi.fn(async () => structuredClone(PROGRAM)),
    listCourses: vi.fn(async () => COURSES),
    createProgram: vi.fn(async () => ({ id: 'P9' })),
    updateProgram: vi.fn(async () => ({ id: 'P1' })),
    addCourse: vi.fn(async () => ({})),
    removeCourse: vi.fn(async () => ({})),
    createCohort: vi.fn(async () => ({ id: 'C9' })),
    updateCohort: vi.fn(async () => ({ id: 'C1' })),
    ...over,
  })
  const mount = () => {
    const el = document.createElement('div')
    document.body.append(el)
    return el
  }

  it('list: names are text; "สร้างโครงการ" and links only for those who administer programmes', async () => {
    const el = mount()
    await renderProgramsView(el, {
      services: { programs: programsService() },
      caps: { canAdministerPrograms: true },
    })
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain(XSS)
    expect(el.querySelector('[data-action-link=new-program]')).not.toBeNull()
    expect(el.querySelector('a[href="#/programs/P1"]')).not.toBeNull()
    const member = mount()
    await renderProgramsView(member, { services: { programs: programsService() }, caps: { isActive: true } })
    expect(member.querySelector('[data-action-link=new-program]')).toBeNull()
    expect(member.querySelector('a[href="#/programs/P1"]')).toBeNull()
    expect(member.textContent).not.toContain('รับสมัคร') // joining settings are for managers
  })

  it('new: a refused save keeps what was typed and says why; a good one goes to the programme', async () => {
    const el = mount()
    const createProgram = vi.fn().mockRejectedValueOnce({ code: '23505' }).mockResolvedValue({ id: 'P9' })
    const services = {
      programs: programsService({ createProgram }),
      organizations: { listActiveOrganizations: async () => [{ id: 'D', name: 'เขต', parent_id: null }] },
    }
    await renderNewProgramView(el, {
      services,
      caps: { canAdministerPrograms: true, isPlatformSupport: true },
      context: {},
    })
    const form = () => el.querySelector('form[data-form=program-new]')
    form().querySelector('[name=code]').value = 'NEW-1'
    form().querySelector('[name=name]').value = 'โครงการใหม่'
    form().querySelector('[name=owner_org_id]').value = 'D'
    submit(form())
    await settle()
    expect(el.textContent).toContain('ข้อมูลนี้มีอยู่แล้วในระบบ')
    expect(form().querySelector('[name=code]').value).toBe('NEW-1')
    expect(form().querySelector('[name=owner_org_id]').value).toBe('D')
    submit(form())
    await settle()
    expect(createProgram).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: 'NEW-1',
        owner_org_id: 'D',
        fiscal_year: currentFiscalYear(),
        status: 'draft',
      })
    )
    expect(window.location.hash).toBe('#/programs/P9')
    window.location.hash = ''
  })

  it('detail: add a course; removing one asks first; a cohort with its joining sentence and members link', async () => {
    const el = mount()
    const services = { programs: programsService() }
    await renderProgramDetailView(el, { services, caps: { canAdministerPrograms: true } }, { id: 'P1' })
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-cohort-id=C1] [data-joining-hint]').textContent).toContain(
      'ผู้เรียนทุกคนที่บัญชีใช้งานได้เห็นรุ่นนี้'
    )
    expect(el.querySelector('[data-cohort-id=C1] [data-joining-hint]').textContent).toContain('30 ที่นั่ง')
    expect(el.querySelector('a[href="#/programs/P1/cohorts/C1"]')).not.toBeNull()
    const select = el.querySelector('form[data-form=add-course] select')
    expect([...select.options].map((o) => o.value)).toEqual(['', 'K2']) // K1 is already in
    select.value = 'K2'
    submit(el.querySelector('form[data-form=add-course]'))
    await settle()
    expect(services.programs.addCourse).toHaveBeenCalledWith('P1', 'K2', 2)

    confirmDialog.mockResolvedValueOnce(false)
    el.querySelector('[data-action=remove-course][data-id=K1]').click()
    await settle()
    expect(services.programs.removeCourse).not.toHaveBeenCalled()
    confirmDialog.mockResolvedValueOnce(true)
    el.querySelector('[data-action=remove-course][data-id=K1]').click()
    await settle()
    expect(services.programs.removeCourse).toHaveBeenCalledWith('P1', 'K1')
    expect(confirmDialog.mock.calls.at(-1)[0].danger).toBe(true)
  })

  it('detail: a new cohort — a typing mistake is shown in the form and what was typed stays', async () => {
    const el = mount()
    const services = { programs: programsService() }
    await renderProgramDetailView(el, { services, caps: { canAdministerPrograms: true } }, { id: 'P1' })
    el.querySelector('[data-action=new-cohort]').click()
    const form = () => el.querySelector('form[data-form=cohort-new]')
    form().querySelector('[name=code]').value = 'C2'
    form().querySelector('[name=name]').value = 'รุ่น 2'
    form().querySelector('[name=enrollment_mode]').value = 'approval'
    form().querySelector('[name=seat_limit]').value = '0'
    submit(form())
    await settle()
    expect(form().textContent).toContain('จำนวนที่นั่ง')
    expect(form().querySelector('[name=name]').value).toBe('รุ่น 2')
    expect(form().querySelector('[name=enrollment_mode]').value).toBe('approval')
    expect(services.programs.createCohort).not.toHaveBeenCalled()
    form().querySelector('[name=seat_limit]').value = '25'
    submit(form())
    await settle()
    expect(services.programs.createCohort).toHaveBeenCalledWith(
      'P1',
      expect.objectContaining({ code: 'C2', enrollment_mode: 'approval', seat_limit: 25 })
    )
    expect(el.textContent).toContain('สร้างรุ่นแล้ว')
  })

  it('detail: someone who only takes part sees the programme but no editing', async () => {
    const el = mount()
    await renderProgramDetailView(
      el,
      { services: { programs: programsService() }, caps: { isActive: true } },
      { id: 'P1' }
    )
    expect(
      el.querySelector(
        '[data-action=edit-program], [data-action=new-cohort], [data-action=edit-cohort], form[data-form=add-course], [data-action=remove-course]'
      )
    ).toBeNull()
  })
})

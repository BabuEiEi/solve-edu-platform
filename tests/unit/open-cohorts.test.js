/**
 * Phase 4g step 4: the learner's page — cohorts open for joining, joining or
 * asking, taking a request back, and choosing courses once in the cohort.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('../../src/shared/ui/dialog.js', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }))
import { confirmDialog } from '../../src/shared/ui/dialog.js'
import { enrolledSet, joinAction, renderOpenCohortsView } from '../../src/features/programs/join.js'
import { NAV_ITEMS } from '../../src/shared/ui/layout.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
const cohort = (id, over = {}) => ({
  cohort_id: id,
  cohort_code: id,
  cohort_name: `รุ่น ${id}`,
  start_at: null,
  end_at: null,
  enrollment_mode: 'open',
  enroll_until: null,
  seats_left: 5,
  program_name: 'โครงการ',
  fiscal_year: 2570,
  owner_org: 'เขตสาธิต',
  courses: [
    { id: 'K1', title: 'หลักสูตร 1' },
    { id: 'K2', title: 'หลักสูตร 2' },
  ],
  my_status: null,
  ...over,
})

describe('logic', () => {
  it("what a card offers follows the person's own status, then seats, then the mode", () => {
    expect(joinAction(cohort('A', { my_status: 'active' }))).toBe('member')
    expect(joinAction(cohort('A', { my_status: 'requested' }))).toBe('waiting')
    expect(joinAction(cohort('A', { my_status: 'withdrawn' }))).toBe('again') // open cohort, but must ask again
    expect(joinAction(cohort('A', { seats_left: 0 }))).toBe('full')
    expect(joinAction(cohort('A', { seats_left: 0, my_status: 'withdrawn' }))).toBe('again') // asking needs no seat yet
    expect(joinAction(cohort('A'))).toBe('join')
    expect(joinAction(cohort('A', { enrollment_mode: 'approval' }))).toBe('request')
    expect(joinAction(cohort('A', { seats_left: null }))).toBe('join') // no limit
  })

  it('enrollments in force: a withdrawn one does not count', () => {
    const set = enrolledSet([
      { cohort_id: 'A', course_id: 'K1', status: 'active' },
      { cohort_id: 'A', course_id: 'K2', status: 'withdrawn' },
      { cohort_id: 'B', course_id: 'K1', status: 'completed' },
    ])
    expect([...set].sort()).toEqual(['A:K1', 'B:K1'])
  })

  it('the menu offers it to every active account and to nobody else', () => {
    const item = NAV_ITEMS.find((i) => i.path === '/join')
    expect(item.label).toBe('รุ่นที่เปิดรับสมัคร')
    expect(item.show({ isActive: true })).toBe(true)
    expect(item.show({ isActive: false })).toBe(false)
  })
})

describe('page', () => {
  afterEach(() => {
    document.body.replaceChildren()
    confirmDialog.mockReset()
  })
  const open = async ({ list = [cohort('A')], enrollments = [], over = {}, refresh = vi.fn() } = {}) => {
    const programs = {
      listOpenCohorts: vi.fn(async () => list),
      requestJoin: vi.fn(async () => 'active'),
      cancelRequest: vi.fn(async () => {}),
      enroll: vi.fn(async () => 'E1'),
      ...over,
    }
    const courses = { listMyEnrollments: vi.fn(async () => enrollments) }
    const el = document.createElement('div')
    document.body.append(el)
    await renderOpenCohortsView(el, {
      services: { programs, courses },
      session: { user: { id: 'me' } },
      refresh,
    })
    return { el, programs, courses, refresh }
  }

  it('lists cohorts and their courses as text; nothing about other people', async () => {
    const { el, courses } = await open({
      list: [
        cohort('A', {
          cohort_name: XSS,
          courses: [{ id: 'K1', title: XSS }],
          seats_left: 3,
          enroll_until: '2027-01-10T00:00:00Z',
        }),
      ],
    })
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain(XSS)
    expect(el.querySelector('[data-seats]').textContent).toContain('เหลือ 3 ที่นั่ง')
    expect(el.textContent).toContain('ปิดรับสมัคร')
    expect(el.querySelector('[data-action=enroll]')).toBeNull() // not a member: courses are shown, not offered
    expect(courses.listMyEnrollments).toHaveBeenCalledWith('me')
  })

  it('nothing open: said so', async () => {
    const { el } = await open({ list: [] })
    expect(el.textContent).toContain('ขณะนี้ยังไม่มีรุ่นที่เปิดรับสมัคร')
  })

  it('open cohort: asks first, then joins and reloads the account (the person is a trainee now)', async () => {
    const { el, programs, refresh } = await open()
    confirmDialog.mockResolvedValueOnce(false)
    el.querySelector('[data-action=join]').click()
    await settle()
    expect(programs.requestJoin).not.toHaveBeenCalled()
    confirmDialog.mockResolvedValueOnce(true)
    el.querySelector('[data-action=join]').click()
    await settle()
    expect(programs.requestJoin).toHaveBeenCalledWith('A')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('approval cohort: sends a request (no question), says it is waiting, and the request can be taken back', async () => {
    const list = [cohort('B', { enrollment_mode: 'approval' })]
    const { el, programs } = await open({
      list,
      over: {
        requestJoin: vi.fn(async () => {
          list[0] = cohort('B', { enrollment_mode: 'approval', my_status: 'requested' })
          return 'requested'
        }),
      },
    })
    el.querySelector('[data-action=request]').click()
    await settle()
    expect(programs.requestJoin).toHaveBeenCalledWith('B')
    expect(el.textContent).toContain('ส่งคำขอเข้ารุ่นแล้ว')
    expect(el.querySelector('[data-status=waiting]')).not.toBeNull()
    confirmDialog.mockResolvedValueOnce(true)
    el.querySelector('[data-action=cancel]').click()
    await settle()
    expect(programs.cancelRequest).toHaveBeenCalledWith('B')
  })

  it('a member chooses courses one by one; an enrolled course offers "เปิดเรียน"', async () => {
    const list = [cohort('A', { my_status: 'active' })]
    const enrollments = [{ cohort_id: 'A', course_id: 'K1', status: 'active' }]
    const { el, programs } = await open({ list, enrollments })
    expect(el.querySelector('[data-status=member]')).not.toBeNull()
    expect(el.querySelector('[data-course=K1] a[href="#/courses/K1"]')).not.toBeNull()
    expect(el.querySelector('[data-course=K1] [data-action=enroll]')).toBeNull()
    el.querySelector('[data-course=K2] [data-action=enroll]').click()
    await settle()
    expect(programs.enroll).toHaveBeenCalledWith('A', 'K2') // no user: the server takes the caller
    expect(el.textContent).toContain('ลงทะเบียนหลักสูตรแล้ว')
  })

  it('a refusal (full, closed, not a trainee) is shown in Thai, the list is reloaded, the page stays usable', async () => {
    const { el, programs } = await open({
      over: { requestJoin: vi.fn(async () => Promise.reject({ code: 'SE011' })) },
    })
    confirmDialog.mockResolvedValueOnce(true)
    el.querySelector('[data-action=join]').click()
    await settle()
    expect(el.textContent).toContain('รุ่นนี้มีผู้เข้าอบรมเต็มจำนวนแล้ว')
    expect(programs.listOpenCohorts).toHaveBeenCalledTimes(2) // reloaded
    expect(el.querySelector('[data-open-cohorts]')).not.toBeNull()
  })

  it('full cohort: no button; removed person: asks again even though the cohort is open', async () => {
    const { el } = await open({
      list: [cohort('F', { seats_left: 0 }), cohort('W', { my_status: 'withdrawn' })],
    })
    const full = el.querySelector('[data-cohort=F]')
    expect(full.querySelector('[data-status=full]')).not.toBeNull()
    expect(full.querySelector('[data-action=join], [data-action=request]')).toBeNull()
    const again = el.querySelector('[data-cohort=W]')
    expect(again.querySelector('[data-status=again]').textContent).toContain('ต้องรอผู้จัดการรุ่นอนุมัติใหม่')
    expect(again.querySelector('[data-action=request]')).not.toBeNull()
    expect(again.querySelector('[data-action=join]')).toBeNull()
  })
})

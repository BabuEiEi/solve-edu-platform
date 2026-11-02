import { describe, it, expect } from 'vitest'
import { render } from '../../src/shared/ui/html.js'
import { appShell } from '../../src/shared/ui/layout.js'
import { deriveCapabilities } from '../../src/core/permissions.js'
import { renderDashboard } from '../../src/features/dashboard.js'
import { renderProgramsView } from '../../src/features/programs/views.js'
import { renderCourseOutlineView } from '../../src/features/courses/views.js'
import { renderApprovalsView } from '../../src/features/admin/views.js'

const XSS = '<img src=x onerror=alert(1)>'
const context = {
  profile: {
    id: 'u1',
    full_name: XSS,
    display_name: null,
    status: 'active',
    updated_at: '2026-11-02T08:00:00Z',
  },
  platformRoles: [],
  orgMemberships: [{ org_role: 'school_admin', organizations: { name: 'โรงเรียนสาธิต ก' } }],
  cohortMemberships: [{ cohort_role: 'trainee', cohorts: { code: 'C1' } }],
}
const caps = deriveCapabilities(context)
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('views render (smoke + XSS)', () => {
  it('app shell shows only permitted menu items and escapes the user name', () => {
    const el = document.createElement('div')
    render(el, appShell({ profile: context.profile, caps, context, currentPath: '/' }))
    const labels = [...el.querySelectorAll('aside nav a')].map((a) => a.textContent.trim())
    expect(labels.some((l) => l.includes('อนุมัติผู้ใช้'))).toBe(true)
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('#view')).not.toBeNull()
  })

  it('dashboard renders role chips', () => {
    const el = document.createElement('div')
    renderDashboard(el, { context, caps })
    expect(el.textContent).toContain('ผู้บริหารสถานศึกษา')
    expect(el.textContent).toContain('ผู้เข้ารับการอบรม')
    expect(el.querySelector('img')).toBeNull()
  })

  it('programs view lists cohorts with Thai dates', async () => {
    const el = document.createElement('div')
    const services = {
      programs: {
        listVisiblePrograms: async () => [
          {
            id: 'p',
            code: 'AFL-2570',
            name: 'โครงการ',
            fiscal_year: 2570,
            status: 'active',
            organizations: { name: 'เขต' },
            cohorts: [
              {
                id: 'c',
                code: 'C1',
                name: 'รุ่น 1',
                status: 'open',
                start_at: '2026-11-15T00:00:00+07:00',
                end_at: null,
              },
            ],
          },
        ],
      },
    }
    await renderProgramsView(el, { services })
    expect(el.textContent).toContain('ปีงบประมาณ 2570')
    expect(el.textContent).toContain('15 พ.ย. 2569')
  })

  it('course outline shows progress for enrolled learner', async () => {
    const el = document.createElement('div')
    const course = {
      id: 'k',
      title: 'AfL',
      status: 'published',
      course_units: [
        {
          id: 'u',
          title: 'หน่วย 1',
          status: 'published',
          lessons: [
            { id: 'l1', title: 'บท 1', status: 'published' },
            { id: 'l2', title: 'บท 2', status: 'published' },
          ],
        },
      ],
    }
    const services = {
      courses: {
        getCourseOutline: async () => course,
        listMyEnrollments: async () => [
          { course_id: 'k', lesson_progress: [{ lesson_id: 'l1', status: 'completed' }] },
        ],
      },
    }
    await renderCourseOutlineView(el, { services, session: { user: { id: 'u1' } } }, { id: 'k' })
    expect(el.querySelector('[role=progressbar]').getAttribute('aria-valuenow')).toBe('50')
    expect(el.textContent).toContain('เรียนจบแล้ว')
  })

  it('approvals view lists scoped pending users and switches tabs', async () => {
    const el = document.createElement('div')
    const calls = []
    const services = {
      admin: {
        listProfilesByStatus: async (s) => {
          calls.push(s)
          return s === 'pending'
            ? [
                {
                  id: 'n',
                  full_name: XSS,
                  status: 'pending',
                  created_at: '2026-11-02T08:00:00Z',
                  organizations: { name: 'โรงเรียน ก' },
                },
              ]
            : []
        },
        setProfileStatus: async () => {},
      },
    }
    await renderApprovalsView(el, { services })
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(el.querySelector('tbody img')).toBeNull()
    el.querySelector('[data-action=tab][data-status=active]').click()
    await flush()
    await flush()
    expect(calls).toEqual(['pending', 'active'])
    expect(el.textContent).toContain('ไม่มีรายการ')
  })
})

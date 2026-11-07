import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNoticeService, NO_NOTICES } from '../../src/features/notices/service.js'
import { NAV_ITEMS, appShell, updateNavBadges } from '../../src/shared/ui/layout.js'
import { render } from '../../src/shared/ui/html.js'

describe('notice service', () => {
  it('returns the counts as numbers; any failure means no badge, never an error', async () => {
    const ok = createNoticeService({
      rpc: vi.fn(async () => ({ data: { unread_results: '2', revise: 1, waiting: 0 }, error: null })),
    })
    expect(await ok.counts()).toEqual({ unread_results: 2, revise: 1, waiting: 0 })
    expect(
      await createNoticeService({ rpc: async () => ({ data: null, error: { code: '42501' } }) }).counts()
    ).toEqual(NO_NOTICES)
    expect(
      await createNoticeService({
        rpc: async () => {
          throw new Error('network')
        },
      }).counts()
    ).toEqual(NO_NOTICES)
  })
})

describe('menu badges', () => {
  afterEach(() => document.body.replaceChildren())
  const caps = { isActive: true, isTrainee: true, isTrainer: true, orgRoles: [], cohortRoles: [] }
  const context = { platformRoles: [] }
  const show = (notices) => {
    render(
      document.body,
      appShell({ profile: { full_name: 'ครู' }, caps, context, currentPath: '/', notices })
    )
  }

  it('the trainee badge adds unread results and tasks to revise; the reviewer badge is the waiting count; both hide at 0', () => {
    show({ unread_results: 2, revise: 1, waiting: 4 })
    const tasks = document.querySelectorAll('[data-nav-badge="/tasks"]')
    const review = document.querySelectorAll('[data-nav-badge="/staff/tasks"]')
    expect(tasks).toHaveLength(2) // desktop and phone menus
    expect([...tasks].every((b) => b.textContent === '3' && !b.hidden)).toBe(true)
    expect([...review].every((b) => b.textContent === '4' && !b.hidden)).toBe(true)
    expect(tasks[0].getAttribute('aria-label')).toBe('มีผลตรวจใหม่หรืองานที่ต้องแก้ไข: 3')
    show({ unread_results: 0, revise: 0, waiting: 0 })
    expect([...document.querySelectorAll('[data-nav-badge]')].every((b) => b.hidden)).toBe(true)
    show()
    expect([...document.querySelectorAll('[data-nav-badge]')].every((b) => b.hidden)).toBe(true) // no notices given
  })

  it('updateNavBadges changes the numbers already on screen', () => {
    show({ unread_results: 2, revise: 0, waiting: 0 })
    updateNavBadges({ unread_results: 0, revise: 0, waiting: 5 })
    expect([...document.querySelectorAll('[data-nav-badge="/tasks"]')].every((b) => b.hidden)).toBe(true)
    expect(
      [...document.querySelectorAll('[data-nav-badge="/staff/tasks"]')].every(
        (b) => b.textContent === '5' && !b.hidden
      )
    ).toBe(true)
  })

  it('only the two task entries carry a badge', () => {
    expect(NAV_ITEMS.filter((i) => i.badge).map((i) => i.path)).toEqual(['/tasks', '/staff/tasks'])
  })
})

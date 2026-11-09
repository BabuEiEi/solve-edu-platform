import { describe, it, expect } from 'vitest'
import { compileRoutes, createNavigationGuard, matchRoute, resolveRoute } from '../../src/core/router.js'

const routes = compileRoutes([
  { path: '/', view: 'home' },
  { path: '/courses/:id', view: 'course' },
  { path: '/admin/approvals', view: 'approvals', allow: (c) => c.canApproveUsers },
])

describe('router', () => {
  it('matches params and decodes them', () => {
    const hit = matchRoute(routes, '#/courses/abc%20d')
    expect(hit.route.view).toBe('course')
    expect(hit.params).toEqual({ id: 'abc d' })
  })
  it('treats empty hash as /', () => {
    expect(matchRoute(routes, '').route.view).toBe('home')
  })
  it('falls back when guard fails or route unknown', () => {
    expect(resolveRoute(routes, '#/admin/approvals', { canApproveUsers: false }).route.view).toBe('home')
    expect(resolveRoute(routes, '#/admin/approvals', { canApproveUsers: true }).route.view).toBe('approvals')
    expect(resolveRoute(routes, '#/nope', {}).route.view).toBe('home')
  })
})

describe('navigation guard (only the latest page draws)', () => {
  it('an earlier navigation that finishes last is no longer current', async () => {
    const nav = createNavigationGuard()
    const screen = []
    const route = async (name, delay) => {
      const ticket = nav.begin()
      await new Promise((r) => setTimeout(r, delay)) // e.g. the menu badges loading
      if (nav.isCurrent(ticket)) screen.push(name)
    }
    await Promise.all([route('courses', 30), route('lesson', 5)]) // courses started first, ends last
    expect(screen).toEqual(['lesson'])
  })
  it('a single navigation draws', () => {
    const nav = createNavigationGuard()
    expect(nav.isCurrent(nav.begin())).toBe(true)
  })
})

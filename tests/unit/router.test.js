import { describe, it, expect } from 'vitest'
import { compileRoutes, matchRoute, resolveRoute } from '../../src/core/router.js'

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

import { describe, it, expect, vi } from 'vitest'
import { createProfileService, PROFILE_COLUMNS } from '../../src/features/profiles/service.js'
import { createAdminService } from '../../src/features/admin/service.js'
import { computeCourseCompletion } from '../../src/features/courses/service.js'

/** Chainable fake of the PostgREST query builder that records calls. */
function fakeClient(result = { data: null, error: null }) {
  const calls = []
  const builder = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => resolve(result)
        return (...args) => {
          calls.push([prop, ...args])
          return builder
        }
      },
    }
  )
  return {
    calls,
    from: vi.fn((table) => {
      calls.push(['from', table])
      return builder
    }),
    rpc: vi.fn(async (fn, args) => {
      calls.push(['rpc', fn, args])
      return result
    }),
  }
}

describe('profile service', () => {
  it('never selects * or contact_email from profiles', async () => {
    const c = fakeClient({ data: { id: 'u1', status: 'active' }, error: null })
    await createProfileService(c).getMyContext('u1')
    const selects = c.calls.filter(([op]) => op === 'select').map(([, cols]) => cols)
    expect(selects).toContain(PROFILE_COLUMNS)
    for (const s of selects) {
      expect(s).not.toBe('*')
      expect(s).not.toMatch(/contact_email/)
    }
  })
  it('only sends editable fields on update (no status/role)', async () => {
    const c = fakeClient({ data: {}, error: null })
    await createProfileService(c).updateMyProfile('u1', {
      full_name: '  ครู ทดสอบ ',
      display_name: '',
      status: 'active',
    })
    const update = c.calls.find(([op]) => op === 'update')[1]
    expect(update).toEqual({ full_name: 'ครู ทดสอบ', display_name: null })
  })
})

describe('admin service', () => {
  it('calls the trusted RPC with named parameters', async () => {
    const c = fakeClient({ data: null, error: null })
    await createAdminService(c).setProfileStatus('t1', 'active')
    expect(c.rpc).toHaveBeenCalledWith('admin_set_profile_status', {
      p_target: 't1',
      p_status: 'active',
      p_reason: null,
    })
  })
  it('requires a reason to suspend and rejects unknown status before calling the server', async () => {
    const c = fakeClient()
    const s = createAdminService(c)
    await expect(s.setProfileStatus('t1', 'suspended', '  ')).rejects.toThrow('เหตุผล')
    await expect(s.setProfileStatus('t1', 'admin')).rejects.toThrow()
    expect(c.rpc).not.toHaveBeenCalled()
  })
  it('surfaces a server-side permission denial as an error (not silent success)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = fakeClient({ data: null, error: { code: '42501', message: 'not allowed' } })
    await expect(createAdminService(c).setProfileStatus('t1', 'active')).rejects.toThrow('ไม่มีสิทธิ์')
    spy.mockRestore()
  })
})

describe('computeCourseCompletion', () => {
  const course = {
    course_units: [
      {
        lessons: [
          { id: 'l1', status: 'published' },
          { id: 'l2', status: 'published' },
        ],
      },
      {
        lessons: [
          { id: 'l3', status: 'published', required: false },
          { id: 'l4', status: 'draft' },
        ],
      },
    ],
  }
  it('counts only published, required lessons', () => {
    expect(computeCourseCompletion(course, [{ lesson_id: 'l1', status: 'completed' }])).toBe(50)
    expect(computeCourseCompletion(course, [{ lesson_id: 'l3', status: 'completed' }])).toBe(0)
  })
  it('ignores in-progress rows and handles empty courses', () => {
    expect(computeCourseCompletion(course, [{ lesson_id: 'l1', status: 'in_progress' }])).toBe(0)
    expect(computeCourseCompletion({ course_units: [] }, [])).toBe(0)
  })
})

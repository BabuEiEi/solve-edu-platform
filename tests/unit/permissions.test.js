import { describe, it, expect } from 'vitest'
import { deriveCapabilities } from '../../src/core/permissions.js'

const ctx = (over = {}) => ({
  profile: { status: 'active' },
  platformRoles: [],
  orgMemberships: [],
  cohortMemberships: [],
  ...over,
})

describe('deriveCapabilities (UI only)', () => {
  it('pending users get no active capabilities even with roles', () => {
    const c = deriveCapabilities(
      ctx({
        profile: { status: 'pending' },
        platformRoles: [{ role: 'platform_admin' }],
        orgMemberships: [{ org_role: 'district_admin' }],
      })
    )
    expect(c.isPending).toBe(true)
    expect(c.isPlatformAdmin).toBe(false)
    expect(c.canApproveUsers).toBe(false)
  })
  it('school admin can approve users but not manage programs', () => {
    const c = deriveCapabilities(ctx({ orgMemberships: [{ org_role: 'school_admin' }] }))
    expect(c.canApproveUsers).toBe(true)
    expect(c.canManagePrograms).toBe(false)
  })
  it('supervisor manages programs but does not approve users', () => {
    const c = deriveCapabilities(ctx({ orgMemberships: [{ org_role: 'supervisor' }] }))
    expect(c.canManagePrograms).toBe(true)
    expect(c.canApproveUsers).toBe(false)
  })
  it('one person may hold several cohort roles', () => {
    const c = deriveCapabilities(
      ctx({ cohortMemberships: [{ cohort_role: 'trainer' }, { cohort_role: 'mentor' }] })
    )
    expect(c.isTrainer && c.isMentor).toBe(true)
    expect(c.isTrainee).toBe(false)
  })
  it('handles missing context safely', () => {
    expect(deriveCapabilities(null).isActive).toBe(false)
  })
})

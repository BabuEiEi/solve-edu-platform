/**
 * UI capability flags derived from the caller's own memberships.
 *
 * IMPORTANT: these flags only decide what to SHOW. Every read/write is still
 * enforced by Postgres RLS / trusted RPCs. Hiding a menu is not security.
 */
export const ORG_ADMIN_ROLES = ['district_admin', 'school_admin']
export const PROGRAM_MANAGER_ROLES = ['district_admin', 'supervisor']

export function deriveCapabilities(context) {
  const profile = context?.profile ?? null
  const platformRoles = context?.platformRoles ?? []
  const orgMemberships = context?.orgMemberships ?? []
  const cohortMemberships = context?.cohortMemberships ?? []
  const active = profile?.status === 'active'

  const orgRoles = new Set(orgMemberships.map((m) => m.org_role))
  const cohortRoles = new Set(cohortMemberships.map((m) => m.cohort_role))
  const isPlatformAdmin = active && platformRoles.some((r) => r.role === 'platform_admin')

  return {
    isActive: active,
    isPending: profile?.status === 'pending',
    isSuspended: profile?.status === 'suspended',
    isPlatformAdmin,
    canApproveUsers: active && (isPlatformAdmin || ORG_ADMIN_ROLES.some((r) => orgRoles.has(r))),
    canManagePrograms: active && (isPlatformAdmin || PROGRAM_MANAGER_ROLES.some((r) => orgRoles.has(r))),
    isTrainee: active && cohortRoles.has('trainee'),
    isTrainer: active && cohortRoles.has('trainer'),
    isMentor: active && cohortRoles.has('mentor'),
    isCoordinator: active && cohortRoles.has('coordinator'),
    orgRoles: [...orgRoles],
    cohortRoles: [...cohortRoles],
  }
}

export const ROLE_LABELS = {
  platform_admin: 'ผู้ดูแลระบบ',
  platform_support: 'ผู้สนับสนุนระบบ',
  district_admin: 'ผู้ดูแลเขตพื้นที่',
  supervisor: 'ศึกษานิเทศก์',
  school_admin: 'ผู้บริหารสถานศึกษา',
  teacher: 'ครู',
  trainee: 'ผู้เข้ารับการอบรม',
  trainer: 'วิทยากร',
  mentor: 'ครูพี่เลี้ยง/ผู้นิเทศ',
  coordinator: 'ผู้ประสานงานรุ่น',
}

export const STATUS_LABELS = {
  pending: 'รออนุมัติ',
  active: 'ใช้งานได้',
  suspended: 'ระงับการใช้งาน',
  draft: 'ฉบับร่าง',
  published: 'เผยแพร่',
  archived: 'เก็บถาวร',
}

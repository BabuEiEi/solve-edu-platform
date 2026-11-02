import { unwrap, AppError } from '../../core/errors.js'

const ALLOWED_STATUS = ['pending', 'active', 'suspended']

export function createAdminService(client) {
  return {
    /**
     * RLS returns only people inside the caller's administrative scope.
     * Current memberships are embedded (RLS on organization_memberships also
     * limits them to orgs the caller governs); ended memberships are filtered out.
     */
    async listProfilesByStatus(status = 'pending') {
      return unwrap(
        await client
          .from('profiles')
          .select(
            'id, full_name, display_name, status, created_at, requested_org_id, organizations!profiles_requested_org_fk ( name ), ' +
              'organization_memberships!organization_memberships_user_id_fkey ( id, org_role, ended_at, organizations ( name ) )'
          )
          .eq('status', status)
          .is('organization_memberships.ended_at', null)
          .order('created_at', { ascending: true }),
        'profiles.by_status'
      )
    },

    /** Trusted RPC: authorization, scope and audit are enforced in the database. */
    async setProfileStatus(targetId, status, reason) {
      if (!ALLOWED_STATUS.includes(status)) throw new AppError('สถานะไม่ถูกต้อง')
      const r = String(reason ?? '').trim()
      if (status === 'suspended' && !r) throw new AppError('กรุณาระบุเหตุผลในการระงับการใช้งาน')
      unwrap(
        await client.rpc('admin_set_profile_status', {
          p_target: targetId,
          p_status: status,
          p_reason: r || null,
        }),
        'rpc.admin_set_profile_status'
      )
    },
  }
}

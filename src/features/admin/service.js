import { unwrap, AppError } from '../../core/errors.js'

const ALLOWED_STATUS = ['pending', 'active', 'suspended']

export function createAdminService(client) {
  return {
    /** RLS returns only people inside the caller's administrative scope. */
    async listProfilesByStatus(status = 'pending') {
      return unwrap(
        await client
          .from('profiles')
          .select(
            'id, full_name, display_name, status, created_at, requested_org_id, organizations!profiles_requested_org_fk ( name )'
          )
          .eq('status', status)
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

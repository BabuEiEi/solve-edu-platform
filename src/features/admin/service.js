import { unwrap, AppError } from '../../core/errors.js'

export const ACCOUNTS_PAGE_SIZE = 50
const DELETE_ERRORS = {
  forbidden: 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบบัญชีได้ (และลบบัญชีของตนเองหรือผู้มีบทบาทระดับระบบไม่ได้)',
  confirm_mismatch: 'อีเมลที่พิมพ์ไม่ตรงกับอีเมลของบัญชีนี้',
  not_found: 'ไม่พบบัญชีนี้ อาจถูกลบไปแล้ว — โหลดหน้าใหม่',
  sign_in_not_removed: 'ลบข้อมูลส่วนตัวแล้ว แต่ปิดการเข้าสู่ระบบไม่สำเร็จ — กด "ลบบัญชี" อีกครั้ง',
  unauthorized: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
}
const DELETE_FALLBACK = 'ติดต่อบริการลบบัญชีไม่สำเร็จ กรุณาลองใหม่'

async function functionErrorCode(error) {
  try {
    const body = await error?.context?.json?.()
    return typeof body?.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

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

    /** Accounts the caller administers, searched and paged on the server. */
    async listAccounts({ search = '', status = '', page = 0 } = {}) {
      return unwrap(
        await client.rpc('admin_list_accounts', {
          p_search: String(search).trim() || null,
          p_status: status || null,
          p_limit: ACCOUNTS_PAGE_SIZE,
          p_offset: Math.max(0, page) * ACCOUNTS_PAGE_SIZE,
        }),
        'rpc.admin_list_accounts'
      )
    },

    /** Name, display name, personal code (blank clears). Scope and audit in the database. */
    async updateAccount(targetId, { full_name, display_name, user_code }) {
      const name = String(full_name ?? '').trim()
      if (!name) throw new AppError('กรุณากรอกชื่อ-นามสกุล')
      const code = String(user_code ?? '').trim()
      if (code && !/^[0-9A-Za-zก-๙._-]{1,50}$/.test(code))
        throw new AppError(
          'รหัสประจำตัวใช้ได้เฉพาะตัวอักษร ตัวเลข จุด ขีดล่าง และขีดกลาง ไม่เกิน 50 ตัว (ไม่เว้นวรรค)'
        )
      const { data, error } = await client.rpc('admin_update_profile', {
        p_target: targetId,
        p_full_name: name,
        p_display_name: String(display_name ?? '').trim() || null,
        p_user_code: code || null,
      })
      if (error?.code === '23505')
        throw new AppError('รหัสประจำตัวนี้มีผู้ใช้แล้ว', { code: '23505', cause: error })
      return unwrap({ data, error }, 'rpc.admin_update_profile')
    },

    /** Platform admin only: through the Edge Function (database first, then the sign-in). */
    async deleteAccount(targetId, confirmEmail) {
      const { data, error } = await client.functions.invoke('delete-account', {
        body: { user_id: targetId, confirm_email: String(confirmEmail ?? '').trim() },
      })
      if (error) {
        const code = await functionErrorCode(error)
        throw new AppError(DELETE_ERRORS[code] ?? DELETE_FALLBACK, { code, cause: error })
      }
      return data
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

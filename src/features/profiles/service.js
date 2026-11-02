import { unwrap } from '../../core/errors.js'

/** Explicit column list — contact_email is intentionally NOT selectable (see PERMISSIONS.md). */
export const PROFILE_COLUMNS =
  'id, full_name, display_name, avatar_path, requested_org_id, status, created_at, updated_at'

export function createProfileService(client) {
  return {
    /** Everything the UI needs about the signed-in user, in one round of parallel queries. */
    async getMyContext(userId) {
      const [profile, platformRoles, orgMemberships, cohortMemberships] = await Promise.all([
        client.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle(),
        client
          .from('platform_role_assignments')
          .select('id, role, granted_at')
          .eq('user_id', userId)
          .is('revoked_at', null),
        client
          .from('organization_memberships')
          .select('id, org_role, organization_id, started_at, organizations ( id, code, name, org_type )')
          .eq('user_id', userId)
          .is('ended_at', null),
        client
          .from('cohort_memberships')
          .select('id, cohort_role, status, cohort_id, cohorts ( id, code, name, status, program_id )')
          .eq('user_id', userId)
          .eq('status', 'active'),
      ])
      return {
        profile: unwrap(profile, 'profiles.me'),
        platformRoles: unwrap(platformRoles, 'platform_roles.me') ?? [],
        orgMemberships: unwrap(orgMemberships, 'org_memberships.me') ?? [],
        cohortMemberships: unwrap(cohortMemberships, 'cohort_memberships.me') ?? [],
      }
    },

    async updateMyProfile(userId, { full_name, display_name }) {
      const patch = {
        full_name: String(full_name ?? '')
          .trim()
          .slice(0, 200),
        display_name: display_name ? String(display_name).trim().slice(0, 100) : null,
      }
      return unwrap(
        await client.from('profiles').update(patch).eq('id', userId).select(PROFILE_COLUMNS).single(),
        'profiles.update'
      )
    },

    async setRequestedOrganization(userId, organizationId) {
      return unwrap(
        await client
          .from('profiles')
          .update({ requested_org_id: organizationId || null })
          .eq('id', userId)
          .select(PROFILE_COLUMNS)
          .single(),
        'profiles.requested_org'
      )
    },

    async getContactEmail(userId) {
      return unwrap(await client.rpc('get_profile_contact', { p_target: userId }), 'rpc.get_profile_contact')
    },
  }
}

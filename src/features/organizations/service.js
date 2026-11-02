import { unwrap } from '../../core/errors.js'

export function createOrganizationService(client) {
  return {
    async listActiveOrganizations({ orgType } = {}) {
      let q = client.from('organizations').select('id, code, name, org_type, parent_id').eq('active', true)
      if (orgType) q = q.eq('org_type', orgType)
      return unwrap(await q.order('name'), 'organizations.list')
    },
  }
}

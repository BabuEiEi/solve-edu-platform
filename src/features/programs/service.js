import { unwrap } from '../../core/errors.js'

export function createProgramService(client) {
  return {
    async listVisiblePrograms() {
      return unwrap(
        await client
          .from('programs')
          .select(
            'id, code, name, description, fiscal_year, status, start_at, end_at, organizations ( name ), cohorts ( id, code, name, status, start_at, end_at )'
          )
          .order('fiscal_year', { ascending: false })
          .order('name'),
        'programs.list'
      )
    },
  }
}

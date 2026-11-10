import { unwrap, AppError } from '../../core/errors.js'

const COHORT_COLUMNS =
  'id, program_id, code, name, status, start_at, end_at, enrollment_mode, seat_limit, enroll_from, enroll_until'
const PROGRAM_COLUMNS =
  'id, code, name, description, fiscal_year, status, start_at, end_at, owner_org_id, organizations ( name )'

/** Programmes and cohorts. RLS decides every row; inserts/updates return the row so a refusal is visible. */
export function createProgramService(client) {
  const one = async (query, context) => {
    const row = unwrap(await query, context)
    if (!row) throw new AppError('ไม่พบข้อมูล หรือท่านไม่มีสิทธิ์แก้ไข')
    return row
  }
  return {
    async listVisiblePrograms() {
      return unwrap(
        await client
          .from('programs')
          .select(`${PROGRAM_COLUMNS}, cohorts ( ${COHORT_COLUMNS} )`)
          .order('fiscal_year', { ascending: false })
          .order('name'),
        'programs.list'
      )
    },

    /** One programme with its cohorts and courses; null when not visible. */
    async getProgram(id) {
      return unwrap(
        await client
          .from('programs')
          .select(
            `${PROGRAM_COLUMNS}, cohorts ( ${COHORT_COLUMNS} ), program_courses ( course_id, display_order, courses ( id, code, title, status ) )`
          )
          .eq('id', id)
          .maybeSingle(),
        'programs.get'
      )
    },

    async createProgram(payload) {
      return one(client.from('programs').insert(payload).select('id').single(), 'programs.create')
    },

    async updateProgram(id, payload) {
      return one(
        client.from('programs').update(payload).eq('id', id).select('id').maybeSingle(),
        'programs.update'
      )
    },

    /** Courses the caller may put in a programme (published ones, plus drafts they manage — RLS). */
    async listCourses() {
      return unwrap(
        await client
          .from('courses')
          .select('id, code, title, status')
          .neq('status', 'archived')
          .order('title'),
        'programs.courses'
      )
    },

    async addCourse(programId, courseId, displayOrder) {
      return one(
        client
          .from('program_courses')
          .insert({ program_id: programId, course_id: courseId, display_order: displayOrder })
          .select('course_id')
          .single(),
        'programs.add_course'
      )
    },

    async removeCourse(programId, courseId) {
      return one(
        client
          .from('program_courses')
          .delete()
          .eq('program_id', programId)
          .eq('course_id', courseId)
          .select('course_id')
          .maybeSingle(),
        'programs.remove_course'
      )
    },

    async createCohort(programId, payload) {
      return one(
        client
          .from('cohorts')
          .insert({ program_id: programId, ...payload })
          .select('id')
          .single(),
        'cohorts.create'
      )
    },

    async updateCohort(id, payload) {
      return one(
        client.from('cohorts').update(payload).eq('id', id).select('id').maybeSingle(),
        'cohorts.update'
      )
    },
  }
}

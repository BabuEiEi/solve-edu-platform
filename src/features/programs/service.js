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

    /**
     * One cohort with its programme's courses, its members (any status) and its
     * enrollments — what the members page shows. RLS decides every row: a
     * cohort's own staff and programme managers (and Staff) see them all.
     */
    async getCohortRoster(cohortId) {
      const cohort = unwrap(
        await client
          .from('cohorts')
          .select(
            `${COHORT_COLUMNS}, programs ( id, code, name, status, program_courses ( course_id, display_order, courses ( id, title, status ) ) )`
          )
          .eq('id', cohortId)
          .maybeSingle(),
        'cohorts.get'
      )
      if (!cohort) return null
      const [members, enrollments] = await Promise.all([
        client
          .from('cohort_memberships')
          .select(
            'id, user_id, cohort_role, status, created_at, profiles!cohort_memberships_user_id_fkey ( id, full_name, display_name, user_code )'
          )
          .eq('cohort_id', cohortId)
          .order('created_at'),
        client.from('course_enrollments').select('id, user_id, course_id, status').eq('cohort_id', cohortId),
      ])
      return {
        cohort,
        members: unwrap(members, 'cohorts.members') ?? [],
        enrollments: unwrap(enrollments, 'cohorts.enrollments') ?? [],
      }
    },

    /**
     * People to add. Account managers (platform admin, Staff, district admin) search
     * names, codes AND e-mails through admin_list_accounts; others search the
     * names and codes of the profiles they can see.
     */
    async searchPeople(query, { withEmail = false } = {}) {
      const q = String(query ?? '')
        .replace(/[,()*%"\\]/g, ' ') // characters with a meaning in a PostgREST filter
        .trim()
        .slice(0, 100)
      if (q.length < 2) throw new AppError('พิมพ์อย่างน้อย 2 ตัวอักษร')
      if (withEmail) {
        const res = unwrap(
          await client.rpc('admin_list_accounts', {
            p_search: q,
            p_status: 'active',
            p_limit: 20,
            p_offset: 0,
          }),
          'people.search_accounts'
        )
        return (res?.rows ?? []).map((r) => ({
          id: r.id,
          full_name: r.full_name,
          display_name: r.display_name,
          user_code: r.user_code,
          email: r.email,
        }))
      }
      return unwrap(
        await client
          .from('profiles')
          .select('id, full_name, display_name, user_code')
          .eq('status', 'active')
          .or(`full_name.ilike.*${q}*,display_name.ilike.*${q}*,user_code.ilike.*${q}*`)
          .order('full_name')
          .limit(20),
        'people.search'
      )
    },

    /** Add someone with a role (or bring back a withdrawn one). The cohort's managers and Staff only (RLS). */
    async addMember(cohortId, userId, role) {
      const existing = unwrap(
        await client
          .from('cohort_memberships')
          .select('id, status')
          .eq('cohort_id', cohortId)
          .eq('user_id', userId)
          .eq('cohort_role', role)
          .maybeSingle(),
        'cohorts.member_find'
      )
      if (existing?.status === 'active') return existing
      if (existing) return this.setMemberStatus(existing.id, 'active')
      return one(
        client
          .from('cohort_memberships')
          .insert({ cohort_id: cohortId, user_id: userId, cohort_role: role, status: 'active' })
          .select('id, status')
          .single(),
        'cohorts.member_add'
      )
    },

    /** 'withdrawn' takes someone out (history kept); 'active' brings them back. */
    async setMemberStatus(membershipId, status) {
      return one(
        client
          .from('cohort_memberships')
          .update({ status })
          .eq('id', membershipId)
          .select('id, status')
          .maybeSingle(),
        'cohorts.member_status'
      )
    },

    /** A self-join request: accept (seats checked by the server) or decline. */
    async decideRequest(membershipId, accept) {
      return unwrap(
        await client.rpc('decide_cohort_request', { p_membership: membershipId, p_accept: Boolean(accept) }),
        'cohorts.decide'
      )
    },

    /** Enroll a trainee of the cohort in one course of its programme (the server checks both). */
    async enroll(cohortId, courseId, userId = null) {
      return unwrap(
        await client.rpc('enroll_in_course', { p_cohort: cohortId, p_course: courseId, p_user: userId }),
        'cohorts.enroll'
      )
    },

    /** Take an enrollment back (status 'withdrawn'; progress kept). */
    async withdrawEnrollment(enrollmentId) {
      return one(
        client
          .from('course_enrollments')
          .update({ status: 'withdrawn' })
          .eq('id', enrollmentId)
          .select('id, status')
          .maybeSingle(),
        'cohorts.withdraw_enrollment'
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

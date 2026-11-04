import { unwrap, AppError } from '../../core/errors.js'
import { ASSIGNMENT_COLUMNS, ATTEMPT_COLUMNS } from '../assessments/service.js'
import { personName } from './logic.js'

const WITH_CONTEXT = `${ASSIGNMENT_COLUMNS}, created_at, cohorts ( id, code, name ), courses ( id, title ),
  instrument_versions ( id, version_no, instruments ( id, code, title, course_id ) )`

/**
 * Staff side of assessments: assign a published version to a cohort, adjust
 * the settings, and read the cohort's results. RLS decides every row:
 * assessors (program managers, coordinators, trainers) see the whole cohort,
 * a mentor only their mentees.
 */
export function createAssignmentService(client) {
  const one = async (query, context) => {
    const rows = unwrap(await query, context)
    if (!rows || rows.length === 0)
      throw new AppError('ไม่พบข้อมูล หรือท่านไม่มีสิทธิ์แก้ไข', { code: '42501' })
    return rows[0]
  }

  return {
    /** Cohorts of the programs that include the course (only those the caller can see). */
    async listCohortsForCourse(courseId) {
      const rows =
        unwrap(
          await client
            .from('program_courses')
            .select('programs ( id, name, cohorts ( id, code, name, status ) )')
            .eq('course_id', courseId),
          'assignments.cohorts'
        ) ?? []
      const seen = new Map()
      for (const r of rows) {
        for (const c of r.programs?.cohorts ?? []) seen.set(c.id, { ...c, program_name: r.programs.name })
      }
      return [...seen.values()]
    },

    /** The version being assigned, with its instrument (RLS: authors and cohort staff). */
    async getVersion(versionId) {
      return unwrap(
        await client
          .from('instrument_versions')
          .select('id, version_no, status, instruments ( id, code, title, course_id )')
          .eq('id', versionId)
          .maybeSingle(),
        'assignments.version'
      )
    },

    async listForVersions(versionIds) {
      if (!versionIds?.length) return []
      return (
        unwrap(
          await client
            .from('assessment_assignments')
            .select(WITH_CONTEXT)
            .in('instrument_version_id', versionIds)
            .order('created_at', { ascending: true }),
          'assignments.for_versions'
        ) ?? []
      )
    },

    /** Every assignment the caller can see (the view drops trainee-only cohorts). */
    async listVisible() {
      return (
        unwrap(
          await client
            .from('assessment_assignments')
            .select(WITH_CONTEXT)
            .order('created_at', { ascending: false }),
          'assignments.list'
        ) ?? []
      )
    },

    async get(assignmentId) {
      return unwrap(
        await client.from('assessment_assignments').select(WITH_CONTEXT).eq('id', assignmentId).maybeSingle(),
        'assignments.get'
      )
    },

    async create({ versionId, cohortId, courseId, status = 'draft', ...fields }) {
      return unwrap(
        await client
          .from('assessment_assignments')
          .insert({
            ...fields,
            instrument_version_id: versionId,
            cohort_id: cohortId,
            course_id: courseId ?? null,
            status,
          })
          .select('id')
          .single(),
        'assignments.create'
      )
    },

    async update(assignmentId, patch) {
      return one(
        client.from('assessment_assignments').update(patch).eq('id', assignmentId).select('id'),
        'assignments.update'
      )
    },

    async remove(assignmentId) {
      return one(
        client.from('assessment_assignments').delete().eq('id', assignmentId).select('id'),
        'assignments.delete'
      )
    },

    /** Extra attempts granted on this assignment (RLS: assessors all, mentor/trainee their own scope). */
    async listExtraAttempts(assignmentId) {
      return (
        unwrap(
          await client
            .from('assessment_extra_attempts')
            .select('id, user_id, reason, created_at')
            .eq('assignment_id', assignmentId),
          'assignments.extras'
        ) ?? []
      )
    },

    /** +1 attempt for one trainee; granted_by and the time are recorded by the server. */
    async grantExtraAttempt(assignmentId, userId, reason) {
      unwrap(
        await client.from('assessment_extra_attempts').insert({
          assignment_id: assignmentId,
          user_id: userId,
          reason: String(reason ?? '').trim() || null,
        }),
        'assignments.grant_extra'
      )
    },

    /** Attempts the caller may see, with the person's name. Never per-item scores. */
    async listAttempts(assignmentId) {
      return (
        unwrap(
          await client
            .from('assessment_attempts')
            .select(`${ATTEMPT_COLUMNS}, user_id, profiles ( full_name, display_name )`)
            .eq('assignment_id', assignmentId)
            .order('started_at', { ascending: true }),
          'assignments.attempts'
        ) ?? []
      )
    },

    /**
     * Who should have taken the test: the cohort's active trainees (visible to
     * assessors) plus the caller's own mentees (all a mentor can see).
     */
    async listRoster(cohortId, userId) {
      const [members, mentees] = await Promise.all([
        client
          .from('cohort_memberships')
          .select('user_id, profiles!cohort_memberships_user_id_fkey ( full_name, display_name )')
          .eq('cohort_id', cohortId)
          .eq('cohort_role', 'trainee')
          .eq('status', 'active'),
        client
          .from('mentor_assignments')
          .select('trainee_id, profiles!mentor_assignments_trainee_id_fkey ( full_name, display_name )')
          .eq('cohort_id', cohortId)
          .eq('mentor_id', userId)
          .is('ended_at', null),
      ])
      const people = new Map()
      for (const m of unwrap(members, 'assignments.roster') ?? [])
        people.set(m.user_id, { user_id: m.user_id, name: personName(m.profiles) })
      for (const m of unwrap(mentees, 'assignments.mentees') ?? [])
        people.set(m.trainee_id, { user_id: m.trainee_id, name: personName(m.profiles) })
      return [...people.values()]
    },
  }
}

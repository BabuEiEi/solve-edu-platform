import { unwrap, AppError } from '../../core/errors.js'
import { ASSIGNMENT_COLUMNS, ATTEMPT_COLUMNS } from '../assessments/service.js'

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
          .select('id, version_no, status, instruments ( id, code, title, course_id, status )')
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

    /** One row per person (assignment_results — the caller's RLS decides who). */
    async results(assignmentId) {
      return (
        unwrap(
          await client.rpc('assignment_results', { p_assignment: assignmentId }),
          'assignments.results'
        ) ?? []
      )
    },

    /** Aggregated item analysis for cohort assessors (item_statistics); never per person, never the key. */
    async itemStatistics(assignmentId) {
      return unwrap(
        await client.rpc('item_statistics', { p_assignment: assignmentId }),
        'assignments.item_stats'
      )
    },
  }
}

import { unwrap } from '../../core/errors.js'

export const ASSIGNMENT_COLUMNS =
  'id, title, purpose, instructions, open_at, close_at, attempt_limit, passing_percent, time_limit_minutes, grace_minutes, status, course_id, cohort_id, instrument_version_id'
export const ATTEMPT_COLUMNS =
  'id, assignment_id, attempt_no, status, started_at, submitted_at, score, max_score, passed, correct_count, item_count, auto_submitted'
// No answer key exists in these columns (keys live in schema private).
export const ITEM_COLUMNS = 'id, item_type, prompt, media_path, options_json, max_score, display_order'

const withMyAttempts = `${ASSIGNMENT_COLUMNS}, courses ( id, title ), assessment_attempts ( ${ATTEMPT_COLUMNS} ), assessment_extra_attempts ( id )`

export function createAssessmentService(client) {
  return {
    /** Published assignments of the given cohorts, with only the caller's attempts embedded. */
    async listMyAssignments(userId, cohortIds) {
      if (!cohortIds?.length) return []
      return (
        unwrap(
          await client
            .from('assessment_assignments')
            .select(withMyAttempts)
            .eq('status', 'published')
            .in('cohort_id', cohortIds)
            .eq('assessment_attempts.user_id', userId)
            .eq('assessment_extra_attempts.user_id', userId)
            .order('created_at', { ascending: true }),
          'assessments.list_mine'
        ) ?? []
      )
    },

    async getAssignment(assignmentId, userId) {
      return unwrap(
        await client
          .from('assessment_assignments')
          .select(withMyAttempts)
          .eq('id', assignmentId)
          .eq('assessment_attempts.user_id', userId)
          .eq('assessment_extra_attempts.user_id', userId)
          .maybeSingle(),
        'assessments.get'
      )
    },

    /**
     * Starts (or resumes) an attempt. The server decides eligibility, window and limit.
     * Returns { attempt_id, attempt_no, started_at, resumed, deadline_at, server_now, draft, timed_out };
     * timed_out = the open attempt was past its deadline and has just been submitted from its saved answers.
     */
    async start(assignmentId) {
      const rows = unwrap(
        await client.rpc('start_attempt', { p_assignment: assignmentId }),
        'assessments.start'
      )
      return rows?.[0] ?? null
    },

    /** Items of a version — visible to a trainee only after starting an attempt (RLS). */
    async getItems(versionId) {
      return (
        unwrap(
          await client
            .from('instrument_items')
            .select(ITEM_COLUMNS)
            .eq('instrument_version_id', versionId)
            .order('display_order', { ascending: true }),
          'assessments.items'
        ) ?? []
      )
    },

    async getAttempt(attemptId) {
      return unwrap(
        await client
          .from('assessment_attempts')
          .select(`${ATTEMPT_COLUMNS}, assessment_assignments ( ${ASSIGNMENT_COLUMNS} )`)
          .eq('id', attemptId)
          .maybeSingle(),
        'assessments.attempt'
      )
    },

    /** Saves the answers so far on the server. { saved_at, finalized } — finalized: time was up, attempt submitted. */
    async saveDraft(attemptId, responses) {
      const rows = unwrap(
        await client.rpc('save_attempt_draft', { p_attempt: attemptId, p_responses: responses }),
        'assessments.save_draft'
      )
      return rows?.[0] ?? null
    },

    /** Only the answers go up; score, passed and timestamps come back from the server. */
    async submit(attemptId, responses) {
      const rows = unwrap(
        await client.rpc('submit_attempt', { p_attempt: attemptId, p_responses: responses }),
        'assessments.submit'
      )
      return rows?.[0] ?? null
    },
  }
}

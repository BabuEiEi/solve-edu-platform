import { unwrap } from '../../core/errors.js'

export const ASSIGNMENT_COLUMNS =
  'id, title, purpose, instructions, open_at, close_at, attempt_limit, passing_percent, time_limit_minutes, grace_minutes, shuffle_items, shuffle_choices, status, course_id, cohort_id, instrument_version_id'
export const ATTEMPT_COLUMNS =
  'id, assignment_id, attempt_no, status, started_at, submitted_at, score, max_score, passed, correct_count, item_count, auto_submitted'
// No answer key exists in these columns (keys live in schema private).
export const ITEM_COLUMNS =
  'id, item_type, prompt, media_path, options_json, max_score, display_order, scoring_mode'

const withMyAttempts = `${ASSIGNMENT_COLUMNS}, courses ( id, title ), assessment_attempts ( ${ATTEMPT_COLUMNS} ), assessment_extra_attempts ( id )`

export function createAssessmentService(client, { restUrl = null, apiKey = null } = {}) {
  // Latest access token, kept for keepalive saves: a closing page cannot wait for supabase-js.
  let accessToken = null
  try {
    client.auth?.onAuthStateChange?.((_event, session) => {
      accessToken = session?.access_token ?? null
    })
  } catch {
    /* clients created with an accessToken option have no auth API (integration tests) */
  }

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

    /**
     * Saves the answers so far on the server, numbered by `seq` (newer wins).
     * { saved_at, finalized, stale } — finalized: time was up, attempt submitted;
     * stale: a page opened later (another device, or after a reload) took over.
     */
    async saveDraft(attemptId, responses, seq = null) {
      const rows = unwrap(
        await client.rpc('save_attempt_draft', { p_attempt: attemptId, p_responses: responses, p_seq: seq }),
        'assessments.save_draft'
      )
      return rows?.[0] ?? null
    },

    /**
     * Last-chance save while the page is hidden or closing (switching apps on a phone,
     * closing the tab). A keepalive request the browser completes even after the page
     * is gone; fire-and-forget. Returns false when it could not be sent.
     */
    saveDraftKeepalive(attemptId, responses, seq = null) {
      if (!restUrl || !apiKey || !accessToken) return false
      try {
        fetch(`${restUrl}/rpc/save_attempt_draft`, {
          method: 'POST',
          keepalive: true,
          headers: {
            apikey: apiKey,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_attempt: attemptId, p_responses: responses, p_seq: seq }),
        }).catch(() => {})
        return true
      } catch {
        return false
      }
    },

    /** Only the answers go up; score, passed and timestamps come back from the server. */
    async submit(attemptId, responses, seq = null) {
      const rows = unwrap(
        await client.rpc('submit_attempt', { p_attempt: attemptId, p_responses: responses, p_seq: seq }),
        'assessments.submit'
      )
      return rows?.[0] ?? null
    },
  }
}

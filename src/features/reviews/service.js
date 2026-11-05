import { unwrap } from '../../core/errors.js'
import { ITEM_COLUMNS } from '../assessments/service.js'
import { TASK_FILES_BUCKET } from '../submissions/logic.js'

const PROFILE = 'profiles ( id, full_name, display_name )'
const ALLOCATION_COLUMNS = `id, task_id, cohort_id, available_at, due_at,
  cohorts ( id, code, name ),
  tasks ( id, course_id, title, instructions, rubric_version_id, max_attempts, status, courses ( id, title ) )`
const SUBMISSION_COLUMNS = `id, allocation_id, user_id, attempt_no, status, text_response, links, submitted_at, is_late, ${PROFILE}`
const FILE_COLUMNS = 'id, submission_id, object_path, file_name, size_bytes, mime_type, created_at'
const REVIEW_COLUMNS =
  'id, submission_id, reviewer_id, status, outcome, feedback, score, max_score, supersedes_id, regrade_reason, released_at, created_at'
const SCORE_COLUMNS = 'review_id, criterion_id, level_id, score, comment'

/**
 * The reviewer's side of tasks. RLS decides every row: assessors see the
 * submitted work of their cohorts, a mentor only their mentees', nobody sees
 * a draft, and a review draft is visible only to its reviewer.
 */
export function createReviewService(client) {
  const rows = async (query, context) => unwrap(await query, context) ?? []

  return {
    async listAllocations() {
      return (
        await rows(client.from('task_allocations').select(ALLOCATION_COLUMNS), 'reviews.allocations')
      ).filter((a) => a.tasks?.status === 'published')
    },

    async getAllocation(id) {
      return unwrap(
        await client.from('task_allocations').select(ALLOCATION_COLUMNS).eq('id', id).maybeSingle(),
        'reviews.allocation'
      )
    },

    /** Submitted attempts of these allocations (newest attempt first) + their released reviews. */
    async submissionsOf(allocationIds) {
      if (!allocationIds.length) return { submissions: [], reviews: [] }
      const submissions = await rows(
        client
          .from('task_submissions')
          .select(SUBMISSION_COLUMNS)
          .in('allocation_id', allocationIds)
          .eq('status', 'submitted')
          .order('attempt_no', { ascending: false }),
        'reviews.submissions'
      )
      const reviews = submissions.length
        ? await rows(
            client
              .from('task_reviews')
              .select('id, submission_id, outcome, score, max_score, released_at')
              .in(
                'submission_id',
                submissions.map((s) => s.id)
              )
              .eq('status', 'released'),
            'reviews.released'
          )
        : []
      return { submissions, reviews }
    },

    /** Trainees of a cohort (the caller's RLS decides who is listed). */
    async roster(cohortId) {
      return rows(
        client
          .from('cohort_memberships')
          // two foreign keys lead to profiles (user_id, approved_by): name the person's
          .select('user_id, profiles!cohort_memberships_user_id_fkey ( id, full_name, display_name )')
          .eq('cohort_id', cohortId)
          .eq('cohort_role', 'trainee')
          .eq('status', 'active'),
        'reviews.roster'
      )
    },

    /** Everything the review page shows for one submitted attempt; null when not visible. */
    async getSubmission(submissionId) {
      const submission = unwrap(
        await client.from('task_submissions').select(SUBMISSION_COLUMNS).eq('id', submissionId).maybeSingle(),
        'reviews.submission'
      )
      if (!submission || submission.status !== 'submitted') return null
      const allocation = await this.getAllocation(submission.allocation_id)
      if (!allocation) return null
      const attempts = await rows(
        client
          .from('task_submissions')
          .select('id, attempt_no, status, submitted_at, is_late')
          .eq('allocation_id', submission.allocation_id)
          .eq('user_id', submission.user_id)
          .eq('status', 'submitted')
          .order('attempt_no', { ascending: false }),
        'reviews.attempts'
      )
      const [files, reviews, criteria] = await Promise.all([
        rows(
          client
            .from('task_submission_files')
            .select(FILE_COLUMNS)
            .eq('submission_id', submissionId)
            .order('created_at'),
          'reviews.files'
        ),
        rows(
          client.from('task_reviews').select(REVIEW_COLUMNS).eq('submission_id', submissionId),
          'reviews.reviews'
        ),
        allocation.tasks.rubric_version_id
          ? rows(
              client
                .from('instrument_items')
                .select(ITEM_COLUMNS)
                .eq('instrument_version_id', allocation.tasks.rubric_version_id)
                .order('display_order'),
              'reviews.criteria'
            )
          : [],
      ])
      const ids = reviews.map((r) => r.id)
      const scores = ids.length
        ? await rows(
            client.from('task_review_scores').select(SCORE_COLUMNS).in('review_id', ids),
            'reviews.scores'
          )
        : []
      return { submission, allocation, attempts, files, reviews, scores, criteria }
    },

    async saveReview(submissionId, { scores, feedback, outcome, reason }) {
      return unwrap(
        await client.rpc('save_task_review', {
          p_submission: submissionId,
          p_scores: scores,
          p_feedback: feedback,
          p_outcome: outcome,
          p_reason: reason,
        }),
        'reviews.save'
      )
    },

    async release(reviewId) {
      return unwrap(await client.rpc('release_task_review', { p_review: reviewId }), 'reviews.release')
    },

    async discard(reviewId) {
      unwrap(await client.from('task_reviews').delete().eq('id', reviewId).select('id'), 'reviews.discard')
    },

    async signedUrls(paths, expiresIn = 3600) {
      if (!paths?.length) return {}
      const out =
        unwrap(
          await client.storage.from(TASK_FILES_BUCKET).createSignedUrls(paths, expiresIn),
          'reviews.sign'
        ) ?? []
      return Object.fromEntries(out.filter((r) => r.signedUrl && !r.error).map((r) => [r.path, r.signedUrl]))
    },
  }
}

import { unwrap, AppError } from '../../core/errors.js'
import { ITEM_COLUMNS } from '../assessments/service.js'
import { TASK_FILES_BUCKET, validateTaskFile, taskFilePath } from './logic.js'

const ALLOCATION_COLUMNS = `id, task_id, cohort_id, available_at, due_at,
  cohorts ( id, code, name ),
  tasks ( id, course_id, title, instructions, rubric_version_id, max_attempts, status, courses ( id, title ) )`
const SUBMISSION_COLUMNS =
  'id, allocation_id, user_id, attempt_no, status, text_response, links, submitted_at, is_late'
const FILE_COLUMNS = 'id, submission_id, object_path, file_name, size_bytes, mime_type, created_at'
const REVIEW_COLUMNS =
  'id, submission_id, outcome, feedback, score, max_score, supersedes_id, regrade_reason, released_at'
const SCORE_COLUMNS = 'review_id, criterion_id, level_id, score, comment'

/**
 * The trainee's side of tasks: the tasks opened to their cohorts, their own
 * attempts (drafts included), files, and the released reviews. RLS decides
 * every row; staff who also learn are told apart by user id.
 */
export function createSubmissionService(client) {
  const bucket = () => client.storage.from(TASK_FILES_BUCKET)
  const rows = async (query, context) => unwrap(await query, context) ?? []

  return {
    /** Allocations of published tasks open to my cohorts, with my attempts. */
    async listMine(userId) {
      const allocations = await rows(
        client
          .from('task_allocations')
          .select(ALLOCATION_COLUMNS)
          .order('due_at', { ascending: true, nullsFirst: false }),
        'submissions.list'
      )
      const mine = allocations.filter((a) => a.tasks?.status === 'published')
      const submissions = mine.length
        ? await rows(
            client
              .from('task_submissions')
              .select(SUBMISSION_COLUMNS)
              .eq('user_id', userId)
              .in(
                'allocation_id',
                mine.map((a) => a.id)
              )
              .order('attempt_no', { ascending: false }),
            'submissions.mine'
          )
        : []
      return { allocations: mine, submissions }
    },

    /** Everything the detail page shows. null when the allocation is not visible. */
    async getDetail(allocationId, userId) {
      const allocation = unwrap(
        await client.from('task_allocations').select(ALLOCATION_COLUMNS).eq('id', allocationId).maybeSingle(),
        'submissions.get'
      )
      if (!allocation || allocation.tasks?.status !== 'published') return null
      const submissions = await rows(
        client
          .from('task_submissions')
          .select(SUBMISSION_COLUMNS)
          .eq('allocation_id', allocationId)
          .eq('user_id', userId)
          .order('attempt_no', { ascending: false }),
        'submissions.attempts'
      )
      const ids = submissions.map((s) => s.id)
      const [files, reviews, criteria] = await Promise.all([
        ids.length
          ? rows(
              client
                .from('task_submission_files')
                .select(FILE_COLUMNS)
                .in('submission_id', ids)
                .order('created_at'),
              'submissions.files'
            )
          : [],
        ids.length
          ? rows(
              client.from('task_reviews').select(REVIEW_COLUMNS).in('submission_id', ids),
              'submissions.reviews'
            )
          : [],
        allocation.tasks.rubric_version_id
          ? rows(
              client
                .from('instrument_items')
                .select(ITEM_COLUMNS)
                .eq('instrument_version_id', allocation.tasks.rubric_version_id)
                .order('display_order'),
              'submissions.criteria'
            )
          : [],
      ])
      const reviewIds = reviews.map((r) => r.id)
      const scores = reviewIds.length
        ? await rows(
            client.from('task_review_scores').select(SCORE_COLUMNS).in('review_id', reviewIds),
            'submissions.scores'
          )
        : []
      return { allocation, submissions, files, reviews, scores, criteria }
    },

    /** Open the draft (or the next attempt). Returns the submission id. */
    async start(allocationId) {
      return unwrap(
        await client.rpc('start_task_submission', { p_allocation: allocationId }),
        'submissions.start'
      )
    },

    async saveDraft(submissionId, { text_response, links }) {
      const out = unwrap(
        await client
          .from('task_submissions')
          .update({ text_response, links })
          .eq('id', submissionId)
          .select('id'),
        'submissions.save'
      )
      if (!out?.length)
        throw new AppError('บันทึกไม่ได้ — ร่างนี้ถูกส่งแล้วหรือท่านไม่มีสิทธิ์', { code: '42501' })
    },

    async submit(submissionId) {
      return unwrap(
        await client.rpc('submit_task_submission', { p_submission: submissionId }),
        'submissions.submit'
      )
    },

    /** Upload to the attempt's folder, then record it; the object is removed again if the record fails. */
    async addFile(submissionId, file, count) {
      const ext = validateTaskFile(file, count)
      const path = taskFilePath(submissionId, ext)
      unwrap(
        await bucket().upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' }),
        'submissions.upload'
      )
      const res = await client
        .from('task_submission_files')
        .insert({ submission_id: submissionId, object_path: path, file_name: file.name.slice(0, 255) })
        .select(FILE_COLUMNS)
        .single()
      if (res.error)
        await bucket()
          .remove([path])
          .catch(() => {})
      return unwrap(res, 'submissions.file_row')
    },

    async removeFile(file) {
      unwrap(
        await client.from('task_submission_files').delete().eq('id', file.id).select('id'),
        'submissions.file_delete'
      )
      await bucket()
        .remove([file.object_path])
        .catch(() => {})
    },

    /** { path: signedUrl } for the files the caller may open. */
    async signedUrls(paths, expiresIn = 3600) {
      if (!paths?.length) return {}
      const out = unwrap(await bucket().createSignedUrls(paths, expiresIn), 'submissions.sign') ?? []
      return Object.fromEntries(out.filter((r) => r.signedUrl && !r.error).map((r) => [r.path, r.signedUrl]))
    },

    /**
     * Uploaded but never recorded (the page was closed between the two steps):
     * remove objects of this draft that no file row refers to, older than
     * `graceMs` so an upload in progress in another tab is left alone.
     */
    async cleanOrphans(submissionId, files, { graceMs = 10 * 60 * 1000, now = Date.now() } = {}) {
      const listed = unwrap(await bucket().list(submissionId, { limit: 100 }), 'submissions.orphans') ?? []
      const known = new Set(files.map((f) => f.object_path))
      const stale = listed
        .filter((o) => o.name && !known.has(`${submissionId}/${o.name}`))
        .filter((o) => now - new Date(o.created_at).getTime() > graceMs)
        .map((o) => `${submissionId}/${o.name}`)
      if (stale.length)
        await bucket()
          .remove(stale)
          .catch(() => {})
      return stale
    },
  }
}

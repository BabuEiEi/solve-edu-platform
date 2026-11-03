import { unwrap } from '../../core/errors.js'

const byOrder = (a, b) => a.display_order - b.display_order
export const BLOCK_COLUMNS = 'id, lesson_id, block_type, content_json, display_order'
const PROGRESS_COLUMNS = 'id, lesson_id, status, progress_percent, started_at, completed_at'

export function createLessonService(client) {
  return {
    /** Lesson with its unit and ordered blocks. RLS hides drafts from learners. */
    async getLesson(lessonId) {
      const lesson = unwrap(
        await client
          .from('lessons')
          .select(
            `id, unit_id, title, learning_objectives, display_order, required, status, course_units ( id, course_id, title, status ), lesson_blocks ( ${BLOCK_COLUMNS} )`
          )
          .eq('id', lessonId)
          .maybeSingle(),
        'lessons.get'
      )
      if (lesson) lesson.lesson_blocks = (lesson.lesson_blocks ?? []).sort(byOrder)
      return lesson
    },

    /**
     * The caller's enrollment for a course (a person may be enrolled through
     * several cohorts; prefer an active one).
     */
    async getMyEnrollment(courseId, userId) {
      const rows = unwrap(
        await client
          .from('course_enrollments')
          .select(`id, status, cohort_id, lesson_progress ( ${PROGRESS_COLUMNS} )`)
          .eq('course_id', courseId)
          .eq('user_id', userId)
          .in('status', ['active', 'completed'])
          .order('enrolled_at', { ascending: false }),
        'enrollments.for_course'
      )
      return rows.find((r) => r.status === 'active') ?? rows[0] ?? null
    },

    /** First visit: create an in_progress row; never downgrades an existing one. */
    async markStarted(enrollmentId, lessonId) {
      unwrap(
        await client
          .from('lesson_progress')
          .upsert(
            { enrollment_id: enrollmentId, lesson_id: lessonId, status: 'in_progress' },
            { onConflict: 'enrollment_id,lesson_id', ignoreDuplicates: true }
          ),
        'progress.start'
      )
    },

    /**
     * Mark completed. Only status is sent — completed_at / started_at /
     * progress_percent are stamped by the database trigger.
     */
    async markCompleted(enrollmentId, lessonId) {
      const updated = unwrap(
        await client
          .from('lesson_progress')
          .update({ status: 'completed' })
          .eq('enrollment_id', enrollmentId)
          .eq('lesson_id', lessonId)
          .select(PROGRESS_COLUMNS),
        'progress.complete'
      )
      if (updated?.length) return updated[0]
      return unwrap(
        await client
          .from('lesson_progress')
          .insert({ enrollment_id: enrollmentId, lesson_id: lessonId, status: 'completed' })
          .select(PROGRESS_COLUMNS)
          .single(),
        'progress.complete_insert'
      )
    },
  }
}

/** Flatten an outline into reading order (unit order, then lesson order). */
export function lessonSequence(course) {
  return (course?.course_units ?? []).flatMap((u) => (u.lessons ?? []).map((l) => ({ ...l, unit: u })))
}

/** Previous / next lesson around `lessonId` in reading order. */
export function neighbours(course, lessonId) {
  const seq = lessonSequence(course)
  const i = seq.findIndex((l) => l.id === lessonId)
  return { prev: i > 0 ? seq[i - 1] : null, next: i >= 0 && i < seq.length - 1 ? seq[i + 1] : null }
}

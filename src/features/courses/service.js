import { unwrap } from '../../core/errors.js'

const byOrder = (a, b) => a.display_order - b.display_order

export function createCourseService(client) {
  return {
    async listVisibleCourses() {
      return unwrap(
        await client
          .from('courses')
          .select('id, code, title, summary, status, duration_minutes, updated_at')
          .order('title'),
        'courses.list'
      )
    },

    /** Course with units → lessons. RLS already hides draft items from learners. */
    async getCourseOutline(courseId) {
      const course = unwrap(
        await client
          .from('courses')
          .select(
            'id, code, title, summary, description, status, duration_minutes, course_units ( id, title, description, display_order, status, lessons ( id, title, display_order, status, required ) )'
          )
          .eq('id', courseId)
          .maybeSingle(),
        'courses.outline'
      )
      if (!course) return null
      course.course_units = (course.course_units ?? []).sort(byOrder)
      for (const u of course.course_units) u.lessons = (u.lessons ?? []).sort(byOrder)
      return course
    },

    /** 'manage' | 'view' | 'none' — decides which tools to SHOW; RLS still enforces. */
    async getAccess(courseId) {
      return unwrap(await client.rpc('course_access', { p_course: courseId }), 'rpc.course_access') ?? 'none'
    },

    async listMyEnrollments(userId) {
      return unwrap(
        await client
          .from('course_enrollments')
          .select(
            'id, status, course_id, cohort_id, enrolled_at, lesson_progress ( lesson_id, status, progress_percent )'
          )
          .eq('user_id', userId),
        'enrollments.mine'
      )
    },
  }
}

/** Percentage of published, required lessons completed (pure, unit-tested). */
export function computeCourseCompletion(course, progressRows = []) {
  const lessons = (course?.course_units ?? [])
    .flatMap((u) => u.lessons ?? [])
    .filter((l) => l.status === 'published' && l.required !== false)
  if (lessons.length === 0) return 0
  const done = new Set(progressRows.filter((p) => p.status === 'completed').map((p) => p.lesson_id))
  const completed = lessons.filter((l) => done.has(l.id)).length
  return Math.round((completed / lessons.length) * 100)
}

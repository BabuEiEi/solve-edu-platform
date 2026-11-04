// @vitest-environment node
/**
 * Integration: lesson page services → Supabase Local (Data API + Storage).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, serverNow, U, IDS } from './helpers.js'
import { createLessonService } from '../../src/features/lessons/service.js'
import { createCourseService } from '../../src/features/courses/service.js'
import { createMediaService } from '../../src/features/lessons/media.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip

run('Lesson page services (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const lessonsAs = (key) => createLessonService(supabaseAs(env, key))

  it('trainee loads a published lesson with ordered blocks; draft lesson is hidden', async () => {
    const svc = lessonsAs('teacher_a1')
    const lesson = await svc.getLesson(IDS.lesson1)
    expect(lesson.course_units.course_id).toBe(IDS.course)
    expect(lesson.lesson_blocks.map((b) => b.block_type)).toEqual(['rich_text', 'video'])
    expect(await svc.getLesson(IDS.draft_lesson)).toBeNull()
  })

  it('course_access reports manage / view / none', async () => {
    expect(await createCourseService(supabaseAs(env, 'trainer')).getAccess(IDS.course)).toBe('manage')
    expect(await createCourseService(supabaseAs(env, 'teacher_a1')).getAccess(IDS.course)).toBe('view')
    expect(await createCourseService(supabaseAs(env, 'school_admin_b')).getAccess(IDS.course)).toBe('none')
  })

  it('start then complete a lesson; timestamps come from the server', async () => {
    const svc = lessonsAs('teacher_a1')
    const enrollment = await svc.getMyEnrollment(IDS.course, U.teacher_a1)
    expect(enrollment.id).toBe(IDS.enr_a1)
    await svc.markStarted(enrollment.id, IDS.lesson2)
    await svc.markStarted(enrollment.id, IDS.lesson2) // idempotent
    const before = await serverNow(env)
    const row = await svc.markCompleted(enrollment.id, IDS.lesson2)
    expect(row.status).toBe('completed')
    expect(Number(row.progress_percent)).toBe(100)
    expect(Math.abs(new Date(row.completed_at).getTime() - before)).toBeLessThan(60_000)
    // a repeated visit must not downgrade the completed lesson
    await svc.markStarted(enrollment.id, IDS.lesson2)
    const again = await svc.getMyEnrollment(IDS.course, U.teacher_a1)
    expect(again.lesson_progress.find((p) => p.lesson_id === IDS.lesson2).status).toBe('completed')
  })

  it('completing directly (no prior visit) inserts the row', async () => {
    const row = await lessonsAs('teacher_a1').markCompleted(
      IDS.enr_a1,
      '60000000-0000-4000-a000-000000000003'
    )
    expect(row.status).toBe('completed')
  })

  it('a trainee cannot record progress in another enrollment', async () => {
    await expect(lessonsAs('teacher_a2').markCompleted(IDS.enr_a1, IDS.lesson1)).rejects.toThrow()
  })

  it('batch signing returns only paths the caller may read', async () => {
    const png = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
    const trainerStorage = supabaseAs(env, 'trainer').storage.from('lesson-media')
    await trainerStorage.upload(`${IDS.lesson1}/it-sign.png`, png)
    await trainerStorage.upload(`${IDS.draft_lesson}/it-sign.png`, png)
    const urls = await createMediaService(supabaseAs(env, 'teacher_a1')).signedUrls([
      `${IDS.lesson1}/it-sign.png`,
      `${IDS.draft_lesson}/it-sign.png`,
    ])
    expect(Object.keys(urls)).toEqual([`${IDS.lesson1}/it-sign.png`])
  })
})

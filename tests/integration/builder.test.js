// @vitest-environment node
/**
 * Integration: Course Builder services → Supabase Local (RLS, RPC, Storage).
 * Full authoring flow: create course → units → lessons → blocks → reorder →
 * publish → learner visibility.
 *
 * Runs in Node (real fetch/File for Storage uploads); DOMPurify only needs a
 * DOM window, so one is provided before the sanitiser module loads.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { supabaseAs, IDS, U } from './helpers.js'

globalThis.window ??= new JSDOM('').window
const { createBuilderService } = await import('../../src/features/builder/service.js')
const { createLessonService } = await import('../../src/features/lessons/service.js')
const { createMediaService } = await import('../../src/features/lessons/media.js')
const { buildBlockContent } = await import('../../src/features/lessons/blocks.js')

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const DISTRICT = '10000000-0000-4000-a000-000000000001'

run('Course Builder (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const builderAs = (key) => createBuilderService(supabaseAs(env, key))

  it('supervisor authors a course with ≥2 units × ≥2 lessons and blocks', async () => {
    const b = builderAs('supervisor')
    const course = await b.createCourse({ owner_org_id: DISTRICT, code: 'IT-BUILD', title: 'หลักสูตรทดสอบ' })
    const u1 = await b.addUnit(course.id, 'หน่วย ก', 1)
    const u2 = await b.addUnit(course.id, 'หน่วย ข', 2)
    for (const [u, n] of [
      [u1, 1],
      [u1, 2],
      [u2, 1],
      [u2, 2],
    ])
      await b.addLesson(u.id, `บท ${n}`, n)
    const tree = await b.getCourseTree(course.id)
    expect(tree.course_units.map((u) => u.lessons.length)).toEqual([2, 2])

    const lessonId = tree.course_units[0].lessons[0].id
    const text = await b.addBlock(
      lessonId,
      'rich_text',
      buildBlockContent('rich_text', { html: '<p>ก</p>' }),
      1
    )
    const link = await b.addBlock(
      lessonId,
      'link',
      buildBlockContent('link', { url: 'https://x.example.test' }),
      2
    )
    await b.reorder('block', lessonId, [link.id, text.id])
    const lesson = await createLessonService(supabaseAs(env, 'supervisor')).getLesson(lessonId)
    expect(lesson.lesson_blocks.map((x) => x.id)).toEqual([link.id, text.id])

    // swap units, then publish everything
    await b.reorder('unit', course.id, [u2.id, u1.id])
    expect((await b.getCourseTree(course.id)).course_units.map((u) => u.id)).toEqual([u2.id, u1.id])
    await b.updateCourse(course.id, { status: 'published' })
  })

  it('trainer uploads an image and saves an image block in the same lesson folder', async () => {
    const media = createMediaService(supabaseAs(env, 'trainer'))
    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], 'รูป.png', { type: 'image/png' })
    const path = await media.upload(IDS.lesson2, 'image', file)
    expect(path.startsWith(`${IDS.lesson2}/`)).toBe(true)
    const block = await builderAs('trainer').addBlock(
      IDS.lesson2,
      'image',
      buildBlockContent('image', { object_path: path, alt: 'แผนภาพ' }),
      50
    )
    expect(block.content_json.object_path).toBe(path)
    // the trainee can view it once the lesson is published (it is, in the seed)
    const urls = await createMediaService(supabaseAs(env, 'teacher_a1')).signedUrls([path])
    expect(urls[path]).toBeTruthy()
  })

  it('learners cannot author; RLS-filtered updates are reported as errors', async () => {
    const t = builderAs('teacher_a1')
    await expect(t.addUnit(IDS.course, 'x', 99)).rejects.toThrow()
    await expect(t.updateLesson(IDS.lesson1, { title: 'hacked' })).rejects.toThrow('ไม่มีสิทธิ์')
    await expect(
      t.reorder('unit', IDS.course, [
        '50000000-0000-4000-a000-000000000002',
        '50000000-0000-4000-a000-000000000001',
      ])
    ).rejects.toThrow()
  })

  it('publishing a draft lesson makes it visible to an enrolled trainee', async () => {
    // Its own course, unit and lesson (published course and unit, draft lesson) with its own
    // enrollment for teacher_b1: other files run at the same time on the same database and
    // count the demo course's lessons and the demo draft lesson — never publish those here.
    const sup = builderAs('supervisor')
    const db = supabaseAs(env, 'supervisor')
    const course = await sup.createCourse({
      owner_org_id: DISTRICT,
      code: `IT-PUB-${Date.now()}`,
      title: 'หลักสูตรทดสอบการเผยแพร่',
    })
    const unit = await sup.addUnit(course.id, 'หน่วยทดสอบ', 1)
    const lesson = await sup.addLesson(unit.id, 'บทร่าง', 1)
    await sup.updateUnit(unit.id, { status: 'published' })
    await sup.updateCourse(course.id, { status: 'published' })
    expect(
      (
        await db
          .from('program_courses')
          .insert({ program_id: IDS.program, course_id: course.id, display_order: 99 })
      ).error
    ).toBeNull()
    expect(
      (
        await db
          .from('course_enrollments')
          .insert({ cohort_id: IDS.cohort, course_id: course.id, user_id: U.teacher_b1 })
      ).error
    ).toBeNull()

    const learner = createLessonService(supabaseAs(env, 'teacher_b1'))
    expect(await learner.getLesson(lesson.id)).toBeNull() // still a draft
    await sup.updateLesson(lesson.id, { status: 'published' })
    expect((await learner.getLesson(lesson.id)).id).toBe(lesson.id)
  })

  it('a lesson with learner progress cannot be deleted (archive instead)', async () => {
    await expect(builderAs('trainer').deleteLesson(IDS.lesson1)).rejects.toThrow('เก็บถาวร')
  })

  it('stored XSS is rejected by the database even if the client skips sanitising', async () => {
    await expect(
      builderAs('trainer').addBlock(IDS.lesson2, 'rich_text', { html: '<img src=x onerror=alert(1)>' }, 60)
    ).rejects.toThrow()
  })
})

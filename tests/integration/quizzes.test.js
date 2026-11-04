// @vitest-environment node
/**
 * Integration: quiz authoring → assignment → trainee, through the real Data
 * API and Storage API (Supabase Local).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, IDS } from './helpers.js'
import { createQuizBuilderService } from '../../src/features/quizzes/service.js'
import { createAssessmentService } from '../../src/features/assessments/service.js'
import { createMediaService } from '../../src/features/lessons/media.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const COHORT = '30000000-0000-4000-a000-000000000001'
const DEMO_QUIZ = 'a1000000-0000-4000-a000-000000000001'
const png = () => new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], 'รูป.png', { type: 'image/png' })

run('Quiz authoring (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const quizzesAs = (key) => createQuizBuilderService(supabaseAs(env, key))
  const mediaAs = (key) => createMediaService(supabaseAs(env, key), 'assessment-media')
  let instrument
  let versionId
  let imagePath
  let assignmentId

  it('trainer creates a quiz with an image choice, sets a key and publishes', async () => {
    const q = quizzesAs('trainer')
    const course = { id: IDS.course, owner_org_id: '10000000-0000-4000-a000-000000000001' }
    instrument = await q.createInstrument(course, { code: 'IT-POST', title: 'แบบทดสอบหลังเรียน (ทดสอบ)' })
    const full = await q.getInstrument(instrument.id)
    expect(full.instrument_versions.map((v) => [v.version_no, v.status])).toEqual([[1, 'draft']])
    versionId = full.instrument_versions[0].id

    imagePath = await mediaAs('trainer').upload(instrument.id, 'image', png())
    expect(imagePath.startsWith(`${instrument.id}/`)).toBe(true)

    const item = await q.addItem(
      versionId,
      {
        item_type: 'mcq_single',
        prompt: 'ภาพใดคือแผนภาพ AfL',
        media_path: null,
        max_score: 1,
        options_json: {
          options: [
            { id: 'a', image_path: imagePath },
            { id: 'b', text: 'ไม่ใช่ข้อใด' },
          ],
        },
      },
      1
    )
    expect(await q.keyStatus(versionId)).toEqual({ [item.id]: { has_key: false, key_valid: false } })
    await expect(q.publish(versionId)).rejects.toThrow() // no key yet
    await q.setKey(item.id, { answer: { correct: ['a'] } })
    expect(await q.keyStatus(versionId)).toEqual({ [item.id]: { has_key: true, key_valid: true } })
    expect(await q.publish(versionId)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the published version is frozen; a clone gives an editable draft with the key', async () => {
    const q = quizzesAs('trainer')
    const [item] = await q.getItems(versionId)
    await expect(q.updateItem(item.id, { prompt: 'แก้' })).rejects.toThrow()
    const draftId = await q.clone(versionId)
    const status = await q.keyStatus(draftId)
    expect(Object.values(status)).toEqual([{ has_key: true, key_valid: true }])
  })

  it('a trainee sees the image only after starting an attempt on an assignment of it', async () => {
    const trainee = mediaAs('teacher_a1')
    expect(await trainee.signedUrls([imagePath])).toEqual({})

    const { data, error } = await supabaseAs(env, 'trainer')
      .from('assessment_assignments')
      .insert({
        instrument_version_id: versionId,
        cohort_id: COHORT,
        course_id: IDS.course,
        purpose: 'posttest',
        title: 'Posttest (ทดสอบ)',
        attempt_limit: 1,
        passing_percent: 50,
        status: 'published',
        close_at: '2027-03-31T16:59:00Z',
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    assignmentId = data.id

    await createAssessmentService(supabaseAs(env, 'teacher_a1')).start(assignmentId)
    expect(Object.keys(await trainee.signedUrls([imagePath]))).toEqual([imagePath])
    expect(await mediaAs('teacher_a2').signedUrls([imagePath])).toEqual({})
  })

  it('the assignment is listed for the course (quiz_reference block picker)', async () => {
    const rows = await quizzesAs('trainer').listCourseAssignments(IDS.course)
    expect(rows.map((r) => r.id)).toContain(assignmentId)
  })

  it('cleanup through the real Storage API removes only images no version uses', async () => {
    const media = mediaAs('trainer')
    const spare = await media.upload(instrument.id, 'image', png())
    expect((await media.list(instrument.id)).map((f) => f.path)).toEqual(
      expect.arrayContaining([imagePath, spare])
    )
    expect(await quizzesAs('trainer').usedMediaPaths(instrument.id)).toEqual([imagePath])

    expect(await mediaAs('teacher_a2').remove([spare])).toEqual([]) // trainee: nothing removed
    expect(await media.remove([imagePath, spare])).toEqual([spare]) // the used one is refused
    expect(Object.keys(await media.signedUrls([imagePath]))).toEqual([imagePath])
    expect((await media.list(instrument.id)).map((f) => f.path)).not.toContain(spare)
  })

  it('outsiders cannot author or upload', async () => {
    await expect(mediaAs('teacher_a1').upload(instrument.id, 'image', png())).rejects.toThrow()
    await expect(mediaAs('school_admin_b').upload(DEMO_QUIZ, 'image', png())).rejects.toThrow()
    await expect(
      quizzesAs('teacher_a1').setKey('a3000000-0000-4000-a000-000000000001', { answer: { correct: ['a'] } })
    ).rejects.toThrow()
    await expect(
      quizzesAs('teacher_a1').createInstrument(
        { id: IDS.course, owner_org_id: '10000000-0000-4000-a000-000000000001' },
        { code: 'X', title: 'x' }
      )
    ).rejects.toThrow()
  })
})

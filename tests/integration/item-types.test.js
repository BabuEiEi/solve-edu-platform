// @vitest-environment node
/**
 * Integration: Phase 2C group A item types through the real Data API —
 * authoring JSON round-trips, keys stay write-only, the server-built
 * presentation reaches the trainee without any key, scoring of a mix.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, serverNow, IDS } from './helpers.js'
import { createQuizBuilderService } from '../../src/features/quizzes/service.js'
import { createAssignmentService } from '../../src/features/assignments/service.js'
import { createAssessmentService } from '../../src/features/assessments/service.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const COHORT = '30000000-0000-4000-a000-000000000001'
const KEY_MARKERS =
  /"correct"|answer_json|scoring_json|tolerance|is_correct|awarded_score|"order":\["a","b","c","d"\]/
const entries = (ids, prefix = '') => ids.map((id) => ({ id, text: `${prefix}${id}` }))

const ITEMS = [
  {
    item_type: 'ordering',
    options_json: { options: entries(['a', 'b', 'c', 'd'], 'ขั้น ') },
    key: { order: ['a', 'b', 'c', 'd'] },
  },
  {
    item_type: 'matching',
    options_json: { left: entries(['l1', 'l2']), right: entries(['r1', 'r2', 'r3']) },
    key: { slots: { l1: 'r1', l2: 'r2' } },
  },
  {
    item_type: 'classification',
    options_json: { categories: entries(['c1', 'c2']), items: entries(['i1', 'i2']) },
    key: { slots: { i1: 'c1', i2: 'c2' } },
  },
  {
    item_type: 'choice_matrix',
    options_json: { rows: entries(['w1', 'w2']), columns: entries(['t', 'f']) },
    key: { slots: { w1: 't', w2: 'f' } },
  },
]

run('Phase 2C group A item types (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const quizzes = () => createQuizBuilderService(supabaseAs(env, 'trainer'))
  let versionId
  let items
  let assignmentId

  it('trainer authors the four types, sets keys, publishes', async () => {
    const q = quizzes()
    const instrument = await q.createInstrument(
      { id: IDS.course, owner_org_id: '10000000-0000-4000-a000-000000000001' },
      { code: 'TYPES-A', title: 'ข้อสอบแบบใหม่ (ทดสอบ)' }
    )
    versionId = (await q.getInstrument(instrument.id)).instrument_versions[0].id
    for (const [i, it] of ITEMS.entries()) {
      const saved = await q.addItem(
        versionId,
        {
          item_type: it.item_type,
          prompt: `ข้อ ${i + 1}`,
          media_path: null,
          max_score: 1,
          options_json: it.options_json,
        },
        i + 1
      )
      await q.setKey(saved.id, { answer: it.key, scoring: {} })
    }
    items = await q.getItems(versionId)
    expect(items.map((i) => i.item_type)).toEqual(ITEMS.map((i) => i.item_type))
    expect(items[1].options_json).toEqual(ITEMS[1].options_json) // JSON round-trip, nothing added
    expect(Object.values(await q.keyStatus(versionId)).every((s) => s.has_key && s.key_valid)).toBe(true)
    await expect(
      q.addItem(
        versionId,
        {
          item_type: 'ordering',
          prompt: 'x',
          media_path: null,
          max_score: 1,
          options_json: { options: entries(['a', 'b']) },
        },
        9
      )
    ).rejects.toThrow() // fewer than 3 entries
    expect(await q.publish(versionId)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('assignment with shuffling: the trainee gets a presentation and no key', async () => {
    const created = await createAssignmentService(supabaseAs(env, 'trainer')).create({
      versionId,
      cohortId: COHORT,
      courseId: IDS.course,
      status: 'published',
      title: 'แบบใหม่ สลับลำดับ',
      purpose: 'formative',
      attempt_limit: 1,
      passing_percent: 50,
      shuffle_items: true,
      shuffle_choices: true,
      close_at: new Date((await serverNow(env)) + 86_400_000).toISOString(),
    })
    assignmentId = created.id
    const client = supabaseAs(env, 'teacher_a1')
    const res = await client.rpc('start_attempt', { p_assignment: assignmentId })
    expect(res.error).toBeNull()
    const p = res.data[0].presentation
    expect([...p.items].sort()).toEqual(items.map((i) => i.id).sort())
    const ord = p.lists[items[0].id].options
    expect([...ord].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(ord).not.toEqual(['a', 'b', 'c', 'd'])
    expect(Object.keys(p.lists[items[1].id]).sort()).toEqual(['left', 'right'])
    expect(JSON.stringify(res.data)).not.toMatch(KEY_MARKERS)

    const itemsAsTrainee = await createAssessmentService(client).getItems(versionId)
    expect(JSON.stringify(itemsAsTrainee)).not.toMatch(/"slots"|"order"/)
  })

  it('server scores a mix of partial answers', async () => {
    const svc = createAssessmentService(supabaseAs(env, 'teacher_a1'))
    const t = await svc.start(assignmentId)
    const [ord, match, cls, mtx] = items
    const out = await svc.submit(t.attempt_id, {
      [ord.id]: { order: ['a', 'b', 'd', 'c'] }, // 2/4
      [match.id]: { slots: { l1: 'r1' } }, // 1/2
      [cls.id]: { slots: { i1: 'c1', i2: 'c2' } }, // 2/2
      [mtx.id]: { slots: { w1: 'f', w2: 'f' } }, // 1/2
    })
    expect(out).toMatchObject({ score: 2.5, max_score: 4, percent: 62.5, passed: true })
    await expect(
      createAssessmentService(supabaseAs(env, 'teacher_a2')).submit(
        (await createAssessmentService(supabaseAs(env, 'teacher_a2')).start(assignmentId)).attempt_id,
        { [ord.id]: { order: ['a', 'b'] } }
      )
    ).rejects.toMatchObject({ code: '22023' }) // incomplete ordering is malformed
  })
})

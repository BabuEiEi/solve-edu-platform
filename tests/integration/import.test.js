// @vitest-environment node
/**
 * Integration (Phase 2D): importing items + keys into a draft through the
 * real Data API — all or nothing, the row number reaches the browser, keys
 * stay write-only.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, IDS } from './helpers.js'
import { createQuizBuilderService } from '../../src/features/quizzes/service.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip

const ROWS = [
  {
    item_type: 'mcq_single',
    prompt: 'ข้อใดเป็นเป้าหมายของ AfL',
    max_score: 1,
    options_json: {
      options: [
        { id: 'a', text: 'ตัดเกรด' },
        { id: 'b', text: 'ปรับการสอน' },
      ],
    },
    answer: { correct: ['b'] },
  },
  { item_type: 'true_false', prompt: 'ควรแจ้งเกณฑ์ก่อนเริ่ม', options_json: {}, answer: { correct: true } },
  {
    item_type: 'numeric',
    prompt: 'ร้อยละเท่าใด',
    options_json: { unit: '%' },
    answer: { value: 75, tolerance: 0 },
  },
]

run('Import items into a draft (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  let versionId

  it('a bad row: nothing saved, the error names the row', async () => {
    const q = createQuizBuilderService(supabaseAs(env, 'trainer'))
    const instrument = await q.createInstrument(
      { id: IDS.course, owner_org_id: '10000000-0000-4000-a000-000000000001' },
      { code: 'IMPORT-1', title: 'นำเข้าจากไฟล์ (ทดสอบ)' }
    )
    versionId = (await q.getInstrument(instrument.id)).instrument_versions[0].id
    const bad = structuredClone(ROWS)
    bad[1].answer = { correct: 'ใช่' }
    const res = await supabaseAs(env, 'trainer').rpc('import_instrument_items', {
      p_version: versionId,
      p_items: bad,
    })
    expect(res.error).toMatchObject({ code: '23514', details: 'แถวที่ 2' })
    expect(await q.getItems(versionId)).toEqual([])
  })

  it('a good file: all rows with keys; keys are not readable back', async () => {
    const client = supabaseAs(env, 'trainer')
    const res = await client.rpc('import_instrument_items', { p_version: versionId, p_items: ROWS })
    expect(res.error).toBeNull()
    expect(res.data).toBe(3)
    const q = createQuizBuilderService(client)
    const items = await q.getItems(versionId)
    expect(items.map((i) => i.item_type)).toEqual(['mcq_single', 'true_false', 'numeric'])
    expect(JSON.stringify(items)).not.toMatch(/"correct"|"value":75|tolerance/)
    expect(Object.values(await q.keyStatus(versionId)).every((s) => s.has_key && s.key_valid)).toBe(true)
  })

  it('a trainee cannot import', async () => {
    const res = await supabaseAs(env, 'teacher_a1').rpc('import_instrument_items', {
      p_version: versionId,
      p_items: ROWS,
    })
    expect(res.error?.code).toBe('42501')
  })
})

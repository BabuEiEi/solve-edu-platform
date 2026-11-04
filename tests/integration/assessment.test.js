// @vitest-environment node
/**
 * Integration: taking a test through the real Data API (Supabase Local).
 * Covers what pgTAP cannot: truly concurrent requests on separate
 * connections, and the exact JSON a trainee's browser receives.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { supabaseAs, U } from './helpers.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip

const A = {
  pretest: 'a4000000-0000-4000-a000-000000000001',
  formative: 'a4000000-0000-4000-a000-000000000002',
  version: 'a2000000-0000-4000-a000-000000000001',
}
const Q = {
  single: 'a3000000-0000-4000-a000-000000000001',
  multiple: 'a3000000-0000-4000-a000-000000000002',
  truefalse: 'a3000000-0000-4000-a000-000000000003',
  numeric: 'a3000000-0000-4000-a000-000000000004',
}
const ALL_RIGHT = {
  [Q.single]: { choice: 'b' },
  [Q.multiple]: { choices: ['a', 'b', 'd'] },
  [Q.truefalse]: { value: true },
  [Q.numeric]: { value: 75 },
}
// Anything that would reveal the key if it reached the browser
const KEY_MARKERS = /"correct"|answer_json|scoring_json|tolerance|is_correct|awarded_score/

/** Fire `n` copies of `fn` at once, each on its own client/connection. */
const burst = (n, fn) => Promise.all(Array.from({ length: n }, () => fn()))

run('Assessment attempts (Supabase Local)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const as = (key) => supabaseAs(env, key)

  it('concurrent starts on a 1-attempt pretest create exactly one attempt', async () => {
    const results = await burst(5, () => as('teacher_a2').rpc('start_attempt', { p_assignment: A.pretest }))
    expect(results.map((r) => r.error)).toEqual([null, null, null, null, null])
    const ids = new Set(results.map((r) => r.data[0].attempt_id))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.data[0].resumed === false)).toHaveLength(1)

    const { data } = await as('teacher_a2').from('assessment_attempts').select('id, attempt_no, status')
    expect(data).toEqual([{ id: [...ids][0], attempt_no: 1, status: 'in_progress' }])
  })

  it('concurrent duplicate submits: ONE success, the rest are refused (SE003)', async () => {
    const start = await as('teacher_a1').rpc('start_attempt', { p_assignment: A.pretest })
    const attemptId = start.data[0].attempt_id
    const results = await burst(4, () =>
      as('teacher_a1').rpc('submit_attempt', { p_attempt: attemptId, p_responses: ALL_RIGHT })
    )
    const ok = results.filter((r) => !r.error)
    expect(ok).toHaveLength(1)
    expect(results.filter((r) => r.error).map((r) => r.error.code)).toEqual(['SE003', 'SE003', 'SE003'])
    expect(ok[0].data[0]).toMatchObject({
      score: 5,
      max_score: 5,
      percent: 100,
      passed: true,
      correct_count: 4,
    })

    const { data } = await as('teacher_a1')
      .from('assessment_responses')
      .select('item_id')
      .eq('attempt_id', attemptId)
    expect(data).toHaveLength(4) // one row per item, not 4 × 4 (other files run in parallel as the same trainee)
  })

  it('start racing with submit never yields a second pretest attempt', async () => {
    const start = await as('teacher_b1').rpc('start_attempt', { p_assignment: A.pretest })
    const attemptId = start.data[0].attempt_id
    const results = await Promise.all([
      as('teacher_b1').rpc('submit_attempt', { p_attempt: attemptId, p_responses: {} }),
      as('teacher_b1').rpc('start_attempt', { p_assignment: A.pretest }),
      as('teacher_b1').rpc('start_attempt', { p_assignment: A.pretest }),
    ])
    expect(results[0].error).toBeNull()
    for (const r of results.slice(1)) {
      // either resumed the same attempt (ran first) or hit the limit (ran after)
      if (r.error) expect(r.error.code).toBe('SE002')
      else expect(r.data[0].attempt_id).toBe(attemptId)
    }
    const { data } = await as('teacher_b1')
      .from('assessment_attempts')
      .select('id')
      .eq('assignment_id', A.pretest)
    expect(data).toHaveLength(1)
  })

  it('a trainee browser never receives answer keys or per-item scores', async () => {
    const client = as('teacher_a2')
    const bodies = []
    const keep = (r) => {
      expect(r.error).toBeNull()
      bodies.push(JSON.stringify(r.data))
      return r.data
    }
    keep(
      await client.from('assessment_assignments').select('id, title, purpose, attempt_limit, passing_percent')
    )
    const [attempt] = keep(await client.rpc('start_attempt', { p_assignment: A.formative }))
    keep(
      await client
        .from('instrument_items')
        .select('id, item_type, prompt, media_path, options_json, max_score, display_order')
        .eq('instrument_version_id', A.version)
    )
    keep(await client.from('instrument_versions').select('id, version_no, status, content_hash'))
    keep(await client.rpc('submit_attempt', { p_attempt: attempt.attempt_id, p_responses: ALL_RIGHT }))
    keep(await client.from('assessment_attempts').select('id, score, max_score, passed, correct_count'))
    keep(await client.from('assessment_responses').select('id, item_id, response_json'))

    expect(bodies.join('\n')).not.toMatch(KEY_MARKERS)
    // the trainee's own answers are fine to return; the key's wording is not
    expect(bodies.join('\n')).toContain('"choices":["a","b","d"]')
  })

  it('keys are unreachable through the API for trainees AND trainers', async () => {
    for (const key of ['teacher_a1', 'trainer']) {
      const client = as(key)
      const viaSchema = await client.schema('private').from('instrument_answer_keys').select('item_id')
      expect(viaSchema.error).toBeTruthy()
      const perItem = await client.from('assessment_responses').select('awarded_score')
      expect(perItem.error?.code).toBe('42501')
    }
    const status = await as('teacher_a1').rpc('item_key_status', { p_version: A.version })
    expect(status.error?.code).toBe('42501')
    // the trainer gets status flags only
    const trainer = await as('trainer').rpc('item_key_status', { p_version: A.version })
    expect(trainer.error).toBeNull()
    expect(JSON.stringify(trainer.data)).not.toMatch(KEY_MARKERS)
    expect(Object.keys(trainer.data[0]).sort()).toEqual(['has_key', 'item_id', 'key_valid'])
  })

  it('scores cannot be forged from the browser', async () => {
    const client = as('teacher_a1')
    const { data: mine } = await client
      .from('assessment_attempts')
      .select('id')
      .eq('assignment_id', A.pretest)
    const upd = await client
      .from('assessment_attempts')
      .update({ score: 0, passed: false })
      .eq('id', mine[0].id)
    expect(upd.error?.code).toBe('42501')
    const ins = await client.from('assessment_attempts').insert({
      assignment_id: A.pretest,
      user_id: U.teacher_a1,
      attempt_no: 2,
      score: 5,
      max_score: 5,
      passed: true,
    })
    expect(ins.error?.code).toBe('42501')
    const extra = await client.rpc('submit_attempt', {
      p_attempt: mine[0].id,
      p_responses: ALL_RIGHT,
      p_score: 5,
    })
    expect(extra.error).toBeTruthy() // no such signature
  })

  it('trainee A cannot see trainee B results; the trainer sees the cohort', async () => {
    const { data: a } = await as('teacher_a1').from('assessment_attempts').select('user_id')
    expect(new Set(a.map((r) => r.user_id))).toEqual(new Set([U.teacher_a1]))
    const { data: all } = await as('trainer').from('assessment_attempts').select('user_id')
    expect(new Set(all.map((r) => r.user_id))).toEqual(new Set([U.teacher_a1, U.teacher_a2, U.teacher_b1]))
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  nextOptionId,
  buildItemDraft,
  keyState,
  publishBlockers,
  defaultVersion,
} from '../../src/features/quizzes/logic.js'
import { createQuizBuilderService } from '../../src/features/quizzes/service.js'
import { renderQuizEditorView, renderCourseQuizzesView } from '../../src/features/quizzes/views.js'
import { buildBlockContent, blockSummary } from '../../src/features/lessons/blocks.js'
import { AppError } from '../../src/core/errors.js'

const XSS = '<img src=x onerror=alert(1)>'
const flush = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush()
}

describe('quiz builder logic', () => {
  it('nextOptionId never reuses an id (keys refer to ids, not positions)', () => {
    expect(nextOptionId([])).toBe('a')
    expect(nextOptionId(['a', 'b', 'd'])).toBe('c')
    expect(nextOptionId([...'abcdefghijklmnopqrstuvwxyz'])).toBe('o1')
  })

  it('mcq: options carry only id/text/image_path; the key is separate', () => {
    const { item, key } = buildItemDraft(
      'mcq_single',
      {
        prompt: '  โจทย์  ',
        max_score: '2',
        options: [
          { id: 'a', text: 'ก', image_path: '' },
          { id: 'b', text: '', image_path: 'inst/b.png' },
          { id: 'c', text: '   ' }, // empty row is dropped
        ],
        correct: ['b'],
      },
      { requireKey: true }
    )
    expect(item).toEqual({
      item_type: 'mcq_single',
      prompt: 'โจทย์',
      media_path: null,
      max_score: 2,
      options_json: {
        options: [
          { id: 'a', text: 'ก' },
          { id: 'b', image_path: 'inst/b.png' },
        ],
      },
    })
    expect(key).toEqual({ answer: { correct: ['b'] }, scoring: {} })
    expect(JSON.stringify(item)).not.toMatch(/correct/)
  })

  it('mcq_multiple carries the scoring mode in the key', () => {
    const opts = [
      { id: 'a', text: 'ก' },
      { id: 'b', text: 'ข' },
      { id: 'c', text: 'ค' },
    ]
    const { key } = buildItemDraft('mcq_multiple', {
      prompt: 'x',
      options: opts,
      correct: ['a', 'c'],
      mode: 'partial',
    })
    expect(key).toEqual({ answer: { correct: ['a', 'c'] }, scoring: { mode: 'partial' } })
    expect(
      buildItemDraft('mcq_multiple', { prompt: 'x', options: opts, correct: ['a'] }).key.scoring
    ).toEqual({
      mode: 'all_or_nothing',
    })
  })

  it('no answer picked: required on create, "keep the stored key" on edit', () => {
    const fields = {
      prompt: 'x',
      options: [
        { id: 'a', text: 'ก' },
        { id: 'b', text: 'ข' },
      ],
    }
    expect(() => buildItemDraft('mcq_single', fields, { requireKey: true })).toThrow('เฉลย')
    expect(buildItemDraft('mcq_single', fields).key).toBeNull()
  })

  it('rejects invalid input with Thai messages', () => {
    const two = [
      { id: 'a', text: 'ก' },
      { id: 'b', text: 'ข' },
    ]
    expect(() => buildItemDraft('mcq_single', { prompt: '', options: two })).toThrow('โจทย์')
    expect(() => buildItemDraft('mcq_single', { prompt: 'x', max_score: '0', options: two })).toThrow('คะแนน')
    expect(() => buildItemDraft('mcq_single', { prompt: 'x', options: [two[0]] })).toThrow('ตัวเลือก 2')
    expect(() => buildItemDraft('mcq_single', { prompt: 'x', options: two, correct: ['a', 'b'] })).toThrow(
      AppError
    )
    expect(() => buildItemDraft('numeric', { prompt: 'x', value: 'abc' })).toThrow('ตัวเลข')
    expect(() => buildItemDraft('numeric', { prompt: 'x', value: '1', tolerance: '-1' })).toThrow('ไม่ติดลบ')
    expect(() => buildItemDraft('essay', { prompt: 'x' })).toThrow('ไม่รองรับ')
  })

  it('true_false and numeric keys', () => {
    expect(buildItemDraft('true_false', { prompt: 'x', tf: 'false' })).toEqual({
      item: { item_type: 'true_false', prompt: 'x', media_path: null, max_score: 1, options_json: {} },
      key: { answer: { correct: false }, scoring: {} },
    })
    const n = buildItemDraft('numeric', { prompt: 'x', unit: '%', value: '๗๕', tolerance: '0.5' })
    expect(n.item.options_json).toEqual({ unit: '%' })
    expect(n.key).toEqual({ answer: { value: 75, tolerance: 0.5 }, scoring: {} })
  })

  it('key status, publish blockers and the default version', () => {
    expect(keyState(undefined)).toBe('missing')
    expect(keyState({ has_key: true, key_valid: false })).toBe('invalid')
    expect(keyState({ has_key: true, key_valid: true })).toBe('ok')
    const items = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    expect(
      publishBlockers(items, {
        x: { has_key: true, key_valid: true },
        z: { has_key: true, key_valid: false },
      })
    ).toEqual([2, 3])
    expect(
      defaultVersion([
        { version_no: 1, status: 'published' },
        { version_no: 2, status: 'draft' },
      ]).version_no
    ).toBe(2)
    expect(
      defaultVersion([
        { version_no: 1, status: 'published' },
        { version_no: 3, status: 'published' },
      ]).version_no
    ).toBe(3)
  })

  it('quiz_reference lesson block', () => {
    const id = 'a4000000-0000-4000-a000-000000000001'
    expect(buildBlockContent('quiz_reference', { assessment_assignment_id: id, title: ' Pretest ' })).toEqual(
      {
        assessment_assignment_id: id,
        title: 'Pretest',
      }
    )
    expect(() => buildBlockContent('quiz_reference', { assessment_assignment_id: 'nope' })).toThrow(
      'เลือกแบบทดสอบ'
    )
    expect(blockSummary({ block_type: 'quiz_reference', content_json: { title: 'Pretest' } })).toBe('Pretest')
  })
})

describe('quiz builder service', () => {
  function fakeClient(result = { data: [], error: null }) {
    const calls = []
    const builder = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then')
            return (resolve) => resolve(typeof result === 'function' ? result(calls) : result)
          return (...args) => {
            calls.push([prop, ...args])
            return builder
          }
        },
      }
    )
    return {
      calls,
      from: (t) => (calls.push(['from', t]), builder),
      rpc: vi.fn(
        async (fn, args) => (
          calls.push(['rpc', fn, args]),
          typeof result === 'function' ? result(calls) : result
        )
      ),
    }
  }

  it('creates an instrument under the course owner org, then its first draft version', async () => {
    const c = fakeClient({ data: { id: 'I1' }, error: null })
    await createQuizBuilderService(c).createInstrument(
      { id: 'K', owner_org_id: 'ORG' },
      { code: ' Q1 ', title: ' แบบทดสอบ ', description: '' }
    )
    const inserts = c.calls.filter(([op]) => op === 'insert').map(([, row]) => row)
    expect(inserts).toEqual([
      { owner_org_id: 'ORG', course_id: 'K', code: 'Q1', title: 'แบบทดสอบ', description: null },
      { instrument_id: 'I1' },
    ])
  })

  it('setKey / keyStatus use the write-only RPCs', async () => {
    const c = fakeClient({ data: [{ item_id: 'i1', has_key: true, key_valid: false }], error: null })
    const svc = createQuizBuilderService(c)
    await svc.setKey('i1', { answer: { correct: ['b'] }, scoring: {} })
    expect(c.rpc).toHaveBeenCalledWith('set_item_key', {
      p_item: 'i1',
      p_answer: { correct: ['b'] },
      p_scoring: {},
    })
    expect(await svc.keyStatus('v1')).toEqual({ i1: { has_key: true, key_valid: false } })
    for (const [op, cols] of c.calls.filter(([op]) => op === 'select')) expect([op, cols]).not.toContain('*')
  })

  it('an item update filtered out by RLS is reported', async () => {
    const c = fakeClient({ data: [], error: null })
    await expect(createQuizBuilderService(c).updateItem('i1', { prompt: 'x' })).rejects.toThrow('ไม่มีสิทธิ์')
  })
})

describe('quiz editor view', () => {
  const course = { id: 'K', title: 'AfL', owner_org_id: 'ORG', course_units: [] }
  const draftItems = [
    {
      id: 'i1',
      item_type: 'mcq_single',
      prompt: XSS,
      max_score: 1,
      display_order: 1,
      options_json: {
        options: [
          { id: 'a', text: 'ก' },
          { id: 'c', text: 'ค' },
        ],
      },
    },
    { id: 'i2', item_type: 'true_false', prompt: 'ข้อสอง', max_score: 1, display_order: 2, options_json: {} },
  ]
  const makeServices = (versions, overrides = {}) => {
    const quizzes = {
      getInstrument: vi.fn(async () => ({
        id: 'I1',
        course_id: 'K',
        code: 'Q1',
        title: 'แบบทดสอบ',
        instrument_versions: versions,
      })),
      getItems: vi.fn(async () => draftItems),
      keyStatus: vi.fn(async () => ({ i1: { has_key: true, key_valid: true } })),
      addItem: vi.fn(async (_v, item) => ({ id: 'new', ...item })),
      updateItem: vi.fn(async (id, item) => ({ id, ...item })),
      setKey: vi.fn(async () => {}),
      publish: vi.fn(async () => 'hash'),
      clone: vi.fn(async () => 'V2'),
      ...overrides,
    }
    return {
      courses: { getAccess: async () => 'manage' },
      builder: { getCourseTree: async () => course },
      assessmentMedia: { signedUrls: async () => ({}), upload: vi.fn() },
      quizzes,
    }
  }
  const draft = [{ id: 'V1', version_no: 1, status: 'draft', published_at: null }]

  it('denies users who cannot manage the course', async () => {
    const el = document.createElement('div')
    const services = makeServices(draft)
    services.courses.getAccess = async () => 'view'
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    expect(el.textContent).toContain('ไม่มีสิทธิ์')
    expect(services.quizzes.getInstrument).not.toHaveBeenCalled()
  })

  it('draft: key badges, prompts escaped, publish blocked until every key is valid', async () => {
    const el = document.createElement('div')
    await renderQuizEditorView(el, { services: makeServices(draft) }, { id: 'K', quizId: 'I1' })
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('ตั้งเฉลยแล้ว')
    expect(el.textContent).toContain('ยังไม่มีเฉลย')
    expect(el.textContent).toContain('ข้อ 2 ยังไม่มีเฉลยที่ถูกต้อง')
    expect(el.querySelector('[data-action=publish]').disabled).toBe(true)
  })

  it('adds an mcq item: choices go to the item, the answer goes to set_item_key', async () => {
    const el = document.createElement('div')
    document.body.append(el)
    const services = makeServices(draft)
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    el.querySelector('[data-action=new-item][data-type=mcq_single]').click()
    const form = el.querySelector('form[data-form=item]')
    form.querySelector('[name=prompt]').value = 'โจทย์ใหม่'
    const texts = form.querySelectorAll('[name=opt_text]')
    texts[0].value = 'หนึ่ง'
    texts[1].value = 'สอง'
    // add a fifth choice: typed text in the other rows must survive
    form.querySelector('[data-action=add-option]').click()
    expect(form.querySelectorAll('[data-option-row]')).toHaveLength(5)
    expect(form.querySelectorAll('[name=opt_text]')[0].value).toBe('หนึ่ง')
    expect(form.querySelectorAll('[name=opt_id]')[4].value).toBe('e')
    form.querySelector('[name=correct][value=b]').checked = true
    form.requestSubmit()
    await settle()
    expect(services.quizzes.addItem).toHaveBeenCalledWith(
      'V1',
      {
        item_type: 'mcq_single',
        prompt: 'โจทย์ใหม่',
        media_path: null,
        max_score: 1,
        options_json: {
          options: [
            { id: 'a', text: 'หนึ่ง' },
            { id: 'b', text: 'สอง' },
          ],
        },
      },
      3
    )
    expect(services.quizzes.setKey).toHaveBeenCalledWith('new', { answer: { correct: ['b'] }, scoring: {} })
    el.remove()
  })

  it('editing without picking an answer keeps the stored key and the choice ids', async () => {
    const el = document.createElement('div')
    document.body.append(el)
    const services = makeServices(draft)
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    el.querySelector('[data-action=edit-item][data-id=i1]').click()
    const form = el.querySelector('form[data-form=item]')
    expect(el.textContent).toContain('ระบบไม่แสดงเฉลยเดิมกลับมา')
    form.querySelectorAll('[name=opt_text]')[1].value = 'ค (แก้)'
    form.requestSubmit()
    await settle()
    expect(services.quizzes.updateItem).toHaveBeenCalledWith(
      'i1',
      expect.objectContaining({
        options_json: {
          options: [
            { id: 'a', text: 'ก' },
            { id: 'c', text: 'ค (แก้)' },
          ],
        },
      })
    )
    expect(services.quizzes.setKey).not.toHaveBeenCalled()
    el.remove()
  })

  it('a validation error keeps the form open with the message', async () => {
    const el = document.createElement('div')
    document.body.append(el)
    const services = makeServices(draft)
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    el.querySelector('[data-action=new-item][data-type=true_false]').click()
    const form = el.querySelector('form[data-form=item]')
    form.querySelector('[name=prompt]').value = 'ไม่มีเฉลย'
    form.requestSubmit()
    await settle()
    expect(el.querySelector('form[data-form=item] [data-form-error]').textContent).toContain('เฉลย')
    expect(services.quizzes.addItem).not.toHaveBeenCalled()
    el.remove()
  })

  it('published version is read-only and offers a new draft', async () => {
    const el = document.createElement('div')
    const services = makeServices([
      { id: 'V1', version_no: 1, status: 'published', published_at: '2026-11-03T00:00:00Z' },
    ])
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    expect(el.querySelector('[data-action=edit-item]')).toBeNull()
    expect(el.querySelector('[data-action=new-item]')).toBeNull()
    el.querySelector('[data-action=clone]').click()
    await settle()
    expect(services.quizzes.clone).toHaveBeenCalledWith('V1')
  })

  it('course quiz list escapes titles and creates through the service', async () => {
    const el = document.createElement('div')
    document.body.append(el)
    const services = makeServices(draft, {
      listForCourse: async () => [{ id: 'I1', code: 'Q1', title: XSS, instrument_versions: draft }],
      createInstrument: vi.fn(async () => ({ id: 'I2' })),
    })
    await renderCourseQuizzesView(el, { services }, { id: 'K' })
    expect(el.querySelector('img')).toBeNull()
    const form = el.querySelector('form[data-form=create-quiz]')
    form.querySelector('[name=code]').value = 'Q2'
    form.querySelector('[name=title]').value = 'หลังเรียน'
    form.requestSubmit()
    await settle()
    expect(services.quizzes.createInstrument).toHaveBeenCalledWith(course, {
      code: 'Q2',
      title: 'หลังเรียน',
      description: '',
    })
    expect(window.location.hash).toBe('#/courses/K/quizzes/I2')
    el.remove()
  })
})

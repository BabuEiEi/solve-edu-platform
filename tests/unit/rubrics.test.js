import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildCriterionDraft,
  defaultLevels,
  nextLevelId,
  rubricMaxScore,
  sortedLevels,
} from '../../src/features/rubrics/logic.js'
import { renderCourseRubricsView, renderRubricEditorView } from '../../src/features/rubrics/views.js'
import { createQuizBuilderService } from '../../src/features/quizzes/service.js'
import { AppError } from '../../src/core/errors.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
const lv = (...rows) =>
  rows.map(([label, score, description = ''], i) => ({ id: 'abcdef'[i], label, score, description }))

describe('criterion logic', () => {
  it('default levels: four, scoring 1–4', () => {
    const d = defaultLevels()
    expect(d.map((l) => [l.id, l.score])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
      ['d', '4'],
    ])
    expect(nextLevelId(['a', 'b'])).toBe('c')
    expect(nextLevelId([...'abcdefghijklmnopqrstuvwxyz'])).toBe('l1')
  })

  it('builds the item: levels with numeric scores, max score from the top level, optional texts left out', () => {
    const { item } = buildCriterionDraft({
      prompt: ' เป้าหมาย ',
      description: '',
      levels: [
        ...lv(['ปรับปรุง', '1'], ['ดี', '๓', ' ชัดเจน '], ['ดีมาก', '4.5']),
        { id: 'x', label: '', score: '', description: '' },
      ],
    })
    expect(item).toEqual({
      item_type: 'rubric_criterion',
      prompt: 'เป้าหมาย',
      media_path: null,
      max_score: 4.5,
      options_json: {
        levels: [
          { id: 'a', label: 'ปรับปรุง', score: 1 },
          { id: 'b', label: 'ดี', score: 3, description: 'ชัดเจน' },
          { id: 'c', label: 'ดีมาก', score: 4.5 },
        ],
      },
    })
    expect(item).not.toHaveProperty('answer')
    expect(
      buildCriterionDraft({ prompt: 'x', description: ' ใช้ดูแผน ', levels: lv(['ก', '0'], ['ข', '2']) }).item
        .options_json.description
    ).toBe('ใช้ดูแผน')
  })

  it.each([
    [{ prompt: '  ', levels: lv(['ก', '1'], ['ข', '2']) }, 'ชื่อเกณฑ์'],
    [{ prompt: 'x', levels: lv(['ก', '1']) }, '2–6 ระดับ'],
    [
      { prompt: 'x', levels: lv(...Array.from({ length: 7 }, (_, i) => ['ก' + i, String(i + 1)])) },
      '2–6 ระดับ',
    ],
    [{ prompt: 'x', levels: lv(['', '1'], ['ข', '2']) }, 'ระดับที่ 1: กรุณาพิมพ์ชื่อระดับ'],
    [{ prompt: 'x', levels: lv(['ก', 'หนึ่ง'], ['ข', '2']) }, 'ระดับที่ 1: คะแนนต้องเป็นตัวเลข'],
    [{ prompt: 'x', levels: lv(['ก', ''], ['ข', '2']) }, 'ระดับที่ 1: คะแนนต้องเป็นตัวเลข'],
    [{ prompt: 'x', levels: lv(['ก', '-1'], ['ข', '2']) }, 'ระหว่าง 0 ถึง 1,000'],
    [{ prompt: 'x', levels: lv(['ก', '1'], ['ข', '1']) }, 'คะแนนไม่ซ้ำ'],
    [{ prompt: 'x', levels: lv(['ก', '0'], ['ข', '0.0']) }, 'คะแนนไม่ซ้ำ'],
    [{ prompt: 'x', levels: lv(['ก'.repeat(101), '1'], ['ข', '2']) }, 'ยาวเกิน 100'],
  ])('%j → %s', (fields, expected) => {
    expect(() => buildCriterionDraft(fields)).toThrow(AppError)
    expect(() => buildCriterionDraft(fields)).toThrow(expected)
  })

  it('totals and ordering for display', () => {
    expect(rubricMaxScore([{ max_score: '4.00' }, { max_score: 2 }])).toBe(6)
    expect(rubricMaxScore()).toBe(0)
    const c = {
      options_json: {
        levels: [
          { score: 3, label: 'ดี' },
          { score: 1, label: 'ต่ำ' },
        ],
      },
    }
    expect(sortedLevels(c).map((l) => l.label)).toEqual(['ต่ำ', 'ดี'])
  })
})

describe('service: rubrics share the quiz service', () => {
  const client = (result = { data: [], error: null }) => {
    const calls = []
    const builder = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve(result)
          return (...args) => (calls.push([prop, ...args]), builder)
        },
      }
    )
    return { calls, from: (t) => (calls.push(['from', t]), builder), rpc: vi.fn() }
  }

  it('lists quizzes by default and rubrics on request', async () => {
    const a = client()
    await createQuizBuilderService(a).listForCourse('K')
    expect(a.calls).toContainEqual(['eq', 'instrument_type', 'quiz'])
    const b = client()
    await createQuizBuilderService(b).listForCourse('K', 'rubric')
    expect(b.calls).toContainEqual(['eq', 'instrument_type', 'rubric'])
  })

  it('creates a rubric with its type, and asks for the code and title in rubric words', async () => {
    const c = client({ data: { id: 'R1' }, error: null })
    const svc = createQuizBuilderService(c)
    await svc.createInstrument({ id: 'K', owner_org_id: 'ORG' }, { code: 'R', title: 'เกณฑ์' }, 'rubric')
    expect(c.calls.filter(([op]) => op === 'insert')[0][1]).toMatchObject({
      instrument_type: 'rubric',
      code: 'R',
    })
    await expect(
      svc.createInstrument({ id: 'K', owner_org_id: 'ORG' }, { code: '', title: 'x' }, 'rubric')
    ).rejects.toThrow('รหัส Rubric')
    const q = client({ data: { id: 'Q1' }, error: null })
    await createQuizBuilderService(q).createInstrument(
      { id: 'K', owner_org_id: 'ORG' },
      { code: 'Q', title: 'x' }
    )
    expect(q.calls.filter(([op]) => op === 'insert')[0][1]).not.toHaveProperty('instrument_type') // quizzes as before
  })
})

describe('rubric views', () => {
  afterEach(() => document.body.replaceChildren())
  const course = { id: 'K', title: 'หลักสูตรทดสอบ', owner_org_id: 'ORG', course_units: [] }
  const criterion = (id, prompt, levels) => ({
    id,
    item_type: 'rubric_criterion',
    prompt,
    max_score: Math.max(...levels.map((l) => l.score)),
    options_json: { levels },
  })
  const C1 = criterion('c1', XSS, [
    { id: 'a', label: 'ต่ำ', score: 1 },
    { id: 'b', label: 'สูง', score: 4, description: XSS },
  ])
  const makeServices = ({ status = 'draft', items = [C1], type = 'rubric' } = {}) => ({
    courses: { getAccess: async () => 'manage' },
    builder: { getCourseTree: async () => course },
    quizzes: {
      listForCourse: vi.fn(async () => [
        {
          id: 'R1',
          code: 'RUB',
          title: XSS,
          instrument_versions: [{ id: 'V1', version_no: 1, status: 'draft' }],
        },
      ]),
      createInstrument: vi.fn(async () => ({ id: 'NEW' })),
      getInstrument: vi.fn(async () => ({
        id: 'R1',
        course_id: 'K',
        code: 'RUB',
        title: 'เกณฑ์ตรวจแผน',
        instrument_type: type,
        instrument_versions: [{ id: 'V1', version_no: 1, status, published_at: '2026-11-05T01:00:00Z' }],
      })),
      getItems: vi.fn(async () => items),
      addItem: vi.fn(async (_v, item) => ({ id: 'new', ...item })),
      updateItem: vi.fn(async (id, item) => ({ id, ...item })),
      deleteItem: vi.fn(async () => {}),
      reorderItems: vi.fn(async () => {}),
      publish: vi.fn(async () => 'hash'),
      clone: vi.fn(async () => 'V2'),
    },
  })
  const open = async (services) => {
    const el = document.createElement('div')
    document.body.append(el)
    await renderRubricEditorView(el, { services }, { id: 'K', rubricId: 'R1' })
    return el
  }

  it('the list shows rubrics (text escaped) and a create form; creating goes to the editor', async () => {
    const services = makeServices()
    const el = document.createElement('div')
    document.body.append(el)
    await renderCourseRubricsView(el, { services }, { id: 'K' })
    expect(services.quizzes.listForCourse).toHaveBeenCalledWith('K', 'rubric')
    expect(el.querySelector('[data-rubrics] a').getAttribute('href')).toBe('#/courses/K/rubrics/R1')
    expect(el.querySelector('img')).toBeNull()
    el.querySelector('input[name=code]').value = 'RUB-X'
    el.querySelector('input[name=title]').value = 'เกณฑ์ใหม่'
    el.querySelector('form').requestSubmit()
    await settle()
    expect(services.quizzes.createInstrument).toHaveBeenCalledWith(
      course,
      expect.objectContaining({ code: 'RUB-X' }),
      'rubric'
    )
  })

  it('the editor shows criteria with levels from lowest to highest, escaped; a quiz id is refused', async () => {
    const el = await open(makeServices())
    expect(el.querySelectorAll('[data-criterion-id]')).toHaveLength(1)
    expect(el.querySelector('[data-criterion-id]').textContent).toContain('2 ระดับ · เต็ม 4 คะแนน')
    expect(el.querySelector('[data-ready]').textContent).toContain('พร้อมเผยแพร่ (1 เกณฑ์ · คะแนนเต็มรวม 4)')
    expect(el.querySelector('img')).toBeNull()
    const quiz = await open(makeServices({ type: 'quiz' }))
    expect(quiz.textContent).toContain('ไม่มีสิทธิ์')
  })

  it('adds a criterion: four levels offered, edits are sent as one criterion item', async () => {
    const services = makeServices({ items: [] })
    const el = await open(services)
    expect(el.querySelector('[data-ready]')).toBeNull()
    expect(el.querySelector('[data-action=publish]').disabled).toBe(true) // no criteria yet
    el.querySelector('[data-action=new-criterion]').click()
    const form = el.querySelector('form[data-form=criterion]')
    expect(form.querySelectorAll('[data-level-row]')).toHaveLength(4)
    form.querySelector('[name=prompt]').value = 'การกำหนดเป้าหมาย'
    const labels = form.querySelectorAll('[name=level_label]')
    labels[3].closest('[data-level-row]').querySelector('[data-action=remove-level]').click() // 3 left
    form.querySelector('[data-action=add-level]').click() // back to 4, new id is free
    expect([...form.querySelectorAll('[name=level_id]')].map((i) => i.value)).toEqual(['a', 'b', 'c', 'd'])
    const row = form.querySelectorAll('[data-level-row]')[3]
    row.querySelector('[name=level_label]').value = 'ยอดเยี่ยม'
    row.querySelector('[name=level_score]').value = '๕'
    form.requestSubmit()
    await settle()
    const [versionId, item, order] = services.quizzes.addItem.mock.calls[0]
    expect(versionId).toBe('V1')
    expect(item.max_score).toBe(5)
    expect(item.options_json.levels.map((l) => [l.id, l.label, l.score])).toEqual([
      ['a', 'ปรับปรุง', 1],
      ['b', 'พอใช้', 2],
      ['c', 'ดี', 3],
      ['d', 'ยอดเยี่ยม', 5],
    ])
    expect(order).toBe(1)
    expect(el.textContent).toContain('บันทึกเกณฑ์แล้ว')
  })

  it('level limits are explained; a bad score keeps the form and the typed text', async () => {
    const services = makeServices({ items: [] })
    const el = await open(services)
    el.querySelector('[data-action=new-criterion]').click()
    const form = el.querySelector('form[data-form=criterion]')
    for (let i = 0; i < 3; i++) form.querySelector('[data-action=add-level]').click() // 4 → 6 (stops at 6)
    expect(form.querySelectorAll('[data-level-row]')).toHaveLength(6)
    expect(form.querySelector('[data-form-error]').textContent).toContain('ไม่เกิน 6 ระดับ')
    const removeLast = () => [...form.querySelectorAll('[data-action=remove-level]')].at(-1).click()
    while (form.querySelectorAll('[data-level-row]').length > 2) removeLast()
    removeLast() // refused: two levels are the minimum
    expect(form.querySelectorAll('[data-level-row]')).toHaveLength(2)
    expect(form.querySelector('[data-form-error]').textContent).toContain('อย่างน้อย 2 ระดับ')
    form.querySelector('[name=prompt]').value = 'พิมพ์ไว้แล้ว'
    form.querySelectorAll('[name=level_score]')[0].value = 'สอง'
    form.requestSubmit()
    await settle()
    expect(services.quizzes.addItem).not.toHaveBeenCalled()
    expect(form.querySelector('[data-form-error]').textContent).toContain('คะแนนต้องเป็นตัวเลข')
    expect(el.querySelector('[name=prompt]').value).toBe('พิมพ์ไว้แล้ว')
  })

  it('edit shows the stored levels; move, delete and publish call the service; published is read-only', async () => {
    const services = makeServices({
      items: [
        C1,
        criterion('c2', 'หลักฐาน', [
          { id: 'x', label: 'ไม่มี', score: 0 },
          { id: 'y', label: 'มี', score: 2 },
        ]),
      ],
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const el = await open(services)
    el.querySelector('[data-criterion-id=c1] [data-action=edit-criterion]').click()
    const form = el.querySelector('form[data-form=criterion]')
    expect([...form.querySelectorAll('[name=level_score]')].map((i) => i.value)).toEqual(['1', '4'])
    form.querySelectorAll('[name=level_score]')[1].value = '5'
    form.requestSubmit()
    await settle()
    expect(services.quizzes.updateItem.mock.calls[0][0]).toBe('c1')
    expect(services.quizzes.updateItem.mock.calls[0][1].max_score).toBe(5)

    el.querySelector('[data-criterion-id=c1] [data-action=move-criterion][data-delta="1"]').click()
    await settle()
    expect(services.quizzes.reorderItems).toHaveBeenCalledWith('V1', ['c2', 'c1'])
    el.querySelector('[data-criterion-id=c2] [data-action=delete-criterion]').click()
    await settle()
    expect(services.quizzes.deleteItem).toHaveBeenCalledWith('c2')
    el.querySelector('[data-action=publish]').click()
    await settle()
    expect(services.quizzes.publish).toHaveBeenCalledWith('V1')

    const published = await open(makeServices({ status: 'published' }))
    expect(published.querySelector('[data-action=edit-criterion]')).toBeNull()
    expect(published.querySelector('[data-action=new-criterion]')).toBeNull()
    published.querySelector('[data-action=clone]').click()
    await settle()
    expect(published.textContent).toContain('สร้างฉบับร่างใหม่แล้ว')
    window.confirm.mockRestore()
  })
})

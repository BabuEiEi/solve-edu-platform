import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  applyPresentation,
  templateParts,
  slotsOf,
  readAnswers,
  buildResponses,
  answersFromResponses,
  itemMediaPaths,
} from '../../src/features/assessments/logic.js'
import { renderItem, handleOrderingClick } from '../../src/features/assessments/items.js'
import { renderAssessmentView } from '../../src/features/assessments/views.js'
import { render, html } from '../../src/shared/ui/html.js'
import { AppError } from '../../src/core/errors.js'

const XSS = '<img src=x onerror=alert(1)>'
const e = (id, text = id) => ({ id, text })

const ITEMS = [
  {
    id: 'ord',
    item_type: 'ordering',
    prompt: 'เรียง',
    max_score: 1,
    options_json: { options: [e('a', XSS), e('b'), e('c')] },
  },
  {
    id: 'mat',
    item_type: 'matching',
    prompt: 'จับคู่',
    max_score: 1,
    options_json: {
      left: [e('l1'), e('l2')],
      right: [e('r1'), e('r2'), { id: 'r3', image_path: 'Q/r3.png' }],
    },
  },
  {
    id: 'cls',
    item_type: 'classification',
    prompt: 'จัดกลุ่ม',
    max_score: 1,
    options_json: { categories: [e('c1'), e('c2')], items: [e('i1'), e('i2')] },
  },
  {
    id: 'mtx',
    item_type: 'choice_matrix',
    prompt: 'ตาราง',
    max_score: 1,
    options_json: { rows: [e('w1'), e('w2')], columns: [e('t', 'ถูก'), e('f', 'ผิด')] },
  },
  {
    id: 'dd',
    item_type: 'dropdown',
    prompt: 'เลือกคำ',
    max_score: 1,
    options_json: {
      text: 'ก {{b1}} ข {{b2}}',
      blanks: [
        { id: 'b1', options: [e('x'), e('y')] },
        { id: 'b2', options: [e('p'), e('q')] },
      ],
    },
  },
  {
    id: 'cz',
    item_type: 'cloze',
    prompt: 'เติมคำ',
    max_score: 1,
    options_json: { text: '{{b1}} = {{b2}} %', blanks: [{ id: 'b1' }, { id: 'b2', kind: 'number' }] },
  },
  {
    id: 'lb',
    item_type: 'image_labelling',
    prompt: 'ติดป้าย',
    max_score: 1,
    media_path: 'Q/pic.png',
    options_json: {
      markers: [
        { id: 'm1', x: 12.5, y: 40 },
        { id: 'm2', x: 80, y: 10 },
      ],
      labels: [e('p1'), e('p2'), e('p3')],
    },
  },
]
const MEDIA = { 'Q/pic.png': 'https://x.example.test/pic.png', 'Q/r3.png': 'https://x.example.test/r3.png' }

function formWith(items, draft = {}) {
  const form = document.createElement('form')
  render(form, html`${items.map((it, i) => renderItem(it, i, draft, MEDIA))}`)
  document.body.append(form)
  return form
}
const pick = (form, name, value) => {
  const select = form.querySelector(`select[name="${name}"]`)
  if (select) select.value = value
  else form.querySelector(`input[name="${name}"][value="${value}"]`).checked = true
}

afterEach(() => document.body.replaceChildren())

describe('presentation and templates', () => {
  it('applies the server order to items and to each list (dropdown blanks too)', () => {
    const shown = applyPresentation(ITEMS, {
      items: ['dd', 'ord', 'mat', 'cls', 'mtx', 'cz', 'lb'],
      lists: {
        ord: { options: ['c', 'a', 'b'] },
        mat: { right: ['r3', 'r1', 'r2'] },
        dd: { 'blank:b2': ['q', 'p'] },
      },
    })
    expect(shown.map((i) => i.id)).toEqual(['dd', 'ord', 'mat', 'cls', 'mtx', 'cz', 'lb'])
    expect(shown[1].options_json.options.map((o) => o.id)).toEqual(['c', 'a', 'b'])
    expect(shown[2].options_json.right.map((o) => o.id)).toEqual(['r3', 'r1', 'r2'])
    expect(shown[2].options_json.left.map((o) => o.id)).toEqual(['l1', 'l2']) // untouched
    expect(shown[0].options_json.blanks[1].options.map((o) => o.id)).toEqual(['q', 'p'])
    expect(ITEMS[0].options_json.options.map((o) => o.id)).toEqual(['a', 'b', 'c']) // input not mutated
    expect(applyPresentation(ITEMS, null)).toBe(ITEMS) // attempts from before 2C
  })

  it('splits a template into text and blanks; lists slots per type', () => {
    expect(templateParts('ก {{b1}} ข {{b2}}')).toEqual(['ก ', { blank: 'b1' }, ' ข ', { blank: 'b2' }])
    expect(slotsOf(ITEMS[1]).map((s) => [s.id, s.choices.length])).toEqual([
      ['l1', 3],
      ['l2', 3],
    ])
    expect(slotsOf(ITEMS[4]).map((s) => s.choices.map((c) => c.id))).toEqual([
      ['x', 'y'],
      ['p', 'q'],
    ])
    expect(itemMediaPaths(ITEMS)).toEqual(['Q/r3.png', 'Q/pic.png'])
  })
})

describe('rendering the seven types', () => {
  it('escapes every text; selects for text choices, picture cards when a choice has an image', () => {
    const form = formWith(ITEMS)
    expect(form.querySelector('img[src="x"]')).toBeNull() // XSS entry text escaped
    expect(form.querySelectorAll('[data-ordering] li')).toHaveLength(3)
    expect(form.querySelectorAll('input[type=radio][name="q:mat:l1"]')).toHaveLength(3) // r3 has an image → cards
    expect(form.querySelectorAll('input[type=radio][name="q:cls:i1"]')).toHaveLength(2) // classification: chips
    expect(form.querySelectorAll('input[type=radio][name="q:mtx:w2"]')).toHaveLength(2)
    expect(form.querySelector('select[name="q:dd:b1"]')).not.toBeNull()
    expect(form.querySelector('input[name="q:cz:b2"]').getAttribute('inputmode')).toBe('decimal')
    expect(form.querySelector('select[name="q:lb:m2"]')).not.toBeNull() // labels are text → select
    const marker = form.querySelector('[data-marker=m1]')
    expect(marker.getAttribute('style')).toBe('left:12.5%;top:40%')
    expect(marker.textContent.trim()).toBe('1')
    expect(form.querySelectorAll('img[src="https://x.example.test/pic.png"]')).toHaveLength(1) // not twice
  })

  it('form → responses → saved draft → the same form state', () => {
    const form = formWith(ITEMS)
    pick(form, 'q:mat:l1', 'r1')
    pick(form, 'q:cls:i1', 'c2')
    pick(form, 'q:cls:i2', 'c1')
    pick(form, 'q:mtx:w1', 't')
    pick(form, 'q:dd:b2', 'q')
    form.querySelector('[name="q:cz:b1"]').value = '  น้ำ '
    form.querySelector('[name="q:cz:b2"]').value = '๘๐'
    pick(form, 'q:lb:m1', 'p3')
    const answers = readAnswers(form, ITEMS)
    const { responses, unanswered, incomplete } = buildResponses(ITEMS, answers)
    expect(responses).toEqual({
      ord: { order: ['a', 'b', 'c'] },
      mat: { slots: { l1: 'r1' } },
      cls: { slots: { i1: 'c2', i2: 'c1' } },
      mtx: { slots: { w1: 't' } },
      dd: { slots: { b2: 'q' } },
      cz: { blanks: { b1: 'น้ำ', b2: 80 } },
      lb: { slots: { m1: 'p3' } },
    })
    expect(unanswered).toEqual([])
    expect(incomplete).toEqual([2, 4, 5, 7]) // matching, matrix, dropdown, labelling are partly answered

    const restored = formWith(ITEMS, answersFromResponses(ITEMS, responses))
    expect(buildResponses(ITEMS, readAnswers(restored, ITEMS)).responses).toEqual(responses)
  })

  it('nothing chosen → unanswered; a non-number in a number blank is an error unless lenient', () => {
    const blank = buildResponses(ITEMS.slice(1), {})
    expect(blank.unanswered).toEqual([1, 2, 3, 4, 5, 6])
    expect(() => buildResponses([ITEMS[5]], { cz: { b2: 'แปดสิบ' } })).toThrow(AppError)
    expect(() => buildResponses([ITEMS[5]], { cz: { b2: 'แปดสิบ' } })).toThrow('ข้อ 1 ช่องที่ 2')
    expect(
      buildResponses([ITEMS[5]], { cz: { b1: 'x', b2: 'แปดสิบ' } }, { lenient: true }).responses
    ).toEqual({
      cz: { blanks: { b1: 'x' } },
    })
  })
})

describe('ordering with buttons', () => {
  it('↑ / ↓ move the row, renumber, disable the ends, keep focus, announce, and notify the form', () => {
    const form = formWith([ITEMS[0]])
    const onInput = vi.fn()
    form.addEventListener('input', onInput)
    const rows = () => [...form.querySelectorAll('[data-order-id]')].map((li) => li.dataset.orderId)
    const down = form.querySelector('[data-order-id=a] [data-move="1"]')
    expect(form.querySelector('[data-order-id=a] [data-move="-1"]').disabled).toBe(true)
    down.click()
    handleOrderingClick({ target: down })
    expect(rows()).toEqual(['b', 'a', 'c'])
    expect(form.querySelector('[data-order-id=a] [data-pos]').textContent).toBe('2')
    expect(form.querySelector('[data-order-status]').textContent).toBe('ย้ายไปตำแหน่งที่ 2')
    expect(document.activeElement).toBe(down)
    expect(onInput).toHaveBeenCalledTimes(1)
    handleOrderingClick({ target: down })
    expect(rows()).toEqual(['b', 'c', 'a'])
    expect(down.disabled).toBe(true)
    expect(document.activeElement).toBe(form.querySelector('[data-order-id=a] [data-move="-1"]')) // focus moved to ↑
    expect(readAnswers(form, [ITEMS[0]])).toEqual({ ord: ['b', 'c', 'a'] })
  })
})

describe('exam page with the new types', () => {
  const assignment = {
    id: 'a1',
    title: 'ข้อสอบแบบใหม่',
    purpose: 'formative',
    open_at: null,
    close_at: '2027-03-31T16:59:00Z',
    attempt_limit: 1,
    passing_percent: null,
    status: 'published',
    instrument_version_id: 'v1',
    assessment_attempts: [{ id: 't1', attempt_no: 1, status: 'in_progress' }],
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T01:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('shows the server order, autosaves moves and picks, warns about partly answered items', async () => {
    const svc = {
      getAssignment: async () => assignment,
      start: async () => ({
        attempt_id: 't1',
        attempt_no: 1,
        started_at: '2026-11-20T01:00:00Z',
        resumed: true,
        deadline_at: null,
        server_now: '2026-11-20T01:00:00Z',
        draft: { mat: { slots: { l2: 'r2' } } },
        timed_out: false,
        draft_seq: 1_000_000,
        presentation: { items: ['mat', 'ord'], lists: { ord: { options: ['c', 'b', 'a'] } } },
      }),
      getItems: async () => [ITEMS[0], ITEMS[1]],
      saveDraft: vi.fn(async () => ({ saved_at: '2026-11-20T01:00:01Z', finalized: false, stale: false })),
      submit: vi.fn(async () => ({})),
    }
    const el = document.createElement('div')
    document.body.append(el)
    await renderAssessmentView(
      el,
      {
        services: { assessments: svc, assessmentMedia: { signedUrls: async () => MEDIA } },
        session: { user: { id: 'u1' } },
      },
      { id: 'a1' }
    )
    await vi.advanceTimersByTimeAsync(0)
    const form = el.querySelector('form[data-form=attempt]')
    expect([...form.querySelectorAll('fieldset[data-item-id]')].map((f) => f.dataset.itemId)).toEqual([
      'mat',
      'ord',
    ])
    expect([...form.querySelectorAll('[data-order-id]')].map((li) => li.dataset.orderId)).toEqual([
      'c',
      'b',
      'a',
    ])
    expect(form.querySelector('[name="q:mat:l2"][value=r2]').checked).toBe(true) // restored

    form.querySelector('[data-order-id=c] [data-move="1"]').click()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.saveDraft).toHaveBeenLastCalledWith(
      't1',
      { mat: { slots: { l2: 'r2' } }, ord: { order: ['b', 'c', 'a'] } },
      1_000_001
    )

    form.requestSubmit()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.submit).not.toHaveBeenCalled()
    expect(el.textContent).toContain('ตอบยังไม่ครบทุกช่อง 1 ข้อ (ข้อ 1)')
    form.requestSubmit()
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.submit).toHaveBeenCalledWith(
      't1',
      { mat: { slots: { l2: 'r2' } }, ord: { order: ['b', 'c', 'a'] } },
      1_000_002
    )
  })
})

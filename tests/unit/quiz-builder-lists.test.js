import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildItemDraft,
  defaultLists,
  nextEntryId,
  randomEntryId,
  LIST_EDITORS,
} from '../../src/features/quizzes/logic.js'
import { renderQuizEditorView } from '../../src/features/quizzes/views.js'
import { AppError } from '../../src/core/errors.js'

const XSS = '<img src=x onerror=alert(1)>'
// Deterministic "random" for repeatable shuffles
const seeded =
  (seed = 7) =>
  () =>
    ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const rows = (ids, prefix = '') => ids.map((id) => ({ id, text: `${prefix}${id}` }))
const base = { prompt: 'โจทย์', max_score: 1 }
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('builder logic for list types', () => {
  it('ids: random ones are [a-z0-9]{4} and unique; prefixed ones count up', () => {
    const r = seeded()
    const ids = []
    for (let i = 0; i < 30; i++) ids.push(randomEntryId(ids, r))
    expect(ids.every((id) => /^[a-z][a-z0-9]{3}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(30)
    // a random source stuck on one value must not hang: falls back to a free id
    expect(randomEntryId(['aaaa', 'z1'], () => 0)).toBe('z2')
  }, 1000)

  it('ordering: the key is the typed order; the stored list never is', () => {
    for (let seed = 1; seed < 40; seed++) {
      const { item, key } = buildItemDraft(
        'ordering',
        { ...base, lists: { options: rows(['p', 'q', 'r', 's']) }, orderIsKey: true },
        { random: seeded(seed) }
      )
      expect(key).toEqual({ answer: { order: ['p', 'q', 'r', 's'] }, scoring: { mode: 'partial' } })
      const stored = item.options_json.options.map((o) => o.id)
      expect([...stored].sort()).toEqual(['p', 'q', 'r', 's'])
      expect(stored).not.toEqual(['p', 'q', 'r', 's'])
    }
  })

  it('ordering: editing without ticking keeps the key (none sent); new items must tick', () => {
    expect(buildItemDraft('ordering', { ...base, lists: { options: rows(['p', 'q', 'r']) } }).key).toBeNull()
    expect(() =>
      buildItemDraft('ordering', { ...base, lists: { options: rows(['p', 'q', 'r']) } }, { requireKey: true })
    ).toThrow('กรุณากำหนดคำตอบที่ถูก')
    expect(() =>
      buildItemDraft('ordering', { ...base, lists: { options: rows(['p', 'q']) }, orderIsKey: true })
    ).toThrow(/3–10/)
  })

  it('matching: pairs become the key; the right column is stored so no partner sits beside its left entry', () => {
    for (let seed = 1; seed < 40; seed++) {
      const { item, key } = buildItemDraft(
        'matching',
        {
          ...base,
          lists: { left: rows(['l1', 'l2']), right: rows(['ab12', 'cd34', 'ef56']) },
          keySlots: { l1: 'ab12', l2: 'cd34' },
          mode: 'all_or_nothing',
        },
        { random: seeded(seed) }
      )
      expect(key).toEqual({
        answer: { slots: { l1: 'ab12', l2: 'cd34' } },
        scoring: { mode: 'all_or_nothing' },
      })
      const right = item.options_json.right.map((o) => o.id)
      expect(right[0] === 'ab12' && right[1] === 'cd34').toBe(false)
    }
  })

  it('slot keys: all or none; matching answers once each; choices must exist', () => {
    const lists = { categories: rows(['c1', 'c2']), items: rows(['i1', 'i2', 'i3']) }
    expect(buildItemDraft('classification', { ...base, lists }).key).toBeNull() // keep the stored key
    expect(() => buildItemDraft('classification', { ...base, lists, keySlots: { i1: 'c1' } })).toThrow(
      'ครบทุกช่อง'
    )
    expect(
      buildItemDraft('classification', { ...base, lists, keySlots: { i1: 'c1', i2: 'c2', i3: 'c1' } }).key
        .answer
    ).toEqual({ slots: { i1: 'c1', i2: 'c2', i3: 'c1' } })
    expect(() =>
      buildItemDraft('matching', {
        ...base,
        lists: { left: rows(['l1', 'l2']), right: rows(['a', 'b']) },
        keySlots: { l1: 'a', l2: 'a' },
      })
    ).toThrow('ใช้ได้ครั้งเดียว')
    expect(() =>
      buildItemDraft('matching', {
        ...base,
        lists: { left: rows(['l1', 'l2', 'l3']), right: rows(['a', 'b']) },
      })
    ).toThrow(AppError)
    expect(
      buildItemDraft('choice_matrix', {
        ...base,
        lists: { rows: rows(['w1']), columns: rows(['t', 'f']) },
        keySlots: { w1: 'zz' },
      }).key
    ).toBeNull()
  })

  it('empty rows are dropped; text is trimmed; defaults per type', () => {
    const { item } = buildItemDraft('classification', {
      ...base,
      lists: {
        categories: [
          { id: 'c1', text: ' ก ' },
          { id: 'c2', text: 'ข' },
          { id: 'c3', text: '  ' },
        ],
        items: rows(['i1', 'i2']),
      },
    })
    expect(item.options_json.categories).toEqual([
      { id: 'c1', text: 'ก' },
      { id: 'c2', text: 'ข' },
    ])
    expect(defaultLists('choice_matrix').columns.map((c) => c.text)).toEqual(['ถูก', 'ผิด'])
    expect(nextEntryId(LIST_EDITORS.matching[0], ['l1', 'l2'])).toBe('l3')
    expect(defaultLists('matching', seeded()).right).toHaveLength(4)
  })
})

describe('quiz editor: list-type forms', () => {
  const course = { id: 'K', title: 'AfL', owner_org_id: 'ORG', course_units: [] }
  const makeServices = (items = []) => ({
    courses: { getAccess: async () => 'manage' },
    builder: { getCourseTree: async () => course },
    assessmentMedia: {
      signedUrls: async () => ({}),
      upload: vi.fn(),
      list: vi.fn(async () => []),
      remove: vi.fn(),
    },
    quizzes: {
      getInstrument: vi.fn(async () => ({
        id: 'I1',
        course_id: 'K',
        code: 'Q',
        title: 'แบบทดสอบ',
        instrument_versions: [{ id: 'V1', version_no: 1, status: 'draft', published_at: null }],
      })),
      getItems: vi.fn(async () => items),
      keyStatus: vi.fn(async () => ({})),
      addItem: vi.fn(async (_v, item) => ({ id: 'new', ...item })),
      updateItem: vi.fn(async (id, item) => ({ id, ...item })),
      setKey: vi.fn(async () => {}),
      usedMediaPaths: vi.fn(async () => []),
    },
  })
  afterEach(() => document.body.replaceChildren())

  const open = async (services, type) => {
    const el = document.createElement('div')
    document.body.append(el)
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    el.querySelector(`[data-action=new-item][data-type=${type}]`).click()
    return el
  }
  const fill = (form, list, texts) =>
    [...form.querySelectorAll(`input[name="${list}_text"]`)].forEach((i, k) => {
      if (texts[k] !== undefined) {
        i.value = texts[k]
        i.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })

  it('ordering: rows in the correct order, ↑/↓ and remove, saved shuffled with the order as key', async () => {
    const services = makeServices()
    const el = await open(services, 'ordering')
    const form = el.querySelector('form[data-form=item]')
    form.querySelector('[name=prompt]').value = 'เรียงขั้นตอน'
    fill(form, 'options', ['สอง', 'หนึ่ง', 'สาม', XSS])
    // move "หนึ่ง" up to the top, then remove the 4th row
    form
      .querySelectorAll('[data-entry-row]')[1]
      .querySelector('[data-action=move-entry][data-delta="-1"]')
      .click()
    expect([...form.querySelectorAll('[data-pos]')].map((p) => p.textContent)).toEqual(['1', '2', '3', '4'])
    form.querySelectorAll('[data-entry-row]')[3].querySelector('[data-action=remove-entry]').click()
    expect(form.querySelector('[name=order_is_key]').checked).toBe(true)
    form.requestSubmit()
    await settle()
    const [, item] = services.quizzes.addItem.mock.calls[0]
    const [, key] = services.quizzes.setKey.mock.calls[0]
    const texts = (ids) => ids.map((id) => item.options_json.options.find((o) => o.id === id).text)
    expect(texts(key.answer.order)).toEqual(['หนึ่ง', 'สอง', 'สาม'])
    expect(item.options_json.options.map((o) => o.id)).not.toEqual(key.answer.order)
    expect(el.querySelector('img[src="x"]')).toBeNull()
  })

  it('matching: key menus follow what is typed on the right; picks become the key', async () => {
    const services = makeServices()
    const el = await open(services, 'matching')
    const form = el.querySelector('form[data-form=item]')
    form.querySelector('[name=prompt]').value = 'จับคู่'
    fill(form, 'left', ['ก', 'ข', 'ค'])
    fill(form, 'right', ['หนึ่ง', 'สอง', 'สาม', 'ตัวลวง'])
    const menus = form.querySelectorAll('select[data-key-select]')
    expect(menus).toHaveLength(3)
    expect([...menus[0].options].map((o) => o.textContent.trim())).toEqual([
      '— เฉลย —',
      'หนึ่ง',
      'สอง',
      'สาม',
      'ตัวลวง',
    ])
    const rightIds = [...form.querySelectorAll('input[name=right_id]')].map((i) => i.value)
    menus.forEach((m, k) => (m.value = rightIds[k]))
    form.requestSubmit()
    await settle()
    const [, key] = services.quizzes.setKey.mock.calls[0]
    expect(key.answer.slots).toEqual({ l1: rightIds[0], l2: rightIds[1], l3: rightIds[2] })
    expect(key.scoring).toEqual({ mode: 'partial' })
  })

  it('editing a classification without picking keeps the stored key (no setKey)', async () => {
    const existing = {
      id: 'it1',
      item_type: 'classification',
      prompt: 'จัดกลุ่ม',
      max_score: 1,
      display_order: 1,
      options_json: { categories: rows(['c1', 'c2'], 'กลุ่ม '), items: rows(['i1', 'i2'], 'รายการ ') },
    }
    const services = makeServices([existing])
    const el = document.createElement('div')
    document.body.append(el)
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    expect(el.querySelector('[data-list-preview]').textContent).toContain('กลุ่ม c1')
    el.querySelector('[data-action=edit-item]').click()
    const form = el.querySelector('form[data-form=item]')
    expect([...form.querySelectorAll('select[data-key-select]')].every((s) => s.value === '')).toBe(true) // key not shown
    fill(form, 'items', ['รายการ แก้'])
    form.requestSubmit()
    await settle()
    expect(services.quizzes.updateItem).toHaveBeenCalledWith(
      'it1',
      expect.objectContaining({ options_json: expect.any(Object) })
    )
    expect(services.quizzes.setKey).not.toHaveBeenCalled()
  })

  it('a list cannot grow past its maximum', async () => {
    const el = await open(makeServices(), 'choice_matrix')
    const form = el.querySelector('form[data-form=item]')
    const add = form.querySelector('[data-action=add-entry][data-list=columns]')
    for (let i = 0; i < 5; i++) add.click()
    expect(form.querySelectorAll('[data-entry-row][data-list=columns]')).toHaveLength(6)
    expect(form.querySelector('[data-form-error]').textContent).toContain('ไม่เกิน 6')
    expect(form.querySelectorAll('select[data-key-select] option')).toHaveLength(3 * 7) // 3 rows × (6 columns + placeholder)
  })
})

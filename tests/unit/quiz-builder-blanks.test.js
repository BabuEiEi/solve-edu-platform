import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildItemDraft, acceptedLines } from '../../src/features/quizzes/logic.js'
import { renderQuizEditorView } from '../../src/features/quizzes/views.js'

const base = { prompt: 'โจทย์', max_score: 1 }
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('builder logic: dropdown, cloze, labelling', () => {
  it('dropdown: blanks stored in reading order, options cleaned, key all-or-none', () => {
    const blanks = [
      {
        id: 'b2',
        options: [
          { id: 'a', text: 'ปลายภาค' },
          { id: 'b', text: ' ระหว่างเรียน ' },
          { id: 'c', text: ' ' },
        ],
        correct: 'b',
      },
      {
        id: 'b1',
        options: [
          { id: 'a', text: 'ข้อมูล' },
          { id: 'b', text: 'เกรด' },
        ],
        correct: 'a',
      },
    ]
    const { item, key } = buildItemDraft('dropdown', { ...base, text: 'ใช้ {{b1}} ใน {{b2}}', blanks })
    expect(item.options_json.blanks.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(item.options_json.blanks[1].options).toEqual([
      { id: 'a', text: 'ปลายภาค' },
      { id: 'b', text: 'ระหว่างเรียน' },
    ])
    expect(key).toEqual({ answer: { slots: { b1: 'a', b2: 'b' } } })
    expect(item.scoring_mode).toBe('partial')
    expect(() =>
      buildItemDraft('dropdown', {
        ...base,
        text: 'ใช้ {{b1}} ใน {{b2}}',
        blanks: [blanks[0], { ...blanks[1], correct: null }],
      })
    ).toThrow('ครบทุกช่อง')
    expect(
      buildItemDraft('dropdown', {
        ...base,
        text: 'ใช้ {{b1}} ใน {{b2}}',
        blanks: blanks.map((b) => ({ ...b, correct: null })),
      }).key
    ).toBeNull()
  })

  it('text and blank rows must agree', () => {
    const blanks = [
      {
        id: 'b1',
        options: [
          { id: 'a', text: 'x' },
          { id: 'b', text: 'y' },
        ],
      },
    ]
    expect(() => buildItemDraft('dropdown', { ...base, text: 'ไม่มีช่อง', blanks })).toThrow(
      'ยังไม่ได้ใส่ในข้อความ'
    )
    expect(() => buildItemDraft('dropdown', { ...base, text: '{{b1}} {{b9}}', blanks })).toThrow('ไม่รู้จัก')
    expect(() => buildItemDraft('dropdown', { ...base, text: '{{b1}} {{b1}}', blanks })).toThrow('ครั้งเดียว')
    expect(() => buildItemDraft('dropdown', { ...base, text: '{{B1}} {{b1}}', blanks })).toThrow('รูปแบบช่อง')
  })

  it('cloze: accepted answers one per line; number blanks take Thai digits; partial keys refused', () => {
    expect(acceptedLines(' AfL \n\nafl\n AfL ')).toEqual(['AfL', 'afl'])
    const blanks = [
      { id: 'b1', kind: 'text', accept: 'AfL\nการประเมินเพื่อการเรียนรู้' },
      { id: 'b2', kind: 'number', value: '๗๕', tolerance: '0.5' },
    ]
    const { item, key } = buildItemDraft('cloze', {
      ...base,
      text: '{{b1}} ร้อยละ {{b2}}',
      blanks,
      mode: 'all_or_nothing',
    })
    expect(item.options_json).toEqual({
      text: '{{b1}} ร้อยละ {{b2}}',
      blanks: [{ id: 'b1' }, { id: 'b2', kind: 'number' }],
    })
    expect(key).toEqual({
      answer: {
        blanks: { b1: { accept: ['AfL', 'การประเมินเพื่อการเรียนรู้'] }, b2: { value: 75, tolerance: 0.5 } },
      },
    })
    expect(item.scoring_mode).toBe('all_or_nothing')
    expect(() =>
      buildItemDraft('cloze', {
        ...base,
        text: '{{b1}} ร้อยละ {{b2}}',
        blanks: [blanks[0], { ...blanks[1], value: '' }],
      })
    ).toThrow('ครบทุกช่อง')
    expect(() =>
      buildItemDraft('cloze', {
        ...base,
        text: '{{b1}}',
        blanks: [{ id: 'b1', kind: 'number', value: 'เจ็ด' }],
      })
    ).toThrow('ตัวเลข')
  })

  it('labelling: needs the picture; markers rounded to 0.1 %, kept on the picture; key all-or-none', () => {
    const fields = {
      ...base,
      media_path: 'Q/p.png',
      markers: [
        { id: 'm1', x: '21.24', y: '25' },
        { id: 'm2', x: 80, y: 35.06 },
      ],
      lists: {
        labels: [
          { id: 'p1', text: 'เป้าหมาย' },
          { id: 'p2', text: 'หลักฐาน' },
          { id: 'p3', text: ' ' },
        ],
      },
      keySlots: { m1: 'p1', m2: 'p2' },
    }
    const { item, key } = buildItemDraft('image_labelling', fields)
    expect(item.options_json.markers).toEqual([
      { id: 'm1', x: 21.2, y: 25 },
      { id: 'm2', x: 80, y: 35.1 },
    ])
    expect(item.options_json.labels).toEqual([
      { id: 'p1', text: 'เป้าหมาย' },
      { id: 'p2', text: 'หลักฐาน' },
    ])
    expect(key.answer).toEqual({ slots: { m1: 'p1', m2: 'p2' } })
    expect(() => buildItemDraft('image_labelling', { ...fields, media_path: null })).toThrow('ต้องมีรูป')
    expect(() =>
      buildItemDraft('image_labelling', { ...fields, markers: [{ id: 'm1', x: 120, y: 0 }] })
    ).toThrow('0–100')
    expect(() => buildItemDraft('image_labelling', { ...fields, keySlots: { m1: 'p1' } })).toThrow(
      'ครบทุกจุด'
    )
  })
})

describe('quiz editor: dropdown, cloze, labelling forms', () => {
  const course = { id: 'K', title: 'AfL', owner_org_id: 'ORG', course_units: [] }
  const makeServices = (items = [], media = {}) => ({
    courses: { getAccess: async () => 'manage' },
    builder: { getCourseTree: async () => course },
    assessmentMedia: {
      signedUrls: async () => media,
      upload: vi.fn(async () => 'I1/new.png'),
      list: vi.fn(),
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
    },
  })
  afterEach(() => document.body.replaceChildren())
  const mount = async (services) => {
    const el = document.createElement('div')
    document.body.append(el)
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    return el
  }

  it('dropdown: "แทรกช่อง" inserts {{b2}} at the cursor and a blank row; removing it takes it out of the text', async () => {
    const services = makeServices()
    const el = await mount(services)
    el.querySelector('[data-action=new-item][data-type=dropdown]').click()
    const form = el.querySelector('form[data-form=item]')
    form.querySelector('[name=prompt]').value = 'เลือกคำ'
    const area = form.querySelector('[data-template]')
    area.value = 'ใช้ {{b1}} เพื่อ '
    area.setSelectionRange(area.value.length, area.value.length)
    form.querySelector('[data-action=insert-blank]').click()
    expect(area.value).toBe('ใช้ {{b1}} เพื่อ {{b2}}')
    expect(form.querySelectorAll('[data-blank-row]')).toHaveLength(2)
    form.querySelector('[data-action=add-bopt][data-blank=b2]').click()
    const set = (sel, v) => (form.querySelector(sel).value = v)
    set('[name=bopt_b1_text]', 'ข้อมูล')
    form.querySelectorAll('[name=bopt_b1_text]')[1].value = 'เกรด'
    form
      .querySelectorAll('[name=bopt_b2_text]')
      .forEach((i, k) => (i.value = ['จัดอันดับ', 'ปรับการสอน', 'ตัดเกรด'][k]))
    form.querySelector('[name=bkey_b1][value=a]').checked = true
    form.querySelector('[name=bkey_b2][value=b]').checked = true
    form.requestSubmit()
    await settle()
    const [, item] = services.quizzes.addItem.mock.calls[0]
    expect(item.options_json.text).toBe('ใช้ {{b1}} เพื่อ {{b2}}')
    expect(services.quizzes.setKey.mock.calls[0][1].answer).toEqual({ slots: { b1: 'a', b2: 'b' } })
  })

  it('cloze: switching a blank to number shows value/tolerance; removing a blank cleans the text', async () => {
    const services = makeServices()
    const el = await mount(services)
    el.querySelector('[data-action=new-item][data-type=cloze]').click()
    const form = el.querySelector('form[data-form=item]')
    form.querySelector('[name=prompt]').value = 'เติมคำ'
    const area = form.querySelector('[data-template]')
    area.value = '{{b1}} ร้อยละ '
    area.setSelectionRange(area.value.length, area.value.length)
    form.querySelector('[data-action=insert-blank]').click()
    const kind = form.querySelector('[data-blank-row=b2] [data-blank-kind]')
    kind.value = 'number'
    kind.dispatchEvent(new Event('input', { bubbles: true }))
    expect(form.querySelector('[data-blank-row=b2] [data-kind=number]').hidden).toBe(false)
    expect(form.querySelector('[data-blank-row=b2] [data-kind=text]').hidden).toBe(true)
    form.querySelector('[name=bacc_b1]').value = 'AfL'
    form.querySelector('[name=bval_b2]').value = '75'
    form.requestSubmit()
    await settle()
    expect(services.quizzes.setKey.mock.calls[0][1].answer).toEqual({
      blanks: { b1: { accept: ['AfL'] }, b2: { value: 75, tolerance: 0 } },
    })

    // a second form: removing a blank also removes its placeholder
    el.querySelector('[data-action=new-item][data-type=cloze]').click()
    const f2 = el.querySelector('form[data-form=item]')
    f2.querySelector('[data-action=insert-blank]').click()
    f2.querySelector('[data-action=remove-blank][data-blank=b1]').click()
    expect(f2.querySelector('[data-template]').value).not.toContain('{{b1}}')
  })

  it('labelling: tapping the picture places a numbered marker; X/Y move it; labels fill the key menus', async () => {
    const services = makeServices()
    const el = await mount(services)
    el.querySelector('[data-action=new-item][data-type=image_labelling]').click()
    const form = el.querySelector('form[data-form=item]')
    form.querySelector('[name=prompt]').value = 'ติดป้าย'
    // choosing a picture shows the preview (blob: URL)
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn()
    const file = new File([new Uint8Array([1])], 'p.png', { type: 'image/png' })
    const picker = form.querySelector('[name=media_file]')
    Object.defineProperty(picker, 'files', { value: [file] })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    const img = form.querySelector('[data-label-image]')
    expect(img.getAttribute('src')).toBe('blob:preview')
    expect(form.querySelector('[data-label-canvas]').hidden).toBe(false)

    img.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200 })
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 100 })) // 25 %, 25 %
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 420, clientY: 230 })) // 80 %, 90 %
    expect([...form.querySelectorAll('[name=marker_x]')].map((i) => i.value)).toEqual(['25', '80'])
    expect(form.querySelectorAll('[data-dot]')).toHaveLength(2)
    const x2 = form.querySelectorAll('[name=marker_x]')[1]
    x2.value = '70'
    x2.dispatchEvent(new Event('input', { bubbles: true }))
    expect(form.querySelectorAll('[data-dot]')[1].getAttribute('style')).toBe('left:70%;top:90%')

    const labels = form.querySelectorAll('[name=labels_text]')
    ;['เป้าหมาย', 'หลักฐาน', 'ตัวลวง'].forEach((t, k) => {
      labels[k].value = t
      labels[k].dispatchEvent(new Event('input', { bubbles: true }))
    })
    const menus = form.querySelectorAll('select[data-key-select]')
    expect([...menus[0].options].map((o) => o.textContent.trim())).toEqual([
      '— เฉลย —',
      'เป้าหมาย',
      'หลักฐาน',
      'ตัวลวง',
    ])
    // (jsdom cannot attach the chosen file to FormData; saving with an upload is covered by E2E)
  })

  it('editing a labelling item shows its picture and dots; no key picked keeps the stored key', async () => {
    const existing = {
      id: 'lb',
      item_type: 'image_labelling',
      prompt: 'ติดป้าย',
      max_score: 1,
      display_order: 1,
      media_path: 'I1/p.png',
      options_json: {
        markers: [{ id: 'm1', x: 10, y: 20 }],
        labels: [
          { id: 'p1', text: 'ก' },
          { id: 'p2', text: 'ข' },
        ],
      },
    }
    const services = makeServices([existing], { 'I1/p.png': 'https://x.example.test/p.png' })
    const el = await mount(services)
    expect(el.querySelector('[data-label-preview]').textContent).toContain('1 จุด')
    el.querySelector('[data-action=edit-item]').click()
    const form = el.querySelector('form[data-form=item]')
    expect(form.querySelector('[data-label-image]').getAttribute('src')).toBe('https://x.example.test/p.png')
    expect(form.querySelector('[data-dot]').getAttribute('style')).toBe('left:10%;top:20%')
    form.requestSubmit()
    await settle()
    expect(services.quizzes.updateItem).toHaveBeenCalledWith(
      'lb',
      expect.objectContaining({ media_path: 'I1/p.png', options_json: existing.options_json })
    )
    expect(services.quizzes.setKey).not.toHaveBeenCalled() // nothing picked: stored key kept

    // edit again: add a marker by tapping and pick every label → a new key is saved
    el.querySelector('[data-action=edit-item]').click()
    const f2 = el.querySelector('form[data-form=item]')
    const img = f2.querySelector('[data-label-image]')
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 })
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 50 }))
    const menus = f2.querySelectorAll('select[data-key-select]')
    expect(menus).toHaveLength(2)
    menus[0].value = 'p2'
    menus[1].value = 'p1'
    f2.requestSubmit()
    await settle()
    expect(services.quizzes.updateItem.mock.calls.at(-1)[1].options_json.markers).toEqual([
      { id: 'm1', x: 10, y: 20 },
      { id: 'm2', x: 75, y: 50 },
    ])
    expect(services.quizzes.setKey).toHaveBeenCalledWith('lb', { answer: { slots: { m1: 'p2', m2: 'p1' } } })
  })
})

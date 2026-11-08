import { describe, it, expect } from 'vitest'
import {
  analyzeQuizImport,
  analyzeQuizImportRows,
  importTemplateCsv,
  importTemplateRows,
  importTemplateXlsx,
  decodeCsvBytes,
  IMPORT_HEADER,
  MAX_IMPORT_ROWS,
} from '../../src/features/quizzes/importFile.js'
import { toCsv } from '../../src/shared/utils/csv.js'
import { readXlsxRows, toXlsx, XLSX_MIME } from '../../src/shared/utils/xlsx.js'

const row = (o = {}) => {
  const base = {
    ประเภท: 'เลือกตอบ',
    โจทย์: 'ข้อทดสอบ',
    คะแนน: '',
    ตัวเลือก1: 'ก',
    ตัวเลือก2: 'ข',
    ตัวเลือก3: '',
    ตัวเลือก4: '',
    ตัวเลือก5: '',
    ตัวเลือก6: '',
    คำตอบ: '2',
    คลาดเคลื่อน: '',
    หน่วย: '',
    วิธีให้คะแนน: '',
    ...o,
  }
  return IMPORT_HEADER.map((h) => base[h])
}
const csv = (...rows) => toCsv([IMPORT_HEADER, ...rows])
const one = (o) => analyzeQuizImport(csv(row(o)))

describe('template', () => {
  it('has the header and one example per type, and imports as-is', () => {
    const rows = importTemplateCsv()
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(rows[0]).toBe(IMPORT_HEADER.join(','))
    const r = analyzeQuizImport(importTemplateCsv())
    expect(r.errors).toEqual([])
    expect(r.items.map((i) => i.item_type)).toEqual(['mcq_single', 'mcq_multiple', 'true_false', 'numeric'])
    expect(r.total).toBe(4)
    expect(importTemplateCsv()).toMatch(/example|ตัวอย่าง/)
  })
})

describe('Excel template', () => {
  it('is the same table as the CSV template and imports as-is', () => {
    const rows = readXlsxRows(importTemplateXlsx())
    expect(rows[0]).toEqual(IMPORT_HEADER)
    const viaExcel = analyzeQuizImportRows(rows)
    expect(viaExcel.errors).toEqual([])
    expect(viaExcel).toEqual(analyzeQuizImport(importTemplateCsv()))
    expect(viaExcel.total).toBe(importTemplateRows().length - 1)
  })
  it('numbers typed in Excel (answer 2, score 1, 0.5) read like the same text in CSV', () => {
    const table = [IMPORT_HEADER, row({ ตัวเลือก1: 'ก', ตัวเลือก2: 'ข', คำตอบ: 2, คะแนน: 1 })]
    expect(analyzeQuizImportRows(readXlsxRows(toXlsx(table)))).toEqual(analyzeQuizImport(toCsv(table)))
  })
})

describe('reading rows', () => {
  it('mcq_single: options become a,b,… and the answer is the option number', () => {
    const r = one({ ตัวเลือก3: 'ค', คำตอบ: '๓', คะแนน: '๒' }) // Thai digits
    expect(r.errors).toEqual([])
    expect(r.items[0]).toEqual({
      item_type: 'mcq_single',
      prompt: 'ข้อทดสอบ',
      max_score: 2,
      options_json: {
        options: [
          { id: 'a', text: 'ก' },
          { id: 'b', text: 'ข' },
          { id: 'c', text: 'ค' },
        ],
      },
      answer: { correct: ['c'] },
    })
  })

  it('mcq_multiple: several answers and the scoring mode', () => {
    const r = one({ ประเภท: 'เลือกหลายคำตอบ', ตัวเลือก3: 'ค', คำตอบ: '1, 3', วิธีให้คะแนน: 'บางส่วน' })
    expect(r.items[0]).toMatchObject({ answer: { correct: ['a', 'c'] }, scoring_mode: 'partial' })
    expect(one({ ประเภท: 'mcq_multiple', คำตอบ: '1;2', วิธีให้คะแนน: 'ทั้งหมด' }).items[0].scoring_mode).toBe(
      'all_or_nothing'
    )
    expect(one({ ประเภท: 'เลือกหลายคำตอบ', คำตอบ: '1,2' }).items[0].scoring_mode).toBe('all_or_nothing') // the type's default, written out
  })

  it('true_false and numeric', () => {
    expect(one({ ประเภท: 'ถูกผิด', ตัวเลือก1: '', ตัวเลือก2: '', คำตอบ: 'ผิด' }).items[0]).toMatchObject({
      item_type: 'true_false',
      answer: { correct: false },
    })
    expect(one({ ประเภท: 'ถูกผิด', ตัวเลือก1: '', ตัวเลือก2: '', คำตอบ: 'ถูก' }).items[0].answer).toEqual({
      correct: true,
    })
    const n = one({
      ประเภท: 'ตัวเลข',
      ตัวเลือก1: '',
      ตัวเลือก2: '',
      คำตอบ: '๗๕',
      คลาดเคลื่อน: '0.5',
      หน่วย: '%',
    })
    expect(n.items[0]).toMatchObject({
      item_type: 'numeric',
      answer: { value: 75, tolerance: 0.5 },
      options_json: { unit: '%' },
    })
    expect(one({ ประเภท: 'ตัวเลข', ตัวเลือก1: '', ตัวเลือก2: '', คำตอบ: '3' }).items[0].answer).toEqual({
      value: 3,
      tolerance: 0,
    })
  })

  it('headers may be in another order and use alias names; extra columns are ignored', () => {
    const text = toCsv([
      ['เฉลย', 'คำถาม', 'หมายเหตุ', 'type', 'ตัวเลือก2', 'ตัวเลือก1'],
      ['1', 'ข้อหนึ่ง', 'ไม่ใช้', 'เลือกตอบ', 'ข', 'ก'],
    ])
    expect(analyzeQuizImport(text).items[0]).toMatchObject({ prompt: 'ข้อหนึ่ง', answer: { correct: ['a'] } })
  })

  it('formula-looking and quoted text stays text; commas and newlines inside quotes are kept', () => {
    const r = one({ โจทย์: 'บรรทัด 1\nบรรทัด 2, มีจุลภาค', ตัวเลือก1: '=1+1' })
    expect(r.errors).toEqual([])
    expect(r.items[0].prompt).toBe('บรรทัด 1\nบรรทัด 2, มีจุลภาค')
    expect(r.items[0].options_json.options[0].text).toBe("'=1+1") // as written by toCsv; the importer keeps what it reads
  })
})

describe('errors are per row (spreadsheet row numbers, header = 1)', () => {
  const msg = (o) => one(o).errors[0]

  it('names the row and what is wrong, in Thai; no items are returned when any row fails', () => {
    const r = analyzeQuizImport(csv(row(), row({ คำตอบ: '9' }), row({ ประเภท: 'อัตนัย' })))
    expect(r.items).toEqual([])
    expect(r.total).toBe(3)
    expect(r.errors).toEqual([
      { row: 3, message: 'คำตอบ 9 ไม่มีตัวเลือกที่ 9 (มี 1–2)' },
      { row: 4, message: 'ไม่รู้จักประเภท "อัตนัย" (ใช้: เลือกตอบ, เลือกหลายคำตอบ, ถูกผิด, ตัวเลข)' },
    ])
  })

  it.each([
    [{ ประเภท: '' }, 'ยังไม่ได้ใส่ประเภท'],
    [{ โจทย์: '' }, 'กรุณาพิมพ์โจทย์'],
    [{ คะแนน: 'สิบ' }, 'คะแนน "สิบ" ต้องเป็นตัวเลข'],
    [{ คะแนน: '0' }, 'คะแนนต่อข้อต้องมากกว่า 0'],
    [{ ตัวเลือก2: '' }, 'ต้องมีตัวเลือกอย่างน้อย 2 ช่อง'],
    [{ ตัวเลือก3: '', ตัวเลือก4: 'ง' }, 'มีช่องตัวเลือกว่างคั่นกลาง'],
    [{ คำตอบ: '' }, 'ยังไม่ได้ใส่คำตอบ'],
    [{ คำตอบ: 'ข' }, 'ต้องเป็นเลขลำดับของตัวเลือก'],
    [{ คำตอบ: '1,2' }, 'ข้อเลือกตอบมีคำตอบที่ถูกได้ 1 ตัวเลือก'],
    [{ ตัวเลือก3: '', ตัวเลือก4: 'ง', ตัวเลือก5: 'จ', คำตอบ: '3' }, 'มีช่องตัวเลือกว่างคั่นกลาง'],
    [{ วิธีให้คะแนน: 'บางส่วน' }, 'ใช้ได้เฉพาะข้อเลือกหลายคำตอบ'],
    [{ ประเภท: 'เลือกหลายคำตอบ', วิธีให้คะแนน: 'ครึ่งหนึ่ง' }, 'วิธีให้คะแนนใช้ได้: บางส่วน หรือ ทั้งหมด'],
    [{ ประเภท: 'ถูกผิด', คำตอบ: 'ถูก' }, 'ข้อถูกผิดไม่ต้องมีตัวเลือก'],
    [{ ประเภท: 'ถูกผิด', ตัวเลือก1: '', ตัวเลือก2: '', คำตอบ: 'บางที' }, 'ต้องเป็น ถูก หรือ ผิด'],
    [{ ประเภท: 'ตัวเลข', ตัวเลือก1: '', ตัวเลือก2: '', คำตอบ: 'หนึ่ง' }, 'ตัวเลข'],
    [{ ประเภท: 'ตัวเลข', ตัวเลือก1: '', ตัวเลือก2: '', คำตอบ: '1', คลาดเคลื่อน: '-1' }, 'ไม่ติดลบ'],
  ])('%j → %s', (o, expected) => {
    expect(msg(o).message).toContain(expected)
    expect(msg(o).row).toBe(2)
  })

  it('an answer pointing at an empty option column is refused', () => {
    expect(msg({ ประเภท: 'เลือกหลายคำตอบ', ตัวเลือก3: 'ค', คำตอบ: '1,4' }).message).toContain(
      'คำตอบ 4 ไม่มีตัวเลือกที่ 4'
    )
  })
})

describe('file-level problems (row 0) never throw', () => {
  it('empty file, header only, missing columns, too many rows', () => {
    expect(analyzeQuizImport('').errors[0]).toEqual({ row: 0, message: 'ไฟล์ว่าง' })
    expect(analyzeQuizImport(toCsv([IMPORT_HEADER])).errors[0].message).toContain('ยังไม่มีข้อสอบ')
    const noAnswer = analyzeQuizImport(
      toCsv([
        ['ประเภท', 'โจทย์', 'ตัวเลือก1', 'ตัวเลือก2'],
        ['เลือกตอบ', 'x', 'a', 'b'],
      ])
    )
    expect(noAnswer.errors[0].message).toContain('คำตอบ')
    expect(noAnswer.errors[0].message).toContain('แม่แบบ')
    expect(analyzeQuizImport('a,b\n1,2').errors[0].row).toBe(0)
    const many = analyzeQuizImport(csv(...Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => row())))
    expect(many.errors).toHaveLength(1)
    expect(many.errors[0].message).toContain(`ไม่เกิน ${MAX_IMPORT_ROWS}`)
    expect(analyzeQuizImport(csv(...Array.from({ length: MAX_IMPORT_ROWS }, () => row()))).errors).toEqual([])
  })
})

describe('decoding (Thai Excel writes Windows-874 by default)', () => {
  it('UTF-8 (with or without BOM) is read as UTF-8', () => {
    const utf8 = new TextEncoder().encode('ข้อสอบ')
    expect(decodeCsvBytes(utf8)).toBe('ข้อสอบ')
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]).buffer)).toBe('ข้อสอบ') // the BOM is dropped
  })

  it('Windows-874 bytes (not valid UTF-8) are read as Thai', () => {
    // ก า ร ป ร ะ เ ม ิ น in TIS-620 / Windows-874
    const bytes = new Uint8Array([0xa1, 0xd2, 0xc3, 0xbb, 0xc3, 0xd0, 0xe0, 0xc1, 0xd4, 0xb9])
    expect(decodeCsvBytes(bytes.buffer)).toBe('การประเมิน')
  })

  it('a whole Windows-874 file imports', () => {
    const asTis = (s) =>
      Uint8Array.from(
        [...s].map((ch) => (ch.charCodeAt(0) >= 0x0e01 ? ch.charCodeAt(0) - 0x0e01 + 0xa1 : ch.charCodeAt(0)))
      )
    const text = decodeCsvBytes(
      asTis('ประเภท,โจทย์,ตัวเลือก1,ตัวเลือก2,คำตอบ\r\nเลือกตอบ,การประเมิน,ก,ข,1\r\n').buffer
    )
    expect(analyzeQuizImport(text).items[0]).toMatchObject({
      prompt: 'การประเมิน',
      answer: { correct: ['a'] },
    })
  })
})

// ---------------------------------------------------------------------
// The import panel in the quiz editor, and the service call
// ---------------------------------------------------------------------
import { vi, afterEach } from 'vitest'
import { renderQuizEditorView } from '../../src/features/quizzes/views.js'
import { createQuizBuilderService } from '../../src/features/quizzes/service.js'
import { AppError } from '../../src/core/errors.js'

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
const course = { id: 'K', title: 'หลักสูตรทดสอบ', course_units: [] }

describe('import panel', () => {
  afterEach(() => document.body.replaceChildren())

  const makeServices = ({
    status = 'draft',
    importItems = vi.fn(async (_v, items) => items.length),
  } = {}) => ({
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
        instrument_versions: [{ id: 'V1', version_no: 1, status, published_at: null }],
      })),
      getItems: vi.fn(async () => []),
      keyStatus: vi.fn(async () => ({})),
      usedMediaPaths: vi.fn(async () => []),
      importItems,
    },
  })
  const open = async (services) => {
    const el = document.createElement('div')
    document.body.append(el)
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    return el
  }
  const choose = async (el, text) => {
    el.querySelector('[data-action=open-import]').click()
    const input = el.querySelector('input[name=import_file]')
    const file = new File([text], 'ข้อสอบ.csv', { type: 'text/csv' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }

  const chooseFile = async (el, file) => {
    el.querySelector('[data-action=open-import]')?.click() // already open on a second file
    const input = el.querySelector('input[name=import_file]')
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
  }

  it('reads an Excel file: preview of every item, then the import', async () => {
    const services = makeServices()
    const el = await open(services)
    await chooseFile(el, new File([importTemplateXlsx()], 'ข้อสอบ.xlsx', { type: XLSX_MIME }))
    expect(el.querySelector('input[name=import_file]').accept).toContain('.xlsx')
    expect(el.querySelector('[data-import-file]').textContent).toContain('ข้อสอบ.xlsx')
    expect(el.querySelector('[data-import-file]').textContent).toContain('4 แถว')
    expect(el.querySelector('[data-import-errors]')).toBeNull()
    el.querySelector('[data-action=confirm-import]').click()
    await settle()
    expect(services.quizzes.importItems).toHaveBeenCalledTimes(1)
    expect(services.quizzes.importItems.mock.calls[0][1].map((i) => i.item_type)).toEqual([
      'mcq_single',
      'mcq_multiple',
      'true_false',
      'numeric',
    ])
  })

  it('an old .xls and a broken .xlsx are explained in Thai and nothing can be imported', async () => {
    const el = await open(makeServices())
    await chooseFile(
      el,
      new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])], 'a.xls')
    )
    expect(el.querySelector('[data-import-errors]').textContent).toContain('.xls')
    expect(el.querySelector('[data-action=confirm-import]')).toBeNull()
    const broken = importTemplateXlsx().slice(0, 40) // a zip cut short
    await chooseFile(el, new File([broken], 'b.xlsx'))
    expect(el.querySelector('[data-import-errors]').textContent).toContain('ไม่ใช่ไฟล์ Excel')
    expect(el.querySelector('[data-action=confirm-import]')).toBeNull()
  })

  it('only a draft offers the import', async () => {
    expect((await open(makeServices())).querySelector('[data-action=open-import]')).not.toBeNull()
    expect(
      (await open(makeServices({ status: 'published' }))).querySelector('[data-action=open-import]')
    ).toBeNull()
  })

  it('a good file: preview of every row, no key shown, confirm sends the rows once', async () => {
    const services = makeServices()
    const el = await open(services)
    await choose(el, importTemplateCsv())
    expect(el.querySelector('[data-import-errors]')).toBeNull()
    expect(el.querySelectorAll('[data-import-row]')).toHaveLength(4)
    expect(el.querySelector('[data-import-file]').textContent).toContain('ข้อสอบ.csv')
    expect(el.querySelector('[data-import-preview]').textContent).not.toMatch(/เฉลย:|correct|answer/)
    el.querySelector('[data-action=confirm-import]').click()
    await settle()
    expect(services.quizzes.importItems).toHaveBeenCalledTimes(1)
    const [versionId, sent] = services.quizzes.importItems.mock.calls[0]
    expect(versionId).toBe('V1')
    expect(sent.map((i) => i.item_type)).toEqual(['mcq_single', 'mcq_multiple', 'true_false', 'numeric'])
    expect(el.textContent).toContain('นำเข้า 4 ข้อแล้ว')
    expect(el.querySelector('[data-import-panel]')).toBeNull() // panel closed after success
  })

  it('a file with errors: every problem listed by row, nothing to confirm, nothing sent', async () => {
    const services = makeServices()
    const el = await open(services)
    await choose(
      el,
      csv(
        row(),
        row({ คำตอบ: '9' }),
        row({ ประเภท: 'อัตนัย' }),
        row({ โจทย์: '<img src=x onerror=alert(1)>', คำตอบ: '' })
      )
    )
    const errors = [...el.querySelectorAll('[data-import-errors] li')].map((li) => li.textContent.trim())
    expect(errors).toHaveLength(3)
    expect(errors[0]).toContain('แถว 3:')
    expect(errors[1]).toContain('แถว 4:')
    expect(errors[2]).toContain('แถว 5:')
    expect(el.querySelector('[data-action=confirm-import]')).toBeNull()
    expect(el.querySelector('img')).toBeNull() // text from the file is escaped
    expect(services.quizzes.importItems).not.toHaveBeenCalled()
  })

  it('a server refusal keeps the panel and says nothing was imported', async () => {
    const importItems = vi.fn(async () => {
      throw new AppError('ระบบไม่รับข้อที่ 2 ในไฟล์ (แถว 3) — x · ยังไม่มีข้อใดถูกนำเข้า')
    })
    const el = await open(makeServices({ importItems }))
    await choose(el, importTemplateCsv())
    el.querySelector('[data-action=confirm-import]').click()
    await settle()
    expect(el.textContent).toContain('ยังไม่มีข้อใดถูกนำเข้า')
  })

  it('a file over 5 MB is refused before it is read', async () => {
    const services = makeServices()
    const el = await open(services)
    el.querySelector('[data-action=open-import]').click()
    const input = el.querySelector('input[name=import_file]')
    const big = { name: 'video.mp4', size: 6 * 1024 * 1024, arrayBuffer: vi.fn() }
    Object.defineProperty(input, 'files', { value: [big], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(big.arrayBuffer).not.toHaveBeenCalled()
    expect(el.querySelector('[data-import-errors]').textContent).toContain('ใหญ่เกิน 5 MB')
    expect(el.querySelector('[data-action=confirm-import]')).toBeNull()
  })

  it('the template button downloads the template; close returns to the add-item buttons', async () => {
    const created = []
    const spy = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (created.push(b), 'blob:x'))
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const el = await open(makeServices())
    el.querySelector('[data-action=open-import]').click()
    el.querySelector('[data-action=download-import-template]').click()
    expect(created).toHaveLength(1)
    expect(await created[0].text()).toContain('ประเภท,โจทย์,คะแนน')
    el.querySelector('[data-action=download-import-template-xlsx]').click()
    expect(created[1].type).toBe(XLSX_MIME)
    expect(readXlsxRows(new Uint8Array(await created[1].arrayBuffer()))[0]).toEqual(IMPORT_HEADER)
    el.querySelector('[data-action=close-import]').click()
    expect(el.querySelector('[data-action=new-item]')).not.toBeNull()
    spy.mockRestore()
  })
})

describe('service.importItems', () => {
  const client = (res) => ({ rpc: vi.fn(async () => res) })

  it('calls the RPC and returns the count', async () => {
    const c = client({ data: 3, error: null })
    expect(await createQuizBuilderService(c).importItems('V1', [{ a: 1 }])).toBe(3)
    expect(c.rpc).toHaveBeenCalledWith('import_instrument_items', { p_version: 'V1', p_items: [{ a: 1 }] })
  })

  it('a refused row: Thai message with the item and spreadsheet row, nothing imported', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = client({
      data: null,
      error: { code: '23514', message: 'invalid answer key', details: 'แถวที่ 2' },
    })
    const err = await createQuizBuilderService(c)
      .importItems('V1', [])
      .catch((e) => e)
    expect(err.message).toContain('ข้อที่ 2 ในไฟล์ (แถว 3)')
    expect(err.message).toContain('ยังไม่มีข้อใดถูกนำเข้า')
    expect(err.code).toBe('23514')
    const other = client({ data: null, error: { code: '42501', message: 'not allowed', details: null } })
    await expect(createQuizBuilderService(other).importItems('V1', [])).rejects.toThrow('ไม่มีสิทธิ์')
    console.error.mockRestore?.()
  })
})

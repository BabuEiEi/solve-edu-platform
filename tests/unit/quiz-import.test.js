import { describe, it, expect } from 'vitest'
import {
  analyzeQuizImport,
  importTemplateCsv,
  decodeCsvBytes,
  IMPORT_HEADER,
  MAX_IMPORT_ROWS,
} from '../../src/features/quizzes/importFile.js'
import { toCsv } from '../../src/shared/utils/csv.js'

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

import { toXlsx } from '../../shared/utils/xlsx.js'
import { parseCsv, toCsv, decodeCsvBytes } from '../../shared/utils/csv.js'
import { buildItemDraft } from './logic.js'
import { AppError } from '../../core/errors.js'

/**
 * Importing items from a CSV file (Phase 2D). Everything here runs in the
 * browser before anything is sent: decode the file, read the rows, build
 * each one with the same builder the editor uses (buildItemDraft), and
 * report every problem per row in Thai. The server checks again
 * (import_instrument_items) and saves all rows or none.
 *
 * Types: เลือกตอบ (mcq_single) · เลือกหลายคำตอบ (mcq_multiple) ·
 * ถูกผิด (true_false) · ตัวเลข (numeric). No pictures in a file.
 */
export const MAX_IMPORT_ROWS = 200
export const MAX_IMPORT_OPTIONS = 6
export const IMPORT_TEMPLATE_FILENAME = 'quiz-import-template.csv'
export const IMPORT_TEMPLATE_XLSX_FILENAME = 'quiz-import-template.xlsx'

const OPTION_COLUMNS = Array.from({ length: MAX_IMPORT_OPTIONS }, (_, i) => `ตัวเลือก${i + 1}`)
export const IMPORT_HEADER = [
  'ประเภท',
  'โจทย์',
  'คะแนน',
  ...OPTION_COLUMNS,
  'คำตอบ',
  'คลาดเคลื่อน',
  'หน่วย',
  'วิธีให้คะแนน',
]

const TYPE_NAMES = {
  mcq_single: ['เลือกตอบ', 'เลือกตอบ (คำตอบเดียว)', 'mcq_single'],
  mcq_multiple: ['เลือกหลายคำตอบ', 'mcq_multiple'],
  true_false: ['ถูกผิด', 'ถูก/ผิด', 'true_false'],
  numeric: ['ตัวเลข', 'numeric'],
}
const TYPE_LOOKUP = new Map(
  Object.entries(TYPE_NAMES).flatMap(([type, names]) => names.map((n) => [normalize(n), type]))
)
const HEADER_ALIASES = {
  ประเภท: ['ประเภท', 'type'],
  โจทย์: ['โจทย์', 'คำถาม', 'prompt'],
  คะแนน: ['คะแนน', 'score'],
  คำตอบ: ['คำตอบ', 'เฉลย', 'answer'],
  คลาดเคลื่อน: ['คลาดเคลื่อน', 'ค่าคลาดเคลื่อน', 'tolerance'],
  หน่วย: ['หน่วย', 'unit'],
  วิธีให้คะแนน: ['วิธีให้คะแนน', 'scoring'],
}
const TRUE_WORDS = new Set(['ถูก', 'จริง', 'true', 'yes', 'ใช่'])
const FALSE_WORDS = new Set(['ผิด', 'เท็จ', 'false', 'no', 'ไม่ใช่'])
const MODE_WORDS = new Map([
  ['บางส่วน', 'partial'],
  ['partial', 'partial'],
  ['ทั้งหมด', 'all_or_nothing'],
  ['ต้องถูกทั้งหมด', 'all_or_nothing'],
  ['all_or_nothing', 'all_or_nothing'],
])
const LETTERS = 'abcdefghij'
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

function normalize(v) {
  return String(v ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

const arabic = (s) => String(s).replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))

export { decodeCsvBytes }

/** The template as rows: header, then one fictitious example per type. */
export function importTemplateRows() {
  const blank = (n) => Array(n).fill('')
  const rows = [
    IMPORT_HEADER,
    [
      'เลือกตอบ',
      'ข้อใดเป็นเป้าหมายหลักของการประเมินเพื่อพัฒนา (ตัวอย่าง)',
      1,
      'ตัดสินผลปลายภาค',
      'ใช้ข้อมูลปรับการสอน',
      'จัดอันดับผู้เรียน',
      'รายงานผู้ปกครอง',
      ...blank(2),
      2,
      '',
      '',
      '',
    ],
    [
      'เลือกหลายคำตอบ',
      'ข้อใดเป็นลักษณะของข้อมูลป้อนกลับที่ดี (ตัวอย่าง)',
      2,
      'ทันเวลา',
      'เฉพาะเจาะจง',
      'บอกแค่คะแนน',
      ...blank(3),
      '1,2',
      '',
      '',
      'บางส่วน',
    ],
    [
      'ถูกผิด',
      'ควรแจ้งเกณฑ์ความสำเร็จก่อนเริ่มกิจกรรม (ตัวอย่าง)',
      1,
      ...blank(MAX_IMPORT_OPTIONS),
      'ถูก',
      '',
      '',
      '',
    ],
    [
      'ตัวเลข',
      'ห้องมีนักเรียน 40 คน ผ่านเกณฑ์ 30 คน คิดเป็นร้อยละเท่าใด (ตัวอย่าง)',
      1,
      ...blank(MAX_IMPORT_OPTIONS),
      75,
      0.5,
      '%',
      '',
    ],
  ]
  return rows
}

export const importTemplateCsv = () => toCsv(importTemplateRows())

/** The same template as an Excel file (bytes). */
export const importTemplateXlsx = () => toXlsx(importTemplateRows(), { sheetName: 'ข้อสอบ' })

function mapHeader(header) {
  const names = header.map(normalize)
  const columns = {}
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const at = names.findIndex((n) => aliases.map(normalize).includes(n))
    if (at >= 0) columns[key] = at
  }
  columns.options = OPTION_COLUMNS.map((c) => names.indexOf(normalize(c)))
  const missing = ['ประเภท', 'โจทย์', 'คำตอบ'].filter((k) => columns[k] === undefined)
  if (columns.options[0] < 0 || columns.options[1] < 0) missing.push('ตัวเลือก1, ตัวเลือก2')
  return { columns, missing }
}

function pickAnswerNumbers(raw, optionCount, texts) {
  const parts = arabic(raw)
    .split(/[,\s;/]+/)
    .filter(Boolean)
  if (!parts.length) throw new AppError('ยังไม่ได้ใส่คำตอบ')
  const ids = parts.map((p) => {
    if (!/^\d+$/.test(p)) throw new AppError(`คำตอบ "${p}" ต้องเป็นเลขลำดับของตัวเลือก เช่น 2 หรือ 1,3`)
    const n = Number(p)
    if (n < 1 || n > optionCount) throw new AppError(`คำตอบ ${n} ไม่มีตัวเลือกที่ ${n} (มี 1–${optionCount})`)
    if (!texts[n - 1]) throw new AppError(`คำตอบ ${n} ชี้ไปที่ช่องตัวเลือกที่ว่าง`)
    return LETTERS[n - 1]
  })
  return [...new Set(ids)]
}

function buildRow(cells, columns) {
  const cell = (k) => String(cells[columns[k]] ?? '').trim()
  const typeName = cell('ประเภท')
  const type = TYPE_LOOKUP.get(normalize(typeName))
  if (!type)
    throw new AppError(
      typeName
        ? `ไม่รู้จักประเภท "${typeName}" (ใช้: เลือกตอบ, เลือกหลายคำตอบ, ถูกผิด, ตัวเลข)`
        : 'ยังไม่ได้ใส่ประเภท'
    )
  const score = arabic(cell('คะแนน'))
  const fields = {
    prompt: cell('โจทย์'),
    max_score: score === '' ? 1 : Number(score),
  }
  if (Number.isNaN(fields.max_score)) throw new AppError(`คะแนน "${cell('คะแนน')}" ต้องเป็นตัวเลข`)

  const modeText = normalize(cell('วิธีให้คะแนน'))
  if (modeText) {
    if (type !== 'mcq_multiple') throw new AppError('วิธีให้คะแนนใช้ได้เฉพาะข้อเลือกหลายคำตอบ (เว้นว่างไว้)')
    if (!MODE_WORDS.has(modeText)) throw new AppError('วิธีให้คะแนนใช้ได้: บางส่วน หรือ ทั้งหมด')
    fields.mode = MODE_WORDS.get(modeText)
  }

  const answer = cell('คำตอบ')
  if (type === 'mcq_single' || type === 'mcq_multiple') {
    const texts = columns.options.map((c) => (c >= 0 ? String(cells[c] ?? '').trim() : ''))
    const filled = texts.filter(Boolean).length
    if (filled < 2) throw new AppError('ต้องมีตัวเลือกอย่างน้อย 2 ช่อง')
    const last = texts.findLastIndex(Boolean) + 1
    if (texts.slice(0, last).some((t) => !t))
      throw new AppError('มีช่องตัวเลือกว่างคั่นกลาง — ใส่ตัวเลือกต่อกันตั้งแต่ช่องแรก')
    fields.options = texts.slice(0, last).map((text, i) => ({ id: LETTERS[i], text }))
    fields.correct = pickAnswerNumbers(answer, last, texts)
    if (type === 'mcq_single' && fields.correct.length !== 1)
      throw new AppError('ข้อเลือกตอบมีคำตอบที่ถูกได้ 1 ตัวเลือก (ถ้ามีหลายคำตอบใช้ประเภท เลือกหลายคำตอบ)')
  } else if (type === 'true_false') {
    if (columns.options.some((c) => c >= 0 && String(cells[c] ?? '').trim()))
      throw new AppError('ข้อถูกผิดไม่ต้องมีตัวเลือก (เว้นว่างไว้)')
    const a = normalize(answer)
    if (TRUE_WORDS.has(a)) fields.tf = 'true'
    else if (FALSE_WORDS.has(a)) fields.tf = 'false'
    else throw new AppError('คำตอบของข้อถูกผิดต้องเป็น ถูก หรือ ผิด')
  } else {
    if (!answer) throw new AppError('ยังไม่ได้ใส่คำตอบ')
    fields.value = arabic(answer)
    fields.tolerance = arabic(cell('คลาดเคลื่อน'))
    fields.unit = cell('หน่วย')
  }

  const { item, key } = buildItemDraft(type, fields, { requireKey: true })
  return {
    item_type: type,
    prompt: item.prompt,
    max_score: item.max_score,
    options_json: item.options_json,
    ...(item.scoring_mode ? { scoring_mode: item.scoring_mode } : {}),
    answer: key.answer,
  }
}

/**
 * CSV text → { items, errors, total } (see analyzeQuizImportRows).
 */
export function analyzeQuizImport(text) {
  return analyzeQuizImportRows(parseCsv(text))
}

/**
 * Table rows (header first; from CSV or Excel) → { items, errors, total }.
 *   items  rows ready for import_instrument_items (only when errors is empty)
 *   errors [{ row, message }]  row = the row number in the spreadsheet (header = 1)
 *   total  data rows read
 * Never throws: a file-level problem is reported as an error with row 0.
 */
export function analyzeQuizImportRows(rows) {
  if (rows.length === 0) return { items: [], errors: [{ row: 0, message: 'ไฟล์ว่าง' }], total: 0 }
  const { columns, missing } = mapHeader(rows[0])
  if (missing.length)
    return {
      items: [],
      errors: [
        { row: 0, message: `ไม่พบคอลัมน์ที่จำเป็น: ${missing.join(', ')} — ใช้แม่แบบจากปุ่มดาวน์โหลด` },
      ],
      total: 0,
    }
  const data = rows.slice(1)
  if (data.length === 0)
    return { items: [], errors: [{ row: 0, message: 'มีแต่หัวตาราง ยังไม่มีข้อสอบ' }], total: 0 }
  if (data.length > MAX_IMPORT_ROWS)
    return {
      items: [],
      errors: [
        {
          row: 0,
          message: `นำเข้าได้ครั้งละไม่เกิน ${MAX_IMPORT_ROWS} ข้อ (ไฟล์มี ${data.length} ข้อ) — แบ่งเป็นหลายไฟล์`,
        },
      ],
      total: data.length,
    }

  const items = []
  const errors = []
  data.forEach((cells, i) => {
    try {
      items.push(buildRow(cells, columns))
    } catch (err) {
      errors.push({ row: i + 2, message: err instanceof AppError ? err.message : 'อ่านแถวนี้ไม่ได้' })
    }
  })
  return { items: errors.length ? [] : items, errors, total: data.length }
}

import { AppError } from '../../core/errors.js'
import { parseCsv } from './csv.js'
import { readXlsxRows, looksLikeXlsx, looksLikeOleFile, XLSX_LIMITS } from './xlsx.js'

/** `accept` for file pickers that take a table: Excel or CSV. */
export const TABLE_FILE_ACCEPT =
  '.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const MSG = {
  none: 'ยังไม่ได้เลือกไฟล์',
  tooBig: (mb) => `ไฟล์ใหญ่เกิน ${mb} MB — แบ่งเป็นหลายไฟล์แล้วนำเข้าทีละไฟล์`,
  notUtf8:
    'อ่านไฟล์ CSV ไม่ได้ เพราะไม่ได้บันทึกเป็น UTF-8 — ใน Excel เลือกบันทึกเป็น "CSV UTF-8" หรือนำเข้าไฟล์ Excel (.xlsx) แทน',
}

/**
 * Rows of an uploaded table file (Excel .xlsx or CSV), chosen by the file's
 * content, not its name. The file is untrusted: size is checked before it is
 * read, and the xlsx reader applies its own caps. CSV must be UTF-8 (a BOM is
 * fine); other encodings get a clear message instead of garbled Thai.
 */
export async function readTableFile(file, { limits = XLSX_LIMITS } = {}) {
  if (!file) throw new AppError(MSG.none)
  const mb = Math.round(limits.fileBytes / 1024 / 1024)
  if (typeof file.size === 'number' && file.size > limits.fileBytes) throw new AppError(MSG.tooBig(mb))
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > limits.fileBytes) throw new AppError(MSG.tooBig(mb))

  if (looksLikeXlsx(bytes) || looksLikeOleFile(bytes)) return readXlsxRows(bytes, limits)

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new AppError(MSG.notUtf8, { cause })
  }
  return parseCsv(text)
}

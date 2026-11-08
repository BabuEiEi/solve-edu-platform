import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { AppError } from '../../core/errors.js'

/**
 * Minimal Excel (.xlsx, Office Open XML) support for tables of plain values.
 *
 *   toXlsx(rows, opts)      rows (array of arrays) → .xlsx bytes (one sheet)
 *   readXlsxRows(bytes)     .xlsx bytes → rows of strings (first sheet only)
 *
 * Writing: strings are always stored as text (inline strings), never as
 * formulas, so a value like "=HYPERLINK(...)" cannot run in Excel; finite
 * numbers are stored as numbers so they can be summed.
 *
 * Reading treats the file as untrusted input: size caps before and after
 * unzipping (zip bombs), no DOCTYPE/ENTITY (XML entity tricks), first sheet
 * only, caps on rows and columns, and every failure becomes one Thai message.
 */

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const XLSX_LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024, // the uploaded file
  entryBytes: 20 * 1024 * 1024, // one unzipped part (declared size)
  totalBytes: 40 * 1024 * 1024, // all unzipped parts together
  rows: 10_000, // non-blank rows returned
  cols: 100,
})

const MAX_CELL_CHARS = 32_767 // Excel's own limit per cell

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

// characters XML 1.0 does not allow (C0 controls except tab/LF/CR, lone surrogates, U+FFFE/FFFF)
// (built from escaped text so the source holds no invisible characters)
const XML_INVALID = new RegExp(
  [
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]',
    '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])',
    '(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  ].join('|'),
  'g'
)

const esc = (s) =>
  String(s)
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 0 → A, 25 → Z, 26 → AA … */
export function columnName(index) {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** Excel sheet names: 1–31 chars, none of []:*?/\ and not starting/ending with ' */
export function safeSheetName(name) {
  const cleaned = String(name ?? '')
    .replace(XML_INVALID, '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    .trim()
  return cleaned || 'Sheet1'
}

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : ''
  if (value === null || value === undefined || value === '') return style ? `<c r="${ref}"${s}/>` : ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : ''
  }
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`
  const text = String(value).slice(0, MAX_CELL_CHARS)
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
}

// rough display width: characters of the longest line, within 8..60
function columnWidths(rows, count) {
  const widths = new Array(count).fill(8)
  for (const row of rows) {
    row.forEach((v, i) => {
      if (v === null || v === undefined) return
      const longest = Math.max(
        ...String(v)
          .split('\n')
          .map((line) => line.length)
      )
      widths[i] = Math.min(60, Math.max(widths[i], longest + 2))
    })
  }
  return widths
}

/**
 * Rows → .xlsx bytes (Uint8Array).
 *   sheetName    tab name (made safe)
 *   header       true (default): the first row is bold and frozen
 *   textColumns  indexes of columns formatted as Text ("@") so values typed
 *                later keep leading zeros (e.g. codes) — used by templates
 */
export function toXlsx(rows, { sheetName = 'Sheet1', header = true, textColumns = [] } = {}) {
  const data = (rows ?? []).map((r) => (Array.isArray(r) ? r : []))
  const colCount = data.reduce((m, r) => Math.max(m, r.length), 1)
  if (data.length > 1_048_576 || colCount > 16_384) throw new AppError('ข้อมูลมีขนาดเกินกว่าที่ Excel รองรับ')
  const textCols = new Set(textColumns)

  // styles: 0 normal · 1 bold (header) · 2 text format · 3 bold + text format
  const styleOf = (r, c) => (header && r === 0 ? 1 : 0) + (textCols.has(c) ? 2 : 0)

  const widths = columnWidths(data, colCount)
  const cols = widths
    .map(
      (w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${textCols.has(i) ? ' style="2"' : ''}/>`
    )
    .join('')

  const sheetRows = data
    .map((row, r) => {
      const cells = row.map((v, c) => cellXml(`${columnName(c)}${r + 1}`, v, styleOf(r, c))).join('')
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join('')

  const pane =
    header && data.length > 0
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'

  const sheet =
    `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `${pane}<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>`

  const workbook =
    `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets><sheet name="${esc(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`

  const styles =
    `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
    '<fonts count="2"><font><sz val="11"/><name val="Tahoma"/></font><font><b/><sz val="11"/><name val="Tahoma"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'

  const files = {
    '[Content_Types].xml': strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>'
    ),
    '_rels/.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    ),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'
    ),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8(styles),
  }
  return zipSync(files, { level: 6, mtime: new Date(2026, 0, 1) })
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

const MSG = {
  tooBig: (mb) => `ไฟล์ใหญ่เกิน ${mb} MB — แบ่งเป็นหลายไฟล์แล้วนำเข้าทีละไฟล์`,
  // the same binary container is used by .xls (Excel 97–2003) and by password-protected .xlsx
  oldXls:
    'ไฟล์ .xls (Excel 97–2003) หรือไฟล์ที่ตั้งรหัสผ่านยังไม่รองรับ — เปิดใน Excel แล้วบันทึกเป็น .xlsx (ไม่ตั้งรหัสผ่าน) หรือ .csv ก่อน',
  notXlsx: 'ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) หรือไฟล์เสียหาย',
  tooManyRows: (n) => `ไฟล์มีข้อมูลเกิน ${n.toLocaleString('th-TH')} แถว`,
  tooManyCols: (n) => `ไฟล์มีข้อมูลเกิน ${n} คอลัมน์`,
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] // .xls and password-protected .xlsx
const startsWith = (bytes, magic) => magic.every((b, i) => bytes[i] === b)

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new AppError(MSG.notXlsx)
}

/** Is this the start of a zip (xlsx) file? Used to choose xlsx vs csv. */
export function looksLikeXlsx(data) {
  const bytes = toBytes(data)
  return bytes.length >= 4 && startsWith(bytes, ZIP_MAGIC)
}

/** Is this an old binary Office file (.xls, or an encrypted .xlsx)? */
export function looksLikeOleFile(data) {
  const bytes = toBytes(data)
  return bytes.length >= 4 && startsWith(bytes, OLE_MAGIC)
}

function parseXml(text) {
  // No DTDs at all: rules out entity expansion and external entities whatever the parser does.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new AppError(MSG.notXlsx)
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new AppError(MSG.notXlsx)
  return doc
}

const byName = (node, local) => Array.from(node.getElementsByTagNameNS('*', local))
const childrenByName = (node, local) => Array.from(node.children).filter((c) => c.localName === local)

// text of <si> / <is>: plain <t>, or rich-text runs <r><t>; phonetic hints (<rPh>) are skipped
function richText(node) {
  let out = ''
  for (const child of Array.from(node.children)) {
    if (child.localName === 't') out += child.textContent
    else if (child.localName === 'r') for (const t of childrenByName(child, 't')) out += t.textContent
  }
  return out
}

/** "BC12" → 54 (0-based column), null if the reference is malformed */
function columnIndexOf(ref) {
  const m = /^([A-Z]{1,3})[0-9]+$/.exec(String(ref ?? '').toUpperCase())
  if (!m) return null
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// workbook.xml.rels target → zip path, e.g. "worksheets/sheet1.xml" or "/xl/worksheets/sheet1.xml"
function resolveTarget(target) {
  const t = String(target ?? '').replace(/\\/g, '/')
  const path = t.startsWith('/') ? t.slice(1) : `xl/${t}`
  const parts = []
  for (const p of path.split('/')) {
    if (p === '..') parts.pop()
    else if (p && p !== '.') parts.push(p)
  }
  return parts.join('/')
}

function unzipParts(bytes, limits) {
  const wanted = (name) =>
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/[^/]+\.xml$/.test(name)
  let total = 0
  let tooBig = false
  let files
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (!wanted(file.name)) return false
        // fflate inflates into a buffer of exactly the declared size, so
        // capping the declared size caps memory even if the header lies.
        total += file.originalSize
        if (file.originalSize > limits.entryBytes || total > limits.totalBytes) {
          tooBig = true
          return false
        }
        return true
      },
    })
  } catch (cause) {
    throw new AppError(MSG.notXlsx, { cause })
  }
  if (tooBig) throw new AppError(MSG.tooBig(Math.round(limits.entryBytes / 1024 / 1024)))
  return files
}

function firstSheetPath(files) {
  const wb = files['xl/workbook.xml']
  const rels = files['xl/_rels/workbook.xml.rels']
  if (wb && rels) {
    const first = byName(parseXml(strFromU8(wb)), 'sheet')[0]
    const rid = first && (first.getAttributeNS(NS_REL, 'id') || first.getAttribute('r:id'))
    const rel =
      rid && byName(parseXml(strFromU8(rels)), 'Relationship').find((r) => r.getAttribute('Id') === rid)
    if (rel) return resolveTarget(rel.getAttribute('Target'))
  }
  return 'xl/worksheets/sheet1.xml'
}

/**
 * .xlsx bytes → array of rows (arrays of strings), first sheet only.
 * Fully blank rows are skipped (like parseCsv); short rows are padded with ''
 * up to the last filled cell of that row. Numbers come back as Excel stored
 * them ("12.5"); dates come back as Excel serial numbers; formulas as their
 * last computed value; booleans as "TRUE"/"FALSE".
 */
export function readXlsxRows(data, limits = XLSX_LIMITS) {
  const bytes = toBytes(data)
  if (bytes.length > limits.fileBytes)
    throw new AppError(MSG.tooBig(Math.round(limits.fileBytes / 1024 / 1024)))
  if (looksLikeOleFile(bytes)) throw new AppError(MSG.oldXls)
  if (!looksLikeXlsx(bytes)) throw new AppError(MSG.notXlsx)

  const files = unzipParts(bytes, limits)
  const sheetPath = firstSheetPath(files)
  const sheetBytes = files[sheetPath]
  if (!sheetBytes) throw new AppError(MSG.notXlsx)

  const shared = files['xl/sharedStrings.xml']
    ? byName(parseXml(strFromU8(files['xl/sharedStrings.xml'])), 'si').map(richText)
    : []

  const rows = []
  for (const rowEl of byName(parseXml(strFromU8(sheetBytes)), 'row')) {
    const row = []
    let next = 0
    for (const c of childrenByName(rowEl, 'c')) {
      const at = c.hasAttribute('r') ? columnIndexOf(c.getAttribute('r')) : next
      if (at === null) throw new AppError(MSG.notXlsx)
      next = at + 1
      const type = c.getAttribute('t') || 'n'
      const v = childrenByName(c, 'v')[0]?.textContent ?? ''
      let value
      if (type === 's') {
        const i = Number(v)
        if (!Number.isInteger(i) || i < 0 || i >= shared.length) throw new AppError(MSG.notXlsx)
        value = shared[i]
      } else if (type === 'inlineStr') {
        const is = childrenByName(c, 'is')[0]
        value = is ? richText(is) : ''
      } else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v
      else value = v // n, str (formula text), e (error such as #N/A), d (ISO date)
      if (value === '') continue
      if (at >= limits.cols) throw new AppError(MSG.tooManyCols(limits.cols))
      while (row.length < at) row.push('')
      row[at] = value
    }
    if (!row.some((cell) => String(cell).trim() !== '')) continue
    if (rows.length >= limits.rows) throw new AppError(MSG.tooManyRows(limits.rows))
    rows.push(row)
  }
  return rows
}

import { html } from './html.js'
import { toCsv } from '../utils/csv.js'
import { toXlsx, XLSX_MIME } from '../utils/xlsx.js'

/** Save a Blob as a download through a short-lived blob: URL (no server round trip). */
function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Save text as a file through a short-lived blob: URL (no server round trip). */
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
  saveBlob(filename, new Blob([text], { type }))
}

/** Save binary data (e.g. an .xlsx) as a file. */
export function downloadBytes(filename, bytes, type = 'application/octet-stream') {
  saveBlob(filename, new Blob([bytes], { type }))
}

/**
 * Save a table (array of arrays, header first) as Excel or CSV.
 *   baseName   file name without extension
 *   format     'xlsx' | 'csv'
 *   sheetName  tab name of the Excel file
 */
export function downloadTable(baseName, rows, format, { sheetName = 'Sheet1' } = {}) {
  if (format === 'xlsx') return downloadBytes(`${baseName}.xlsx`, toXlsx(rows, { sheetName }), XLSX_MIME)
  return downloadText(`${baseName}.csv`, toCsv(rows))
}

/**
 * The pair of buttons used wherever a table can be exported. Labels are
 * "<label> (Excel)" and "<label> (CSV)"; handlers match on data-action
 * "<action>-xlsx" and "<action>-csv".
 */
export function exportButtons({ action, label, className = '' }) {
  return html`<span class="inline-flex flex-wrap gap-2" data-export-buttons="${action}">
    <button type="button" class="${className}" data-action="${action}-xlsx">${label} (Excel)</button>
    <button type="button" class="${className}" data-action="${action}-csv">${label} (CSV)</button>
  </span>`
}

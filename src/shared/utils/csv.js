/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), embedded
 * commas/newlines, CRLF/LF, UTF-8 BOM. Returns an array of string arrays;
 * fully blank lines are skipped.
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    if (row.some((c) => c.trim() !== '')) rows.push(row)
    row = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') ((field += '"'), i++)
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') endField()
    else if (ch === '\r') {
      if (src[i + 1] === '\n') i++
      endRow()
    } else if (ch === '\n') endRow()
    else field += ch
  }
  if (field !== '' || row.length) endRow()
  return rows
}

/**
 * Date display helpers. The database stores `timestamptz`; the UI always shows
 * Asia/Bangkok time with the Buddhist Era year (พ.ศ.).
 */
export const TIME_ZONE = 'Asia/Bangkok'
const BE_OFFSET = 543

export function toBuddhistYear(gregorianYear) {
  return Number(gregorianYear) + BE_OFFSET
}

export function toGregorianYear(buddhistYear) {
  return Number(buddhistYear) - BE_OFFSET
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** e.g. "2 พ.ย. 2569" */
export function formatThaiDate(value, { month = 'short' } = {}) {
  const d = toDate(value)
  if (!d) return '—'
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month,
    year: 'numeric',
  }).format(d)
}

/** e.g. "2 พ.ย. 2569 15:31 น." */
export function formatThaiDateTime(value) {
  const d = toDate(value)
  if (!d) return '—'
  const time = new Intl.DateTimeFormat('th-TH', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  return `${formatThaiDate(d)} ${time} น.`
}

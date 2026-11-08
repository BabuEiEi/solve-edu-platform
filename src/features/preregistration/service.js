import { unwrap, AppError } from '../../core/errors.js'
import { parseCsv } from '../../shared/utils/csv.js'

export const MAX_ROWS = 500

/** Column headers of the roster CSV — the single source for the template and the parser. */
export const TEMPLATE_HEADER = ['email', 'full_name', 'user_code']
export const TEMPLATE_FILENAME = 'roster-template.csv'

/** Template content: BOM (so Excel reads Thai as UTF-8) + header + fictitious example rows. */
export function rosterTemplateCsv() {
  const rows = [
    TEMPLATE_HEADER,
    ['teacher.one@example.test', 'ครู ตัวอย่าง หนึ่ง', 'T-0001'],
    ['teacher.two@example.test', 'ครู ตัวอย่าง สอง', 'T-0002'],
  ]
  return '\uFEFF' + rows.map((r) => r.join(',')).join('\r\n') + '\r\n'
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
// the same rule as profiles.user_code in the database
export const USER_CODE = /^[0-9A-Za-zก-๙._-]{1,50}$/
const HEADER_ALIASES = {
  email: ['email', 'e-mail', 'อีเมล'],
  full_name: ['full_name', 'name', 'ชื่อ', 'ชื่อ-นามสกุล', 'ชื่อ–นามสกุล'],
  user_code: ['user_code', 'code', 'รหัส', 'รหัสประจำตัว'],
}

const normEmail = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()

function columnIndex(header, key) {
  const names = HEADER_ALIASES[key].map((n) => n.toLowerCase())
  return header.findIndex((h) => names.includes(String(h).trim().toLowerCase()))
}

/**
 * Parse + validate roster CSV (pure; unit-tested).
 * Needs an `email` column; `full_name` optional. `existing` = emails already
 * pending for the same org/role/cohort. Returns { rows, errors, validCount }
 * where every row has { line, email, full_name, errors[] }.
 */
export function analyzeRoster(text, { existing = [] } = {}) {
  const table = parseCsv(text)
  if (table.length === 0) throw new AppError('ไฟล์ว่าง — ต้องมีหัวตาราง email และอย่างน้อย 1 แถว')
  const [header, ...body] = table
  const iEmail = columnIndex(header, 'email')
  const iName = columnIndex(header, 'full_name')
  const iCode = columnIndex(header, 'user_code')
  if (iEmail < 0) throw new AppError('ไม่พบคอลัมน์ email ในแถวแรกของไฟล์')
  if (body.length === 0) throw new AppError('ไม่มีข้อมูลหลังหัวตาราง')
  if (body.length > MAX_ROWS)
    throw new AppError(`นำเข้าได้ครั้งละไม่เกิน ${MAX_ROWS} แถว (ไฟล์นี้มี ${body.length})`)

  const taken = new Set(existing.map(normEmail))
  const seen = new Map()
  const seenCodes = new Map()
  const rows = body.map((cells, i) => {
    const line = i + 2 // 1-based, header is line 1
    const email = normEmail(cells[iEmail])
    const full_name = iName >= 0 ? String(cells[iName] ?? '').trim() : ''
    const user_code = iCode >= 0 ? String(cells[iCode] ?? '').trim() : ''
    const errors = []
    if (!email) errors.push('ไม่มีอีเมล')
    else if (!EMAIL.test(email) || email.length > 254) errors.push('รูปแบบอีเมลไม่ถูกต้อง')
    if (full_name.length > 200) errors.push('ชื่อยาวเกิน 200 ตัวอักษร')
    if (email && seen.has(email)) errors.push(`อีเมลซ้ำกับแถว ${seen.get(email)}`)
    else if (email) seen.set(email, line)
    if (email && taken.has(email)) errors.push('มีรายการรอผูกบัญชีของอีเมลนี้อยู่แล้ว')
    if (user_code) {
      if (!USER_CODE.test(user_code))
        errors.push('รหัสประจำตัวใช้ได้เฉพาะตัวอักษร ตัวเลข . _ - ไม่เว้นวรรค ไม่เกิน 50 ตัว')
      else if (seenCodes.has(user_code.toLowerCase()))
        errors.push(`รหัสประจำตัวซ้ำกับแถว ${seenCodes.get(user_code.toLowerCase())}`)
      else seenCodes.set(user_code.toLowerCase(), line)
    }
    return { line, email, full_name, user_code, errors }
  })
  const validCount = rows.filter((r) => r.errors.length === 0).length
  return { rows, validCount, errorCount: rows.length - validCount }
}

export function createPreregistrationService(client) {
  return {
    /** Pending emails for the same target, so the preview can flag duplicates. */
    async pendingEmails(organizationId, orgRole, cohortId) {
      let q = client
        .from('preregistrations')
        .select('email')
        .eq('status', 'pending')
        .eq('organization_id', organizationId)
        .eq('org_role', orgRole)
      q = cohortId ? q.eq('cohort_id', cohortId) : q.is('cohort_id', null)
      return unwrap(await q, 'prereg.pending').map((r) => r.email)
    },

    /** One bulk INSERT = one transaction: all rows or none. status/importer are server-stamped. */
    async importRows(rows, { organizationId, orgRole, cohortId = null, cohortRole = null }) {
      if (rows.length === 0) throw new AppError('ไม่มีแถวที่ถูกต้องให้นำเข้า')
      const batch_id = globalThis.crypto.randomUUID()
      unwrap(
        await client.from('preregistrations').insert(
          rows.map((r) => ({
            email: r.email,
            full_name: r.full_name,
            user_code: r.user_code || null,
            organization_id: organizationId,
            org_role: orgRole,
            cohort_id: cohortId,
            cohort_role: cohortId ? cohortRole : null,
            batch_id,
          }))
        ),
        'prereg.import'
      )
      return { batch_id, count: rows.length }
    },

    async list(status = 'pending') {
      return unwrap(
        await client
          .from('preregistrations')
          .select(
            'id, email, full_name, user_code, org_role, cohort_role, status, created_at, claimed_at, organizations ( name ), cohorts ( name )'
          )
          .eq('status', status)
          .order('created_at', { ascending: false })
          .limit(500),
        'prereg.list'
      )
    },

    async cancel(id) {
      const rows = unwrap(
        await client.from('preregistrations').update({ status: 'cancelled' }).eq('id', id).select('id'),
        'prereg.cancel'
      )
      if (!rows?.length) throw new AppError('ไม่พบรายการ หรือท่านไม่มีสิทธิ์ยกเลิก', { code: '42501' })
    },

    /** Called after sign-in; applies roster rows for the caller's VERIFIED email. */
    async claimMine() {
      return unwrap(await client.rpc('claim_my_preregistrations'), 'rpc.claim_my_preregistrations') ?? 0
    },
  }
}

import { AppError } from '../../core/errors.js'
import { fromBangkokInput } from '../assignments/logic.js'

/**
 * Programmes and cohorts (Phase 4g): labels, form → columns, and the schools
 * or districts a person may own a programme with. The database decides every
 * write (RLS + triggers); these only shape the form and catch typing mistakes
 * early with a Thai message.
 */

export const PROGRAM_STATUS = {
  draft: 'ร่าง',
  active: 'ดำเนินการ',
  closed: 'ปิดโครงการ',
  archived: 'เก็บถาวร',
}
export const COHORT_STATUS = {
  draft: 'ร่าง',
  open: 'เปิดรับ',
  in_progress: 'กำลังอบรม',
  closed: 'จบรุ่น',
  archived: 'เก็บถาวร',
}
export const ENROLLMENT_MODES = {
  closed: 'ปิดรับสมัคร (ผู้จัดการเพิ่มคนเอง)',
  approval: 'เปิดรับสมัคร — ต้องอนุมัติ',
  open: 'เปิดรับสมัคร — เข้าได้ทันที',
}

const text = (v) => String(v ?? '').trim()
const CODE = /^[0-9A-Za-zก-๙._-]{1,50}$/

/** Thai fiscal year (พ.ศ.): October starts the next one. */
export function currentFiscalYear(now = new Date()) {
  const bangkok = new Date(now.getTime() + 7 * 3600_000)
  return bangkok.getUTCFullYear() + 543 + (bangkok.getUTCMonth() >= 9 ? 1 : 0)
}

function period(fields, fromLabel, untilLabel) {
  const start = fromBangkokInput(fields.start_at, fromLabel)
  const end = fromBangkokInput(fields.end_at, untilLabel)
  if (start && end && new Date(end) < new Date(start))
    throw new AppError(`${untilLabel}ต้องไม่ก่อน${fromLabel}`)
  return { start_at: start, end_at: end }
}

/** Form fields → programmes columns. `isNew` adds the owner (it cannot change later). */
export function buildProgramPayload(fields, { isNew = false } = {}) {
  const code = text(fields.code)
  const name = text(fields.name)
  if (!CODE.test(code)) throw new AppError('รหัสโครงการ: ตัวอักษร ตัวเลข . _ - ไม่เว้นวรรค ไม่เกิน 50 ตัว')
  if (!name || name.length > 300) throw new AppError('กรุณากรอกชื่อโครงการ (ไม่เกิน 300 ตัวอักษร)')
  const year = Number(fields.fiscal_year)
  if (!Number.isInteger(year) || year < 2500 || year > 2700)
    throw new AppError('ปีงบประมาณ (พ.ศ.) ต้องอยู่ระหว่าง 2500–2700')
  if (!(fields.status in PROGRAM_STATUS)) throw new AppError('สถานะโครงการไม่ถูกต้อง')
  const description = text(fields.description)
  if (description.length > 5000) throw new AppError('รายละเอียดยาวเกิน 5,000 ตัวอักษร')
  const out = {
    code,
    name,
    description: description || null,
    fiscal_year: year,
    status: fields.status,
    ...period(fields, 'วันเริ่มโครงการ', 'วันสิ้นสุดโครงการ'),
  }
  if (isNew) {
    if (!text(fields.owner_org_id)) throw new AppError('กรุณาเลือกหน่วยงานเจ้าของโครงการ')
    out.owner_org_id = text(fields.owner_org_id)
  }
  return out
}

/** Form fields → cohorts columns (with the joining settings, 4g). */
export function buildCohortPayload(fields) {
  const code = text(fields.code)
  const name = text(fields.name)
  if (!CODE.test(code)) throw new AppError('รหัสรุ่น: ตัวอักษร ตัวเลข . _ - ไม่เว้นวรรค ไม่เกิน 50 ตัว')
  if (!name || name.length > 300) throw new AppError('กรุณากรอกชื่อรุ่น (ไม่เกิน 300 ตัวอักษร)')
  if (!(fields.status in COHORT_STATUS)) throw new AppError('สถานะรุ่นไม่ถูกต้อง')
  if (!(fields.enrollment_mode in ENROLLMENT_MODES)) throw new AppError('การรับสมัครไม่ถูกต้อง')
  const seats = text(fields.seat_limit)
  const seatLimit = seats === '' ? null : Number(seats)
  if (seatLimit !== null && (!Number.isInteger(seatLimit) || seatLimit < 1 || seatLimit > 10000))
    throw new AppError('จำนวนที่นั่งต้องเป็นจำนวนเต็ม 1–10,000 (เว้นว่าง = ไม่จำกัด)')
  const from = fromBangkokInput(fields.enroll_from, 'เปิดรับสมัครตั้งแต่')
  const until = fromBangkokInput(fields.enroll_until, 'ปิดรับสมัคร')
  if (from && until && new Date(until) <= new Date(from))
    throw new AppError('วันปิดรับสมัครต้องหลังวันเปิดรับสมัคร')
  return {
    code,
    name,
    status: fields.status,
    enrollment_mode: fields.enrollment_mode,
    seat_limit: seatLimit,
    enroll_from: from,
    enroll_until: until,
    ...period(fields, 'วันเริ่มรุ่น', 'วันจบรุ่น'),
  }
}

/**
 * Who sees a cohort in "รุ่นที่เปิดรับสมัคร" right now — the same rule as the
 * database (private.cohort_open_for_joining), as a sentence for the manager.
 */
export function joiningHint(program, cohort, now = new Date()) {
  if (cohort.enrollment_mode === 'closed')
    return { open: false, text: 'ปิดรับสมัคร — ผู้เรียนไม่เห็นรุ่นนี้ในรายการรับสมัคร' }
  const why = []
  if (program.status !== 'active') why.push('โครงการยังไม่อยู่ในสถานะ "ดำเนินการ"')
  if (!['open', 'in_progress'].includes(cohort.status))
    why.push('รุ่นต้องอยู่ในสถานะ "เปิดรับ" หรือ "กำลังอบรม"')
  if (cohort.enroll_from && now < new Date(cohort.enroll_from)) why.push('ยังไม่ถึงวันเปิดรับสมัคร')
  if (cohort.enroll_until && now >= new Date(cohort.enroll_until)) why.push('เลยวันปิดรับสมัครแล้ว')
  return why.length
    ? { open: false, text: `ตั้งค่าเปิดรับสมัครไว้ แต่ผู้เรียนยังไม่เห็น: ${why.join(' · ')}` }
    : { open: true, text: 'ผู้เรียนทุกคนที่บัญชีใช้งานได้เห็นรุ่นนี้ในเมนู "รุ่นที่เปิดรับสมัคร"' }
}

/**
 * Organizations the caller may own a programme with (programs_insert is the
 * real gate): platform admin and Staff — every active one; a district admin or
 * supervisor — their organizations and those below.
 */
export function ownerOrgChoices(orgs, context, caps) {
  if (caps?.isPlatformAdmin || caps?.isPlatformSupport) return orgs
  const mine = new Set(
    (context?.orgMemberships ?? [])
      .filter((m) => ['district_admin', 'supervisor'].includes(m.org_role))
      .map((m) => m.organization_id)
  )
  return orgs.filter((o) => mine.has(o.id) || mine.has(o.parent_id))
}

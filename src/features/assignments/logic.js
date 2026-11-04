import { AppError } from '../../core/errors.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { PURPOSE_LABELS, attemptPercent } from '../assessments/logic.js'

/**
 * Pure helpers for assigning tests to a cohort and reading the results.
 * Scores are never computed here — attempts.score / passed come from
 * submit_attempt; this only arranges them for display and export.
 */
export const ATTEMPT_LIMIT_MAX = 20
export const TIME_LIMIT_MAX = 600
export const GRACE_MAX = 60
export const GRACE_DEFAULT = 5

// The platform shows Asia/Bangkok time (UTC+7, no DST); <input type="datetime-local">
// values are read and written in that zone regardless of the device's zone.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000
const INPUT_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** ISO timestamp → "YYYY-MM-DDTHH:mm" in Bangkok time ('' for null/invalid). */
export function toBangkokInput(iso) {
  if (!iso) return ''
  if (INPUT_FORMAT.test(iso)) return iso // already an input value (re-shown after a failed save)
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  return new Date(t + BANGKOK_OFFSET_MS).toISOString().slice(0, 16)
}

/** "YYYY-MM-DDTHH:mm" (Bangkok) → ISO with +07:00; null when blank; AppError when malformed. */
export function fromBangkokInput(value, fieldLabel) {
  const s = String(value ?? '').trim()
  if (!s) return null
  if (!INPUT_FORMAT.test(s) || Number.isNaN(new Date(`${s}:00+07:00`).getTime()))
    throw new AppError(`${fieldLabel}: รูปแบบวันเวลาไม่ถูกต้อง`)
  return `${s}:00+07:00`
}

/**
 * The browser's date picker shows the Gregorian year; echo the chosen value
 * in the platform's format (พ.ศ., Bangkok) underneath. '' when blank/invalid.
 */
export function bangkokInputLabel(value) {
  const s = String(value ?? '').trim()
  if (!INPUT_FORMAT.test(s)) return ''
  return formatThaiDateTime(`${s}:00+07:00`)
}

/**
 * Form fields → columns for assessment_assignments (insert or update).
 * `locked` (an attempt exists) leaves out passing_percent, purpose and the
 * time limit, which the server freezes (SE004), so an unrelated edit still saves.
 */
export function buildAssignmentPayload(fields, { locked = false } = {}) {
  const title = String(fields.title ?? '').trim()
  if (!title) throw new AppError('กรุณาระบุชื่อที่ผู้เรียนเห็น')
  if (title.length > 300) throw new AppError('ชื่อยาวเกิน 300 ตัวอักษร')
  const instructions = String(fields.instructions ?? '').trim()
  if (instructions.length > 5000) throw new AppError('คำชี้แจงยาวเกิน 5,000 ตัวอักษร')

  const limit = Number(fields.attempt_limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > ATTEMPT_LIMIT_MAX)
    throw new AppError(`จำนวนครั้งต้องเป็นจำนวนเต็ม 1–${ATTEMPT_LIMIT_MAX}`)

  const openAt = fromBangkokInput(fields.open_at, 'เวลาเปิด')
  const closeAt = fromBangkokInput(fields.close_at, 'เวลาปิด')
  // Every assignment closes at a set time, so every attempt has a deadline (DB enforces it for published ones).
  if (!closeAt) throw new AppError('กรุณากำหนดวันเวลาปิดรับ')
  if (openAt && closeAt && new Date(closeAt) <= new Date(openAt))
    throw new AppError('เวลาปิดต้องอยู่หลังเวลาเปิด')

  const graceRaw = String(fields.grace_minutes ?? '').trim()
  const grace = graceRaw === '' ? GRACE_DEFAULT : Number(graceRaw)
  if (!Number.isInteger(grace) || grace < 0 || grace > GRACE_MAX)
    throw new AppError(`ช่วงผ่อนผันต้องเป็นจำนวนเต็ม 0–${GRACE_MAX} นาที`)

  const payload = {
    title,
    instructions: instructions || null,
    open_at: openAt,
    close_at: closeAt,
    attempt_limit: limit,
    grace_minutes: grace,
  }
  if (locked) return payload

  const timeRaw = String(fields.time_limit_minutes ?? '').trim()
  const timeLimit = timeRaw === '' ? null : Number(timeRaw)
  if (timeLimit !== null && (!Number.isInteger(timeLimit) || timeLimit < 1 || timeLimit > TIME_LIMIT_MAX))
    throw new AppError(`เวลาทำต้องเป็นจำนวนเต็ม 1–${TIME_LIMIT_MAX} นาที หรือเว้นว่าง`)

  if (!Object.hasOwn(PURPOSE_LABELS, fields.purpose)) throw new AppError('กรุณาเลือกประเภทแบบทดสอบ')
  const passRaw = String(fields.passing_percent ?? '').trim()
  let passing = null
  if (passRaw !== '') {
    passing = Number(passRaw)
    if (!Number.isFinite(passing) || passing < 0 || passing > 100)
      throw new AppError('เกณฑ์ผ่านต้องเป็นตัวเลข 0–100 หรือเว้นว่าง')
  }
  return { ...payload, purpose: fields.purpose, passing_percent: passing, time_limit_minutes: timeLimit }
}

/**
 * UI hint only (RLS decides): may the caller change this cohort's assignments?
 * Mirrors authz.is_cohort_assessor — program managers, coordinators, trainers.
 */
export function canAssessHint(caps, context, cohortId) {
  if (caps?.isPlatformAdmin || caps?.canManagePrograms) return true
  return (context?.cohortMemberships ?? []).some(
    (m) => m.cohort_id === cohortId && ['trainer', 'coordinator'].includes(m.cohort_role)
  )
}

/** Cohorts where the caller only learns — their assignments belong on "my tests", not the staff list. */
export function traineeOnlyCohorts(context) {
  const roles = new Map()
  for (const m of context?.cohortMemberships ?? []) {
    roles.set(m.cohort_id, [...(roles.get(m.cohort_id) ?? []), m.cohort_role])
  }
  return new Set([...roles].filter(([, r]) => r.every((x) => x === 'trainee')).map(([id]) => id))
}

/**
 * Rows of assignment_results (one per person, already scoped by RLS) → the
 * table rows the page shows, plus cohort totals. The summary uses each
 * person's best submitted attempt.
 */
export function summarizeResults(results, assignment) {
  const rows = results.map((r) => ({
    user_id: r.user_id,
    name: r.name || 'ไม่ทราบชื่อ',
    offRoster: !r.on_roster,
    used: r.used,
    extra: r.extra,
    limit: (assignment?.attempt_limit ?? 0) + r.extra,
    autoSubmitted: r.auto_submitted,
    status: r.submitted ? 'submitted' : r.used ? 'in_progress' : 'not_started',
    inProgress: r.in_progress,
    first: r.first_score === null ? null : { score: r.first_score, max_score: r.first_max },
    best:
      r.best_score === null ? null : { score: r.best_score, max_score: r.best_max, passed: r.best_passed },
    lastSubmittedAt: r.last_submitted_at,
  }))
  rows.sort((a, b) => a.name.localeCompare(b.name, 'th'))

  const done = rows.filter((r) => r.best)
  const judged = assignment?.passing_percent !== null && assignment?.passing_percent !== undefined
  const average = done.length
    ? Math.round((done.reduce((s, r) => s + attemptPercent(r.best), 0) * 100) / done.length) / 100
    : null
  return {
    rows,
    summary: {
      total: rows.length,
      started: rows.filter((r) => r.used > 0).length,
      submitted: done.length,
      average,
      passed: judged ? done.filter((r) => r.best.passed === true).length : null,
    },
  }
}

// ---------------------------------------------------------------------
// Item analysis (item_statistics). Rough guides for reading the numbers,
// commonly used thresholds — not hard rules.
// ---------------------------------------------------------------------
export function difficultyLabel(p) {
  if (p === null || p === undefined) return ''
  if (p < 0.2) return 'ยากมาก'
  if (p > 0.8) return 'ง่ายมาก'
  return 'พอเหมาะ'
}

export function discriminationLabel(d) {
  if (d === null || d === undefined) return ''
  if (d < 0) return 'ติดลบ — ตรวจโจทย์/เฉลย'
  if (d < 0.2) return 'ต่ำ — ควรปรับปรุง'
  if (d < 0.4) return 'พอใช้'
  return 'ดี'
}

export function reliabilityLabel(x) {
  if (x === null || x === undefined) return 'คำนวณไม่ได้'
  if (x >= 0.9) return 'สูงมาก'
  if (x >= 0.7) return 'ยอมรับได้'
  if (x >= 0.5) return 'ค่อนข้างต่ำ'
  return 'ต่ำ'
}

const CHOICE_NAMES = { true: 'ถูก', false: 'ผิด' }

/** {"b":4,"a":1} → "a 1 · b 4"; true/false in Thai. */
export function choicesText(choices = {}) {
  return Object.keys(choices)
    .sort()
    .map((k) => `${CHOICE_NAMES[k] ?? k} ${choices[k]}`)
    .join(' · ')
}

/** item_statistics → CSV rows (header first). */
export function itemStatsCsvRows(stats) {
  return [
    [
      'ข้อ',
      'ประเภท',
      'โจทย์',
      'คะแนนเต็ม',
      'ค่าความยาก (p)',
      'อำนาจจำแนก (D)',
      'r (item-total)',
      'ตัวเลือกที่ถูกเลือก',
      'ไม่ตอบ',
    ],
    ...(stats.items ?? []).map((it, i) => [
      i + 1,
      it.item_type,
      it.prompt,
      Number(it.max_score),
      it.p,
      it.d,
      it.r_it ?? '',
      choicesText(it.choices),
      it.blank,
    ]),
  ]
}

const RESULT_TEXT = { true: 'ผ่าน', false: 'ไม่ผ่าน' }
const STATUS_TEXT = { submitted: 'ส่งแล้ว', in_progress: 'กำลังทำ', not_started: 'ยังไม่เริ่ม' }

/** Results table → CSV rows (header first). Timestamps stay ISO so spreadsheets can sort them. */
export function resultsCsvRows(rows) {
  return [
    [
      'ชื่อ',
      'สถานะ',
      'จำนวนครั้งที่ใช้',
      'สิทธิ์ทำเพิ่ม',
      'ส่งอัตโนมัติ (ครั้ง)',
      'ครั้งแรก (%)',
      'สูงสุด (%)',
      'คะแนนสูงสุด',
      'คะแนนเต็ม',
      'ผล',
      'ส่งล่าสุด',
    ],
    ...rows.map((r) => [
      r.name,
      STATUS_TEXT[r.status],
      r.used,
      r.extra,
      r.autoSubmitted,
      r.first ? attemptPercent(r.first) : '',
      r.best ? attemptPercent(r.best) : '',
      r.best ? Number(r.best.score) : '',
      r.best ? Number(r.best.max_score) : '',
      r.best ? (RESULT_TEXT[r.best.passed] ?? '') : '',
      r.lastSubmittedAt ?? '',
    ]),
  ]
}

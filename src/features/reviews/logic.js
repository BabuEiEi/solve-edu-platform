import { AppError } from '../../core/errors.js'
import { attemptState, reviewsOf, scoreText, STATE_LABELS } from '../submissions/logic.js'

/**
 * The reviewer's side of tasks: who is waiting, what the review form sends,
 * and the CSV. Scores are never computed here — the server adds up the
 * levels (save_task_review) — and the form only offers levels of the rubric.
 */
export const FILTERS = {
  all: 'ทั้งหมด',
  waiting: 'รอตรวจ',
  revise: 'ส่งกลับแก้ไข',
  passed: 'ผ่านแล้ว',
  none: 'ยังไม่ส่ง',
}
export const NONE_STATE = 'none'

const displayName = (p) => (p?.display_name || p?.full_name || '').trim() || 'ไม่ทราบชื่อ'
export { displayName }

/**
 * One row per person: their latest submitted attempt and the review in force
 * for it. `roster` (assessors only) adds people who have not submitted.
 *   submissions: [{id, user_id, attempt_no, status:'submitted', submitted_at, is_late, profiles}]
 *   reviews: released reviews [{submission_id, outcome, score, max_score, released_at}]
 */
export function groupByPerson(submissions = [], reviews = [], roster = []) {
  const byUser = new Map()
  for (const s of submissions) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s])
  const rows = [...byUser].map(([userId, list]) => {
    const sorted = [...list].sort((a, b) => b.attempt_no - a.attempt_no)
    const latest = sorted[0]
    const { current } = reviewsOf(reviews.filter((r) => r.submission_id === latest.id))
    return {
      user_id: userId,
      name: displayName(latest.profiles),
      attempts: sorted.length,
      latest,
      review: current,
      state: attemptState(latest, current),
      is_late: Boolean(latest.is_late),
      submitted_at: latest.submitted_at,
    }
  })
  for (const person of roster) {
    if (byUser.has(person.user_id)) continue
    rows.push({
      user_id: person.user_id,
      name: displayName(person.profiles),
      attempts: 0,
      latest: null,
      review: null,
      state: NONE_STATE,
      is_late: false,
      submitted_at: null,
    })
  }
  const order = { waiting: 0, revise: 1, passed: 2, [NONE_STATE]: 3 }
  return rows.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name, 'th'))
}

export const filterRows = (rows, filter) => (filter === 'all' ? rows : rows.filter((r) => r.state === filter))

export const countWaiting = (rows) => rows.filter((r) => r.state === 'waiting').length

/**
 * What the review form sent → arguments of save_task_review.
 *   fields: { levels: {criterionId: levelId}, comments: {criterionId: text}, feedback, outcome, reason }
 *   release: true checks what release_task_review will require (the server checks again)
 */
export function buildReviewPayload(fields, criteria = [], { release = false, regrade = false } = {}) {
  const scores = {}
  for (const c of criteria) {
    const level = fields.levels?.[c.id]
    if (!level) continue
    const comment = String(fields.comments?.[c.id] ?? '').trim()
    if (comment.length > 2000) throw new AppError(`ความเห็นของเกณฑ์ “${c.prompt}” ยาวเกิน 2,000 ตัวอักษร`)
    scores[c.id] = { level, ...(comment ? { comment } : {}) }
  }
  const feedback = String(fields.feedback ?? '').trim()
  if (feedback.length > 10000) throw new AppError('ข้อเสนอแนะยาวเกิน 10,000 ตัวอักษร')
  const outcome = fields.outcome === 'passed' || fields.outcome === 'revise' ? fields.outcome : null
  const reason = String(fields.reason ?? '').trim()
  if (reason.length > 1000) throw new AppError('เหตุผลที่ตรวจใหม่ยาวเกิน 1,000 ตัวอักษร')

  if (release) {
    const missing = criteria.filter((c) => !scores[c.id])
    if (missing.length)
      throw new AppError(`ยังไม่ได้เลือกระดับของเกณฑ์: ${missing.map((c) => `“${c.prompt}”`).join(', ')}`)
    if (!outcome) throw new AppError('เลือกผลการตรวจ “ผ่าน” หรือ “ส่งกลับแก้ไข” ก่อนส่งผล')
    if (regrade && !reason) throw new AppError('งานรอบนี้มีผลการตรวจแล้ว — ระบุเหตุผลที่ตรวจใหม่')
  }
  return { scores, feedback: feedback || null, outcome, reason: reason || null }
}

/** Header first. Names and scores only: no text, links or files of the work. */
export function reviewCsvRows(rows, task) {
  const withRubric = Boolean(task?.rubric_version_id)
  return [
    [
      'ชื่อ',
      'สถานะ',
      'จำนวนรอบที่ส่ง',
      'ส่งล่าสุด (ISO)',
      'ส่งช้า',
      ...(withRubric ? ['คะแนน', 'คะแนนเต็ม'] : []),
      'ผลการตรวจล่าสุด',
    ],
    ...rows.map((r) => [
      r.name,
      STATE_LABELS[r.state] ?? 'ยังไม่ส่ง',
      r.attempts,
      r.submitted_at ?? '',
      r.latest ? (r.is_late ? 'ใช่' : 'ไม่') : '',
      ...(withRubric ? [r.review?.score ?? '', r.review?.max_score ?? ''] : []),
      r.review ? (r.review.outcome === 'passed' ? 'ผ่าน' : 'ส่งกลับแก้ไข') : '',
    ]),
  ]
}

export { scoreText, STATE_LABELS }

import { AppError } from '../../core/errors.js'

/**
 * Pure helpers for the trainee test pages. Nothing here decides a score or
 * an attempt count — start_attempt / submit_attempt do that on the server.
 */
export const PURPOSE_LABELS = {
  pretest: 'แบบทดสอบก่อนเรียน',
  posttest: 'แบบทดสอบหลังเรียน',
  formative: 'แบบทดสอบระหว่างเรียน',
}

const byAttemptDesc = (a, b) => b.attempt_no - a.attempt_no

/** Percent of a submitted attempt, 2 decimals (display only; the server stored score/max_score). */
export const attemptPercent = (t) =>
  Number(t.max_score) > 0 ? Math.round((Number(t.score) * 10000) / Number(t.max_score)) / 100 : 0

/**
 * Where an assignment stands for the caller (UI hint only).
 *   window: 'upcoming' | 'open' | 'closed'
 * A started attempt counts toward the limit, exactly as on the server.
 */
export function assignmentState(assignment, attempts = [], now = new Date()) {
  const openAt = assignment.open_at ? new Date(assignment.open_at) : null
  const closeAt = assignment.close_at ? new Date(assignment.close_at) : null
  const window = openAt && now < openAt ? 'upcoming' : closeAt && now >= closeAt ? 'closed' : 'open'
  const inProgress = attempts.find((t) => t.status === 'in_progress') ?? null
  const submitted = attempts.filter((t) => t.status === 'submitted').sort(byAttemptDesc)
  const remaining = Math.max(0, assignment.attempt_limit - attempts.length)
  return {
    window,
    inProgress,
    latest: submitted[0] ?? null,
    submitted,
    used: attempts.length,
    remaining,
    canStart: window === 'open' && (Boolean(inProgress) || remaining > 0),
  }
}

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

/**
 * Typed number → Number, null when blank, NaN when not a number.
 * Accepts Thai digits (๗๕), thousands separators and surrounding spaces.
 */
export function parseNumericAnswer(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/[,\s]/g, '')
  if (s === '') return null
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return Number.NaN
  return Number(s)
}

const fieldName = (itemId) => `q:${itemId}`

/** Raw answers from the exam form: { [itemId]: string | string[] }. */
export function readAnswers(form, items) {
  const data = new FormData(form)
  const answers = {}
  for (const item of items) {
    const name = fieldName(item.id)
    answers[item.id] =
      item.item_type === 'mcq_multiple' ? data.getAll(name).map(String) : (data.get(name) ?? '')
  }
  return answers
}

/**
 * Raw answers → the payload submit_attempt expects, plus the numbers
 * (1-based) of unanswered items. Throws AppError for a non-numeric entry.
 */
export function buildResponses(items, answers = {}) {
  const responses = {}
  const unanswered = []
  items.forEach((item, index) => {
    const raw = answers[item.id]
    let value = null
    switch (item.item_type) {
      case 'mcq_single':
        if (raw) value = { choice: String(raw) }
        break
      case 'mcq_multiple':
        if (Array.isArray(raw) && raw.length) value = { choices: [...new Set(raw.map(String))] }
        break
      case 'true_false':
        if (raw === 'true' || raw === 'false') value = { value: raw === 'true' }
        break
      case 'numeric': {
        const n = parseNumericAnswer(raw)
        if (Number.isNaN(n)) throw new AppError(`ข้อ ${index + 1}: กรุณากรอกเป็นตัวเลข`)
        if (n !== null) value = { value: n }
        break
      }
    }
    if (value) responses[item.id] = value
    else unanswered.push(index + 1)
  })
  return { responses, unanswered }
}

/** Storage paths an exam needs signed (question and choice images). */
export function itemMediaPaths(items = []) {
  const paths = items.flatMap((i) => [
    i.media_path,
    ...(i.options_json?.options ?? []).map((o) => o.image_path),
  ])
  return [...new Set(paths.filter(Boolean))]
}

// ---------------------------------------------------------------------
// Local draft: the trainee's own answers survive a refresh on this device.
// Storage may be unavailable (private mode); the exam still works without it.
// ---------------------------------------------------------------------
const draftKey = (attemptId) => `solveedu:attempt:${attemptId}`

export function loadDraft(storage, attemptId) {
  try {
    const parsed = JSON.parse(storage?.getItem(draftKey(attemptId)) ?? 'null')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveDraft(storage, attemptId, answers) {
  try {
    storage?.setItem(draftKey(attemptId), JSON.stringify(answers))
  } catch {
    /* quota / disabled storage: keep going */
  }
}

export function clearDraft(storage, attemptId) {
  try {
    storage?.removeItem(draftKey(attemptId))
  } catch {
    /* ignore */
  }
}

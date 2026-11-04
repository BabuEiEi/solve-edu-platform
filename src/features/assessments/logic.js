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
  const limit = assignment.attempt_limit + (assignment.assessment_extra_attempts?.length ?? 0)
  const remaining = Math.max(0, limit - attempts.length)
  return {
    window,
    inProgress,
    latest: submitted[0] ?? null,
    submitted,
    used: attempts.length,
    limit,
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

// ---------------------------------------------------------------------
// Item types with several parts. Slot types: each slot takes one choice.
// ---------------------------------------------------------------------
export const SLOT_LISTS = {
  matching: { slots: 'left', choices: 'right' },
  classification: { slots: 'items', choices: 'categories' },
  choice_matrix: { slots: 'rows', choices: 'columns' },
  image_labelling: { slots: 'markers', choices: 'labels' },
}
export const isSlotType = (type) => type === 'dropdown' || Boolean(SLOT_LISTS[type])

/** [{ id, choices }] for a slot item (dropdown: each blank has its own options). */
export function slotsOf(item) {
  const o = item.options_json ?? {}
  if (item.item_type === 'dropdown')
    return (o.blanks ?? []).map((b) => ({ id: b.id, choices: b.options ?? [] }))
  const lists = SLOT_LISTS[item.item_type]
  return lists ? (o[lists.slots] ?? []).map((s) => ({ id: s.id, choices: o[lists.choices] ?? [] })) : []
}

/** "ก {{b1}} ข" → ['ก ', {blank: 'b1'}, ' ข'] */
export function templateParts(text = '') {
  return String(text)
    .split(/\{\{([a-z0-9]{1,8})\}\}/)
    .map((part, i) => (i % 2 ? { blank: part } : part))
    .filter((p) => p !== '')
}

const byIds = (list = [], ids) => {
  if (!Array.isArray(ids)) return list
  const at = new Map(ids.map((id, i) => [id, i]))
  return [...list].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9))
}

/**
 * Items and their lists in the order this person was shown
 * (start_attempt.presentation; null for attempts made before 2C).
 */
export function applyPresentation(items, presentation) {
  if (!presentation) return items
  const ordered = byIds(
    items.map((i) => ({ ...i })),
    presentation.items
  )
  return ordered.map((item) => {
    const lists = presentation.lists?.[item.id]
    if (!lists) return item
    const o = { ...item.options_json }
    for (const [name, ids] of Object.entries(lists)) {
      if (name.startsWith('blank:')) {
        const id = name.slice(6)
        o.blanks = (o.blanks ?? []).map((b) => (b.id === id ? { ...b, options: byIds(b.options, ids) } : b))
      } else {
        o[name] = byIds(o[name], ids)
      }
    }
    return { ...item, options_json: o }
  })
}

const fieldName = (itemId) => `q:${itemId}`
export const partName = (itemId, part) => `q:${itemId}:${part}`

/**
 * Raw answers from the exam form:
 *   mcq_single / true_false / numeric → string · mcq_multiple / ordering → string[]
 *   slot types → { slot: choice } (filled slots only) · cloze → { blank: typed text }
 */
export function readAnswers(form, items) {
  const data = new FormData(form)
  const answers = {}
  for (const item of items) {
    const name = fieldName(item.id)
    if (item.item_type === 'ordering') {
      // the order shown at the start is not an answer: moved, confirmed or restored only
      answers[item.id] = data.get(partName(item.id, 'set')) === '1' ? data.getAll(name).map(String) : []
    } else if (item.item_type === 'mcq_multiple') {
      answers[item.id] = data.getAll(name).map(String)
    } else if (isSlotType(item.item_type)) {
      const slots = {}
      for (const s of slotsOf(item)) {
        const v = data.get(partName(item.id, s.id))
        if (v) slots[s.id] = String(v)
      }
      answers[item.id] = slots
    } else if (item.item_type === 'cloze') {
      const blanks = {}
      for (const b of item.options_json?.blanks ?? [])
        blanks[b.id] = String(data.get(partName(item.id, b.id)) ?? '')
      answers[item.id] = blanks
    } else {
      answers[item.id] = data.get(name) ?? ''
    }
  }
  return answers
}

/**
 * Raw answers → the payload submit_attempt expects, plus the numbers
 * (1-based) of unanswered and partly answered items. Throws AppError for a
 * non-numeric entry, unless `lenient` (autosave, time-up submit): then that
 * entry is left out.
 */
export function buildResponses(items, answers = {}, { lenient = false } = {}) {
  const responses = {}
  const unanswered = []
  const incomplete = []
  items.forEach((item, index) => {
    const raw = answers[item.id]
    let value = null
    let parts = null // [filled, total] for items with several parts
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
        if (Number.isNaN(n) && !lenient) throw new AppError(`ข้อ ${index + 1}: กรุณากรอกเป็นตัวเลข`)
        if (n !== null && !Number.isNaN(n)) value = { value: n }
        break
      }
      case 'ordering':
        // empty until the trainee moved an entry or pressed "ใช้ลำดับนี้" (readAnswers)
        if (Array.isArray(raw) && raw.length) value = { order: raw.map(String) }
        break
      case 'cloze': {
        const blanks = {}
        const all = item.options_json?.blanks ?? []
        all.forEach((b, k) => {
          const typed = String(raw?.[b.id] ?? '').trim()
          if (!typed) return
          if (b.kind === 'number') {
            const n = parseNumericAnswer(typed)
            if (Number.isNaN(n)) {
              if (!lenient) throw new AppError(`ข้อ ${index + 1} ช่องที่ ${k + 1}: กรุณากรอกเป็นตัวเลข`)
              return
            }
            blanks[b.id] = n
          } else {
            blanks[b.id] = typed.slice(0, 200)
          }
        })
        parts = [Object.keys(blanks).length, all.length]
        if (parts[0]) value = { blanks }
        break
      }
      default:
        if (isSlotType(item.item_type)) {
          const slots = Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v))
          parts = [Object.keys(slots).length, slotsOf(item).length]
          if (parts[0]) value = { slots }
        }
    }
    if (value) responses[item.id] = value
    else unanswered.push(index + 1)
    if (value && parts && parts[0] < parts[1]) incomplete.push(index + 1)
  })
  return { responses, unanswered, incomplete }
}

/** Storage paths an exam needs signed: the question image and images in any list of the item. */
export function itemMediaPaths(items = []) {
  const paths = items.flatMap((i) => [
    i.media_path,
    ...Object.values(i.options_json ?? {})
      .filter(Array.isArray)
      .flat()
      .map((o) => o?.image_path),
  ])
  return [...new Set(paths.filter(Boolean))]
}

/** Saved responses (server draft) → raw answers the exam form shows. */
export function answersFromResponses(items, responses) {
  const answers = {}
  for (const item of items) {
    const r = responses?.[item.id]
    if (!r) continue
    if (item.item_type === 'mcq_single') answers[item.id] = r.choice
    else if (item.item_type === 'mcq_multiple') answers[item.id] = r.choices ?? []
    else if (item.item_type === 'true_false') answers[item.id] = String(r.value)
    else if (item.item_type === 'numeric') answers[item.id] = String(r.value)
    else if (item.item_type === 'ordering') answers[item.id] = r.order ?? []
    else if (item.item_type === 'cloze')
      answers[item.id] = Object.fromEntries(Object.entries(r.blanks ?? {}).map(([k, v]) => [k, String(v)]))
    else if (isSlotType(item.item_type)) answers[item.id] = { ...(r.slots ?? {}) }
  }
  return answers
}

// ---------------------------------------------------------------------
// Countdown. The server decides when time is up; the page only shows it,
// using the server clock (start_attempt.server_now) so a wrong device
// clock does not shift the deadline.
// ---------------------------------------------------------------------
export const clockOffset = (serverNow, localNow = Date.now()) => new Date(serverNow).getTime() - localNow

export const remainingMs = (deadlineAt, offset, localNow = Date.now()) =>
  new Date(deadlineAt).getTime() - (localNow + offset)

/** 754000 → "12:34"; 3723000 → "1:02:03"; a day or more → "3 วัน 5 ชม."; never negative. */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total >= 86_400) return `${Math.floor(total / 86_400)} วัน ${Math.floor((total % 86_400) / 3600)} ชม.`
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

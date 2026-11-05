import { AppError } from '../../core/errors.js'
import { parseNumericAnswer } from '../assessments/logic.js'

/**
 * Rubric criteria (Phase 3). A rubric is an instrument of type 'rubric'; each
 * criterion is an item of type 'rubric_criterion' with 2–6 levels. The
 * server sets the criterion's max score from its levels and checks the same
 * rules again (private.rubric_criterion_error); here they give Thai messages.
 */
export const MIN_LEVELS = 2
export const MAX_LEVELS = 6
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export function nextLevelId(used = []) {
  const taken = new Set(used)
  for (const ch of LETTERS) if (!taken.has(ch)) return ch
  for (let n = 1; ; n++) if (!taken.has(`l${n}`)) return `l${n}`
}

/** A starting set of levels for a new criterion: 4 levels scoring 1–4. */
export function defaultLevels() {
  return ['ปรับปรุง', 'พอใช้', 'ดี', 'ดีมาก'].map((label, i) => ({
    id: LETTERS[i],
    label,
    score: String(i + 1),
    description: '',
  }))
}

const clean = (v) => String(v ?? '').trim()

/**
 * Editor fields → { item }.
 *   fields: { prompt, description, levels: [{ id, label, score, description }] }
 * Empty rows (no label, no score, no description) are dropped, so an
 * author can leave spare rows blank.
 */
export function buildCriterionDraft(fields = {}) {
  const prompt = clean(fields.prompt)
  if (!prompt) throw new AppError('กรุณาพิมพ์ชื่อเกณฑ์')
  if (prompt.length > 5000) throw new AppError('ชื่อเกณฑ์ยาวเกิน 5,000 ตัวอักษร')
  const description = clean(fields.description)
  if (description.length > 2000) throw new AppError('คำอธิบายเกณฑ์ยาวเกิน 2,000 ตัวอักษร')

  const rows = (fields.levels ?? []).filter((l) => clean(l.label) || clean(l.score) || clean(l.description))
  if (rows.length < MIN_LEVELS || rows.length > MAX_LEVELS)
    throw new AppError(`เกณฑ์ต้องมี ${MIN_LEVELS}–${MAX_LEVELS} ระดับ`)

  const levels = rows.map((l, i) => {
    const name = `ระดับที่ ${i + 1}`
    const label = clean(l.label)
    if (!label) throw new AppError(`${name}: กรุณาพิมพ์ชื่อระดับ`)
    if (label.length > 100) throw new AppError(`${name}: ชื่อระดับยาวเกิน 100 ตัวอักษร`)
    const score = parseNumericAnswer(l.score)
    if (score === null || Number.isNaN(score)) throw new AppError(`${name}: คะแนนต้องเป็นตัวเลข`)
    if (score < 0 || score > 1000) throw new AppError(`${name}: คะแนนต้องอยู่ระหว่าง 0 ถึง 1,000`)
    const text = clean(l.description)
    if (text.length > 1000) throw new AppError(`${name}: คำอธิบายยาวเกิน 1,000 ตัวอักษร`)
    return { id: l.id, label, score, ...(text ? { description: text } : {}) }
  })
  if (new Set(levels.map((l) => l.score)).size !== levels.length)
    throw new AppError('แต่ละระดับต้องมีคะแนนไม่ซ้ำกัน')
  if (Math.max(...levels.map((l) => l.score)) <= 0) throw new AppError('ระดับสูงสุดต้องมีคะแนนมากกว่า 0')

  return {
    item: {
      item_type: 'rubric_criterion',
      prompt,
      media_path: null,
      max_score: Math.max(...levels.map((l) => l.score)),
      options_json: { ...(description ? { description } : {}), levels },
    },
  }
}

/** Highest total a rubric can give: the sum of each criterion's top level. */
export function rubricMaxScore(criteria = []) {
  return criteria.reduce((sum, c) => sum + Number(c.max_score ?? 0), 0)
}

/** Levels from lowest to highest score (for display). */
export const sortedLevels = (criterion) =>
  [...(criterion.options_json?.levels ?? [])].sort((a, b) => Number(a.score) - Number(b.score))

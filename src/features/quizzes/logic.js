import { AppError } from '../../core/errors.js'
import { parseNumericAnswer } from '../assessments/logic.js'

/**
 * Quiz builder helpers. Mirrors private.item_shape_error / answer_key_error
 * so authors get a Thai message first; the database re-checks everything.
 */
export const ITEM_TYPES = {
  mcq_single: { label: 'ปรนัย (คำตอบเดียว)', icon: '◉' },
  mcq_multiple: { label: 'ปรนัย (หลายคำตอบ)', icon: '☑' },
  true_false: { label: 'ถูก / ผิด', icon: '⊤' },
  numeric: { label: 'ตอบเป็นตัวเลข', icon: '#' },
}

export const SCORING_MODES = {
  all_or_nothing: 'ต้องเลือกถูกครบทุกข้อจึงได้คะแนน',
  partial: 'ให้คะแนนบางส่วน (ถูก − ผิด, ไม่ต่ำกว่า 0)',
}

export const isChoiceType = (type) => type === 'mcq_single' || type === 'mcq_multiple'

export const MAX_CHOICES = 10
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/**
 * A choice id not in `used`. Ids are never re-lettered by position: the
 * stored key refers to them, and authors cannot read the key back to notice
 * a silent shift.
 */
export function nextOptionId(used = []) {
  const taken = new Set(used)
  for (const ch of LETTERS) if (!taken.has(ch)) return ch
  for (let n = 1; ; n++) if (!taken.has(`o${n}`)) return `o${n}`
}

const clean = (v) => String(v ?? '').trim()

/**
 * Editor fields → { item, key }. `key` is null when the author did not pick
 * an answer; on an existing item that keeps the stored key unchanged.
 *   fields: { prompt, max_score, media_path, unit, options: [{ id, text, image_path }],
 *             correct: [ids], mode, tf: 'true'|'false', value, tolerance }
 */
export function buildItemDraft(type, fields = {}, { requireKey = false } = {}) {
  if (!ITEM_TYPES[type]) throw new AppError('ไม่รองรับข้อสอบประเภทนี้')
  const prompt = clean(fields.prompt)
  if (!prompt) throw new AppError('กรุณาพิมพ์โจทย์')
  if (prompt.length > 5000) throw new AppError('โจทย์ยาวเกิน 5,000 ตัวอักษร')
  const maxScore = Number(fields.max_score ?? 1)
  if (!(maxScore > 0 && maxScore <= 1000)) throw new AppError('คะแนนต่อข้อต้องมากกว่า 0 และไม่เกิน 1,000')

  const item = { item_type: type, prompt, media_path: fields.media_path || null, max_score: maxScore }
  let key = null

  if (isChoiceType(type)) {
    const options = (fields.options ?? [])
      .map((o) => ({ id: o.id, text: clean(o.text), image_path: o.image_path || null }))
      .filter((o) => o.text || o.image_path)
      .map((o) => ({
        id: o.id,
        ...(o.text ? { text: o.text } : {}),
        ...(o.image_path ? { image_path: o.image_path } : {}),
      }))
    if (options.length < 2 || options.length > MAX_CHOICES)
      throw new AppError(`ต้องมีตัวเลือก 2–${MAX_CHOICES} ตัว (แต่ละตัวมีข้อความหรือรูปภาพ)`)
    if (options.some((o) => (o.text ?? '').length > 1000))
      throw new AppError('ข้อความตัวเลือกยาวเกิน 1,000 ตัวอักษร')
    item.options_json = { options }

    const ids = new Set(options.map((o) => o.id))
    const correct = [...new Set(fields.correct ?? [])].filter((id) => ids.has(id))
    if (correct.length) {
      if (type === 'mcq_single' && correct.length !== 1)
        throw new AppError('ข้อแบบคำตอบเดียวต้องมีคำตอบที่ถูก 1 ตัวเลือก')
      key = {
        answer: { correct },
        scoring:
          type === 'mcq_single' ? {} : { mode: fields.mode === 'partial' ? 'partial' : 'all_or_nothing' },
      }
    }
  } else if (type === 'true_false') {
    item.options_json = {}
    if (fields.tf === 'true' || fields.tf === 'false')
      key = { answer: { correct: fields.tf === 'true' }, scoring: {} }
  } else {
    const unit = clean(fields.unit)
    if (unit.length > 32) throw new AppError('หน่วยยาวเกิน 32 ตัวอักษร')
    item.options_json = unit ? { unit } : {}
    const value = parseNumericAnswer(fields.value)
    if (Number.isNaN(value)) throw new AppError('คำตอบที่ถูกต้องเป็นตัวเลข')
    if (value !== null) {
      const tolerance = parseNumericAnswer(fields.tolerance) ?? 0
      if (Number.isNaN(tolerance) || tolerance < 0)
        throw new AppError('ค่าคลาดเคลื่อนที่ยอมรับต้องเป็นตัวเลขไม่ติดลบ')
      key = { answer: { value, tolerance }, scoring: {} }
    }
  }

  if (!key && requireKey) throw new AppError('กรุณากำหนดคำตอบที่ถูก (เฉลย)')
  return { item, key }
}

/** item_key_status row → 'ok' | 'missing' | 'invalid' */
export function keyState(status) {
  if (!status?.has_key) return 'missing'
  return status.key_valid ? 'ok' : 'invalid'
}

/** Item numbers (1-based) that would block publishing. */
export function publishBlockers(items = [], statuses = {}) {
  return items.map((it, i) => (keyState(statuses[it.id]) === 'ok' ? null : i + 1)).filter(Boolean)
}

/** The version an author lands on: the open draft, else the newest. */
export function defaultVersion(versions = []) {
  const sorted = [...versions].sort((a, b) => b.version_no - a.version_no)
  return sorted.find((v) => v.status === 'draft') ?? sorted[0] ?? null
}

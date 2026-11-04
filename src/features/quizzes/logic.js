import { AppError } from '../../core/errors.js'
import { parseNumericAnswer, SLOT_LISTS, templateParts } from '../assessments/logic.js'

/**
 * Quiz builder helpers. Mirrors private.item_shape_error / answer_key_error
 * so authors get a Thai message first; the database re-checks everything.
 */
export const ITEM_TYPES = {
  mcq_single: { label: 'ปรนัย (คำตอบเดียว)', icon: '◉' },
  mcq_multiple: { label: 'ปรนัย (หลายคำตอบ)', icon: '☑' },
  true_false: { label: 'ถูก / ผิด', icon: '⊤' },
  numeric: { label: 'ตอบเป็นตัวเลข', icon: '#' },
  ordering: { label: 'เรียงลำดับ', icon: '⇅' },
  matching: { label: 'จับคู่', icon: '⇄' },
  classification: { label: 'จัดกลุ่ม', icon: '▦' },
  choice_matrix: { label: 'ตารางตัวเลือก', icon: '▤' },
  dropdown: { label: 'เลือกคำในประโยค', icon: '▾' },
  cloze: { label: 'เติมคำ', icon: '✎' },
  image_labelling: { label: 'ติดป้ายบนรูป', icon: '⌖' },
}

export const isBlankType = (type) => type === 'dropdown' || type === 'cloze'
export const BLANK_ID = { prefix: 'b' }
export const MARKER_ID = { prefix: 'm' }
export const LABELS_LIST = {
  name: 'labels',
  label: 'ป้าย (ใส่ตัวลวงเพิ่มได้)',
  min: 2,
  max: 20,
  prefix: 'p',
  textOnly: true,
}

/** Scoring for the 2C types: partial by default (owner decision). */
export const PART_SCORING_MODES = {
  partial: 'ให้คะแนนตามสัดส่วนส่วนที่ถูก',
  all_or_nothing: 'ต้องถูกทั้งหมดจึงได้คะแนน',
}

/**
 * The lists an author fills in per type. `random`: ids are random and the
 * list is stored shuffled when a key is set — trainees can read the stored
 * list, so its order must not give the answer away (the database refuses
 * keys that would).
 */
export const LIST_EDITORS = {
  ordering: [
    { name: 'options', label: 'รายการ (ใส่ตามลำดับที่ถูก)', min: 3, max: 10, random: true, movable: true },
  ],
  matching: [
    { name: 'left', label: 'ฝั่งซ้าย (ข้อที่ต้องจับคู่)', min: 2, max: 10, prefix: 'l' },
    { name: 'right', label: 'ฝั่งขวา (คำตอบ ใส่ตัวลวงเพิ่มได้)', min: 2, max: 15, random: true },
  ],
  classification: [
    { name: 'categories', label: 'กลุ่ม', min: 2, max: 6, prefix: 'c' },
    { name: 'items', label: 'รายการที่ต้องจัดกลุ่ม', min: 2, max: 15, prefix: 'i' },
  ],
  choice_matrix: [
    { name: 'rows', label: 'แถว (ข้อความที่ต้องตอบ)', min: 1, max: 15, prefix: 'w' },
    { name: 'columns', label: 'คอลัมน์ (ตัวเลือกของทุกแถว)', min: 2, max: 6, prefix: 'k' },
  ],
}
export const isListType = (type) => Boolean(LIST_EDITORS[type])

/** A random id ([a-z0-9]{4}) not in `used`. */
export function randomEntryId(used = [], random = Math.random) {
  const taken = new Set(used)
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let tries = 0; tries < 100; tries++) {
    let id = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 26)]
    for (let i = 0; i < 3; i++) id += chars[Math.floor(random() * chars.length)]
    if (!taken.has(id)) return id
  }
  // A broken random source must not hang the page: fall back to a counter.
  for (let n = 1; ; n++) if (!taken.has(`z${n}`)) return `z${n}`
}

/** The next id for a list: random, or prefix + number. */
export function nextEntryId(def, used = [], random = Math.random) {
  if (def.random) return randomEntryId(used, random)
  const taken = new Set(used)
  for (let n = 1; ; n++) if (!taken.has(`${def.prefix}${n}`)) return `${def.prefix}${n}`
}

/** Starting rows for a new item. */
export function defaultLists(type, random = Math.random) {
  const rows = (def, n, texts = []) => {
    const out = []
    for (let i = 0; i < n; i++)
      out.push({
        id: nextEntryId(
          def,
          out.map((r) => r.id),
          random
        ),
        text: texts[i] ?? '',
      })
    return out
  }
  const defs = LIST_EDITORS[type] ?? []
  const counts =
    { ordering: [4], matching: [3, 4], classification: [2, 4], choice_matrix: [3, 2] }[type] ?? []
  return Object.fromEntries(
    defs.map((def, k) => [
      def.name,
      rows(def, counts[k], type === 'choice_matrix' && k === 1 ? ['ถูก', 'ผิด'] : []),
    ])
  )
}

function shuffled(list, random) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Shuffle until `ok(order)` (at most 50 tries; then rotate by one, which is never the original order). */
function shuffleUntil(list, ok, random) {
  for (let t = 0; t < 50; t++) {
    const s = shuffled(list, random)
    if (ok(s)) return s
  }
  return [...list.slice(1), list[0]]
}

const cleanEntry = (e) => ({
  id: e.id,
  ...(String(e.text ?? '').trim() ? { text: String(e.text).trim() } : {}),
  ...(e.image_path ? { image_path: e.image_path } : {}),
})

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
 *             correct: [ids], mode, tf: 'true'|'false', value, tolerance,
 *             lists: { name: [{ id, text, image_path }] }, keySlots: { slot: choice },
 *             orderIsKey }
 */
export function buildItemDraft(type, fields = {}, { requireKey = false, random = Math.random } = {}) {
  if (!ITEM_TYPES[type]) throw new AppError('ไม่รองรับข้อสอบประเภทนี้')
  const prompt = clean(fields.prompt)
  if (!prompt) throw new AppError('กรุณาพิมพ์โจทย์')
  if (prompt.length > 5000) throw new AppError('โจทย์ยาวเกิน 5,000 ตัวอักษร')
  const maxScore = Number(fields.max_score ?? 1)
  if (!(maxScore > 0 && maxScore <= 1000)) throw new AppError('คะแนนต่อข้อต้องมากกว่า 0 และไม่เกิน 1,000')

  const item = { item_type: type, prompt, media_path: fields.media_path || null, max_score: maxScore }
  let key = null

  if (isListType(type)) {
    key = buildListItem(type, item, fields, random)
  } else if (isBlankType(type)) {
    key = buildBlankItem(type, item, fields)
  } else if (type === 'image_labelling') {
    key = buildLabelItem(item, fields)
  } else if (isChoiceType(type)) {
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

function buildListItem(type, item, fields, random) {
  const lists = {}
  for (const def of LIST_EDITORS[type]) {
    const rows = (fields.lists?.[def.name] ?? []).map(cleanEntry).filter((e) => e.text || e.image_path)
    if (rows.length < def.min || rows.length > def.max)
      throw new AppError(`${def.label}: ต้องมี ${def.min}–${def.max} รายการ (แต่ละรายการมีข้อความหรือรูปภาพ)`)
    if (rows.some((e) => (e.text ?? '').length > 1000))
      throw new AppError(`${def.label}: ข้อความยาวเกิน 1,000 ตัวอักษร`)
    lists[def.name] = rows
  }
  const mode = fields.mode === 'all_or_nothing' ? 'all_or_nothing' : 'partial'

  if (type === 'ordering') {
    const options = lists.options
    if (!fields.orderIsKey) {
      item.options_json = { options }
      return null
    }
    const order = options.map((o) => o.id)
    // Stored shuffled: never in the correct order.
    item.options_json = { options: shuffleUntil(options, (s) => s.some((o, i) => o.id !== order[i]), random) }
    return { answer: { order }, scoring: { mode } }
  }

  const { slots: slotList, choices: choiceList } = SLOT_LISTS[type]
  if (type === 'matching' && lists.right.length < lists.left.length)
    throw new AppError('ฝั่งขวาต้องมีจำนวนไม่น้อยกว่าฝั่งซ้าย')
  const choiceIds = new Set(lists[choiceList].map((c) => c.id))
  const picked = Object.fromEntries(
    lists[slotList].map((s) => [s.id, fields.keySlots?.[s.id]]).filter(([, c]) => c && choiceIds.has(c))
  )
  const n = Object.keys(picked).length
  if (n === 0) {
    item.options_json = lists
    return null
  }
  if (n < lists[slotList].length)
    throw new AppError('เลือกเฉลยให้ครบทุกช่อง (หรือเว้นว่างทั้งหมดเพื่อคงเฉลยเดิม)')
  if (type === 'matching' && new Set(Object.values(picked)).size !== n)
    throw new AppError('คำตอบฝั่งขวาแต่ละตัวใช้ได้ครั้งเดียว')
  if (type === 'matching') {
    // Stored shuffled: no right entry may sit next to every partner.
    lists.right = shuffleUntil(
      lists.right,
      (s) => lists.left.some((l, i) => picked[l.id] !== s[i]?.id),
      random
    )
  }
  item.options_json = lists
  return { answer: { slots: picked }, scoring: { mode } }
}

/** Accepted answers typed one per line → distinct, trimmed. */
export function acceptedLines(raw) {
  return [
    ...new Set(
      String(raw ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    ),
  ]
}

function buildBlankItem(type, item, fields) {
  const text = clean(fields.text)
  if (!text) throw new AppError('กรุณาพิมพ์ข้อความที่มีช่อง')
  if (text.length > 5000) throw new AppError('ข้อความยาวเกิน 5,000 ตัวอักษร')
  const placed = templateParts(text)
    .filter((p) => typeof p !== 'string')
    .map((p) => p.blank)
  if ((text.match(/\{\{/g) ?? []).length !== placed.length)
    throw new AppError('รูปแบบช่องในข้อความไม่ถูกต้อง — ใช้ปุ่ม “แทรกช่อง”')
  if (new Set(placed).size !== placed.length) throw new AppError('แต่ละช่องใส่ในข้อความได้ครั้งเดียว')
  const rows = new Map((fields.blanks ?? []).map((b) => [b.id, b]))
  const missing = [...rows.keys()].filter((id) => !placed.includes(id))
  if (missing.length) throw new AppError(`ช่อง ${missing.join(', ')} ยังไม่ได้ใส่ในข้อความ`)
  const unknown = placed.filter((id) => !rows.has(id))
  if (unknown.length) throw new AppError(`ข้อความมีช่องที่ไม่รู้จัก: ${unknown.join(', ')}`)
  if (placed.length < 1 || placed.length > 20) throw new AppError('ต้องมี 1–20 ช่อง')

  // Blanks are stored in reading order, so "ช่องที่ k" matches the text.
  const blanks = placed.map((id) => rows.get(id))
  const keyParts = {}
  const out = blanks.map((b, k) => {
    const name = `ช่องที่ ${k + 1}`
    if (type === 'dropdown') {
      const options = (b.options ?? []).map((o) => ({ id: o.id, text: clean(o.text) })).filter((o) => o.text)
      if (options.length < 2 || options.length > 10) throw new AppError(`${name}: ต้องมีตัวเลือก 2–10 ตัว`)
      if (options.some((o) => o.text.length > 1000))
        throw new AppError(`${name}: ข้อความตัวเลือกยาวเกิน 1,000 ตัวอักษร`)
      if (b.correct && options.some((o) => o.id === b.correct)) keyParts[b.id] = b.correct
      return { id: b.id, options }
    }
    if (b.kind === 'number') {
      const value = parseNumericAnswer(b.value)
      if (Number.isNaN(value)) throw new AppError(`${name}: คำตอบที่ถูกต้องเป็นตัวเลข`)
      if (value !== null) {
        const tolerance = parseNumericAnswer(b.tolerance) ?? 0
        if (Number.isNaN(tolerance) || tolerance < 0)
          throw new AppError(`${name}: ค่าคลาดเคลื่อนต้องเป็นตัวเลขไม่ติดลบ`)
        keyParts[b.id] = { value, tolerance }
      }
      return { id: b.id, kind: 'number' }
    }
    const accept = acceptedLines(b.accept)
    if (accept.length > 10) throw new AppError(`${name}: คำตอบที่ยอมรับได้ไม่เกิน 10 แบบ`)
    if (accept.some((a) => a.length > 200)) throw new AppError(`${name}: คำตอบยาวเกิน 200 ตัวอักษร`)
    if (accept.length) keyParts[b.id] = { accept }
    return { id: b.id }
  })
  item.options_json = { text, blanks: out }

  const n = Object.keys(keyParts).length
  if (n === 0) return null
  if (n < blanks.length) throw new AppError('กำหนดเฉลยให้ครบทุกช่อง (หรือเว้นว่างทั้งหมดเพื่อคงเฉลยเดิม)')
  const mode = fields.mode === 'all_or_nothing' ? 'all_or_nothing' : 'partial'
  return { answer: type === 'dropdown' ? { slots: keyParts } : { blanks: keyParts }, scoring: { mode } }
}

function buildLabelItem(item, fields) {
  if (!item.media_path) throw new AppError('ข้อติดป้ายบนรูปต้องมีรูป (เลือกในช่อง “รูปสำหรับติดป้าย”)')
  const markers = (fields.markers ?? []).map((m) => {
    const x = Number(m.x)
    const y = Number(m.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100)
      throw new AppError('ตำแหน่งจุดต้องอยู่บนรูป (0–100%)')
    return { id: m.id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
  })
  if (markers.length < 1 || markers.length > 15)
    throw new AppError('ต้องมีจุดบนรูป 1–15 จุด (แตะบนรูปเพื่อวางจุด)')
  const labels = (fields.lists?.labels ?? [])
    .map((l) => ({ id: l.id, text: clean(l.text) }))
    .filter((l) => l.text)
  if (labels.length < 2 || labels.length > 20) throw new AppError('ต้องมีป้าย 2–20 ป้าย')
  if (labels.some((l) => l.text.length > 1000)) throw new AppError('ข้อความป้ายยาวเกิน 1,000 ตัวอักษร')
  item.options_json = { markers, labels }

  const labelIds = new Set(labels.map((l) => l.id))
  const picked = Object.fromEntries(
    markers.map((m) => [m.id, fields.keySlots?.[m.id]]).filter(([, l]) => l && labelIds.has(l))
  )
  const n = Object.keys(picked).length
  if (n === 0) return null
  if (n < markers.length)
    throw new AppError('เลือกป้ายที่ถูกให้ครบทุกจุด (หรือเว้นว่างทั้งหมดเพื่อคงเฉลยเดิม)')
  const mode = fields.mode === 'all_or_nothing' ? 'all_or_nothing' : 'partial'
  return { answer: { slots: picked }, scoring: { mode } }
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
export const UNUSED_MEDIA_MIN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Images in the quiz folder that no item of any version uses, and that are
 * old enough not to be an upload whose item is still being written. The
 * database refuses to delete anything still in use anyway.
 */
export function unusedMedia(
  files = [],
  usedPaths = [],
  now = new Date(),
  minAgeMs = UNUSED_MEDIA_MIN_AGE_MS
) {
  const used = new Set(usedPaths)
  return files
    .filter((f) => !used.has(f.path))
    .filter((f) => f.created_at && now - new Date(f.created_at) >= minAgeMs)
    .map((f) => f.path)
}

export function defaultVersion(versions = []) {
  const sorted = [...versions].sort((a, b) => b.version_no - a.version_no)
  return sorted.find((v) => v.status === 'draft') ?? sorted[0] ?? null
}

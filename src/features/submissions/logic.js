import { AppError } from '../../core/errors.js'

/**
 * The trainee side of tasks (ภาระงาน): what can be attached, how an attempt
 * is described, and what the trainee may do next. The server decides all of
 * it (start_task_submission, submit_task_submission, RLS, the bucket); this
 * gives Thai messages before anything is sent.
 */
const MB = 1024 * 1024
export const MAX_FILES = 5
export const MAX_LINKS = 5
export const FILE_MAX_BYTES = 20 * MB
export const TASK_FILES_BUCKET = 'task-files'

export const FILE_TYPES = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
export const FILE_ACCEPT = Object.keys(FILE_TYPES).join(',')

/** Extension for an acceptable file; AppError (Thai) otherwise. `count` = files already attached. */
export function validateTaskFile(file, count = 0) {
  if (!file) throw new AppError('กรุณาเลือกไฟล์')
  if (count >= MAX_FILES) throw new AppError(`แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์ต่อรอบ`)
  const ext = FILE_TYPES[file.type]
  if (!ext)
    throw new AppError(
      'ชนิดไฟล์ไม่รองรับ (รับ PDF, Word, Excel, PowerPoint และรูปภาพ — วิดีโอให้ส่งเป็นลิงก์)'
    )
  if (file.size > FILE_MAX_BYTES) throw new AppError(`ไฟล์มีขนาดใหญ่เกิน ${FILE_MAX_BYTES / MB} MB`)
  return ext
}

/** <submission_id>/<random>.<ext>: the first folder decides who may read the object. */
export const taskFilePath = (submissionId, ext, uuid = globalThis.crypto.randomUUID()) =>
  `${submissionId}/${uuid}.${ext}`

/** Link rows from the form → [{url, label?}]; blank rows dropped; https only. */
export function buildLinks(rows = []) {
  const links = rows
    .map((r) => ({ url: String(r.url ?? '').trim(), label: String(r.label ?? '').trim() }))
    .filter((r) => r.url || r.label)
    .map((r, i) => {
      if (!r.url) throw new AppError(`ลิงก์ที่ ${i + 1}: กรุณาใส่ที่อยู่ลิงก์`)
      if (!/^https:\/\/[^\s<>"]+$/.test(r.url) || r.url.length > 2000)
        throw new AppError(
          `ลิงก์ที่ ${i + 1}: ต้องขึ้นต้นด้วย https:// (เช่น ลิงก์ Google Drive หรือ YouTube)`
        )
      if (r.label.length > 200) throw new AppError(`ลิงก์ที่ ${i + 1}: ชื่อลิงก์ยาวเกิน 200 ตัวอักษร`)
      return { url: r.url, ...(r.label ? { label: r.label } : {}) }
    })
  if (links.length > MAX_LINKS) throw new AppError(`แนบลิงก์ได้ไม่เกิน ${MAX_LINKS} ลิงก์`)
  return links
}

/** Draft content from the form; text is trimmed and capped. */
export function buildDraft({ text, linkRows }) {
  const text_response = String(text ?? '').trim()
  if (text_response.length > 20000) throw new AppError('ข้อความยาวเกิน 20,000 ตัวอักษร')
  return { text_response: text_response || null, links: buildLinks(linkRows) }
}

/** Has anything to submit? (text, a link or a file) */
export const hasContent = (draft, fileCount) =>
  Boolean(draft.text_response) || draft.links.length > 0 || fileCount > 0

/** The released review in force for one attempt (newest release), and the earlier ones. */
export function reviewsOf(reviews = []) {
  const sorted = [...reviews].sort((a, b) => String(b.released_at).localeCompare(String(a.released_at)))
  return { current: sorted[0] ?? null, earlier: sorted.slice(1) }
}

/** 'draft' | 'waiting' | 'passed' | 'revise' for one attempt and its current review. */
export function attemptState(submission, current) {
  if (submission.status === 'draft') return 'draft'
  if (!current) return 'waiting'
  return current.outcome
}

export const STATE_LABELS = {
  draft: 'ร่าง (ยังไม่ส่ง)',
  waiting: 'รอตรวจ',
  passed: 'ผ่าน',
  revise: 'ส่งกลับแก้ไข',
}

/**
 * What the trainee can do now:
 *   'open'   a draft exists → edit and submit it
 *   'start'  no attempt yet and the task is open
 *   'again'  the last attempt was returned for revision and attempts are left
 *   'not_open' | 'waiting' | 'passed' | 'used_up' | null
 * `submissions` newest first; `currentOf(submissionId)` → its current review.
 */
export function nextAction({ allocation, task, submissions, currentOf, now = Date.now() }) {
  const draft = submissions.find((s) => s.status === 'draft')
  if (draft) return 'open'
  if (allocation.available_at && now < new Date(allocation.available_at).getTime()) return 'not_open'
  const last = submissions[0]
  if (!last) return 'start'
  const outcome = currentOf(last.id)?.outcome
  if (!outcome) return 'waiting'
  if (outcome === 'passed') return 'passed'
  return submissions.length >= task.max_attempts ? 'used_up' : 'again'
}

/** Is the work late relative to the due time? (display only; the server stamps is_late) */
export const isOverdue = (allocation, now = Date.now()) =>
  Boolean(allocation.due_at) && now > new Date(allocation.due_at).getTime()

/** Score text: "3 / 5" or '' when the task has no rubric. */
export const scoreText = (review) =>
  review?.score === null || review?.score === undefined || review?.max_score === null
    ? ''
    : `${Number(review.score)} / ${Number(review.max_score)}`

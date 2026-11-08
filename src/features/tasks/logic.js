import { AppError } from '../../core/errors.js'
import { fromBangkokInput } from '../assignments/logic.js'

export const TASK_ATTEMPTS_MAX = 10
export const TASK_ATTEMPTS_DEFAULT = 3

export const TASK_STATUS_LABELS = { draft: 'ร่าง', published: 'เผยแพร่', archived: 'เก็บถาวร' }

/**
 * Form fields → columns for public.tasks (insert or update). Throws AppError
 * (Thai) for what the page can check; the server checks it all again.
 */
export function buildTaskPayload(fields) {
  const title = String(fields.title ?? '').trim()
  if (!title) throw new AppError('กรุณาระบุชื่อภาระงาน')
  if (title.length > 300) throw new AppError('ชื่อภาระงานยาวเกิน 300 ตัวอักษร')
  const instructions = String(fields.instructions ?? '').trim()
  if (instructions.length > 10000) throw new AppError('คำชี้แจงยาวเกิน 10,000 ตัวอักษร')
  const raw = String(fields.max_attempts ?? '').trim()
  const attempts = raw === '' ? TASK_ATTEMPTS_DEFAULT : Number(raw)
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > TASK_ATTEMPTS_MAX)
    throw new AppError(`จำนวนรอบที่ส่งได้ต้องเป็นเลข 1–${TASK_ATTEMPTS_MAX}`)
  return {
    title,
    instructions: instructions || null,
    rubric_version_id: fields.rubric_version_id ? String(fields.rubric_version_id) : null,
    max_attempts: attempts,
  }
}

/** Form fields → columns for public.task_allocations; due must follow the opening time. */
export function buildAllocationPayload(fields) {
  const available_at = fromBangkokInput(fields.available_at, 'วันเปิดรับงาน')
  const due_at = fromBangkokInput(fields.due_at, 'กำหนดส่ง')
  if (available_at && due_at && new Date(due_at) <= new Date(available_at))
    throw new AppError('กำหนดส่งต้องหลังวันเปิดรับงาน')
  return { available_at, due_at }
}

/**
 * Published rubric versions of a course's rubrics → select options.
 * Archived rubrics are not offered for new choices; `keepVersionId` keeps the
 * one a task already uses visible.
 */
export function rubricOptions(rubrics = [], keepVersionId = null) {
  return rubrics
    .filter(
      (r) => r.status !== 'archived' || (r.instrument_versions ?? []).some((v) => v.id === keepVersionId)
    )
    .flatMap((r) =>
      (r.instrument_versions ?? [])
        .filter((v) => v.status === 'published' && (r.status !== 'archived' || v.id === keepVersionId))
        .sort((a, b) => b.version_no - a.version_no)
        .map((v) => ({
          id: v.id,
          label: `${r.title} · ฉบับที่ ${v.version_no}${r.status === 'archived' ? ' (เก็บถาวร)' : ''}`,
        }))
    )
}

/** Cohorts a task is not yet open to. */
export function cohortsLeft(cohorts = [], allocations = []) {
  const used = new Set(allocations.map((a) => a.cohort_id))
  return cohorts.filter((c) => !used.has(c.id))
}

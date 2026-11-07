/**
 * Texts for "ส่งสำเนาไป Google Drive" (Phase 3b). The Edge Function answers
 * with short codes (never Google's own words); this turns them into Thai.
 */

export const DRIVE_ERROR_TEXT = {
  unauthorized: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  forbidden: 'เฉพาะผู้ตรวจของรุ่นนี้เท่านั้นที่ส่งสำเนาได้',
  already_running: 'กำลังส่งสำเนาไป Google Drive อยู่ กรุณารอสักครู่แล้วลองใหม่',
  not_configured: 'ยังไม่ได้ตั้งค่า Google Drive ของระบบ กรุณาแจ้งผู้ดูแลระบบ',
  bad_request: 'ข้อมูลที่ส่งไม่ถูกต้อง กรุณาโหลดหน้าใหม่',
  internal: 'ระบบส่งสำเนาขัดข้อง กรุณาลองใหม่ หากยังไม่ได้แจ้งผู้ดูแลระบบ',
}
export const DRIVE_FALLBACK_TEXT =
  'ติดต่อบริการส่งสำเนาไม่สำเร็จ งานอาจยังส่งต่ออยู่ในระบบ — ตรวจ "ประวัติการส่งสำเนา" ด้านล่าง แล้วลองใหม่อีกครั้ง'

export const DRIVE_STATUS_LABEL = {
  running: 'กำลังส่ง',
  done: 'ส่งครบ',
  partial: 'ส่งบางส่วน',
  failed: 'ไม่สำเร็จ',
}

const files = (n) => `${n} ไฟล์`

// The run record keeps short codes from the function (e.g. "drive_forbidden: upload (HTTP 403)").
const REASONS = [
  [/^google_auth_failed/, 'เข้าสู่ระบบ Google ไม่สำเร็จ (ตรวจกุญแจของ service account)'],
  [/^drive_forbidden/, 'Google Drive ไม่อนุญาต (ตรวจว่า service account เป็นสมาชิกของ Shared Drive)'],
  [/^drive_not_found/, 'ไม่พบโฟลเดอร์หรือไฟล์ใน Google Drive (ตรวจรหัสโฟลเดอร์กลางที่ตั้งไว้)'],
  [/^download_failed/, 'อ่านไฟล์งานจากระบบไม่ได้'],
  [/^drive_error/, 'Google Drive ขัดข้องชั่วคราว'],
  [/^did not finish/, 'การส่งค้างและถูกยกเลิกหลัง 15 นาที'],
]

/** Thai explanation of a recorded error; the original code stays as detail for the administrator. */
export function explainError(text) {
  if (!text) return null
  const reasons = [...new Set(String(text).split('; '))]
  return {
    reason: reasons
      .map((r) => REASONS.find(([re]) => re.test(r))?.[1] ?? 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')
      .join(' · '),
    code: String(text),
  }
}

/** One sentence about a finished run (the function's answer). */
export function resultMessage(r) {
  const copied = Number(r?.copied) || 0
  const skipped = Number(r?.skipped) || 0
  const failed = Number(r?.failed) || 0
  const remaining = Number(r?.remaining) || 0
  if (r?.status === 'failed') {
    return 'ส่งสำเนาไม่สำเร็จ — ไม่มีไฟล์ถูกส่ง กรุณาลองใหม่ หากยังไม่ได้แจ้งผู้ดูแลระบบ'
  }
  const parts = []
  if (copied) parts.push(`ส่งใหม่ ${files(copied)}`)
  if (skipped) parts.push(`มีใน Drive อยู่แล้ว ${files(skipped)}`)
  if (!parts.length && r?.status === 'done') return 'ไม่มีไฟล์แนบในงานที่ส่งแล้ว จึงยังไม่มีอะไรให้ส่ง'
  let text = `${r?.status === 'partial' ? 'ส่งยังไม่ครบ: ' : 'ส่งครบแล้ว: '}${parts.join(' · ')}`
  if (remaining) text += ` · เหลืออีก ${files(remaining)} (หมดเวลาในรอบนี้) — กดอีกครั้งเพื่อส่งต่อ`
  if (failed) text += ` · ส่งไม่สำเร็จ ${files(failed)} — กดอีกครั้งเพื่อลองใหม่`
  return text
}

/** `done` is a success, anything else needs the person's attention. */
export const resultTone = (r) => (r?.status === 'done' ? 'success' : 'warning')

/** One line of the history list. */
export function historyLine(run) {
  const label = DRIVE_STATUS_LABEL[run?.status] ?? 'ไม่ทราบสถานะ'
  const parts = []
  if (run?.status !== 'running') {
    parts.push(`ส่งใหม่ ${run.files_copied ?? 0}`, `มีแล้ว ${run.files_skipped ?? 0}`)
    if (run.files_failed) parts.push(`ไม่สำเร็จ/เหลือ ${run.files_failed}`)
  }
  return { label, detail: parts.join(' · '), error: explainError(run?.error) }
}

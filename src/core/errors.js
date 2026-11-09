/**
 * Translate Supabase/PostgREST/Postgres errors into user-facing Thai messages.
 * Raw details go to the console for developers — never secrets, never to the UI.
 */
const BY_CODE = {
  42501: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
  23505: 'ข้อมูลนี้มีอยู่แล้วในระบบ',
  23503: 'ข้อมูลอ้างอิงไม่ถูกต้องหรือถูกใช้งานอยู่',
  23514: 'ข้อมูลไม่ผ่านเงื่อนไขของระบบ',
  22023: 'ค่าที่ส่งมาไม่ถูกต้อง',
  // assessments (start_attempt / submit_attempt; SE004 = assignment settings frozen; SE005 = newer page took over)
  SE001: 'แบบทดสอบนี้ยังไม่เปิดหรือปิดรับแล้ว',
  SE002: 'ท่านทำแบบทดสอบนี้ครบจำนวนครั้งที่กำหนดแล้ว',
  SE003: 'ส่งคำตอบของครั้งนี้ไปแล้ว',
  SE004: 'มีผู้เริ่มทำแล้ว จึงแก้ประเภท เกณฑ์ผ่าน หรือหลักสูตร หรือย้อนเป็นฉบับร่างไม่ได้',
  SE005: 'มีการทำต่อจากอีกเครื่องแล้ว กรุณาโหลดหน้าใหม่',
  // tasks (ภาระงาน): SE006 = rubric frozen once work is submitted; SE007 = no new attempt now
  SE006: 'มีผู้ส่งงานแล้ว จึงเปลี่ยน Rubric ของภาระงานนี้ไม่ได้',
  SE007: 'รอบล่าสุดรอผลตรวจหรือผ่านแล้ว จึงส่งรอบใหม่ไม่ได้',
  // Google Drive copy (begin_task_drive_export): one run per task-cohort at a time
  SE008: 'กำลังส่งสำเนาไป Google Drive อยู่ กรุณารอสักครู่แล้วลองใหม่',
  // an archived quiz or rubric cannot be assigned or chosen again until it is brought back (Phase 4d)
  // cohorts and course enrollment (Phase 4g)
  SE011: 'รุ่นนี้มีผู้เข้าอบรมเต็มจำนวนแล้ว',
  SE012: 'รุ่นนี้ไม่ได้เปิดรับสมัครในขณะนี้',
  SE013: 'ลงทะเบียนได้เฉพาะผู้เข้าอบรมของรุ่นนี้ และเฉพาะหลักสูตรของโครงการนี้',
  SE010: 'แบบทดสอบหรือ Rubric นี้ถูกเก็บถาวรแล้ว กรุณากด “นำกลับมาใช้” ที่หน้าของมันก่อน',
  PGRST116: 'ไม่พบข้อมูลที่ต้องการ',
  PGRST301: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
}

export class AppError extends Error {
  constructor(userMessage, { code = null, cause = null } = {}) {
    super(userMessage)
    this.name = 'AppError'
    this.code = code
    this.cause = cause
  }
}

export function toUserMessage(error) {
  if (!error) return ''
  if (error instanceof AppError) return error.message
  const code = error.code ?? error.status ?? null
  if (code && BY_CODE[code]) return BY_CODE[code]
  const msg = String(error.message || '')
  if (/Invalid login credentials/i.test(msg)) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
  if (/Email not confirmed/i.test(msg)) return 'กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ'
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบเครือข่าย'
  // Storage API errors carry HTTP-ish statusCode + English messages
  if (/row-level security|unauthorized|not authorized/i.test(msg)) return BY_CODE[42501]
  if (/mime type|not supported/i.test(msg)) return 'ชนิดไฟล์ไม่รองรับ'
  if (/maximum allowed size|payload too large|entity too large/i.test(msg)) return 'ไฟล์มีขนาดใหญ่เกินกำหนด'
  if (/already exists|duplicate/i.test(msg)) return BY_CODE[23505]
  return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'
}

/** Throw AppError if a Supabase response carries an error (SEC-05). */
export function unwrap({ data, error }, context = '') {
  if (error) {
    console.error(`[supabase] ${context}`, {
      code: error.code,
      message: error.message,
      details: error.details,
    })
    throw new AppError(toUserMessage(error), { code: error.code ?? null, cause: error })
  }
  return data
}

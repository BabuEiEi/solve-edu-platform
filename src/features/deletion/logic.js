/**
 * Texts for "ลบ / เก็บถาวร". The database answers with counts of what is in
 * use (deletion_usage); this turns them into sentences a trainer understands.
 */

const REASONS = {
  enrollments: (n) => `มีผู้ลงทะเบียนเรียน ${n} คน`,
  attempts: (n) => `มีผู้ทำแบบทดสอบแล้ว ${n} ครั้ง`,
  submissions: (n) => `มีงานที่ผู้เรียนเริ่มหรือส่งแล้ว ${n} รอบ`,
  drive_exports: (n) => `มีประวัติส่งสำเนาไป Google Drive ${n} ครั้ง`,
  rubric_tasks: (n) => `มีภาระงาน ${n} รายการใช้ Rubric นี้`,
  rubric_tasks_elsewhere: (n) => `Rubric ของหลักสูตรนี้ถูกภาระงานของหลักสูตรอื่นใช้ ${n} รายการ`,
  reviews: (n) => `มีผลการตรวจงาน ${n} รายการที่อ้างอิง Rubric นี้`,
}

/** ["มีผู้ลงทะเบียนเรียน 3 คน", …] in the order above; unknown keys are ignored. */
export function reasonLines(reasons) {
  return Object.entries(REASONS)
    .filter(([key]) => Number(reasons?.[key]) > 0)
    .map(([key, text]) => text(Number(reasons[key])))
}

export const KINDS = {
  course: {
    noun: 'หลักสูตร',
    below: 'หน่วยการเรียน บทเรียน แบบทดสอบ Rubric ภาระงาน และการผูกกับโครงการของหลักสูตรนี้',
    confirmLabel: 'รหัสหลักสูตร',
    listPath: '/courses',
  },
  instrument: {
    noun: 'แบบทดสอบ',
    below: 'ทุกฉบับ ข้อสอบ เฉลย และการมอบหมายให้รุ่น',
    confirmLabel: 'รหัส',
  },
  task: {
    noun: 'ภาระงาน',
    below: 'การเปิดให้รุ่นของภาระงานนี้',
    confirmLabel: 'ชื่อภาระงาน',
  },
}

/** What the person must type: the code (course, quiz, rubric) or the title (task). Exact, as the database checks. */
export const confirmMatches = (typed, expected) =>
  typeof expected === 'string' && expected !== '' && typed === expected

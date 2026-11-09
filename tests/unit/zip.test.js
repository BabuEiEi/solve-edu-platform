import { describe, it, expect, vi } from 'vitest'
import { unzipSync, strFromU8, strToU8 } from 'fflate'
import {
  safeSegment,
  uniqueName,
  personFolderName,
  attemptFolderName,
  answerText,
  planZip,
  checkZipLimits,
  buildZip,
  ANSWER_FILE,
  SUMMARY_FILE,
  FAILED_FILE,
  ZIP_MAX_BYTES,
} from '../../src/features/reviews/zip.js'
import { readXlsxRows } from '../../src/shared/utils/xlsx.js'

const RLO = String.fromCharCode(0x202e) // right-to-left override
const LRI = String.fromCharCode(0x2066)
const NUL = String.fromCharCode(0)
const utf8 = (s) => new TextEncoder().encode(s).length

const segmentsOf = (path) => path.split('/')
const isSafePath = (path) =>
  (path = path.replace(/\/$/, '')) && // a folder entry ends with "/"
  !path.startsWith('/') &&
  !path.includes('\\') &&
  segmentsOf(path).every(
    (seg) => seg && seg !== '.' && seg !== '..' && !seg.startsWith('.') && !/[:*?"<>|]/.test(seg)
  )

describe('safeSegment: names from users become one harmless path segment', () => {
  it('cannot climb out of its folder or name an absolute path', () => {
    for (const evil of [
      '../../etc/passwd',
      '..\\..\\Windows\\win.ini',
      '/etc/shadow',
      'C:\\Windows\\x.exe',
      '..',
      '.',
      '...',
    ]) {
      const s = safeSegment(evil)
      expect(s).not.toMatch(/[\\/:]/)
      expect(s.startsWith('.')).toBe(false)
      expect(isSafePath(s)).toBe(true)
    }
    expect(safeSegment('..')).toBe('ไฟล์') // nothing left → the fallback
  })

  it('drops control characters and direction overrides (so "exe" cannot pose as "pdf")', () => {
    expect(safeSegment(`งาน${RLO}fdp.exe`)).toBe('งานfdp.exe')
    expect(safeSegment(`a${NUL}b${LRI}c.pdf`)).toBe('abc.pdf')
  })

  it('replaces characters Windows forbids and trims what Windows would drop', () => {
    expect(safeSegment('แผน:การสอน*?.pdf')).toBe('แผน_การสอน__.pdf')
    expect(safeSegment('  รายงาน. . ')).toBe('รายงาน')
    expect(safeSegment('a   b\tc.docx')).toBe('a b c.docx')
  })

  it('renames device names Windows reserves', () => {
    expect(safeSegment('CON.txt')).toBe('_CON.txt')
    expect(safeSegment('aux')).toBe('_aux')
    expect(safeSegment('com1.pdf')).toBe('_com1.pdf')
    expect(safeSegment('console.pdf')).toBe('console.pdf')
  })

  it('keeps long Thai names inside the file-system limit and keeps the extension', () => {
    const s = safeSegment(`${'แผนการจัดการเรียนรู้'.repeat(20)}.pdf`)
    expect(utf8(s)).toBeLessThanOrEqual(150)
    expect(s.endsWith('.pdf')).toBe(true)
    expect(s.startsWith('แผนการจัดการเรียนรู้')).toBe(true)
  })

  it('keeps an ordinary name as it is', () => {
    expect(safeSegment('แผนการสอน AfL (ฉบับแก้).pdf')).toBe('แผนการสอน AfL (ฉบับแก้).pdf')
  })
})

describe('uniqueName', () => {
  it('numbers later copies, ignoring case as Windows and macOS do', () => {
    const used = new Set()
    expect(uniqueName('a.pdf', used)).toBe('a.pdf')
    expect(uniqueName('A.PDF', used)).toBe('A (2).PDF')
    expect(uniqueName('a.pdf', used)).toBe('a (3).pdf')
    expect(uniqueName('folder', used)).toBe('folder')
    expect(uniqueName('folder', used)).toBe('folder (2)')
  })
})

describe('folder names', () => {
  it('a person: code then name; no code → name only', () => {
    expect(personFolderName({ user_code: 'T001', full_name: 'นายสมชาย ใจดี' })).toBe('T001 นายสมชาย ใจดี')
    expect(personFolderName({ full_name: '', display_name: 'ครูนก' })).toBe('ครูนก')
    expect(personFolderName(null)).toBe('ไม่ทราบชื่อ')
    expect(personFolderName({ user_code: '../x', full_name: 'a/b' })).toBe('_x a_b')
  })

  it('an attempt: number and the Thai date it was sent, late marked', () => {
    expect(attemptFolderName({ attempt_no: 2, submitted_at: '2026-11-08T20:00:00Z', is_late: true })).toBe(
      'รอบที่ 2 (ส่ง 2026-11-09, ส่งช้า)'
    )
    expect(attemptFolderName({ attempt_no: 1, submitted_at: null })).toBe('รอบที่ 1')
  })
})

describe('answerText', () => {
  it('the typed answer and links, with Windows line ends; none → null', () => {
    const t = answerText(
      {
        attempt_no: 1,
        submitted_at: '2026-11-08T03:00:00Z',
        text_response: 'สรุปผลการทดลองสอน',
        links: [
          { url: 'https://drive.example.test/x', label: 'คลิปการสอน' },
          { url: 'https://y.example.test' },
        ],
        profiles: { full_name: 'นายสมชาย ใจดี', user_code: 'T001' },
      },
      { taskTitle: 'ส่งแผนการสอน' }
    )
    expect(t).toContain('ภาระงาน: ส่งแผนการสอน\r\n')
    expect(t).toContain('ผู้ส่ง: นายสมชาย ใจดี (T001)')
    expect(t).toContain('สรุปผลการทดลองสอน')
    expect(t).toContain('- คลิปการสอน — https://drive.example.test/x')
    expect(t).toContain('- https://y.example.test')
    expect(answerText({ attempt_no: 1, text_response: '  ', links: [] })).toBeNull()
  })
})

// ---------- the plan ----------
const P = {
  a: { id: 'A', full_name: 'นายสมชาย ใจดี', user_code: 'T001' },
  b: { id: 'B', full_name: 'นางสาวสมหญิง รักเรียน', user_code: 'T002' },
  c: { id: 'C', full_name: 'นายเงียบ ไม่ส่ง', user_code: 'T003' },
  d1: { id: 'D1', full_name: 'ครูซ้ำ ชื่อเดียวกัน' },
  d2: { id: 'D2', full_name: 'ครูซ้ำ ชื่อเดียวกัน' },
}
const sub = (id, user, attempt_no, extra = {}) => ({
  id,
  user_id: user,
  attempt_no,
  status: 'submitted',
  submitted_at: `2026-11-0${attempt_no}T03:00:00Z`,
  is_late: false,
  text_response: null,
  links: [],
  profiles: P[user.toLowerCase()] ?? P[user],
  ...extra,
})
const file = (submission_id, file_name, size_bytes, n = 1) => ({
  id: `${submission_id}-f${n}`,
  submission_id,
  object_path: `${submission_id}/${n}.bin`,
  file_name,
  size_bytes,
  created_at: `2026-11-01T00:00:0${n}Z`,
})
const DATA = {
  task: { title: 'ส่งแผนการสอน AfL' },
  cohort: { name: 'รุ่น 1/2569', code: 'C1' },
  submissions: [
    sub('sa1', 'A', 1, { text_response: 'ฉบับแรก' }),
    sub('sa2', 'A', 2, { is_late: true }),
    sub('sb1', 'B', 1, { links: [{ url: 'https://drive.example.test/b' }] }),
    sub('sd1', 'D1', 1),
    sub('sd2', 'D2', 1),
    sub('draft', 'B', 2, { status: 'draft' }),
  ],
  files: [
    file('sa1', 'แผน.pdf', 1000, 1),
    file('sa1', 'แผน.pdf', 2000, 2),
    file('sa1', ANSWER_FILE, 10, 3),
    file('sa2', `../../${RLO}fdp.exe`, 500, 1),
    file('sb1', 'CON.docx', 300, 1),
    file('draft', 'ร่าง.pdf', 999, 1),
  ],
  reviews: [
    { submission_id: 'sa1', outcome: 'revise', score: 4, max_score: 10, released_at: '2026-11-02T00:00:00Z' },
    { submission_id: 'sa2', outcome: 'revise', score: 5, max_score: 10, released_at: '2026-11-03T00:00:00Z' },
    { submission_id: 'sa2', outcome: 'passed', score: 8, max_score: 10, released_at: '2026-11-04T00:00:00Z' },
  ],
  roster: [
    { user_id: 'A', profiles: P.a },
    { user_id: 'C', profiles: P.c },
  ],
}
DATA.submissions.find((s) => s.id === 'sd1').profiles = P.d1
DATA.submissions.find((s) => s.id === 'sd2').profiles = P.d2

describe('planZip', () => {
  const plan = planZip(DATA)
  const paths = plan.entries.map((e) => e.path)

  it('one folder per person and attempt; every path is safe', () => {
    expect(paths).toContain(`T001 นายสมชาย ใจดี/รอบที่ 1 (ส่ง 2026-11-01)/${ANSWER_FILE}`)
    expect(paths).toContain('T001 นายสมชาย ใจดี/รอบที่ 1 (ส่ง 2026-11-01)/แผน.pdf')
    expect(paths).toContain('T001 นายสมชาย ใจดี/รอบที่ 1 (ส่ง 2026-11-01)/แผน (2).pdf')
    // the trainee's own "คำตอบ.txt" does not overwrite ours
    expect(paths).toContain('T001 นายสมชาย ใจดี/รอบที่ 1 (ส่ง 2026-11-01)/คำตอบ (2).txt')
    expect(paths).toContain('T001 นายสมชาย ใจดี/รอบที่ 2 (ส่ง 2026-11-02, ส่งช้า)/_.._fdp.exe')
    expect(paths).toContain('T002 นางสาวสมหญิง รักเรียน/รอบที่ 1 (ส่ง 2026-11-01)/_CON.docx')
    for (const p of paths) expect(isSafePath(p), p).toBe(true)
  })

  it('two people with the same name get two folders; an attempt with no file still has its folder', () => {
    expect(plan.folders).toContain('ครูซ้ำ ชื่อเดียวกัน/รอบที่ 1 (ส่ง 2026-11-01)')
    expect(plan.folders).toContain('ครูซ้ำ ชื่อเดียวกัน (2)/รอบที่ 1 (ส่ง 2026-11-01)')
    for (const f of plan.folders) expect(isSafePath(f), f).toBe(true)
  })

  it('a draft never goes in, not even its files', () => {
    expect(paths.some((p) => p.includes('ร่าง.pdf'))).toBe(false)
    expect(plan.summaryRows.some((r) => r[2] === 2 && r[0] === 'T002')).toBe(false)
  })

  it('counts files and bytes of submitted attempts only', () => {
    expect(plan.fileCount).toBe(5)
    expect(plan.totalBytes).toBe(1000 + 2000 + 10 + 500 + 300)
  })

  it('the summary: one row per attempt, the review in force, and who sent nothing', () => {
    const [header, ...rows] = plan.summaryRows
    expect(header[0]).toBe('รหัส')
    const a2 = rows.find((r) => r[0] === 'T001' && r[2] === 2)
    expect(a2.slice(4, 10)).toEqual(['ใช่', 1, '', 'ผ่าน', 8, 10]) // the regrade, not the earlier review
    const b1 = rows.find((r) => r[0] === 'T002')
    expect(b1[6]).toBe('https://drive.example.test/b')
    expect(b1[7]).toBe('') // not reviewed yet
    const c = rows.find((r) => r[0] === 'T003')
    expect(c[7]).toBe('ยังไม่ส่ง')
    expect(paths.some((p) => p.includes('นายเงียบ'))).toBe(false)
  })

  it('names the archive after the task and the cohort, safely', () => {
    expect(plan.name).toBe('ส่งแผนการสอน AfL - รุ่น 1_2569.zip')
  })
})

describe('checkZipLimits', () => {
  it('refuses an archive the browser could not hold, before downloading anything', () => {
    expect(() => checkZipLimits({ totalBytes: ZIP_MAX_BYTES + 1, fileCount: 1 })).toThrow(
      /เกินกว่าที่ดาวน์โหลดเป็นไฟล์เดียวได้/
    )
    expect(() => checkZipLimits({ totalBytes: 10, fileCount: 5 }, { maxFiles: 4 })).toThrow(/5 ไฟล์/)
    expect(() => checkZipLimits({ totalBytes: ZIP_MAX_BYTES, fileCount: 3000 })).not.toThrow()
  })
})

describe('buildZip', () => {
  const plan = planZip(DATA)
  const bytesOf = (path) => strToU8(`content of ${path}`)

  it('packs every file, the answers and the summary; names stay UTF-8', async () => {
    const signedUrls = vi.fn(async (paths) =>
      Object.fromEntries(paths.map((p) => [p, `https://sign.example.test/${p}`]))
    )
    const fetchBytes = vi.fn(async (url) => bytesOf(url.replace('https://sign.example.test/', '')))
    const progress = []
    const out = await buildZip(plan, {
      signedUrls,
      fetchBytes,
      onProgress: (p) => progress.push(p),
      signChunk: 2,
    })
    expect(out.failed).toEqual([])
    expect(out.name).toBe(plan.name)
    expect(signedUrls).toHaveBeenCalledTimes(3) // 5 files, 2 per request
    expect(progress.at(-1)).toEqual({ done: 5, total: 5 })

    const files = unzipSync(out.bytes)
    const names = Object.keys(files)
    for (const n of names) expect(isSafePath(n), n).toBe(true)
    expect(strFromU8(files['T001 นายสมชาย ใจดี/รอบที่ 1 (ส่ง 2026-11-01)/แผน (2).pdf'])).toBe(
      'content of sa1/2.bin'
    )
    expect(strFromU8(files[`T001 นายสมชาย ใจดี/รอบที่ 1 (ส่ง 2026-11-01)/${ANSWER_FILE}`])).toContain(
      'ฉบับแรก'
    )
    const summary = readXlsxRows(files[SUMMARY_FILE])
    expect(summary[0][0]).toBe('รหัส')
    expect(summary.some((r) => r[7] === 'ยังไม่ส่ง')).toBe(true)
    expect(names).not.toContain(FAILED_FILE)
    expect(names).toContain('ครูซ้ำ ชื่อเดียวกัน (2)/รอบที่ 1 (ส่ง 2026-11-01)/') // the empty attempt folder
  })

  it('a file that fails twice is left out and listed; one that fails once is retried', async () => {
    const calls = {}
    const fetchBytes = async (url) => {
      calls[url] = (calls[url] ?? 0) + 1
      if (url.endsWith('sb1/1.bin')) throw new Error('network')
      if (url.endsWith('sa2/1.bin') && calls[url] === 1) throw new Error('flaky')
      return strToU8('ok')
    }
    const signedUrls = async (paths) => Object.fromEntries(paths.map((p) => [p, `u/${p}`]))
    const out = await buildZip(plan, { signedUrls, fetchBytes })
    expect(out.failed).toEqual(['T002 นางสาวสมหญิง รักเรียน/รอบที่ 1 (ส่ง 2026-11-01)/_CON.docx'])
    const files = unzipSync(out.bytes)
    expect(files['T002 นางสาวสมหญิง รักเรียน/รอบที่ 1 (ส่ง 2026-11-01)/_CON.docx']).toBeUndefined()
    expect(strFromU8(files[FAILED_FILE])).toContain('_CON.docx')
    expect(calls['u/sa2/1.bin']).toBe(2)
    expect(Object.keys(files).some((n) => n.endsWith('_fdp.exe'))).toBe(true)
  })

  it('a file the person may not open (no signed URL) is listed, not fetched', async () => {
    const fetchBytes = vi.fn(async () => strToU8('ok'))
    const signedUrls = async (paths) =>
      Object.fromEntries(paths.filter((p) => !p.startsWith('sb1/')).map((p) => [p, `u/${p}`]))
    const out = await buildZip(plan, { signedUrls, fetchBytes })
    expect(out.failed).toHaveLength(1)
    expect(fetchBytes).toHaveBeenCalledTimes(4)
  })
})

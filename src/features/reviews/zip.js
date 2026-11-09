import { zipSync, strToU8 } from 'fflate'
import { AppError } from '../../core/errors.js'
import { toXlsx } from '../../shared/utils/xlsx.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'

/**
 * Download every submitted attempt of a task in one cohort as one .zip
 * (Phase 4e — instead of the Google Drive copy, which needs a Shared Drive).
 *
 *   <task> - <cohort>.zip
 *   ├── สรุป.xlsx                      one row per attempt, plus people who sent nothing
 *   └── <code> <name>/
 *       └── รอบที่ N (ส่ง YYYY-MM-DD[, ส่งช้า])/
 *           ├── คำตอบ.txt              typed answer and links (only when there are any)
 *           └── <the files, under the names the trainee gave them>
 *
 * Everything runs in the browser with the reviewer's own rights: the rows come
 * through RLS and the files through signed URLs, so nothing here can widen
 * what the person may read. Names come from users and are made safe for every
 * desktop OS: one path segment each, no "..", no reserved names, no control or
 * direction-changing characters, not too long, never two the same.
 */

/** Browsers hold the whole archive in memory; past this, the page may stall or crash. */
export const ZIP_MAX_BYTES = 500 * 1024 * 1024
export const ZIP_MAX_FILES = 3000
export const ANSWER_FILE = 'คำตอบ.txt'
export const SUMMARY_FILE = 'สรุป.xlsx'
export const FAILED_FILE = 'ไฟล์ที่ดาวน์โหลดไม่สำเร็จ.txt'

// a name stays well inside the 255-byte limit of common file systems ...
const MAX_SEGMENT_BYTES = 100
// ... and a whole path inside the 260-character limit of older Windows tools (the
// archive is extracted under the person's own folders, which take room too)
export const MAX_PATH_CHARS = 200
const MAX_EXT_CHARS = 16
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
// C0/C1 controls, and the characters that change text direction (a name like
// U+202E + "fdp.exe" would show as "exe.pdf"); matching control characters is the point here
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const FORBIDDEN = /[\\/:*?"<>|]/g

const utf8Length = (s) => new TextEncoder().encode(s).length

/** Cut by whole characters until the UTF-8 form fits. */
function cutToBytes(s, max) {
  const chars = [...s]
  while (chars.length && utf8Length(chars.join('')) > max) chars.pop()
  return chars.join('')
}

/** One safe path segment (a file or folder name), never empty. */
export function safeSegment(name, fallback = 'ไฟล์') {
  let s = String(name ?? '')
    .normalize('NFC')
    .replace(/[\t\n\r\v\f]/g, ' ') // whitespace controls become spaces before the rest are dropped
    .replace(INVISIBLE, '')
    .replace(FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '') // Windows drops trailing dots/spaces; leading dots hide files
  if (!s) s = fallback
  const dot = s.lastIndexOf('.')
  let base = dot > 0 && s.length - dot - 1 <= MAX_EXT_CHARS ? s.slice(0, dot) : s
  const ext = base === s ? '' : s.slice(dot)
  if (RESERVED.test(base.trim())) base = `_${base}`
  if (utf8Length(base + ext) > MAX_SEGMENT_BYTES) {
    base = cutToBytes(base, MAX_SEGMENT_BYTES - utf8Length(ext)).replace(/[.\s]+$/, '') || '_'
  }
  return base + ext
}

/** `name` cut (before its extension) so that `${folder}/${name}` has at most `max` characters. */
export function fitName(folder, name, max = MAX_PATH_CHARS) {
  const room = max - [...folder].length - 1
  if ([...name].length <= room) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= MAX_EXT_CHARS + 1 ? name.slice(dot) : ''
  const stem = [...name.slice(0, name.length - ext.length)]
    .slice(0, Math.max(room - [...ext].length, 8))
    .join('')
  return `${stem.replace(/[.\s]+$/, '') || '_'}${ext}`
}

/** Give `name` a " (2)", " (3)" … before its extension until no other name in `used` matches it (any case). */
export function uniqueName(name, used) {
  const key = (n) => n.normalize('NFC').toLowerCase()
  if (!used.has(key(name))) {
    used.add(key(name))
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})${ext}`
    if (!used.has(key(candidate))) {
      used.add(key(candidate))
      return candidate
    }
  }
}

/** YYYY-MM-DD in Thailand (UTC+7, no daylight saving). */
export function bangkokDate(iso) {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return new Date(t.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

const personName = (p) => (p?.full_name || p?.display_name || '').trim()

export function personFolderName(profile) {
  const code = (profile?.user_code ?? '').trim()
  const name = personName(profile) || 'ไม่ทราบชื่อ'
  return safeSegment(code ? `${code} ${name}` : name, 'ไม่ทราบชื่อ')
}

export function attemptFolderName(s) {
  const when = bangkokDate(s.submitted_at)
  return `รอบที่ ${s.attempt_no}${when ? ` (ส่ง ${when}${s.is_late ? ', ส่งช้า' : ''})` : ''}`
}

const outcomeLabel = (r) => (r ? (r.outcome === 'passed' ? 'ผ่าน' : 'ส่งกลับแก้ไข') : '')
const linkLine = (l) => (l.label ? `${l.label} — ${l.url}` : l.url)

/** คำตอบ.txt: the typed answer and the links of one attempt; null when there are neither. */
export function answerText(submission, { taskTitle = '' } = {}) {
  const text = (submission.text_response ?? '').trim()
  const links = Array.isArray(submission.links) ? submission.links.filter((l) => l?.url) : []
  if (!text && !links.length) return null
  const p = submission.profiles
  const code = (p?.user_code ?? '').trim()
  return [
    taskTitle ? `ภาระงาน: ${taskTitle}` : null,
    `ผู้ส่ง: ${personName(p) || 'ไม่ทราบชื่อ'}${code ? ` (${code})` : ''}`,
    `รอบที่ ${submission.attempt_no} · ส่งเมื่อ ${formatThaiDateTime(submission.submitted_at)}${submission.is_late ? ' · ส่งช้า' : ''}`,
    '',
    'คำตอบ:',
    text || '(ไม่มี)',
    '',
    'ลิงก์:',
    ...(links.length ? links.map((l) => `- ${linkLine(l)}`) : ['(ไม่มี)']),
    '',
  ]
    .filter((line) => line !== null)
    .join('\r\n') // Notepad on older Windows shows \n-only text on one line
}

/**
 * What goes into the archive, without downloading anything.
 *   data: { task, cohort, submissions, files, reviews, roster }
 *     submissions  submitted attempts with profiles (id, full_name, display_name, user_code)
 *     files        task_submission_files rows of those attempts
 *     reviews      released reviews of those attempts
 *     roster       [{user_id, profiles}] of the cohort's trainees (for "ยังไม่ส่ง")
 * → { name, entries: [{path, objectPath, size} | {path, text}], summaryRows, fileCount, totalBytes }
 */
export function planZip({ task, cohort, submissions = [], files = [], reviews = [], roster = [] }) {
  const submitted = submissions.filter((s) => s.status === undefined || s.status === 'submitted')
  const filesOf = new Map()
  for (const f of files) filesOf.set(f.submission_id, [...(filesOf.get(f.submission_id) ?? []), f])
  // the review in force: the latest released one (a regrade supersedes the earlier)
  const reviewOf = new Map()
  for (const r of reviews) {
    const prev = reviewOf.get(r.submission_id)
    if (!prev || String(r.released_at) > String(prev.released_at)) reviewOf.set(r.submission_id, r)
  }

  // people: everyone who sent something, then the roster's others; sorted by code, then name
  const people = new Map()
  for (const s of submitted) people.set(s.user_id, s.profiles ?? null)
  for (const m of roster) if (!people.has(m.user_id)) people.set(m.user_id, m.profiles ?? null)
  const order = [...people].sort(([, a], [, b]) =>
    `${a?.user_code ?? '￿'} ${personName(a)}`.localeCompare(`${b?.user_code ?? '￿'} ${personName(b)}`, 'th')
  )

  const usedTop = new Set([SUMMARY_FILE.toLowerCase(), FAILED_FILE.toLowerCase()])
  const entries = []
  const folders = [] // every attempt gets its folder, even one with no file (the summary points to it)
  const summaryRows = [
    [
      'รหัส',
      'ชื่อ',
      'รอบที่',
      'ส่งเมื่อ',
      'ส่งช้า',
      'จำนวนไฟล์',
      'ลิงก์',
      'ผลการตรวจ',
      'คะแนน',
      'คะแนนเต็ม',
      'โฟลเดอร์ใน zip',
    ],
  ]
  let totalBytes = 0
  let fileCount = 0

  for (const [userId, profile] of order) {
    const mine = submitted.filter((s) => s.user_id === userId).sort((a, b) => a.attempt_no - b.attempt_no)
    const code = (profile?.user_code ?? '').trim()
    const name = personName(profile) || 'ไม่ทราบชื่อ'
    if (!mine.length) {
      summaryRows.push([code, name, '', '', '', '', '', 'ยังไม่ส่ง', '', '', ''])
      continue
    }
    const person = uniqueName(personFolderName(profile), usedTop)
    const usedAttempts = new Set()
    for (const s of mine) {
      const folder = `${person}/${uniqueName(safeSegment(attemptFolderName(s), `รอบที่ ${s.attempt_no}`), usedAttempts)}`
      folders.push(folder)
      const used = new Set([ANSWER_FILE.toLowerCase()])
      const answer = answerText(s, { taskTitle: task?.title ?? '' })
      if (answer) entries.push({ path: `${folder}/${ANSWER_FILE}`, text: answer })
      const mineFiles = (filesOf.get(s.id) ?? [])
        .slice()
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      for (const f of mineFiles) {
        const size = Number(f.size_bytes) || 0
        entries.push({
          path: `${folder}/${uniqueName(fitName(folder, safeSegment(f.file_name)), used)}`,
          objectPath: f.object_path,
          size,
        })
        totalBytes += size
        fileCount += 1
      }
      const review = reviewOf.get(s.id)
      const links = Array.isArray(s.links)
        ? s.links
            .filter((l) => l?.url)
            .map(linkLine)
            .join('\n')
        : ''
      summaryRows.push([
        code,
        name,
        s.attempt_no,
        formatThaiDateTime(s.submitted_at),
        s.is_late ? 'ใช่' : 'ไม่',
        mineFiles.length,
        links,
        outcomeLabel(review),
        review?.score ?? '',
        review?.max_score ?? '',
        folder,
      ])
    }
  }

  const base = safeSegment(
    [task?.title, cohort?.name ?? cohort?.code].filter(Boolean).join(' - '),
    'งานที่ส่ง'
  )
  return { name: `${base}.zip`, entries, folders, summaryRows, fileCount, totalBytes }
}

const MB = 1024 * 1024
const mb = (bytes) => `${Math.ceil(bytes / MB).toLocaleString('th-TH')} MB`

/** Refuse before downloading anything when the archive would be too big for the browser. */
export function checkZipLimits(plan, { maxBytes = ZIP_MAX_BYTES, maxFiles = ZIP_MAX_FILES } = {}) {
  if (plan.totalBytes > maxBytes)
    throw new AppError(
      `งานของรุ่นนี้มีขนาดรวม ${mb(plan.totalBytes)} เกินกว่าที่ดาวน์โหลดเป็นไฟล์เดียวได้ (ไม่เกิน ${mb(maxBytes)}) — เปิดดูและดาวน์โหลดทีละคนจากหน้าตรวจงานแทน`
    )
  if (plan.fileCount > maxFiles)
    throw new AppError(
      `งานของรุ่นนี้มี ${plan.fileCount.toLocaleString('th-TH')} ไฟล์ เกินกว่าที่รวมเป็นไฟล์เดียวได้ (ไม่เกิน ${maxFiles.toLocaleString('th-TH')} ไฟล์)`
    )
}

/**
 * Download the files of a plan and pack the archive.
 *   signedUrls(paths) → { [path]: url }      (the reviewer's rights)
 *   fetchBytes(url)   → Uint8Array           (throws on a failed download)
 *   onProgress({ done, total })
 * A file that cannot be downloaded (after one retry) is left out and listed in
 * ไฟล์ที่ดาวน์โหลดไม่สำเร็จ.txt, so one broken file does not lose the rest.
 *   isCancelled()     → true once the person has left the page: stop fetching, build nothing
 * → { bytes, name, failed: [path] }, or null when cancelled
 */
export async function buildZip(
  plan,
  {
    signedUrls,
    fetchBytes,
    onProgress = () => {},
    isCancelled = () => false,
    concurrency = 4,
    signChunk = 100,
  }
) {
  const fileEntries = plan.entries.filter((e) => e.objectPath)
  const urls = {}
  for (let i = 0; i < fileEntries.length; i += signChunk) {
    Object.assign(urls, await signedUrls(fileEntries.slice(i, i + signChunk).map((e) => e.objectPath)))
  }

  const tree = {}
  for (const folder of plan.folders ?? []) tree[`${folder}/`] = new Uint8Array(0)
  const failed = []
  let done = 0
  onProgress({ done, total: fileEntries.length })
  const fetchOne = async (entry) => {
    const url = urls[entry.objectPath]
    let bytes = null
    for (let attempt = 0; attempt < 2 && url && !bytes; attempt += 1) {
      try {
        bytes = await fetchBytes(url)
      } catch {
        bytes = null
      }
    }
    if (bytes)
      tree[entry.path] = [bytes, { level: 0 }] // work files are usually compressed already
    else failed.push(entry.path)
    done += 1
    onProgress({ done, total: fileEntries.length })
  }
  let next = 0
  const worker = async () => {
    while (next < fileEntries.length && !isCancelled()) await fetchOne(fileEntries[next++])
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, fileEntries.length) }, worker))

  if (isCancelled()) return null // the person left the page: nothing is built or saved
  for (const e of plan.entries) if (e.text != null) tree[e.path] = strToU8(e.text)
  tree[SUMMARY_FILE] = toXlsx(plan.summaryRows, { sheetName: 'สรุป', textColumns: [0] })
  if (failed.length) {
    failed.sort()
    tree[FAILED_FILE] = strToU8(
      ['ไฟล์เหล่านี้ดาวน์โหลดไม่สำเร็จ กรุณาเปิดจากหน้าตรวจงาน:', ...failed.map((p) => `- ${p}`), ''].join(
        '\r\n'
      )
    )
  }
  return { bytes: zipSync(tree), name: plan.name, failed }
}

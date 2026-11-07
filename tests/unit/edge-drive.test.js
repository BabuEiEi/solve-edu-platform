// @vitest-environment node
/**
 * Google token, Drive client and the copy logic of drive-export-task,
 * against the strict fake Google (tests/fake-google.js) — no network.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createFakeGoogle } from '../fake-google.js'
import {
  createTokenSource,
  parseServiceAccount,
  googleUrl,
  GOOGLE_TOKEN_URL,
} from '../../supabase/functions/_shared/google.js'
import { createDrive, cleanName, q } from '../../supabase/functions/_shared/drive.js'
import {
  exportToDrive,
  attemptFolderName,
  bangkokDate,
} from '../../supabase/functions/drive-export-task/exporter.js'

const BASE = 'http://fake-google.example.test'
const EMAIL = 'copier@solveedu-test.iam.gserviceaccount.example.test'
let keys

beforeAll(() => {
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 })
  keys = {
    privatePem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: k.publicKey.export({ type: 'spki', format: 'pem' }),
  }
})

function setup() {
  const g = createFakeGoogle({ publicKeyPem: keys.publicPem, clientEmail: EMAIL, baseUrl: BASE })
  const fetch = vi.fn((url, init) => g.handle(new Request(url, init)))
  const getToken = createTokenSource({
    serviceAccount: { clientEmail: EMAIL, privateKey: keys.privatePem },
    tokenUrl: `${BASE}/token`,
    fetch,
  })
  const drive = createDrive({
    getToken,
    api: `${BASE}/drive/v3`,
    upload: `${BASE}/upload/drive/v3`,
    fetch,
    sleep: async () => {},
  })
  return { g, fetch, getToken, drive }
}

const pdf = (text) => new TextEncoder().encode(`%PDF-1.4 ${text}`)
const manifest = () => ({
  run_id: 'r1',
  allocation_id: 'alloc-1',
  course: { id: 'c1', title: 'หลักสูตรครูผู้ช่วย' },
  cohort: { id: 'h1', name: 'รุ่น 1/2569' },
  task: { id: 't1', title: 'ส่งแผนการสอน' },
  attempts: [
    {
      submission_id: 's1',
      attempt_no: 1,
      user_id: 'u1',
      person: 'ครู ก',
      submitted_at: '2026-11-05T17:30:00Z',
      is_late: false,
      files: [
        { id: 'f1', object_path: 's1/a.pdf', file_name: 'แผน.pdf', mime_type: 'application/pdf' },
        { id: 'f2', object_path: 's1/b.pdf', file_name: 'ใบงาน.pdf', mime_type: 'application/pdf' },
      ],
    },
    {
      submission_id: 's2',
      attempt_no: 2,
      user_id: 'u1',
      person: 'ครู ก',
      submitted_at: '2026-11-06T02:00:00Z',
      is_late: true,
      files: [
        { id: 'f3', object_path: 's2/c.pdf', file_name: 'แผน (แก้).pdf', mime_type: 'application/pdf' },
      ],
    },
  ],
})
const download = vi.fn(async (path) => pdf(path))

describe('Google token', () => {
  it('signs a correct assertion (verified by the fake with the public key) and reuses the token', async () => {
    const { getToken, fetch } = setup()
    const t = await getToken()
    expect(t).toMatch(/^ya29\.fake-/)
    expect(await getToken()).toBe(t)
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/token'))).toHaveLength(1)
  })

  it('a key that is not the service account’s is refused by Google', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    })
    const g = createFakeGoogle({ publicKeyPem: keys.publicPem, clientEmail: EMAIL, baseUrl: BASE })
    const getToken = createTokenSource({
      serviceAccount: { clientEmail: EMAIL, privateKey: other },
      tokenUrl: `${BASE}/token`,
      fetch: (u, i) => g.handle(new Request(u, i)),
    })
    await expect(getToken()).rejects.toMatchObject({ code: 'google_auth_failed', status: 400 })
  })

  it('service account JSON: missing pieces are "not configured"', () => {
    expect(
      parseServiceAccount(JSON.stringify({ client_email: EMAIL, private_key: keys.privatePem }))
    ).toMatchObject({
      clientEmail: EMAIL,
    })
    for (const raw of [
      undefined,
      '',
      '{',
      '{}',
      JSON.stringify({ client_email: EMAIL, private_key: 'abc' }),
    ]) {
      expect(() => parseServiceAccount(raw)).toThrow(expect.objectContaining({ code: 'not_configured' }))
    }
  })

  it('Google URL overrides may only point at this machine (tests), never elsewhere', () => {
    expect(googleUrl(undefined, GOOGLE_TOKEN_URL)).toBe(GOOGLE_TOKEN_URL)
    expect(googleUrl('http://host.docker.internal:54399/token', 'x')).toBe(
      'http://host.docker.internal:54399/token'
    )
    expect(googleUrl('http://127.0.0.1:9/', 'x')).toBe('http://127.0.0.1:9')
    for (const bad of [
      'https://evil.example.test/token',
      'http://10.0.0.5/token',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(() => googleUrl(bad, 'x')).toThrow(expect.objectContaining({ code: 'not_configured' }))
    }
  })
})

describe('Drive client', () => {
  it('ensureFolder finds by our key, not by name, and creates once', async () => {
    const { g, drive } = setup()
    const a = await drive.ensureFolder(g.root, 'ครู ก', 'person:u1')
    expect(await drive.ensureFolder(g.root, 'ครู ก (เปลี่ยนชื่อแล้ว)', 'person:u1')).toBe(a)
    expect(await drive.ensureFolder(g.root, 'ครู ก', 'person:u2')).not.toBe(a) // same name, another person
    expect(g.files.get(a).appProperties).toEqual({ solveedu: 'person:u1' })
  })

  it('uploads with a resumable session; filesIn maps our ids to Drive ids', async () => {
    const { g, drive } = setup()
    const id = await drive.uploadFile(g.root, {
      name: 'แผน.pdf',
      mimeType: 'application/pdf',
      bytes: pdf('x'),
      fileKey: 'f1',
    })
    expect(g.files.get(id)).toMatchObject({
      name: 'แผน.pdf',
      mimeType: 'application/pdf',
      appProperties: { solveeduFile: 'f1' },
    })
    expect(new TextDecoder().decode(g.files.get(id).bytes)).toBe('%PDF-1.4 x')
    expect(await drive.filesIn(g.root)).toEqual(new Map([['f1', id]]))
  })

  it('retries 5xx/429 but fails at once on 403, with a safe code', async () => {
    const { g, drive, fetch } = setup()
    await drive.ensureFolder(g.root, 'x', 'k0') // token fetched
    let flaky = 2
    const real = fetch.getMockImplementation()
    fetch.mockImplementation((u, i) => (flaky-- > 0 ? new Response('busy', { status: 503 }) : real(u, i)))
    expect(await drive.ensureFolder(g.root, 'y', 'k1')).toBeTruthy()
    fetch.mockImplementation(real)
    g.fail.createFolder = 403
    await expect(drive.ensureFolder(g.root, 'z', 'k2')).rejects.toMatchObject({ status: 403 })
    await expect(drive.ensureFolder(g.root, 'z', 'k2')).rejects.toThrow(
      /^drive_forbidden: create folder \(HTTP 403\)$/
    )
  })

  it('refuses an upload session on another host', async () => {
    const { g, drive, fetch } = setup()
    const real = fetch.getMockImplementation()
    fetch.mockImplementation(async (u, i) => {
      const r = await real(u, i)
      return r.headers.get('location')
        ? new Response(null, { status: 200, headers: { location: 'https://evil.example.test/upload' } })
        : r
    })
    await expect(
      drive.uploadFile(g.root, { name: 'a.pdf', mimeType: 'application/pdf', bytes: pdf('a'), fileKey: 'f9' })
    ).rejects.toThrow(/upload session host/)
    expect(fetch.mock.calls.some(([u]) => String(u).startsWith('https://evil'))).toBe(false)
  })

  it('names and query literals are made safe', () => {
    expect(cleanName('  ครู\u0000ก\n\tข  ')).toBe('ครู ก ข')
    expect(cleanName('')).toBe('(ไม่มีชื่อ)')
    expect(cleanName('ก'.repeat(300))).toHaveLength(120)
    expect(q("it's \\ ok")).toBe("'it\\'s \\\\ ok'")
  })
})

describe('export logic', () => {
  it('builds course / cohort / task / trainee / attempt and copies every file', async () => {
    const { g, drive } = setup()
    const out = await exportToDrive({ manifest: manifest(), drive, download, rootFolderId: g.root })
    expect(out).toMatchObject({ status: 'done', copied: 3, skipped: 0, failed: 0, remaining: 0 })
    const paths = g.uploaded().map((f) => g.pathOf(f.id).join(' / '))
    expect(paths.sort()).toEqual([
      'หลักสูตรครูผู้ช่วย / รุ่น 1/2569 / ส่งแผนการสอน / ครู ก / รอบที่ 1 (ส่ง 2026-11-06) / แผน.pdf',
      'หลักสูตรครูผู้ช่วย / รุ่น 1/2569 / ส่งแผนการสอน / ครู ก / รอบที่ 1 (ส่ง 2026-11-06) / ใบงาน.pdf',
      'หลักสูตรครูผู้ช่วย / รุ่น 1/2569 / ส่งแผนการสอน / ครู ก / รอบที่ 2 (ส่ง 2026-11-06, ส่งช้า) / แผน (แก้).pdf',
    ])
    expect(out.copies.map((c) => c.file_id).sort()).toEqual(['f1', 'f2', 'f3'])
    expect(g.files.get(out.folderId).name).toBe('ส่งแผนการสอน')
  })

  it('pressing again copies nothing twice; a file deleted in Drive is copied again', async () => {
    const { g, drive } = setup()
    await exportToDrive({ manifest: manifest(), drive, download, rootFolderId: g.root })
    const again = await exportToDrive({ manifest: manifest(), drive, download, rootFolderId: g.root })
    expect(again).toMatchObject({ status: 'done', copied: 0, skipped: 3 })
    expect(again.copies).toHaveLength(3) // still reported, so the record stays complete
    expect(g.uploaded()).toHaveLength(3)
    g.uploaded().find((f) => f.appProperties.solveeduFile === 'f2').trashed = true
    const third = await exportToDrive({ manifest: manifest(), drive, download, rootFolderId: g.root })
    expect(third).toMatchObject({ copied: 1, skipped: 2 })
  })

  it('a failing file does not stop the others ("partial"); the top folder failing is "failed"', async () => {
    const { g, drive } = setup()
    const flaky = vi.fn(async (path) => {
      if (path === 's1/b.pdf') throw Object.assign(new Error('x'), { code: 'download_failed' })
      return pdf(path)
    })
    const out = await exportToDrive({ manifest: manifest(), drive, download: flaky, rootFolderId: g.root })
    expect(out).toMatchObject({ status: 'partial', copied: 2, failed: 1 })
    const g2 = setup()
    g2.g.fail.createFolder = 403
    const none = await exportToDrive({
      manifest: manifest(),
      drive: g2.drive,
      download,
      rootFolderId: g2.g.root,
    })
    expect(none).toMatchObject({ status: 'failed', copied: 0, folderId: null })
    expect(none.errors[0]).toMatch(/^drive_forbidden/)
  })

  it('stops starting new files when the time budget runs out, and says how many remain', async () => {
    const { g, drive } = setup()
    let t = 0
    const slow = async (path) => {
      t += 60_000
      return pdf(path)
    }
    const out = await exportToDrive({
      manifest: manifest(),
      drive,
      download: slow,
      rootFolderId: g.root,
      budgetMs: 100_000,
      now: () => t,
    })
    expect(out).toMatchObject({ status: 'partial', copied: 2, remaining: 1 })
    const rest = await exportToDrive({ manifest: manifest(), drive, download, rootFolderId: g.root })
    expect(rest).toMatchObject({ status: 'done', copied: 1, skipped: 2 })
  })

  it('attempt folder names: Thai date (UTC+7) and late mark', () => {
    expect(bangkokDate('2026-11-05T17:30:00Z')).toBe('2026-11-06')
    expect(bangkokDate('nonsense')).toBe('')
    expect(attemptFolderName({ attempt_no: 3, submitted_at: '2026-01-01T00:00:00Z', is_late: true })).toBe(
      'รอบที่ 3 (ส่ง 2026-01-01, ส่งช้า)'
    )
  })
})

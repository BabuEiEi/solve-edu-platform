/**
 * The small part of the Google Drive v3 API we use, for a Shared Drive.
 *
 * Folders and files are found by OUR ids kept in appProperties
 * (solveedu = folder key, solveeduFile = task file id), never by name, so a
 * renamed person or task does not create a second folder and a repeated
 * copy never uploads a file twice. Every call sets supportsAllDrives
 * (required for Shared Drives).
 */
import { DriveError } from './google.js'

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER = 'application/vnd.google-apps.folder'
const ID = /^[A-Za-z0-9_-]{1,200}$/

/** Drive query string literal: backslash and quote escaped. */
export const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** A folder or file name Drive and people can read: no control characters, ≤ 120 characters. */
export function cleanName(name, fallback = '(ไม่มีชื่อ)') {
  const s = [...String(name ?? '')]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return (s || fallback).slice(0, 120)
}

/**
 *   getToken: () => access token (see google.js)
 *   sharedDriveId: when set, searches stay inside that Shared Drive
 */
export function createDrive({
  getToken,
  sharedDriveId = '',
  api = DRIVE_API,
  upload = DRIVE_UPLOAD,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const scope = sharedDriveId
    ? { corpora: 'drive', driveId: sharedDriveId, includeItemsFromAllDrives: 'true' }
    : { corpora: 'allDrives', includeItemsFromAllDrives: 'true' }

  // 429 / 5xx are retried (3 tries, growing pause); anything else fails at once
  async function call(what, url, init = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${await getToken()}`, ...init.headers },
      })
      if (res.ok) return res
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(500 * attempt)
        continue
      }
      const code =
        res.status === 403 ? 'drive_forbidden' : res.status === 404 ? 'drive_not_found' : 'drive_error'
      throw new DriveError(`${code}: ${what}`, res.status)
    }
  }

  const params = (o) => new URLSearchParams({ supportsAllDrives: 'true', ...o }).toString()

  async function list(query, fields) {
    const out = []
    let pageToken = ''
    do {
      const res = await call(
        'list',
        `${api}/files?${params({ ...scope, q: query, fields: `nextPageToken,files(${fields})`, pageSize: '1000', ...(pageToken ? { pageToken } : {}) })}`
      )
      const body = await res.json()
      out.push(...(body.files ?? []))
      pageToken = body.nextPageToken ?? ''
    } while (pageToken)
    return out
  }

  /** The child folder with this key, created if missing; returns its id. */
  async function ensureFolder(parentId, name, key) {
    const found = await list(
      `${q(parentId)} in parents and mimeType = ${q(FOLDER)} and trashed = false and appProperties has { key='solveedu' and value=${q(key)} }`,
      'id'
    )
    if (found[0]?.id) return found[0].id
    const res = await call('create folder', `${api}/files?${params({ fields: 'id' })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        name: cleanName(name),
        mimeType: FOLDER,
        parents: [parentId],
        appProperties: { solveedu: key },
      }),
    })
    const { id } = await res.json()
    if (!ID.test(id ?? '')) throw new DriveError('drive_error: create folder')
    return id
  }

  /** Map of our file id → Drive file id for files already in a folder. */
  async function filesIn(folderId) {
    const files = await list(
      `${q(folderId)} in parents and trashed = false and mimeType != ${q(FOLDER)}`,
      'id,appProperties'
    )
    return new Map(
      files.filter((f) => f.appProperties?.solveeduFile).map((f) => [f.appProperties.solveeduFile, f.id])
    )
  }

  /** Resumable upload (works for files up to the 20 MB task limit and beyond). */
  async function uploadFile(folderId, { name, mimeType, bytes, fileKey }) {
    const type = mimeType || 'application/octet-stream'
    const start = await call(
      'upload',
      `${upload}/files?${params({ uploadType: 'resumable', fields: 'id' })}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': type,
          'x-upload-content-length': String(bytes.byteLength),
        },
        body: JSON.stringify({
          name: cleanName(name, 'ไฟล์'),
          parents: [folderId],
          appProperties: { solveeduFile: fileKey },
        }),
      }
    )
    const session = start.headers.get('location') ?? ''
    // the upload session must be on the upload host we were configured with
    if (new URL(session, upload).origin !== new URL(upload).origin)
      throw new DriveError('drive_error: upload session host')
    const done = await call('upload', session, {
      method: 'PUT',
      headers: { 'content-type': type },
      body: bytes,
    })
    const { id } = await done.json()
    if (!ID.test(id ?? '')) throw new DriveError('drive_error: upload')
    return id
  }

  return { ensureFolder, filesIn, uploadFile }
}

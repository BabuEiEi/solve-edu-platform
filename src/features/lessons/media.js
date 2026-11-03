import { AppError, unwrap } from '../../core/errors.js'

export const LESSON_MEDIA_BUCKET = 'lesson-media'
const MB = 1024 * 1024

/** Client-side mirror of the bucket allowlist (the bucket itself is authoritative). */
export const MEDIA_RULES = {
  image: {
    maxBytes: 10 * MB,
    types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' },
  },
  document: {
    maxBytes: 50 * MB,
    types: {
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    },
  },
  video: { maxBytes: 50 * MB, types: { 'video/mp4': 'mp4', 'video/webm': 'webm' } },
}

export function acceptAttr(kind) {
  return Object.keys(MEDIA_RULES[kind]?.types ?? {}).join(',')
}

export function validateMediaFile(kind, file) {
  const rule = MEDIA_RULES[kind]
  if (!rule || !file) throw new AppError('กรุณาเลือกไฟล์')
  if (!rule.types[file.type]) throw new AppError('ชนิดไฟล์ไม่รองรับ')
  if (file.size > rule.maxBytes) throw new AppError(`ไฟล์มีขนาดใหญ่เกิน ${Math.round(rule.maxBytes / MB)} MB`)
  return rule.types[file.type]
}

/**
 * Path = <lesson_id>/<random>.<ext>. The first folder decides who may read
 * or write the object (storage policies); the user's file name is never
 * part of the path.
 */
export function mediaPathFor(lessonId, ext, uuid = globalThis.crypto.randomUUID()) {
  return `${lessonId}/${uuid}.${ext}`
}

export function createMediaService(client) {
  const bucket = () => client.storage.from(LESSON_MEDIA_BUCKET)
  return {
    async upload(lessonId, kind, file) {
      const ext = validateMediaFile(kind, file)
      const path = mediaPathFor(lessonId, ext)
      unwrap(
        await bucket().upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' }),
        'storage.upload'
      )
      return path
    },

    /** { [path]: signedUrl } — paths the caller may not read are simply absent. */
    async signedUrls(paths, expiresIn = 3600) {
      if (!paths?.length) return {}
      const rows = unwrap(await bucket().createSignedUrls(paths, expiresIn), 'storage.sign') ?? []
      return Object.fromEntries(rows.filter((r) => r.signedUrl && !r.error).map((r) => [r.path, r.signedUrl]))
    },

    async remove(paths) {
      if (!paths?.length) return
      unwrap(await bucket().remove(paths), 'storage.remove')
    },
  }
}

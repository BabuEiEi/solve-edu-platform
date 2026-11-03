import { AppError } from '../../core/errors.js'
import { sanitizeRichText, isBlankRichText } from '../../shared/ui/sanitize.js'

/**
 * Lesson block types. `authoring: false` types exist in the schema but have
 * no editor yet (embed is limited by CSP frame-src; quiz_reference = Phase 2B).
 */
export const BLOCK_TYPES = {
  rich_text: { label: 'ข้อความ', icon: '¶', authoring: true },
  video: { label: 'วิดีโอ', icon: '▶', authoring: true },
  image: { label: 'รูปภาพ', icon: '▨', authoring: true },
  document: { label: 'เอกสารแนบ', icon: '⎙', authoring: true },
  link: { label: 'ลิงก์', icon: '↗', authoring: true },
  embed: { label: 'ฝังเนื้อหา', icon: '⧉', authoring: false },
  quiz_reference: { label: 'แบบทดสอบ', icon: '?', authoring: false },
}

export const AUTHORING_TYPES = Object.keys(BLOCK_TYPES).filter((t) => BLOCK_TYPES[t].authoring)

const VIDEO_ID = /^[A-Za-z0-9_-]{6,64}$/
const MAX_TEXT = 300

/**
 * Accepts a YouTube/Vimeo URL or a bare YouTube id; returns
 * { provider, video_id } or null. Ids are re-validated by the database.
 */
export function parseVideoInput(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  if (VIDEO_ID.test(s)) return { provider: 'youtube', video_id: s }
  let url
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^www\.|^m\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  let id = null
  let provider = 'youtube'
  if (host === 'youtu.be') id = parts[0]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v')
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1]
  } else if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    provider = 'vimeo'
    id = parts.find((p) => /^\d+$/.test(p))
  }
  return id && VIDEO_ID.test(id) ? { provider, video_id: id } : null
}

const text = (v) =>
  String(v ?? '')
    .trim()
    .slice(0, MAX_TEXT)

/**
 * Build a block's content_json from editor fields, or throw AppError (Thai).
 * Mirrors private.is_valid_lesson_block so users see a clear message first.
 */
export function buildBlockContent(type, fields = {}) {
  switch (type) {
    case 'rich_text': {
      const html = sanitizeRichText(fields.html)
      if (isBlankRichText(html)) throw new AppError('กรุณาพิมพ์เนื้อหา')
      return { html }
    }
    case 'video': {
      const caption = text(fields.caption)
      if (fields.object_path) return { provider: 'storage', object_path: fields.object_path, caption }
      const parsed = parseVideoInput(fields.url)
      if (!parsed) throw new AppError('ลิงก์วิดีโอไม่ถูกต้อง (รองรับ YouTube และ Vimeo แบบ https)')
      return { ...parsed, caption }
    }
    case 'image': {
      if (!fields.object_path) throw new AppError('กรุณาเลือกไฟล์รูปภาพ')
      const alt = text(fields.alt)
      if (!alt) throw new AppError('กรุณาระบุคำอธิบายรูปภาพ (สำหรับผู้ใช้โปรแกรมอ่านหน้าจอ)')
      return { object_path: fields.object_path, alt, caption: text(fields.caption) }
    }
    case 'document': {
      if (!fields.object_path) throw new AppError('กรุณาเลือกไฟล์เอกสาร')
      return {
        object_path: fields.object_path,
        label: text(fields.label) || text(fields.file_name) || 'เอกสารประกอบ',
        file_name: text(fields.file_name),
      }
    }
    case 'link': {
      const url = String(fields.url ?? '').trim()
      if (!/^https:\/\/[^\s]+$/i.test(url)) throw new AppError('ลิงก์ต้องขึ้นต้นด้วย https://')
      return { url, label: text(fields.label) }
    }
    default:
      throw new AppError('ยังไม่รองรับการแก้ไขบล็อกประเภทนี้')
  }
}

/** Short plain-text description of a block for builder lists. */
export function blockSummary(block) {
  const c = block?.content_json ?? {}
  switch (block?.block_type) {
    case 'rich_text':
      return (
        sanitizeRichText(c.html)
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120) || '(ว่าง)'
      )
    case 'video':
      return c.caption || (c.provider === 'storage' ? 'ไฟล์วิดีโอ' : `${c.provider} · ${c.video_id}`)
    case 'image':
      return c.caption || c.alt || 'รูปภาพ'
    case 'document':
      return c.label || c.file_name || 'เอกสาร'
    case 'link':
      return c.label || c.url
    default:
      return BLOCK_TYPES[block?.block_type]?.label ?? ''
  }
}

/** Storage paths referenced by blocks (for batch signing / cleanup). */
export function mediaPathsOf(blocks = []) {
  return [...new Set(blocks.map((b) => b.content_json?.object_path).filter(Boolean))]
}

import { html, safeUrl } from '../../shared/ui/html.js'
import { richText } from '../../shared/ui/sanitize.js'

/**
 * Learner-facing block rendering, shared by the lesson page and the
 * builder preview. `media` maps storage object_path → short-lived signed URL.
 */
const unavailable = (what) =>
  html`<p class="rounded-lg border border-dashed border-ink-200 px-4 py-6 text-center text-sm text-ink-400">
    ไม่สามารถแสดง${what}ได้ (ไฟล์ไม่พบหรือไม่มีสิทธิ์เข้าถึง)
  </p>`

function videoEmbed(c) {
  const id = encodeURIComponent(c.video_id)
  const src =
    c.provider === 'vimeo'
      ? `https://player.vimeo.com/video/${id}`
      : `https://www.youtube-nocookie.com/embed/${id}`
  return html`<div class="aspect-video overflow-hidden rounded-xl bg-ink-900">
    <iframe
      class="h-full w-full"
      src="${src}"
      title="${c.caption || 'วิดีโอบทเรียน'}"
      loading="lazy"
      referrerpolicy="strict-origin-when-cross-origin"
      allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      allowfullscreen
    ></iframe>
  </div>`
}

export function renderBlock(block, media = {}) {
  const c = block.content_json ?? {}
  const caption = (t) => (t ? html`<figcaption class="mt-2 text-sm text-ink-500">${t}</figcaption>` : '')
  switch (block.block_type) {
    case 'rich_text':
      return html`<div class="lesson-prose">${richText(c.html)}</div>`
    case 'video': {
      if (c.provider === 'storage') {
        const url = media[c.object_path]
        return html`<figure>
          ${
            url
              ? html`<video class="w-full rounded-xl bg-ink-900" controls preload="metadata" src="${safeUrl(url)}"></video>`
              : unavailable('วิดีโอ')
          }
          ${caption(c.caption)}
        </figure>`
      }
      return html`<figure>${videoEmbed(c)}${caption(c.caption)}</figure>`
    }
    case 'image': {
      const url = media[c.object_path]
      return html`<figure>
        ${
          url
            ? html`<img class="mx-auto max-h-[70vh] rounded-xl" src="${safeUrl(url)}" alt="${c.alt ?? ''}" loading="lazy" />`
            : unavailable('รูปภาพ')
        }
        ${caption(c.caption)}
      </figure>`
    }
    case 'document': {
      const url = media[c.object_path]
      if (!url) return unavailable('เอกสาร')
      return html`<a
        href="${safeUrl(url)}"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-3 rounded-xl border border-ink-200 bg-white px-4 py-3 text-sm hover:border-brand-300"
        ><span aria-hidden="true" class="text-lg">⎙</span>
        <span class="font-medium text-ink-800">${c.label || c.file_name || 'เอกสารประกอบ'}</span>
        <span class="ml-auto text-xs text-brand-700">เปิดไฟล์</span></a
      >`
    }
    case 'link':
      return html`<a
        href="${safeUrl(c.url)}"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-3 rounded-xl border border-ink-200 bg-white px-4 py-3 text-sm hover:border-brand-300"
        ><span aria-hidden="true">↗</span><span class="font-medium text-brand-700">${c.label || c.url}</span></a
      >`
    case 'quiz_reference':
      // Eligibility, window and attempt limit are checked on the assessment page / by the RPC.
      return html`<a
        href="#/assessments/${encodeURIComponent(c.assessment_assignment_id ?? '')}"
        data-quiz-link
        class="flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-4 py-3 text-sm hover:border-brand-400"
        ><span aria-hidden="true" class="text-lg">✎</span>
        <span class="font-medium text-ink-800">${c.title || 'แบบทดสอบ'}</span>
        <span class="ml-auto text-xs font-semibold text-brand-700">ไปที่แบบทดสอบ</span></a
      >`
    default:
      return html`<p class="rounded-lg bg-ink-50 px-4 py-3 text-sm text-ink-500">
        เนื้อหาประเภทนี้จะรองรับในเวอร์ชันถัดไป
      </p>`
  }
}

export function renderBlocks(blocks = [], media = {}) {
  if (blocks.length === 0) return html`<p class="text-sm text-ink-400">บทเรียนนี้ยังไม่มีเนื้อหา</p>`
  return html`<div class="space-y-6">
    ${blocks.map((b) => html`<section data-block-id="${b.id}">${renderBlock(b, media)}</section>`)}
  </div>`
}

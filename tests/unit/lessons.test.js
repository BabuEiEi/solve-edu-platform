import { describe, it, expect, vi } from 'vitest'
import { render, html } from '../../src/shared/ui/html.js'
import { sanitizeRichText, isBlankRichText } from '../../src/shared/ui/sanitize.js'
import {
  parseVideoInput,
  buildBlockContent,
  blockSummary,
  mediaPathsOf,
} from '../../src/features/lessons/blocks.js'
import { mediaPathFor, validateMediaFile } from '../../src/features/lessons/media.js'
import { renderBlock } from '../../src/features/lessons/render.js'
import { createLessonService, neighbours } from '../../src/features/lessons/service.js'
import { renderLessonView } from '../../src/features/lessons/views.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

// JS mirror of the database guard in private.is_valid_lesson_block (migration 09).
const DB_GUARDS = [
  /<\s*\/?\s*(script|style|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|option|link|meta|base|svg|math|template)\b/i,
  /<[^>]*\son[a-z]+\s*=/i,
  /\s(href|src|xlink:href|action|formaction)\s*=\s*["']?\s*(javascript|vbscript|data)\s*:/i,
]

describe('sanitizeRichText', () => {
  const payloads = [
    '<p>ok</p><script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
    '<iframe src="https://evil.example.test"></iframe>',
    '<p style="background:url(javascript:alert(1))" onclick="x()">t</p>',
    '<form action="https://evil.example.test"><input name=a></form>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<a href="https://ok.example.test" onmouseover="x()">ok</a>',
  ]

  it('removes script-capable markup', () => {
    for (const p of payloads) {
      const out = sanitizeRichText(p)
      for (const g of DB_GUARDS) expect(out, `${p} → ${out}`).not.toMatch(g)
      expect(out).not.toMatch(/style=|onclick|onerror|javascript:/i)
    }
  })

  it('keeps allowed formatting and hardens links', () => {
    const out = sanitizeRichText(
      '<h2>หัวข้อ</h2><p><strong>ตัวหนา</strong> <a href="https://example.test">ลิงก์</a></p>'
    )
    expect(out).toContain('<h2>หัวข้อ</h2>')
    expect(out).toContain('<strong>ตัวหนา</strong>')
    expect(out).toMatch(
      /<a href="https:\/\/example.test" target="_blank" rel="noopener noreferrer nofollow">/
    )
  })

  it('drops http: links (https/mailto only)', () => {
    expect(sanitizeRichText('<a href="http://x.example.test">x</a>')).toBe('<a>x</a>')
  })

  it('detects blank content', () => {
    expect(isBlankRichText('<p></p><p>&nbsp;</p>')).toBe(true)
    expect(isBlankRichText('<p>ก</p>')).toBe(false)
  })
})

describe('parseVideoInput', () => {
  it.each([
    ['https://www.youtube.com/watch?v=gxyBiCWiQ_8', 'youtube', 'gxyBiCWiQ_8'],
    ['https://www.youtube.com/watch?v=gxyBiCWiQ_8&t=30s&list=PL1', 'youtube', 'gxyBiCWiQ_8'],
    ['https://youtu.be/gxyBiCWiQ_8', 'youtube', 'gxyBiCWiQ_8'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=10', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://vimeo.com/123456789', 'vimeo', '123456789'],
    ['https://player.vimeo.com/video/123456789', 'vimeo', '123456789'],
    ['dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
  ])('%s', (input, provider, video_id) => {
    expect(parseVideoInput(input)).toEqual({ provider, video_id })
  })

  it.each([
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://evil.example.test/watch?v=dQw4w9WgXcQ',
    '<script>',
    '',
  ])('rejects %s', (input) => expect(parseVideoInput(input)).toBeNull())
})

describe('buildBlockContent', () => {
  it('accepts the course YouTube link and stores only provider + video_id', () => {
    const content = buildBlockContent('video', { url: 'https://www.youtube.com/watch?v=gxyBiCWiQ_8' })
    expect(content).toEqual({ provider: 'youtube', video_id: 'gxyBiCWiQ_8', caption: '' })
  })
  it('sanitises rich text and rejects empty text', () => {
    expect(buildBlockContent('rich_text', { html: '<p>ก<script>x</script></p>' })).toEqual({
      html: '<p>ก</p>',
    })
    expect(() => buildBlockContent('rich_text', { html: '<p> </p>' })).toThrow('กรุณาพิมพ์เนื้อหา')
  })
  it('validates links, images and video', () => {
    expect(() => buildBlockContent('link', { url: 'http://x.example.test' })).toThrow('https://')
    expect(buildBlockContent('link', { url: 'https://x.example.test', label: ' เกณฑ์ ' })).toEqual({
      url: 'https://x.example.test',
      label: 'เกณฑ์',
    })
    expect(() => buildBlockContent('image', { object_path: 'l/x.png' })).toThrow('คำอธิบายรูปภาพ')
    expect(buildBlockContent('video', { url: 'https://youtu.be/dQw4w9WgXcQ', caption: 'c' })).toEqual({
      provider: 'youtube',
      video_id: 'dQw4w9WgXcQ',
      caption: 'c',
    })
    expect(buildBlockContent('video', { object_path: 'l/v.mp4' })).toMatchObject({ provider: 'storage' })
    expect(() => buildBlockContent('quiz_reference', {})).toThrow()
  })
  it('summarises blocks and collects media paths', () => {
    expect(
      blockSummary({ block_type: 'rich_text', content_json: { html: '<p>สวัสดี <b>ครู</b></p>' } })
    ).toBe('สวัสดี ครู')
    expect(
      mediaPathsOf([
        { content_json: { object_path: 'a/1.png' } },
        { content_json: { html: '' } },
        { content_json: { object_path: 'a/1.png' } },
      ])
    ).toEqual(['a/1.png'])
  })
})

describe('media rules', () => {
  it('builds lesson-scoped paths that ignore the user file name', () => {
    expect(mediaPathFor('L1', 'png', 'u-u-i-d')).toBe('L1/u-u-i-d.png')
  })
  it('validates type and size before uploading', () => {
    expect(validateMediaFile('image', { type: 'image/png', size: 10 })).toBe('png')
    expect(() => validateMediaFile('image', { type: 'text/html', size: 10 })).toThrow('ชนิดไฟล์')
    expect(() => validateMediaFile('image', { type: 'image/png', size: 11 * 1024 * 1024 })).toThrow(
      'ขนาดใหญ่'
    )
  })
})

describe('renderBlock', () => {
  it('embeds the course YouTube video through youtube-nocookie', () => {
    const el = document.createElement('div')
    render(
      el,
      html`${renderBlock({ block_type: 'video', content_json: { provider: 'youtube', video_id: 'gxyBiCWiQ_8' } })}`
    )
    expect(el.querySelector('iframe').getAttribute('src')).toBe(
      'https://www.youtube-nocookie.com/embed/gxyBiCWiQ_8'
    )
  })
  const draw = (block, media) => {
    const el = document.createElement('div')
    render(el, html`${renderBlock(block, media)}`)
    return el
  }
  it('re-sanitises stored rich text at render time', () => {
    const el = draw({
      block_type: 'rich_text',
      content_json: { html: '<p>ก</p><img src=x onerror=alert(1)>' },
    })
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('ก')
  })
  it('embeds YouTube via the no-cookie domain and escapes captions', () => {
    const el = draw({
      block_type: 'video',
      content_json: { provider: 'youtube', video_id: 'dQw4w9WgXcQ', caption: '<b>x</b>' },
    })
    expect(el.querySelector('iframe').getAttribute('src')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
    )
    expect(el.querySelector('b')).toBeNull()
  })
  it('uses signed URLs for media and degrades gracefully without one', () => {
    const block = { block_type: 'image', content_json: { object_path: 'L/1.png', alt: 'แผนภาพ' } }
    expect(draw(block, { 'L/1.png': 'https://signed.example.test/1' }).querySelector('img').alt).toBe(
      'แผนภาพ'
    )
    expect(draw(block, {}).textContent).toContain('ไม่สามารถแสดง')
  })
  it('neutralises non-http links', () => {
    const el = draw({ block_type: 'link', content_json: { url: 'javascript:alert(1)' } })
    expect(el.querySelector('a').getAttribute('href')).toBe('#')
  })
})

/** Records PostgREST builder calls and returns queued results. */
function fakeClient(results) {
  const calls = []
  const queue = [...results]
  const builder = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => resolve(queue.shift() ?? { data: null, error: null })
        return (...args) => {
          calls.push([prop, ...args])
          return builder
        }
      },
    }
  )
  return { calls, from: (t) => (calls.push(['from', t]), builder) }
}

describe('lesson service', () => {
  it('markCompleted sends only status (timestamps are server-stamped)', async () => {
    const c = fakeClient([{ data: [{ id: 'p', status: 'completed' }], error: null }])
    await createLessonService(c).markCompleted('E', 'L')
    const update = c.calls.find(([op]) => op === 'update')[1]
    expect(update).toEqual({ status: 'completed' })
    expect(c.calls.some(([op]) => op === 'insert')).toBe(false)
  })
  it('markCompleted inserts when no progress row exists yet', async () => {
    const c = fakeClient([
      { data: [], error: null },
      { data: { id: 'p', status: 'completed' }, error: null },
    ])
    const row = await createLessonService(c).markCompleted('E', 'L')
    expect(row.status).toBe('completed')
    expect(c.calls.find(([op]) => op === 'insert')[1]).toEqual({
      enrollment_id: 'E',
      lesson_id: 'L',
      status: 'completed',
    })
  })
  it('markStarted never overwrites existing progress', async () => {
    const c = fakeClient([{ data: null, error: null }])
    await createLessonService(c).markStarted('E', 'L')
    const [, , opts] = c.calls.find(([op]) => op === 'upsert')
    expect(opts).toEqual({ onConflict: 'enrollment_id,lesson_id', ignoreDuplicates: true })
  })
  it('neighbours follows unit then lesson order', () => {
    const course = { course_units: [{ lessons: [{ id: 'a' }, { id: 'b' }] }, { lessons: [{ id: 'c' }] }] }
    expect(neighbours(course, 'b')).toMatchObject({ prev: { id: 'a' }, next: { id: 'c' } })
    expect(neighbours(course, 'a').prev).toBeNull()
  })
})

describe('lesson page', () => {
  const course = {
    id: 'K',
    title: 'AfL',
    status: 'published',
    course_units: [
      {
        id: 'U',
        title: 'หน่วย 1',
        status: 'published',
        lessons: [
          { id: 'L1', title: 'บท 1', status: 'published' },
          { id: 'L2', title: 'บท 2', status: 'published' },
        ],
      },
    ],
  }
  const lesson = {
    id: 'L1',
    title: 'บท 1',
    status: 'published',
    learning_objectives: 'อธิบายได้',
    course_units: { id: 'U', course_id: 'K', title: 'หน่วย 1', status: 'published' },
    lesson_blocks: [{ id: 'B', block_type: 'rich_text', content_json: { html: '<p>เนื้อหา</p>' } }],
  }
  const servicesFor = ({ enrollment = null, access = 'view' } = {}) => ({
    courses: { getCourseOutline: async () => course, getAccess: async () => access },
    lessons: {
      getLesson: async () => lesson,
      getMyEnrollment: async () => enrollment,
      markStarted: vi.fn(async () => {}),
      markCompleted: vi.fn(async () => ({
        lesson_id: 'L1',
        status: 'completed',
        completed_at: '2026-11-03T03:00:00Z',
      })),
    },
    media: { signedUrls: async () => ({}) },
  })
  const session = { user: { id: 'me' } }

  it('enrolled learner: records the visit, completes the lesson, shows progress', async () => {
    const el = document.createElement('div')
    const services = servicesFor({ enrollment: { id: 'E', status: 'active', lesson_progress: [] } })
    await renderLessonView(el, { services, session }, { courseId: 'K', lessonId: 'L1' })
    expect(services.lessons.markStarted).toHaveBeenCalledWith('E', 'L1')
    expect(el.textContent).toContain('เนื้อหา')
    expect(el.querySelector('a[href="#/learn/K/L2"]')).not.toBeNull()
    el.querySelector('[data-action=complete-lesson]').click()
    await flush()
    expect(services.lessons.markCompleted).toHaveBeenCalledWith('E', 'L1')
    expect(el.textContent).toContain('เรียนจบแล้ว')
    expect(el.querySelector('[role=progressbar]').getAttribute('aria-valuenow')).toBe('50')
    expect(el.querySelector('[data-action=complete-lesson]')).toBeNull()
  })

  it('course manager without enrollment sees a learner-view preview and records nothing', async () => {
    const el = document.createElement('div')
    const services = servicesFor({ access: 'manage' })
    await renderLessonView(el, { services, session }, { courseId: 'K', lessonId: 'L1' })
    expect(el.textContent).toContain('โหมดตัวอย่าง')
    expect(el.querySelector('[data-action=complete-lesson]')).toBeNull()
    expect(services.lessons.markStarted).not.toHaveBeenCalled()
  })

  it('a lesson from another course is treated as not found', async () => {
    const el = document.createElement('div')
    await renderLessonView(el, { services: servicesFor(), session }, { courseId: 'OTHER', lessonId: 'L1' })
    expect(el.textContent).toContain('ไม่พบบทเรียน')
  })
})

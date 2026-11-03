import { html } from './html.js'
import { sanitizeRichText } from './sanitize.js'

/**
 * Rich-text editor (Tiptap 3, MIT) — loaded on demand so learners never
 * download it. Output always passes through sanitizeRichText(), and the
 * StarterKit is narrowed to the tags the sanitiser allows.
 */
const TOOLS = [
  { cmd: 'bold', label: 'B', title: 'ตัวหนา', cls: 'font-bold' },
  { cmd: 'italic', label: 'I', title: 'ตัวเอียง', cls: 'italic' },
  { cmd: 'underline', label: 'U', title: 'ขีดเส้นใต้', cls: 'underline' },
  { cmd: 'h2', label: 'H2', title: 'หัวข้อ' },
  { cmd: 'h3', label: 'H3', title: 'หัวข้อย่อย' },
  { cmd: 'bulletList', label: '•', title: 'รายการแบบจุด' },
  { cmd: 'orderedList', label: '1.', title: 'รายการแบบตัวเลข' },
  { cmd: 'blockquote', label: '❝', title: 'ข้อความอ้างอิง' },
  { cmd: 'link', label: '🔗', title: 'ใส่/ลบลิงก์ (https)' },
  { cmd: 'undo', label: '↶', title: 'เลิกทำ' },
  { cmd: 'redo', label: '↷', title: 'ทำซ้ำ' },
]

/** Static editor markup; the editor mounts into [data-editor-surface]. */
export function richTextEditorMarkup() {
  return html`<div class="rich-editor" data-editor-host>
    <div
      class="flex flex-wrap gap-1 rounded-t-lg border border-ink-200 bg-ink-50 p-1"
      role="toolbar"
      aria-label="จัดรูปแบบข้อความ"
    >
      ${TOOLS.map(
        (t) =>
          html`<button
            type="button"
            data-cmd="${t.cmd}"
            title="${t.title}"
            aria-label="${t.title}"
            class="min-w-8 rounded px-2 py-1 text-sm text-ink-700 hover:bg-white ${t.cls ?? ''}"
          >
            ${t.label}
          </button>`
      )}
    </div>
    <div data-editor-surface></div>
  </div>`
}

const RUN = {
  bold: (c) => c.toggleBold(),
  italic: (c) => c.toggleItalic(),
  underline: (c) => c.toggleUnderline(),
  h2: (c) => c.toggleHeading({ level: 2 }),
  h3: (c) => c.toggleHeading({ level: 3 }),
  bulletList: (c) => c.toggleBulletList(),
  orderedList: (c) => c.toggleOrderedList(),
  blockquote: (c) => c.toggleBlockquote(),
  undo: (c) => c.undo(),
  redo: (c) => c.redo(),
}

export async function mountRichTextEditor(host, initialHtml = '') {
  const [{ Editor }, { default: StarterKit }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
  ])
  const editor = new Editor({
    element: host.querySelector('[data-editor-surface]'),
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        trailingNode: false, // would store an empty <p></p> after headings/lists
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['https', 'mailto'],
          isAllowedUri: (url) => /^(https:|mailto:)/i.test(url),
        },
      }),
    ],
    content: sanitizeRichText(initialHtml),
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'เนื้อหาบทเรียน' },
    },
  })

  const toolbar = host.querySelector('[role=toolbar]')
  const onToolbar = (e) => {
    const cmd = e.target.closest('[data-cmd]')?.dataset.cmd
    if (!cmd) return
    e.preventDefault()
    e.stopPropagation()
    if (cmd === 'link') {
      if (editor.isActive('link')) return editor.chain().focus().unsetLink().run()
      const href = window.prompt('ลิงก์ (ต้องขึ้นต้นด้วย https://)', 'https://')
      if (href && /^https:\/\/\S+$/i.test(href.trim()))
        editor.chain().focus().setLink({ href: href.trim() }).run()
      return
    }
    RUN[cmd]?.(editor.chain().focus()).run()
  }
  toolbar.addEventListener('click', onToolbar)

  return {
    getHTML: () => sanitizeRichText(editor.getHTML()),
    focus: () => editor.commands.focus('end'),
    destroy: () => {
      toolbar.removeEventListener('click', onToolbar)
      editor.destroy()
    },
  }
}

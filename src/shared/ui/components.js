import { html } from './html.js'
import { ROLE_LABELS, STATUS_LABELS } from '../../core/permissions.js'

const STATUS_TONE = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  published: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  in_progress: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  open: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  pending: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  draft: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  suspended: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  archived: 'bg-slate-100 text-slate-500 ring-slate-500/20',
  closed: 'bg-slate-100 text-slate-500 ring-slate-500/20',
}

export function statusBadge(status) {
  const tone = STATUS_TONE[status] ?? 'bg-slate-100 text-slate-600 ring-slate-500/20'
  return html`<span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}"
    >${STATUS_LABELS[status] ?? status}</span
  >`
}

export function roleChip(role) {
  return html`<span
    class="inline-flex items-center rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
    >${ROLE_LABELS[role] ?? role}</span
  >`
}

export function pageHeader(title, subtitle = '') {
  return html`<header class="mb-6">
    <h1 class="text-2xl font-semibold tracking-tight text-ink-900">${title}</h1>
    ${subtitle ? html`<p class="mt-1 text-sm text-ink-500">${subtitle}</p>` : ''}
  </header>`
}

export function emptyState(message) {
  return html`<div
    class="rounded-xl border border-dashed border-ink-200 bg-white px-6 py-10 text-center text-sm text-ink-500"
  >
    ${message}
  </div>`
}

export function alertBox(message, tone = 'error') {
  const cls =
    tone === 'error'
      ? 'border-rose-200 bg-rose-50 text-rose-800'
      : tone === 'success'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
        : 'border-sky-200 bg-sky-50 text-sky-800'
  return html`<div
    role="${tone === 'error' ? 'alert' : 'status'}"
    class="rounded-lg border px-4 py-3 text-sm ${cls}"
  >
    ${message}
  </div>`
}

export const loading = html`<div
  class="flex items-center gap-3 py-10 text-sm text-ink-500"
  aria-live="polite"
>
  <span class="h-4 w-4 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"></span>
  กำลังโหลด…
</div>`

const NO_FILE = 'ยังไม่ได้เลือกไฟล์'

/**
 * File picker with Thai text. The native control's button and "no file"
 * text follow the browser's language ("Choose File"), so the real input is
 * visually hidden inside a styled label and the chosen name is shown next
 * to it (bindFilePickers). Keyboard focus stays on the real input; the
 * label shows the focus ring.
 *   { name, accept, button = 'เลือกไฟล์…', label = '', required = false }
 * `label` becomes the input's accessible name (what the file is for).
 */
export function filePicker({ name, accept = '', button = 'เลือกไฟล์…', label = '', required = false }) {
  return html`<span class="inline-flex max-w-full flex-wrap items-center gap-2" data-file-picker>
    <label
      class="inline-flex cursor-pointer items-center rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700 shadow-sm hover:bg-ink-50 focus-within:ring-2 focus-within:ring-brand-500/40"
    >
      <input
        type="file"
        name="${name}"
        accept="${accept}"
        class="sr-only"
        ${label ? html`aria-label="${label}"` : ''}
        ${required ? html`required` : ''}
      />
      <span>${button}</span>
    </label>
    <span class="max-w-56 truncate text-xs text-ink-500" data-file-name>${NO_FILE}</span>
  </span>`
}

/** Show the chosen file's name next to every filePicker under `root` (one listener). */
export function bindFilePickers(root = document) {
  if (root.__filePickersBound) return
  root.__filePickersBound = true
  root.addEventListener('change', (e) => {
    const input = e.target
    if (input?.type !== 'file') return
    const out = input.closest('[data-file-picker]')?.querySelector('[data-file-name]')
    if (!out) return
    const names = [...(input.files ?? [])].map((f) => f.name)
    out.textContent = names.length ? names.join(', ') : NO_FILE
    out.title = out.textContent
  })
}

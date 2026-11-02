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

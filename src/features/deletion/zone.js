import { html, render } from '../../shared/ui/html.js'
import { alertBox } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { KINDS, confirmMatches, reasonLines } from './logic.js'

/**
 * A page puts `<section data-delete-zone data-kind="course|instrument|task"
 * data-id="…"></section>` anywhere in its output and calls
 * watchDeleteZones() once. Whenever the page redraws and a new, empty zone
 * appears, it is filled in: the database says whether the item is used.
 *   unused → "ลบ" with a typed confirmation (code or title), then onDeleted
 *   used   → the reasons, and the page's own "เก็บถาวร" if it offers one
 * Zones listen on their own container, so the page's handlers are untouched.
 *
 *   config(zone) → { confirmWord, noun?, below?, archive?, onDeleted }
 *     confirmWord  what must be typed (code or title)
 *     noun / below overrides of the kind's wording (e.g. "Rubric" on the rubric page)
 *     archive      { label, run } optional "เก็บถาวร" for used items
 *     onDeleted    called after a successful delete (e.g. go to the list)
 */
const inputCls =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500/30'
const btn = 'rounded-md px-3 py-1.5 text-sm font-semibold'

export function watchDeleteZones(root, { services, config }) {
  const states = new WeakMap()

  const view = (zone, st, cfg) => {
    const k = {
      ...KINDS[zone.dataset.kind],
      ...(cfg.noun ? { noun: cfg.noun } : {}),
      ...(cfg.below ? { below: cfg.below } : {}),
    }
    const title = html`<h2 class="text-sm font-semibold text-rose-900">ลบ${k.noun}</h2>`
    if (st.loading)
      return html`${title}<p class="mt-1 text-sm text-ink-500">กำลังตรวจว่ามีผู้ใช้อยู่หรือไม่…</p>`
    if (st.failed) return html`${title}${alertBox(st.failed, 'error')}`
    const error = st.error ? html`<div class="mt-2">${alertBox(st.error, 'error')}</div>` : ''
    if (!st.usage.can_delete) {
      const lines = reasonLines(st.usage.reasons)
      return html`${title}
        <p class="mt-1 text-sm text-ink-700">ลบ${k.noun}นี้ไม่ได้ เพราะมีผู้ใช้แล้ว (ผลการเรียนและหลักฐานต้องเก็บไว้):</p>
        <ul class="mt-1 list-disc pl-5 text-sm text-ink-700" data-reasons>${lines.map((l) => html`<li>${l}</li>`)}</ul>
        ${
          cfg.archive
            ? html`<p class="mt-2 text-sm text-ink-600">ซ่อน${k.noun}นี้จากรายการได้ด้วยการเก็บถาวร ผลที่เกิดขึ้นแล้วยังอยู่ครบ</p>
                <button type="button" class="${btn} mt-2 border border-ink-300 text-ink-800 hover:bg-ink-50" data-zone-action="archive" ${st.busy ? html`disabled` : ''}>${cfg.archive.label}</button>`
            : ''
        }
        ${error}`
    }
    if (!st.open)
      return html`${title}
        <p class="mt-1 text-sm text-ink-700">ยังไม่มีผู้ใช้${k.noun}นี้ ลบได้ถาวร</p>
        <button type="button" class="${btn} mt-2 border border-rose-300 text-rose-800 hover:bg-rose-50" data-zone-action="open">ลบ${k.noun}…</button>`
    const ready = confirmMatches(st.typed, cfg.confirmWord)
    return html`${title}
      <form data-zone-form class="mt-1 space-y-3">
        <p class="text-sm text-rose-900">การลบจะนำออก: ${k.below} · <strong>ย้อนคืนไม่ได้</strong> · บันทึกใน Audit Log</p>
        <label class="block text-sm font-medium text-ink-700"
          >พิมพ์ ${k.confirmLabel} “<span data-confirm-word>${cfg.confirmWord}</span>” เพื่อยืนยัน<input
            name="confirm"
            autocomplete="off"
            value="${st.typed}"
            class="${inputCls}"
        /></label>
        ${error}
        <div class="flex gap-2">
          <button type="submit" class="${btn} bg-rose-700 text-white hover:bg-rose-800 disabled:opacity-50" data-zone-confirm ${ready && !st.busy ? '' : html`disabled`}>ลบถาวร</button>
          <button type="button" class="${btn} border border-ink-200 text-ink-700 hover:bg-ink-50" data-zone-action="cancel">ยกเลิก</button>
        </div>
      </form>`
  }

  const paint = (zone) => {
    const st = states.get(zone)
    render(
      zone,
      html`<div class="rounded-xl border border-rose-200 bg-rose-50/40 p-4">${view(zone, st, st.cfg)}</div>`
    )
  }

  const mount = async (zone) => {
    if (states.has(zone)) return
    const { kind, id } = zone.dataset
    if (!KINDS[kind] || !id) return
    const st = {
      loading: true,
      usage: null,
      open: false,
      typed: '',
      busy: false,
      error: '',
      failed: '',
      cfg: config({ kind, id, el: zone }),
    }
    states.set(zone, st)
    paint(zone)
    try {
      st.usage = await services.deletion.usage(kind, id)
    } catch (err) {
      st.failed = toUserMessage(err)
    }
    st.loading = false
    if (zone.isConnected) paint(zone)
  }

  const scan = () => root.querySelectorAll('[data-delete-zone]').forEach((z) => void mount(z))

  const zoneOf = (target) => target.closest?.('[data-delete-zone]')

  root.addEventListener('click', async (e) => {
    const zone = zoneOf(e.target)
    const b = e.target.closest?.('[data-zone-action]')
    if (!zone || !b) return
    const st = states.get(zone)
    if (!st) return
    const action = b.dataset.zoneAction
    if (action === 'open' || action === 'cancel') {
      Object.assign(st, { open: action === 'open', typed: '', error: '' })
      paint(zone)
      if (action === 'open') zone.querySelector('input[name=confirm]')?.focus()
    } else if (action === 'archive' && st.cfg.archive && !st.busy) {
      st.busy = true
      st.error = ''
      paint(zone)
      try {
        await st.cfg.archive.run()
      } catch (err) {
        st.error = toUserMessage(err)
      }
      st.busy = false
      if (zone.isConnected) paint(zone)
    }
  })

  root.addEventListener('input', (e) => {
    const zone = zoneOf(e.target)
    if (!zone || e.target.name !== 'confirm') return
    const st = states.get(zone)
    st.typed = e.target.value
    const confirmBtn = zone.querySelector('[data-zone-confirm]')
    if (confirmBtn) confirmBtn.disabled = !confirmMatches(st.typed, st.cfg.confirmWord) || st.busy // no re-render: keep the caret
  })

  root.addEventListener('submit', async (e) => {
    const zone = zoneOf(e.target)
    if (!zone || !e.target.matches('[data-zone-form]')) return
    e.preventDefault()
    const st = states.get(zone)
    if (st.busy || !confirmMatches(st.typed, st.cfg.confirmWord)) return
    st.busy = true
    st.error = ''
    paint(zone)
    try {
      await services.deletion.remove(zone.dataset.kind, zone.dataset.id, st.typed)
      st.busy = false
      await st.cfg.onDeleted?.()
    } catch (err) {
      st.busy = false
      st.error = toUserMessage(err)
      if (zone.isConnected) paint(zone)
    }
  })

  const observer = new MutationObserver(scan)
  observer.observe(root, { childList: true, subtree: true })
  scan()
  return () => observer.disconnect()
}

import { html, render, safeUrl } from '../../shared/ui/html.js'
import { BLANK_ID, MARKER_ID, LABELS_LIST, nextEntryId, nextOptionId } from './logic.js'
import { entryRow, keyOptions, refreshKeySelects } from './listEditors.js'

/**
 * Editors for dropdown / cloze (text with {{blank}} placeholders) and image
 * labelling (markers placed on the question image). Keys are write-only:
 * leaving every key field empty keeps the stored key.
 *   text: tpl_text · blank rows: blank_id, blank_kind (cloze)
 *   dropdown: bopt_<blank>_id / bopt_<blank>_text, bkey_<blank> (radio)
 *   cloze: bacc_<blank> (accepted answers, one per line) · bval_<blank> / btol_<blank>
 *   labelling: marker_id / marker_x / marker_y, key:<marker>, labels list
 */
const input =
  'block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const secondary = 'rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50'
const dangerBtn =
  'rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50'

// ---------------------------------------------------------------------
// Dropdown / cloze
// ---------------------------------------------------------------------
function dropdownOptionRow(blankId, option) {
  return html`<div class="flex items-center gap-2" data-bopt-row>
    <input type="hidden" name="bopt_${blankId}_id" value="${option.id}" />
    <label class="flex items-center gap-1 text-xs text-ink-600"
      ><input type="radio" name="bkey_${blankId}" value="${option.id}" /> ถูก</label
    >
    <input name="bopt_${blankId}_text" maxlength="1000" value="${option.text ?? ''}" placeholder="ตัวเลือก" aria-label="ตัวเลือกของช่อง ${blankId}" class="${input} min-w-0 flex-1" />
    <button type="button" class="${dangerBtn}" data-action="remove-bopt">ลบ</button>
  </div>`
}

export function blankRow(type, blank, { editing = false } = {}) {
  const id = blank.id
  let body
  if (type === 'dropdown') {
    const options = blank.options ?? [{ id: 'a' }, { id: 'b' }]
    body = html`<div class="space-y-2" data-bopts="${id}">${options.map((o) => dropdownOptionRow(id, o))}</div>
      <button type="button" class="${secondary}" data-action="add-bopt" data-blank="${id}">+ ตัวเลือก</button>`
  } else {
    const number = blank.kind === 'number'
    body = html`<label class="${label}"
        >ชนิดคำตอบ
        <select name="blank_kind" class="${input} mt-1 sm:w-48" data-blank-kind>
          <option value="text" ${number ? '' : html`selected`}>ข้อความ</option>
          <option value="number" ${number ? html`selected` : ''}>ตัวเลข</option>
        </select>
      </label>
      <div data-kind="text" ${number ? html`hidden` : ''}>
        <label class="${label}"
          >คำตอบที่ยอมรับได้ (บรรทัดละ 1 แบบ ไม่เกิน 10 แบบ)
          <textarea name="bacc_${id}" rows="2" class="${input} mt-1" placeholder="${editing ? 'เว้นว่าง = คงเดิม' : 'เช่น AfL'}"></textarea>
        </label>
        <p class="mt-1 text-xs text-ink-500">ไม่สนตัวพิมพ์เล็กใหญ่ ช่องว่าง “ำ/ํา” และเลขไทย — ไม่ตรวจคำสะกดใกล้เคียง</p>
      </div>
      <div class="grid gap-2 sm:grid-cols-2" data-kind="number" ${number ? '' : html`hidden`}>
        <label class="${label}"
          >คำตอบที่ถูก<input name="bval_${id}" inputmode="decimal" placeholder="${editing ? 'คงเดิม' : 'เช่น 75'}" class="${input} mt-1"
        /></label>
        <label class="${label}"
          >ค่าคลาดเคลื่อน (±)<input name="btol_${id}" inputmode="decimal" placeholder="0" class="${input} mt-1"
        /></label>
      </div>`
  }
  return html`<div class="space-y-2 rounded-lg border border-ink-100 p-3" data-blank-row="${id}">
    <input type="hidden" name="blank_id" value="${id}" />
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-semibold text-ink-700">ช่อง <code class="rounded bg-ink-50 px-1">{{${id}}}</code></p>
      <button type="button" class="${dangerBtn}" data-action="remove-blank" data-blank="${id}">ลบช่อง</button>
    </div>
    ${body}
  </div>`
}

export function blankEditorFields(type, options, { editing = false } = {}) {
  const blanks = options?.blanks ?? [{ id: 'b1' }]
  const text = options?.text ?? 'ข้อความ {{b1}}'
  return html`<label class="${label}"
      >ข้อความ (วางเคอร์เซอร์แล้วกด “แทรกช่อง”)
      <textarea name="tpl_text" rows="3" maxlength="5000" class="${input} mt-1" data-template>${text}</textarea>
    </label>
    <button type="button" class="${secondary}" data-action="insert-blank">+ แทรกช่อง</button>
    <div class="space-y-2" data-blanks>${blanks.map((b) => blankRow(type, b, { editing }))}</div>
`
}

/** Blank rows read back: [{ id, kind, options, correct, accept, value, tolerance }] */
export function readBlanks(f, type) {
  const kinds = f.getAll('blank_kind').map(String)
  return f.getAll('blank_id').map((id, i) => {
    id = String(id)
    if (type === 'dropdown') {
      const ids = f.getAll(`bopt_${id}_id`).map(String)
      const texts = f.getAll(`bopt_${id}_text`).map(String)
      return { id, options: ids.map((oid, k) => ({ id: oid, text: texts[k] })), correct: f.get(`bkey_${id}`) }
    }
    return {
      id,
      kind: kinds[i] === 'number' ? 'number' : 'text',
      accept: f.get(`bacc_${id}`),
      value: f.get(`bval_${id}`),
      tolerance: f.get(`btol_${id}`),
    }
  })
}

// ---------------------------------------------------------------------
// Image labelling
// ---------------------------------------------------------------------
function markerRow(marker, k, labels) {
  return html`<div class="flex flex-wrap items-center gap-2 rounded-lg border border-ink-100 p-2" data-marker-row="${marker.id}">
    <input type="hidden" name="marker_id" value="${marker.id}" />
    <span class="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white" data-marker-no>${k + 1}</span>
    <label class="text-xs text-ink-600"
      >X (%)<input name="marker_x" type="number" min="0" max="100" step="0.1" value="${marker.x}" class="${input} mt-0.5 w-20"
    /></label>
    <label class="text-xs text-ink-600"
      >Y (%)<input name="marker_y" type="number" min="0" max="100" step="0.1" value="${marker.y}" class="${input} mt-0.5 w-20"
    /></label>
    <select name="key:${marker.id}" data-key-select class="${input} sm:w-56" aria-label="ป้ายที่ถูกของจุดนี้">
      ${keyOptions(labels, '')}
    </select>
    <button type="button" class="${dangerBtn}" data-action="remove-marker">ลบจุด</button>
  </div>`
}

export function labellingEditorFields(options, imageUrl) {
  const labels = options?.labels ?? [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
  const markers = options?.markers ?? []
  return html`<fieldset class="space-y-2">
      <legend class="${label}">จุดบนรูป (1–15) — แตะ/คลิกบนรูปเพื่อวางจุด ปรับตำแหน่งได้ที่ช่อง X/Y</legend>
      <p class="text-xs text-ink-500" data-no-image ${imageUrl ? html`hidden` : ''}>เลือกรูปในช่อง “รูปสำหรับติดป้าย” ด้านบนก่อน</p>
      <div class="relative inline-block max-w-full cursor-crosshair select-none" data-label-canvas ${imageUrl ? '' : html`hidden`}>
        <img src="${imageUrl ? safeUrl(imageUrl) : ''}" alt="รูปสำหรับวางจุด" class="max-h-96 max-w-full rounded-lg" data-label-image />
        <div data-dots>${markers.map(dot)}</div>
      </div>
      <div class="space-y-2" data-markers>${markers.map((m, k) => markerRow(m, k, labels))}</div>
    </fieldset>
    <fieldset class="space-y-2" data-list-editor="labels">
      <legend class="${label}">${LABELS_LIST.label} <span class="font-normal text-ink-400">(2–20)</span></legend>
      <div data-entries="labels" class="space-y-2">${labels.map((l) => entryRow('image_labelling', LABELS_LIST, l, {}))}</div>
      <button type="button" class="${secondary}" data-action="add-entry" data-list="labels">+ เพิ่มป้าย</button>
    </fieldset>
`
}

const dot = (m, k) =>
  html`<span
    class="pointer-events-none absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white shadow ring-2 ring-white"
    style="left:${Number(m.x)}%;top:${Number(m.y)}%"
    data-dot
    >${k + 1}</span
  >`

/** Numbered dots on the preview, from the marker rows. */
export function redrawDots(form) {
  const dots = form.querySelector('[data-dots]')
  if (!dots) return
  const rows = [...form.querySelectorAll('[data-marker-row]')]
  rows.forEach((row, k) => (row.querySelector('[data-marker-no]').textContent = String(k + 1)))
  render(
    dots,
    html`${rows.map((row, k) =>
      dot({ x: row.querySelector('[name=marker_x]').value, y: row.querySelector('[name=marker_y]').value }, k)
    )}`
  )
}

export function readMarkers(f) {
  const xs = f.getAll('marker_x')
  const ys = f.getAll('marker_y')
  return f.getAll('marker_id').map((id, i) => ({ id: String(id), x: xs[i], y: ys[i] }))
}

/** Click on the picture: add a marker there (percent of the image). Returns an error message or null. */
export function placeMarker(form, event) {
  const img = form.querySelector('[data-label-image]')
  const box = form.querySelector('[data-markers]')
  if (box.children.length >= 15) return 'วางจุดได้ไม่เกิน 15 จุด'
  const rect = img.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100))
  const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
  const used = [...box.querySelectorAll('input[name=marker_id]')].map((i) => i.value)
  const holder = document.createElement('div')
  render(
    holder,
    markerRow(
      { id: nextEntryId(MARKER_ID, used), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 },
      box.children.length,
      []
    )
  )
  box.append(holder.firstElementChild)
  refreshKeySelects(form)
  redrawDots(form)
  return null
}

/** insert-blank / remove-blank / add-bopt / remove-bopt / remove-marker. Returns an error message or null. */
export function handleBlankAction(button) {
  const form = button.closest('form')
  const type = form.dataset.type
  const action = button.dataset.action
  if (action === 'insert-blank') {
    const box = form.querySelector('[data-blanks]')
    const used = [...box.querySelectorAll('input[name=blank_id]')].map((i) => i.value)
    if (used.length >= 20) return 'มีได้ไม่เกิน 20 ช่อง'
    const id = nextEntryId(BLANK_ID, used)
    const area = form.querySelector('[data-template]')
    const at = area.selectionStart ?? area.value.length
    const end = area.selectionEnd ?? at
    area.value = `${area.value.slice(0, at)}{{${id}}}${area.value.slice(end)}`
    const holder = document.createElement('div')
    render(holder, blankRow(type, { id }))
    box.append(holder.firstElementChild)
    area.focus()
    area.setSelectionRange(at + id.length + 4, at + id.length + 4)
    return null
  }
  if (action === 'remove-blank') {
    const id = button.dataset.blank
    form.querySelector(`[data-blank-row="${id}"]`)?.remove()
    const area = form.querySelector('[data-template]')
    area.value = area.value.split(`{{${id}}}`).join('')
    return null
  }
  if (action === 'add-bopt') {
    const id = button.dataset.blank
    const box = form.querySelector(`[data-bopts="${id}"]`)
    const used = [...box.querySelectorAll(`input[name="bopt_${id}_id"]`)].map((i) => i.value)
    if (used.length >= 10) return 'ตัวเลือกต่อช่องไม่เกิน 10 ตัว'
    const holder = document.createElement('div')
    render(holder, dropdownOptionRow(id, { id: nextOptionId(used) }))
    box.append(holder.firstElementChild)
    return null
  }
  if (action === 'remove-bopt') {
    button.closest('[data-bopt-row]')?.remove()
    return null
  }
  if (action === 'remove-marker') {
    button.closest('[data-marker-row]')?.remove()
    redrawDots(form)
    return null
  }
  return null
}

/** Cloze: show the answer fields of the chosen kind. */
export function toggleBlankKind(select) {
  const row = select.closest('[data-blank-row]')
  for (const box of row.querySelectorAll('[data-kind]')) box.hidden = box.dataset.kind !== select.value
}

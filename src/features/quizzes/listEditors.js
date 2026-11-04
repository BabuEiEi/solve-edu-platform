import { html, render, safeUrl } from '../../shared/ui/html.js'
import { acceptAttr } from '../lessons/media.js'
import { SLOT_LISTS } from '../assessments/logic.js'
import { LIST_EDITORS, LABELS_LIST, nextEntryId } from './logic.js'

/**
 * Editors for the item types made of lists (ordering, matching,
 * classification, choice matrix). Field names per list `<name>`:
 *   <name>_id · <name>_text · <name>_image (kept path) · <name>_file · <name>_clear
 * and for slot types `key:<slot id>` (the correct choice, write-only).
 */
const input =
  'block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const secondary = 'rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50'
const iconBtn =
  'rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-600 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40'
const dangerBtn =
  'rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50'

const choiceText = (c) => c.text || (c.image_path || c.hasImage ? `(รูป ${c.id})` : `(ว่าง)`)

function keySelect(slotId, choices, selected) {
  return html`<select name="key:${slotId}" data-key-select class="${input} sm:w-56" aria-label="คำตอบที่ถูกของรายการนี้">
    ${keyOptions(choices, selected)}
  </select>`
}

export const keyOptions = (choices, selected) =>
  html`<option value="">— เฉลย —</option>
    ${choices.map((c) => html`<option value="${c.id}" ${selected === c.id ? html`selected` : ''}>${choiceText(c)}</option>`)}`

export function entryRow(type, def, entry, media, { choices = null, index = 0, count = 1 } = {}) {
  const url = entry.image_path ? media[entry.image_path] : null
  const n = def.name
  return html`<div data-entry-row data-list="${n}" class="space-y-2 rounded-lg border border-ink-100 p-2">
    <input type="hidden" name="${n}_id" value="${entry.id}" />
    <input type="hidden" name="${n}_image" value="${entry.image_path ?? ''}" />
    <div class="flex flex-wrap items-center gap-2">
      ${def.movable ? html`<span class="w-5 text-center text-xs font-semibold text-ink-400" data-pos>${index + 1}</span>` : ''}
      <input
        name="${n}_text"
        maxlength="1000"
        value="${entry.text ?? ''}"
        placeholder="ข้อความ"
        aria-label="${def.label}: ข้อความ"
        class="${input} min-w-0 flex-1"
      />
      ${choices ? keySelect(entry.id, choices, entry.keyChoice) : ''}
      ${
        def.movable
          ? html`<button type="button" class="${iconBtn}" data-action="move-entry" data-delta="-1" aria-label="เลื่อนขึ้น" ${index === 0 ? html`disabled` : ''}>↑</button>
              <button type="button" class="${iconBtn}" data-action="move-entry" data-delta="1" aria-label="เลื่อนลง" ${index === count - 1 ? html`disabled` : ''}>↓</button>`
          : ''
      }
      <button type="button" class="${dangerBtn}" data-action="remove-entry">ลบ</button>
    </div>
    ${
      def.textOnly
        ? ''
        : html`<div class="flex flex-wrap items-center gap-2">
            ${
              url
                ? html`<img src="${safeUrl(url)}" alt="" class="max-h-16 rounded" />
                    <label class="flex items-center gap-1 text-xs text-ink-500"
                      ><input type="checkbox" name="${n}_clear" value="${entry.id}" /> เอารูปออก</label
                    >`
                : ''
            }
            <label class="text-xs text-ink-500"
              >${url ? 'เปลี่ยนรูป' : 'รูปภาพ (ไม่บังคับ)'}
              <input type="file" name="${n}_file" accept="${acceptAttr('image')}" class="text-xs" />
            </label>
          </div>`
    }
  </div>`
}

/** The list fields + key controls of one item form. `lists`: { name: entries }. */
export function listEditorFields(type, lists, media, { editing = false } = {}) {
  const defs = LIST_EDITORS[type]
  const slotNames = SLOT_LISTS[type]
  const choices = slotNames ? (lists[slotNames.choices] ?? []) : null
  return html`${defs.map(
    (def) => html`<fieldset class="space-y-2" data-list-editor="${def.name}">
        <legend class="${label}">${def.label} <span class="font-normal text-ink-400">(${def.min}–${def.max})</span></legend>
        ${
          slotNames && def.name === slotNames.slots
            ? html`<p class="text-xs text-ink-500">เลือกคำตอบที่ถูกของแต่ละรายการในช่อง “เฉลย”</p>`
            : ''
        }
        <div data-entries="${def.name}" class="space-y-2">
          ${(lists[def.name] ?? []).map((e, index, all) =>
            entryRow(type, def, e, media, {
              choices: slotNames && def.name === slotNames.slots ? choices : null,
              index,
              count: all.length,
            })
          )}
        </div>
        <button type="button" class="${secondary}" data-action="add-entry" data-list="${def.name}">+ เพิ่มรายการ</button>
      </fieldset>`
  )}
    ${
      type === 'ordering'
        ? html`<label class="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" name="order_is_key" ${editing ? '' : html`checked`} />
            ใช้ลำดับนี้เป็นเฉลย ${editing ? html`<span class="text-xs text-ink-500">(ไม่ติ๊ก = คงเฉลยเดิม)</span>` : ''}
          </label>`
        : ''
    }
    ${
      type === 'ordering' || type === 'matching'
        ? html`<p class="text-xs text-ink-500">ระบบเก็บรายการแบบสลับลำดับเสมอ เพื่อไม่ให้ลำดับที่เก็บบอกเฉลย</p>`
        : ''
    }`
}

/** Rows of one list read back from the form (in screen order). */
export function readList(formData, name) {
  const ids = formData.getAll(`${name}_id`).map(String)
  const texts = formData.getAll(`${name}_text`).map(String)
  const images = formData.getAll(`${name}_image`).map(String)
  const files = formData.getAll(`${name}_file`)
  const cleared = new Set(formData.getAll(`${name}_clear`).map(String))
  return ids.map((id, i) => ({
    id,
    text: texts[i],
    image_path: cleared.has(id) ? null : images[i] || null,
    file: files[i],
  }))
}

/** Rebuild every key menu from the current choice rows (keeps what was picked). */
export function refreshKeySelects(form) {
  const names = SLOT_LISTS[form.dataset.type]
  if (!names) return
  const choices = [...form.querySelectorAll(`[data-entry-row][data-list="${names.choices}"]`)].map((row) => ({
    id: row.querySelector(`input[name="${names.choices}_id"]`).value,
    text: row.querySelector(`input[name="${names.choices}_text"]`).value.trim(),
    hasImage: Boolean(row.querySelector(`input[name="${names.choices}_image"]`).value),
  }))
  for (const select of form.querySelectorAll('select[data-key-select]')) {
    const picked = select.value
    render(select, keyOptions(choices, choices.some((c) => c.id === picked) ? picked : ''))
  }
}

function renumber(box) {
  const rows = [...box.children]
  rows.forEach((row, i) => {
    const pos = row.querySelector('[data-pos]')
    if (pos) pos.textContent = String(i + 1)
    const up = row.querySelector('[data-action="move-entry"][data-delta="-1"]')
    const down = row.querySelector('[data-action="move-entry"][data-delta="1"]')
    if (up) up.disabled = i === 0
    if (down) down.disabled = i === rows.length - 1
  })
}

/** Add / remove / move a row inside an item form. Returns an error message or null. */
export function handleListAction(button, media) {
  const form = button.closest('form')
  const type = form.dataset.type
  const action = button.dataset.action
  if (action === 'add-entry') {
    const def = (LIST_EDITORS[type] ?? [LABELS_LIST]).find((d) => d.name === button.dataset.list)
    const box = form.querySelector(`[data-entries="${def.name}"]`)
    const used = [...box.querySelectorAll(`input[name="${def.name}_id"]`)].map((i) => i.value)
    if (used.length >= def.max) return `${def.label}: มีได้ไม่เกิน ${def.max} รายการ`
    const names = SLOT_LISTS[type]
    const holder = document.createElement('div')
    const choices = names && def.name === names.slots ? [] : null
    render(holder, entryRow(type, def, { id: nextEntryId(def, used) }, media, { choices }))
    box.append(holder.firstElementChild)
    renumber(box)
    refreshKeySelects(form)
    return null
  }
  const row = button.closest('[data-entry-row]')
  const box = row.parentElement
  if (action === 'remove-entry') {
    row.remove()
  } else if (action === 'move-entry') {
    const sibling = button.dataset.delta === '-1' ? row.previousElementSibling : row.nextElementSibling
    if (sibling) {
      if (button.dataset.delta === '-1') box.insertBefore(row, sibling)
      else box.insertBefore(sibling, row)
      button.focus()
    }
  }
  renumber(box)
  refreshKeySelects(form)
  return null
}

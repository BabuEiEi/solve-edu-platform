import { html, safeUrl } from '../../shared/ui/html.js'
import { SLOT_LISTS, partName, templateParts } from './logic.js'

/**
 * How each question type is shown on the exam page. Everything works by
 * tapping, buttons and selects (no drag-and-drop): phones, keyboards and
 * screen readers alike. Field names: q:<item> for single answers and
 * ordering positions, q:<item>:<slot|blank> for each part.
 */
const field =
  'rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const moveBtn =
  'rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-30'

const entryText = (e) => e.text || (e.image_path ? 'รูปภาพ' : e.id)

export function choiceLabel(option, media) {
  const url = option.image_path ? media[option.image_path] : null
  return html`${
    url
      ? html`<img
          src="${safeUrl(url)}"
          alt="${option.text || 'ตัวเลือกรูปภาพ'}"
          class="max-h-40 rounded-lg border border-ink-100"
          loading="lazy"
        />`
      : option.image_path
        ? html`<span class="text-xs text-ink-400">(ไม่สามารถแสดงรูปภาพได้)</span>`
        : ''
  }${option.text ? html`<span>${option.text}</span>` : ''}`
}

function choiceCard(type, name, value, content, checked) {
  return html`<label
    class="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 px-4 py-3 text-sm hover:border-brand-300 has-checked:border-brand-500 has-checked:bg-brand-50"
  >
    <input type="${type}" name="${name}" value="${value}" class="mt-0.5" ${checked ? html`checked` : ''} />
    <span class="flex flex-col gap-2">${content}</span>
  </label>`
}

/** One slot's answer: a select when every choice is text (compact), otherwise picture cards; `chips` = small inline radios. */
function slotControl(name, choices, selected, media, label, { chips = false } = {}) {
  if (chips)
    return html`<div role="radiogroup" aria-label="${label}" class="flex flex-wrap gap-2">
      ${choices.map(
        (c) => html`<label
          class="flex cursor-pointer items-center gap-2 rounded-full border border-ink-200 px-3 py-1.5 text-sm hover:border-brand-300 has-checked:border-brand-500 has-checked:bg-brand-50"
        >
          <input type="radio" name="${name}" value="${c.id}" ${selected === c.id ? html`checked` : ''} />
          ${c.image_path ? choiceLabel(c, media) : c.text}
        </label>`
      )}
    </div>`
  if (choices.every((c) => !c.image_path))
    return html`<select name="${name}" aria-label="${label}" class="${field} w-full sm:w-auto">
      <option value="">— เลือก —</option>
      ${choices.map((c) => html`<option value="${c.id}" ${selected === c.id ? html`selected` : ''}>${c.text}</option>`)}
    </select>`
  return html`<div role="radiogroup" aria-label="${label}" class="grid gap-2 sm:grid-cols-2">
    ${choices.map((c) => choiceCard('radio', name, c.id, choiceLabel(c, media), selected === c.id))}
  </div>`
}

const HINTS = {
  mcq_multiple: 'เลือกได้มากกว่า 1 ข้อ',
  ordering: 'ใช้ปุ่ม ↑ ↓ จัดลำดับจากบนลงล่าง',
  matching: 'เลือกคู่ให้แต่ละข้อ',
  classification: 'เลือกกลุ่มให้แต่ละรายการ',
  choice_matrix: 'เลือกหนึ่งคำตอบในแต่ละแถว',
  dropdown: 'เลือกคำที่เหมาะสมในแต่ละช่อง',
  cloze: 'พิมพ์คำตอบในแต่ละช่อง',
  image_labelling: 'เลือกป้ายให้แต่ละหมายเลขบนภาพ',
}

function orderingBody(item, saved, media) {
  const options = item.options_json?.options ?? []
  const byId = new Map(options.map((o) => [o.id, o]))
  const order =
    Array.isArray(saved) && saved.length === options.length && saved.every((id) => byId.has(id))
      ? saved.map((id) => byId.get(id))
      : options
  return html`<ol class="space-y-2" data-ordering>
      ${order.map(
        (
          o,
          i
        ) => html`<li class="flex items-center gap-3 rounded-lg border border-ink-200 bg-white px-3 py-2" data-order-id="${o.id}">
          <input type="hidden" name="q:${item.id}" value="${o.id}" />
          <span class="w-6 text-center text-sm font-semibold text-brand-700" data-pos>${i + 1}</span>
          <span class="flex flex-1 flex-col gap-2 text-sm">${choiceLabel(o, media)}</span>
          <button type="button" class="${moveBtn}" data-move="-1" aria-label="เลื่อน “${entryText(o)}” ขึ้น" ${i === 0 ? html`disabled` : ''}>↑</button>
          <button type="button" class="${moveBtn}" data-move="1" aria-label="เลื่อน “${entryText(o)}” ลง" ${i === order.length - 1 ? html`disabled` : ''}>↓</button>
        </li>`
      )}
    </ol>
    <p class="sr-only" aria-live="polite" data-order-status></p>`
}

function slotRows(item, saved, media) {
  const o = item.options_json ?? {}
  const lists = SLOT_LISTS[item.item_type]
  const chips = item.item_type === 'classification' || item.item_type === 'choice_matrix'
  return html`<div class="space-y-3">
    ${(o[lists.slots] ?? []).map((s, k) => {
      const label = item.item_type === 'image_labelling' ? `จุดที่ ${k + 1}` : entryText(s)
      return html`<div class="rounded-lg border border-ink-100 p-3" data-slot="${s.id}">
        <div class="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium text-ink-800">
          ${
            item.item_type === 'image_labelling'
              ? html`<span class="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">${k + 1}</span>`
              : choiceLabel(s, media)
          }
        </div>
        ${slotControl(partName(item.id, s.id), o[lists.choices] ?? [], saved?.[s.id], media, `คำตอบของ ${label}`, { chips })}
      </div>`
    })}
  </div>`
}

function labellingImage(item, index, media) {
  const url = item.media_path ? media[item.media_path] : null
  if (!url) return html`<p class="text-xs text-ink-400">(ไม่สามารถแสดงรูปภาพได้)</p>`
  return html`<div class="relative mb-3 inline-block max-w-full">
    <img src="${safeUrl(url)}" alt="ภาพสำหรับติดป้าย ข้อ ${index + 1}" class="max-h-96 max-w-full rounded-lg" loading="lazy" />
    ${(item.options_json?.markers ?? []).map(
      (m, k) => html`<span
        class="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white shadow ring-2 ring-white"
        style="left:${Number(m.x)}%;top:${Number(m.y)}%"
        aria-hidden="true"
        data-marker="${m.id}"
        >${k + 1}</span
      >`
    )}
  </div>`
}

/** Text with blanks: a select (dropdown) or a typed field (cloze) in each {{blank}}. */
function inlineBlanks(item, saved) {
  const blanks = item.options_json?.blanks ?? []
  const index = new Map(blanks.map((b, k) => [b.id, k]))
  return html`<p class="whitespace-pre-line leading-10 text-ink-900" data-blanks>
    ${templateParts(item.options_json?.text).map((part) => {
      if (typeof part === 'string') return part
      const k = index.get(part.blank)
      if (k === undefined) return ''
      const b = blanks[k]
      const name = partName(item.id, b.id)
      const label = `ช่องที่ ${k + 1}`
      if (item.item_type === 'dropdown')
        return html`<select name="${name}" aria-label="${label}" class="${field} mx-1 py-1">
          <option value="">— ${k + 1} —</option>
          ${(b.options ?? []).map((c) => html`<option value="${c.id}" ${saved?.[b.id] === c.id ? html`selected` : ''}>${c.text}</option>`)}
        </select>`
      return html`<input
        type="text"
        name="${name}"
        aria-label="${label}"
        ${b.kind === 'number' ? html`inputmode="decimal"` : ''}
        maxlength="200"
        value="${saved?.[b.id] ?? ''}"
        placeholder="${k + 1}"
        class="${field} mx-1 w-36 py-1"
      />`
    })}
  </p>`
}

export function renderItem(item, index, draft, media) {
  const name = `q:${item.id}`
  const saved = draft[item.id]
  const type = item.item_type

  let body
  switch (type) {
    case 'mcq_single':
    case 'mcq_multiple': {
      const multi = type === 'mcq_multiple'
      const picked = multi ? (Array.isArray(saved) ? saved : []) : [saved]
      body = html`<div class="grid gap-2">
        ${(item.options_json?.options ?? []).map((o) =>
          choiceCard(multi ? 'checkbox' : 'radio', name, o.id, choiceLabel(o, media), picked.includes(o.id))
        )}
      </div>`
      break
    }
    case 'true_false':
      body = html`<div class="grid gap-2 sm:grid-cols-2">
        ${choiceCard('radio', name, 'true', 'ถูก', saved === 'true')} ${choiceCard('radio', name, 'false', 'ผิด', saved === 'false')}
      </div>`
      break
    case 'numeric':
      body = html`<div class="flex items-center gap-2">
        <input
          type="text"
          inputmode="decimal"
          name="${name}"
          value="${typeof saved === 'string' ? saved : ''}"
          aria-label="คำตอบข้อ ${index + 1}"
          class="${field} w-40"
        />
        ${item.options_json?.unit ? html`<span class="text-sm text-ink-600">${item.options_json.unit}</span>` : ''}
      </div>`
      break
    case 'ordering':
      body = orderingBody(item, saved, media)
      break
    case 'matching':
    case 'classification':
    case 'choice_matrix':
      body = slotRows(item, saved, media)
      break
    case 'image_labelling':
      body = html`${labellingImage(item, index, media)}${slotRows(item, saved, media)}`
      break
    case 'dropdown':
    case 'cloze':
      body = inlineBlanks(item, saved)
      break
    default:
      body = html`<p class="text-sm text-ink-500">ข้อนี้ยังไม่รองรับในเวอร์ชันนี้</p>`
  }

  // image_labelling shows its image with the numbered markers instead
  const image = type !== 'image_labelling' && item.media_path ? media[item.media_path] : null
  return html`<fieldset class="rounded-xl border border-ink-200 bg-white p-5" data-item-id="${item.id}" data-item-type="${type}">
    <legend class="sr-only">ข้อ ${index + 1}</legend>
    <p class="text-sm font-semibold text-brand-700">
      ข้อ ${index + 1}
      <span class="font-normal text-ink-400">(${Number(item.max_score)} คะแนน)</span>
    </p>
    <p class="mt-1 whitespace-pre-line text-ink-900">${item.prompt}</p>
    ${
      image
        ? html`<img src="${safeUrl(image)}" alt="ภาพประกอบข้อ ${index + 1}" class="mt-3 max-h-80 rounded-lg" loading="lazy" />`
        : ''
    }
    ${HINTS[type] ? html`<p class="mt-2 text-xs text-ink-500">${HINTS[type]}</p>` : ''}
    <div class="mt-2">${body}</div>
  </fieldset>`
}

/**
 * ↑ / ↓ on an ordering list: move the row, renumber, keep focus on the
 * button, announce the new position, and let the form know (autosave).
 * Returns true when the click was a move.
 */
export function handleOrderingClick(e) {
  const btn = e.target.closest?.('button[data-move]')
  if (!btn || btn.disabled) return false
  const row = btn.closest('li[data-order-id]')
  const list = row.parentElement
  const delta = Number(btn.dataset.move)
  const sibling = delta < 0 ? row.previousElementSibling : row.nextElementSibling
  if (!sibling) return true
  if (delta < 0) list.insertBefore(row, sibling)
  else list.insertBefore(sibling, row)
  const rows = [...list.children]
  rows.forEach((li, i) => {
    li.querySelector('[data-pos]').textContent = String(i + 1)
    li.querySelector('[data-move="-1"]').disabled = i === 0
    li.querySelector('[data-move="1"]').disabled = i === rows.length - 1
  })
  const target = btn.disabled ? row.querySelector(`[data-move="${-delta}"]`) : btn
  target.focus()
  const status = list.parentElement.querySelector('[data-order-status]')
  if (status) status.textContent = `ย้ายไปตำแหน่งที่ ${rows.indexOf(row) + 1}`
  row.querySelector('input[type=hidden]').dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

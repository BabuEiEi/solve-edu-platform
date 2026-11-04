import { html, render, safeUrl } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { PURPOSE_LABELS } from '../assessments/logic.js'
import { moveId, nextOrder } from '../builder/service.js'
import { acceptAttr } from '../lessons/media.js'
import { itemMediaPaths } from '../assessments/logic.js'
import {
  ITEM_TYPES,
  SCORING_MODES,
  MAX_CHOICES,
  isChoiceType,
  nextOptionId,
  buildItemDraft,
  keyState,
  publishBlockers,
  defaultVersion,
  unusedMedia,
  isListType,
  defaultLists,
  LIST_EDITORS,
} from './logic.js'
import { listEditorFields, readList, handleListAction, refreshKeySelects } from './listEditors.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const inputInline = input.replace('mt-1 ', '')
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary = 'rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50'
const iconBtn =
  'rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-600 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40'
const dangerBtn =
  'rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50'

const accessDenied = () =>
  html`${pageHeader('แบบทดสอบของหลักสูตร')}${emptyState('ท่านไม่มีสิทธิ์จัดการแบบทดสอบของหลักสูตรนี้ หรือไม่พบหลักสูตร')}`

const KEY_BADGE = {
  ok: html`<span class="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">ตั้งเฉลยแล้ว</span>`,
  missing: html`<span class="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">ยังไม่มีเฉลย</span>`,
  invalid: html`<span class="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700"
    >เฉลยไม่ตรงกับตัวเลือก</span
  >`,
}

const versionLabel = (v) => `ฉบับที่ ${v.version_no}`

async function loadManagedCourse(services, courseId) {
  if ((await services.courses.getAccess(courseId)) !== 'manage') return null
  return services.builder.getCourseTree(courseId)
}

// =====================================================================
// #/courses/:id/quizzes — instruments of a course
// =====================================================================
export async function renderCourseQuizzesView(el, { services }, { id }) {
  render(el, loading)
  let course, quizzes
  try {
    course = await loadManagedCourse(services, id)
    if (!course) return render(el, accessDenied())
    quizzes = await services.quizzes.listForCourse(id)
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  let message = null

  const draw = () =>
    render(
      el,
      html`<a href="#/courses/${course.id}/builder" class="text-sm text-brand-700 hover:underline">← ${course.title}</a>
        ${pageHeader('แบบทดสอบของหลักสูตร', 'สร้างข้อสอบ ตั้งเฉลย และเผยแพร่เป็นฉบับ (ฉบับที่เผยแพร่แล้วแก้ไขไม่ได้)')}
        ${
          quizzes.length
            ? html`<ul class="space-y-3">
                ${quizzes.map((q) => {
                  const current = defaultVersion(q.instrument_versions)
                  return html`<li>
                    <a
                      href="#/courses/${course.id}/quizzes/${q.id}"
                      class="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-white px-5 py-4 hover:border-brand-300"
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block font-semibold text-ink-900">${q.title}</span>
                        <span class="text-xs text-ink-500">${q.code}</span>
                      </span>
                      ${current ? html`<span class="text-sm text-ink-500">${versionLabel(current)}</span>${statusBadge(current.status)}` : ''}
                    </a>
                  </li>`
                })}
              </ul>`
            : emptyState('ยังไม่มีแบบทดสอบในหลักสูตรนี้')
        }
        <form data-form="create-quiz" class="mt-6 grid gap-3 rounded-xl border border-dashed border-ink-200 bg-white p-5 sm:grid-cols-[200px_1fr]">
          <p class="text-sm font-semibold text-ink-800 sm:col-span-2">สร้างแบบทดสอบใหม่</p>
          ${message ? html`<div class="sm:col-span-2">${alertBox(message)}</div>` : ''}
          <label class="${label}">รหัส<input name="code" required maxlength="50" placeholder="เช่น AFL-POST" class="${input}" /></label>
          <label class="${label}">ชื่อแบบทดสอบ<input name="title" required maxlength="300" class="${input}" /></label>
          <label class="${label} sm:col-span-2"
            >คำอธิบาย (ไม่บังคับ)<textarea name="description" rows="2" maxlength="5000" class="${input}"></textarea>
          </label>
          <div><button class="${primary}" type="submit">สร้างแบบทดสอบ</button></div>
        </form>`
    )

  el.onsubmit = async (e) => {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.target))
    const button = e.target.querySelector('button[type=submit]')
    button.disabled = true
    try {
      const created = await services.quizzes.createInstrument(course, f)
      navigate(`/courses/${course.id}/quizzes/${created.id}`)
    } catch (err) {
      message = toUserMessage(err)
      draw()
    }
  }

  draw()
}

// =====================================================================
// #/courses/:id/quizzes/:quizId — versions, items, keys, publish
// =====================================================================
function choicePreview(o, media) {
  const url = o.image_path ? media[o.image_path] : null
  return html`${url ? html`<img src="${safeUrl(url)}" alt="${o.text || 'ตัวเลือกรูปภาพ'}" class="max-h-24 rounded border border-ink-100" />` : ''}${
    o.text ? html`<span>${o.text}</span>` : ''
  }`
}

function optionRow(type, option, media) {
  const url = option.image_path ? media[option.image_path] : null
  return html`<div data-option-row class="grid items-center gap-2 rounded-lg border border-ink-100 p-2 sm:grid-cols-[auto_1fr_auto]">
    <input type="hidden" name="opt_id" value="${option.id}" />
    <input type="hidden" name="opt_image" value="${option.image_path ?? ''}" />
    <label class="flex items-center gap-1.5 text-xs font-medium text-ink-600">
      <input type="${type === 'mcq_single' ? 'radio' : 'checkbox'}" name="correct" value="${option.id}" />
      ถูก
    </label>
    <label class="sr-only" for="opt-${option.id}">ข้อความตัวเลือก ${option.id}</label>
    <input id="opt-${option.id}" name="opt_text" maxlength="1000" value="${option.text ?? ''}" placeholder="ข้อความตัวเลือก" class="${inputInline}" />
    <button type="button" class="${dangerBtn}" data-action="remove-option">ลบ</button>
    <div class="flex flex-wrap items-center gap-2 sm:col-span-3">
      ${
        url
          ? html`<img src="${safeUrl(url)}" alt="" class="max-h-16 rounded" />
              <label class="flex items-center gap-1 text-xs text-ink-500"
                ><input type="checkbox" name="opt_clear" value="${option.id}" /> เอารูปออก</label
              >`
          : ''
      }
      <label class="text-xs text-ink-500"
        >${url ? 'เปลี่ยนรูป' : 'รูปภาพ (ไม่บังคับ)'}
        <input type="file" name="opt_file" accept="${acceptAttr('image')}" class="text-xs" />
      </label>
    </div>
  </div>`
}

function itemForm(type, item, media) {
  const editing = Boolean(item)
  const options = item?.options_json?.options ?? [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const questionImage = item?.media_path ? media[item.media_path] : null
  const keyHint = editing
    ? html`<p class="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        ระบบไม่แสดงเฉลยเดิมกลับมา หากไม่เลือก/กรอกคำตอบที่ถูกใหม่ เฉลยเดิมจะคงไว้
        ${type === 'mcq_multiple' ? ' (การเปลี่ยนวิธีให้คะแนนต้องเลือกคำตอบที่ถูกใหม่ทั้งหมด)' : ''}
      </p>`
    : ''

  let typeFields
  if (isListType(type)) {
    typeFields = listEditorFields(type, item ? item.options_json : defaultLists(type), media, { editing })
  } else if (isChoiceType(type)) {
    typeFields = html`<fieldset class="space-y-2">
        <legend class="${label}">ตัวเลือก (ทำเครื่องหมาย “ถูก” ที่คำตอบที่ถูก)</legend>
        <div data-options class="space-y-2">${options.map((o) => optionRow(type, o, media))}</div>
        <button type="button" class="${secondary}" data-action="add-option">+ เพิ่มตัวเลือก</button>
      </fieldset>
      ${
        type === 'mcq_multiple'
          ? html`<label class="${label}"
              >วิธีให้คะแนน
              <select name="mode" class="${input}">
                ${Object.entries(SCORING_MODES).map(([v, l]) => html`<option value="${v}">${l}</option>`)}
              </select>
            </label>`
          : ''
      }`
  } else if (type === 'true_false') {
    typeFields = html`<fieldset>
      <legend class="${label}">คำตอบที่ถูก</legend>
      <div class="mt-2 flex gap-4 text-sm">
        <label class="flex items-center gap-2"><input type="radio" name="correct_tf" value="true" /> ถูก</label>
        <label class="flex items-center gap-2"><input type="radio" name="correct_tf" value="false" /> ผิด</label>
      </div>
    </fieldset>`
  } else {
    typeFields = html`<div class="grid gap-3 sm:grid-cols-3">
      <label class="${label}"
        >คำตอบที่ถูก<input name="key_value" inputmode="decimal" placeholder="${editing ? 'คงเดิม' : 'เช่น 75'}" class="${input}"
      /></label>
      <label class="${label}"
        >ค่าคลาดเคลื่อนที่ยอมรับ (±)<input name="key_tolerance" inputmode="decimal" placeholder="0" class="${input}"
      /></label>
      <label class="${label}"
        >หน่วย (ไม่บังคับ)<input name="unit" maxlength="32" value="${item?.options_json?.unit ?? ''}" class="${input}"
      /></label>
    </div>`
  }

  return html`<form data-form="item" data-type="${type}" class="space-y-4 rounded-xl border-2 border-brand-200 bg-white p-5">
    <p class="text-sm font-semibold text-brand-700">${editing ? 'แก้ไขข้อ' : 'เพิ่มข้อ'} — ${ITEM_TYPES[type].label}</p>
    <label class="${label}"
      >โจทย์<textarea name="prompt" required rows="3" maxlength="5000" class="${input}">${item?.prompt ?? ''}</textarea>
    </label>
    <div class="grid gap-3 sm:grid-cols-[160px_1fr]">
      <label class="${label}"
        >คะแนน<input name="max_score" type="number" min="0.01" max="1000" step="0.01" value="${Number(item?.max_score ?? 1)}" class="${input}"
      /></label>
      <div class="text-sm">
        <span class="${label}">รูปประกอบโจทย์ (ไม่บังคับ)</span>
        ${
          questionImage
            ? html`<img src="${safeUrl(questionImage)}" alt="" class="mt-1 max-h-32 rounded" />
                <label class="mt-1 flex items-center gap-1 text-xs text-ink-500"
                  ><input type="checkbox" name="remove_media" /> เอารูปออก</label
                >`
            : ''
        }
        <input type="file" name="media_file" accept="${acceptAttr('image')}" class="mt-1 text-xs" />
      </div>
    </div>
    ${typeFields} ${keyHint}
    <div data-form-error></div>
    <div class="flex gap-2">
      <button class="${primary}" type="submit">บันทึกข้อ</button>
      <button class="${secondary}" type="button" data-action="cancel-item">ยกเลิก</button>
    </div>
  </form>`
}

export async function renderQuizEditorView(el, { services }, { id: courseId, quizId }) {
  render(el, loading)
  let course, instrument, version, items, statuses, media
  let assignments = []
  let selectedVersionId = null
  let editing = null // { type, itemId|null }
  let message = null
  let tone = 'success'
  let busy = false

  const load = async () => {
    instrument = await services.quizzes.getInstrument(quizId)
    if (!instrument || instrument.course_id !== courseId) return
    const versions = instrument.instrument_versions
    version = versions.find((v) => v.id === selectedVersionId) ?? defaultVersion(versions)
    items = version ? await services.quizzes.getItems(version.id) : []
    statuses = version ? await services.quizzes.keyStatus(version.id) : {}
    media = await services.assessmentMedia.signedUrls(itemMediaPaths(items))
    assignments = services.assignments
      ? await services.assignments.listForVersions(
          versions.filter((v) => v.status !== 'draft').map((v) => v.id)
        )
      : []
  }

  try {
    course = await loadManagedCourse(services, courseId)
    if (!course) return render(el, accessDenied())
    await load()
    if (!instrument || instrument.course_id !== courseId) return render(el, accessDenied())
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }

  const isDraft = () => version?.status === 'draft'
  const draftVersion = () => instrument.instrument_versions.find((v) => v.status === 'draft')

  const itemCard = (item, index) => {
    if (editing?.itemId === item.id) return html`<li>${itemForm(item.item_type, item, media)}</li>`
    const image = item.media_path ? media[item.media_path] : null
    const options = item.options_json?.options ?? []
    return html`<li class="rounded-xl border border-ink-200 bg-white" data-item-id="${item.id}">
      <div class="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-2 text-sm">
        <span class="font-semibold text-brand-700">ข้อ ${index + 1}</span>
        <span class="text-ink-500">${ITEM_TYPES[item.item_type]?.label ?? item.item_type} · ${Number(item.max_score)} คะแนน</span>
        <span class="flex-1"></span>
        ${KEY_BADGE[keyState(statuses[item.id])]}
        ${
          isDraft()
            ? html`<span class="flex gap-1">
                <button type="button" class="${iconBtn}" data-action="move-item" data-id="${item.id}" data-delta="-1" ${index === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น">↑</button>
                <button type="button" class="${iconBtn}" data-action="move-item" data-id="${item.id}" data-delta="1" ${index === items.length - 1 ? 'disabled' : ''} aria-label="เลื่อนลง">↓</button>
                <button type="button" class="${iconBtn}" data-action="edit-item" data-id="${item.id}">แก้ไข</button>
                <button type="button" class="${dangerBtn}" data-action="delete-item" data-id="${item.id}">ลบ</button>
              </span>`
            : ''
        }
      </div>
      <div class="space-y-2 p-4 text-sm">
        <p class="whitespace-pre-line text-ink-900">${item.prompt}</p>
        ${image ? html`<img src="${safeUrl(image)}" alt="" class="max-h-48 rounded" />` : ''}
        ${
          isListType(item.item_type)
            ? html`<div class="grid gap-3 sm:grid-cols-2" data-list-preview>
                ${LIST_EDITORS[item.item_type].map(
                  (def) => html`<div>
                    <p class="text-xs font-medium text-ink-500">${def.label}</p>
                    <ul class="mt-1 grid gap-1 text-ink-600">
                      ${(item.options_json?.[def.name] ?? []).map((o) => html`<li class="flex items-center gap-2">• ${choicePreview(o, media)}</li>`)}
                    </ul>
                  </div>`
                )}
              </div>`
            : options.length
              ? html`<ul class="grid gap-1 text-ink-600">
                ${options.map((o) => html`<li class="flex items-center gap-2">○ ${choicePreview(o, media)}</li>`)}
              </ul>`
              : item.item_type === 'true_false'
                ? html`<p class="text-ink-500">ถูก / ผิด</p>`
                : item.options_json?.unit
                  ? html`<p class="text-ink-500">ตอบเป็นตัวเลข (${item.options_json.unit})</p>`
                  : html`<p class="text-ink-500">ตอบเป็นตัวเลข</p>`
        }
      </div>
    </li>`
  }

  const versionBar = () =>
    html`<nav class="flex flex-wrap gap-2" aria-label="ฉบับของแบบทดสอบ">
      ${[...instrument.instrument_versions].reverse().map(
        (v) =>
          html`<button
            type="button"
            data-action="select-version"
            data-id="${v.id}"
            class="${v.id === version?.id ? 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white' : secondary}"
            ${v.id === version?.id ? html`aria-current="true"` : ''}
          >
            ${versionLabel(v)} · ${v.status === 'draft' ? 'ร่าง' : v.status === 'published' ? 'เผยแพร่' : 'เก็บถาวร'}
          </button>`
      )}
    </nav>`

  const statusPanel = () => {
    if (!version) return emptyState('ยังไม่มีฉบับของแบบทดสอบนี้')
    if (isDraft()) {
      const blockers = publishBlockers(items, statuses)
      const ready = items.length > 0 && blockers.length === 0
      return html`<section class="rounded-xl border border-ink-200 bg-white p-4 text-sm">
        <p class="text-ink-700">
          ${versionLabel(version)} เป็น<strong>ฉบับร่าง</strong> — แก้ไขได้ ผู้เรียนยังไม่เห็น
          เมื่อเผยแพร่แล้วจะแก้ไขฉบับนี้ไม่ได้อีก
        </p>
        ${
          items.length === 0
            ? html`<p class="mt-2 text-amber-800">ยังไม่มีข้อสอบ</p>`
            : blockers.length
              ? html`<p class="mt-2 text-amber-800">ยังเผยแพร่ไม่ได้: ข้อ ${blockers.join(', ')} ยังไม่มีเฉลยที่ถูกต้อง</p>`
              : html`<p class="mt-2 text-emerald-700">พร้อมเผยแพร่ (${items.length} ข้อ)</p>`
        }
        <button type="button" class="${primary} mt-3" data-action="publish" ${ready ? '' : 'disabled'}>เผยแพร่ฉบับนี้</button>
      </section>`
    }
    const draft = draftVersion()
    return html`<section class="rounded-xl border border-ink-200 bg-white p-4 text-sm">
      <p class="text-ink-700">
        ${versionLabel(version)} ${statusBadge(version.status)} เมื่อ ${formatThaiDateTime(version.published_at)} — แก้ไขไม่ได้
        เพื่อให้คะแนนที่บันทึกไว้แล้วยังมีความหมายเดิม
      </p>
      ${
        draft
          ? html`<button type="button" class="${secondary} mt-3" data-action="select-version" data-id="${draft.id}">
              ไปที่ฉบับร่าง (${versionLabel(draft)})
            </button>`
          : html`<button type="button" class="${primary} mt-3" data-action="clone">สร้างฉบับใหม่จากฉบับนี้เพื่อแก้ไข</button>`
      }
    </section>`
  }

  const assignmentPanel = () => {
    const canAssign = version?.status === 'published' && services.assignments
    if (!canAssign && assignments.length === 0) return ''
    return html`<section class="rounded-xl border border-ink-200 bg-white p-4 text-sm" data-assignments>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold text-ink-800">การมอบหมายให้รุ่น</h2>
        ${
          canAssign
            ? html`<a href="#/staff/assessments/new/${version.id}" class="${primary}" data-action-link="assign"
                >มอบหมาย${versionLabel(version)}ให้รุ่น</a
              >`
            : ''
        }
      </div>
      ${
        assignments.length
          ? html`<ul class="mt-3 divide-y divide-ink-100">
              ${assignments.map(
                (a) => html`<li class="flex flex-wrap items-center gap-2 py-2">
                  <a href="#/staff/assessments/${a.id}" class="font-medium text-brand-700 hover:underline">${a.title}</a>
                  <span class="text-ink-500"
                    >${PURPOSE_LABELS[a.purpose] ?? a.purpose} · ${a.cohorts?.name ?? ''} ·
                    ${a.instrument_versions ? versionLabel(a.instrument_versions) : ''}</span
                  >
                  ${statusBadge(a.status)}
                </li>`
              )}
            </ul>`
          : html`<p class="mt-2 text-ink-500">ยังไม่ได้มอบหมายให้รุ่นใด</p>`
      }
    </section>`
  }

  const draw = () =>
    render(
      el,
      html`<a href="#/courses/${courseId}/quizzes" class="text-sm text-brand-700 hover:underline">← แบบทดสอบของหลักสูตร</a>
        <div class="mt-3">${pageHeader(instrument.title, `${instrument.code} · ${course.title}`)}</div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <div class="space-y-4">
          ${versionBar()} ${statusPanel()} ${assignmentPanel()}
          <section class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-200 bg-white p-4 text-sm" data-media-cleanup>
            <span class="text-ink-600">รูปที่อัปโหลดแล้วไม่มีข้อใดใช้ (ทุกฉบับ) และเก่ากว่า 24 ชั่วโมง ลบได้ — รูปที่ยังใช้อยู่ระบบไม่ยอมให้ลบ</span>
            <button type="button" class="${secondary}" data-action="clean-media">ล้างรูปที่ไม่ได้ใช้</button>
          </section>
          <ol class="space-y-3">${items.map(itemCard)}</ol>
          ${
            isDraft()
              ? editing && !editing.itemId
                ? itemForm(editing.type, null, media)
                : html`<div class="flex flex-wrap gap-2 rounded-xl border border-dashed border-ink-200 bg-white p-3">
                    <span class="self-center text-sm text-ink-500">เพิ่มข้อ:</span>
                    ${Object.entries(ITEM_TYPES).map(
                      ([t, meta]) =>
                        html`<button type="button" class="${secondary}" data-action="new-item" data-type="${t}">
                          ${meta.icon} ${meta.label}
                        </button>`
                    )}
                  </div>`
              : ''
          }
        </div>`
    )

  const run = async (fn, okMessage) => {
    if (busy) return
    busy = true
    try {
      const result = await fn()
      editing = null
      await load()
      message = typeof okMessage === 'function' ? okMessage(result) : okMessage
      tone = 'success'
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
    } finally {
      busy = false
      draw()
    }
  }

  const upload = async (file) =>
    file && typeof file === 'object' && file.size > 0
      ? services.assessmentMedia.upload(instrument.id, 'image', file)
      : null

  const saveItem = async (form) => {
    const f = new FormData(form)
    const type = form.dataset.type
    const existing = editing.itemId ? items.find((i) => i.id === editing.itemId) : null
    const ids = f.getAll('opt_id').map(String)
    const texts = f.getAll('opt_text').map(String)
    const images = f.getAll('opt_image').map(String)
    const files = f.getAll('opt_file')
    const cleared = new Set(f.getAll('opt_clear').map(String))

    const options = []
    for (let i = 0; i < ids.length; i++) {
      const uploaded = await upload(files[i])
      options.push({
        id: ids[i],
        text: texts[i],
        image_path: uploaded ?? (cleared.has(ids[i]) ? null : images[i] || null),
      })
    }
    const mediaPath =
      (await upload(f.get('media_file'))) ?? (f.get('remove_media') ? null : (existing?.media_path ?? null))

    const lists = {}
    const keySlots = {}
    if (isListType(type)) {
      for (const def of LIST_EDITORS[type]) {
        lists[def.name] = []
        for (const row of readList(f, def.name)) {
          const uploaded = await upload(row.file)
          lists[def.name].push({ id: row.id, text: row.text, image_path: uploaded ?? row.image_path })
        }
      }
      for (const [k, v] of f.entries()) if (k.startsWith('key:') && v) keySlots[k.slice(4)] = String(v)
    }

    const { item, key } = buildItemDraft(
      type,
      {
        prompt: f.get('prompt'),
        max_score: f.get('max_score'),
        media_path: mediaPath,
        options,
        correct: f.getAll('correct').map(String),
        mode: f.get('mode'),
        tf: f.get('correct_tf'),
        value: f.get('key_value'),
        tolerance: f.get('key_tolerance'),
        unit: f.get('unit'),
        lists,
        keySlots,
        orderIsKey: f.get('order_is_key') === 'on',
      },
      { requireKey: !existing }
    )
    const saved = existing
      ? await services.quizzes.updateItem(existing.id, item)
      : await services.quizzes.addItem(version.id, item, nextOrder(items))
    if (key) await services.quizzes.setKey(saved.id, key)
  }

  const cleanMedia = async () => {
    let candidates
    try {
      const [files, used] = await Promise.all([
        services.assessmentMedia.list(instrument.id),
        services.quizzes.usedMediaPaths(instrument.id),
      ])
      candidates = unusedMedia(files, used)
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
      return draw()
    }
    if (candidates.length === 0) {
      message = 'ไม่มีรูปที่ไม่ได้ใช้ให้ลบ (รูปที่อัปโหลดภายใน 24 ชั่วโมงจะยังไม่ถูกลบ)'
      tone = 'success'
      return draw()
    }
    if (!window.confirm(`ลบรูปที่ไม่มีข้อใดใช้ ${candidates.length} ไฟล์? ลบแล้วกู้คืนไม่ได้`))
      return undefined
    return run(
      () => services.assessmentMedia.remove(candidates),
      (removed) =>
        removed.length === candidates.length
          ? `ลบรูปที่ไม่ได้ใช้แล้ว ${removed.length} ไฟล์`
          : `ลบแล้ว ${removed.length} จาก ${candidates.length} ไฟล์ — ที่เหลือถูกใช้อยู่ ระบบจึงไม่ลบ`
    )
  }

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return
    const { action, id: targetId, delta, type } = b.dataset
    switch (action) {
      case 'select-version':
        selectedVersionId = targetId
        editing = null
        message = null
        return run(async () => {}, null)
      case 'new-item':
        editing = { type, itemId: null }
        message = null
        return draw()
      case 'edit-item':
        editing = { type: items.find((i) => i.id === targetId).item_type, itemId: targetId }
        message = null
        return draw()
      case 'cancel-item':
        editing = null
        return draw()
      case 'add-option': {
        const form = b.closest('form')
        const box = form.querySelector('[data-options]')
        const used = [...box.querySelectorAll('input[name=opt_id]')].map((i) => i.value)
        if (used.length >= MAX_CHOICES) {
          return render(
            form.querySelector('[data-form-error]'),
            alertBox(`มีตัวเลือกได้ไม่เกิน ${MAX_CHOICES} ตัว`)
          )
        }
        // Append one row without re-rendering the form (keeps typed text and chosen files).
        const holder = document.createElement('div')
        render(holder, optionRow(form.dataset.type, { id: nextOptionId(used) }, media))
        box.append(holder.firstElementChild)
        return undefined
      }
      case 'add-entry':
      case 'remove-entry':
      case 'move-entry': {
        const problem = handleListAction(b, media)
        if (problem) render(b.closest('form').querySelector('[data-form-error]'), alertBox(problem))
        return undefined
      }
      case 'remove-option':
        b.closest('[data-option-row]')?.remove()
        return undefined
      case 'move-item':
        return run(
          () =>
            services.quizzes.reorderItems(
              version.id,
              moveId(
                items.map((i) => i.id),
                targetId,
                Number(delta)
              )
            ),
          'จัดลำดับข้อแล้ว'
        )
      case 'delete-item':
        if (!window.confirm('ลบข้อนี้?')) return undefined
        return run(() => services.quizzes.deleteItem(targetId), 'ลบข้อแล้ว')
      case 'publish':
        if (!window.confirm('เผยแพร่ฉบับนี้? เมื่อเผยแพร่แล้วจะแก้ไขข้อสอบและเฉลยของฉบับนี้ไม่ได้อีก'))
          return undefined
        return run(async () => {
          await services.quizzes.publish(version.id)
          selectedVersionId = version.id
        }, 'เผยแพร่แล้ว — นำไปมอบหมายให้รุ่นได้')
      case 'clone':
        return run(async () => {
          selectedVersionId = await services.quizzes.clone(version.id)
        }, 'สร้างฉบับร่างใหม่แล้ว (คัดลอกข้อและเฉลยจากฉบับเดิม)')
      case 'clean-media':
        return cleanMedia()
    }
    return undefined
  }

  // Typing a choice updates the key menus of the slots.
  el.oninput = (e) => {
    const form = e.target.closest?.('form[data-form=item]')
    if (form && e.target.closest('[data-entries]')) refreshKeySelects(form)
  }

  el.onsubmit = (e) => {
    e.preventDefault()
    const form = e.target
    if (form.dataset.form !== 'item' || busy) return
    busy = true
    const errorSlot = form.querySelector('[data-form-error]')
    saveItem(form).then(
      () => {
        busy = false
        run(async () => {}, 'บันทึกข้อแล้ว')
      },
      (err) => {
        // Keep the open form (and what the author typed); show the error inside it.
        busy = false
        render(errorSlot, alertBox(toUserMessage(err)))
      }
    )
  }

  draw()
}

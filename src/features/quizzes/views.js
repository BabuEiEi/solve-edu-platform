import { html, render, safeUrl } from '../../shared/ui/html.js'
import {
  pageHeader,
  emptyState,
  alertBox,
  statusBadge,
  loading,
  filePicker,
} from '../../shared/ui/components.js'
import { toUserMessage, AppError } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { watchDeleteZones } from '../deletion/zone.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { PURPOSE_LABELS } from '../assessments/logic.js'
import { moveId, nextOrder } from '../builder/service.js'
import { acceptAttr } from '../lessons/media.js'
import { downloadText, downloadBytes } from '../../shared/ui/download.js'
import { confirmDialog } from '../../shared/ui/dialog.js'
import { readTableFile, TABLE_FILE_ACCEPT } from '../../shared/utils/tableFile.js'
import { XLSX_MIME } from '../../shared/utils/xlsx.js'
import {
  analyzeQuizImportRows,
  importTemplateCsv,
  importTemplateXlsx,
  IMPORT_TEMPLATE_FILENAME,
  IMPORT_TEMPLATE_XLSX_FILENAME,
  MAX_IMPORT_ROWS,
} from './importFile.js'
import { itemMediaPaths } from '../assessments/logic.js'
import {
  ITEM_TYPES,
  scoringModesFor,
  defaultScoringMode,
  MAX_CHOICES,
  isChoiceType,
  nextOptionId,
  buildItemDraft,
  keyState,
  publishBlockers,
  defaultVersion,
  unusedMedia,
  isListType,
  isBlankType,
  defaultLists,
  LIST_EDITORS,
} from './logic.js'
import { listEditorFields, readList, handleListAction, refreshKeySelects } from './listEditors.js'
import {
  blankEditorFields,
  labellingEditorFields,
  readBlanks,
  readMarkers,
  handleBlankAction,
  placeMarker,
  redrawDots,
  toggleBlankKind,
} from './blankEditors.js'

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
                ${[...quizzes]
                  .sort((a, b) => (a.status === 'archived') - (b.status === 'archived'))
                  .map((q) => {
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
                      ${q.status === 'archived' ? html`<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-500/20" data-archived-badge>เก็บถาวร</span>` : ''}
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
      ${filePicker({
        name: 'opt_file',
        accept: acceptAttr('image'),
        button: url ? 'เปลี่ยนรูป…' : 'เลือกรูป…',
        label: `รูปของตัวเลือก ${option.id}`,
      })}
    </div>
  </div>`
}

/** Scoring mode select for types that have one; shows the item's stored mode (not part of the key). */
function modeField(type, item) {
  const modes = scoringModesFor(type)
  if (!modes) return ''
  const current = item?.scoring_mode ?? defaultScoringMode(type)
  return html`<label class="${label}"
    >วิธีให้คะแนน
    <select name="mode" class="${input} mt-1">
      ${Object.entries(modes).map(
        ([v, l]) => html`<option value="${v}" ${v === current ? html`selected` : ''}>${l}</option>`
      )}
    </select>
  </label>`
}

function itemForm(type, item, media) {
  const editing = Boolean(item)
  const options = item?.options_json?.options ?? [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const questionImage = item?.media_path ? media[item.media_path] : null
  const keyHint = editing
    ? html`<p class="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
        ระบบไม่แสดงเฉลยเดิมกลับมา หากไม่เลือก/กรอกคำตอบที่ถูกใหม่ เฉลยเดิมจะคงไว้
      </p>`
    : ''

  let typeFields
  if (isBlankType(type)) {
    typeFields = blankEditorFields(type, item?.options_json, { editing })
  } else if (type === 'image_labelling') {
    typeFields = labellingEditorFields(item?.options_json, questionImage)
  } else if (isListType(type)) {
    typeFields = listEditorFields(type, item ? item.options_json : defaultLists(type), media, { editing })
  } else if (isChoiceType(type)) {
    typeFields = html`<fieldset class="space-y-2">
        <legend class="${label}">ตัวเลือก (ทำเครื่องหมาย “ถูก” ที่คำตอบที่ถูก)</legend>
        <div data-options class="space-y-2">${options.map((o) => optionRow(type, o, media))}</div>
        <button type="button" class="${secondary}" data-action="add-option">+ เพิ่มตัวเลือก</button>
      </fieldset>
`
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
        <span class="${label}">${type === 'image_labelling' ? 'รูปสำหรับติดป้าย (บังคับ)' : 'รูปประกอบโจทย์ (ไม่บังคับ)'}</span>
        ${
          questionImage
            ? html`${type === 'image_labelling' ? '' : html`<img src="${safeUrl(questionImage)}" alt="" class="mt-1 max-h-32 rounded" />`}
                <label class="mt-1 flex items-center gap-1 text-xs text-ink-500"
                  ><input type="checkbox" name="remove_media" /> เอารูปออก</label
                >`
            : ''
        }
        <div class="mt-1">
          ${filePicker({
            name: 'media_file',
            accept: acceptAttr('image'),
            button: questionImage ? 'เปลี่ยนรูป…' : 'เลือกรูป…',
            label: type === 'image_labelling' ? 'รูปสำหรับติดป้าย' : 'รูปประกอบโจทย์',
          })}
        </div>
      </div>
    </div>
    ${typeFields} ${modeField(type, item)} ${keyHint}
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
  let importing = null // { fileName, analysis } while the import panel is open
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
          isBlankType(item.item_type)
            ? html`<p class="leading-8 text-ink-700" data-blank-preview>
                ${(item.options_json?.text ?? '')
                  .split(/\{\{[a-z0-9]{1,8}\}\}/)
                  .map((part, k, all) =>
                    k < all.length - 1
                      ? html`${part}<span class="mx-1 rounded border border-dashed border-ink-300 px-2 text-xs text-ink-500">ช่อง ${k + 1}</span>`
                      : part
                  )}
              </p>`
            : item.item_type === 'image_labelling'
              ? html`<p class="text-ink-500" data-label-preview>
                  ${(item.options_json?.markers ?? []).length} จุด · ป้าย: ${(item.options_json?.labels ?? []).map((l) => l.text).join(' · ')}
                </p>`
              : isListType(item.item_type)
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

  const archivedBar = () =>
    instrument.status === 'archived'
      ? html`<div class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-archived>
          <span>แบบทดสอบนี้เก็บถาวรแล้ว (ซ่อนจากรายการ) ผลที่เกิดขึ้นแล้วยังอยู่ครบ</span>
          <button type="button" class="${secondary}" data-action="unarchive">นำกลับมาใช้</button>
        </div>`
      : ''

  const assignmentPanel = () => {
    const canAssign =
      version?.status === 'published' && instrument.status !== 'archived' && services.assignments
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

  const TYPE_LABELS = {
    mcq_single: 'เลือกตอบ',
    mcq_multiple: 'เลือกหลายคำตอบ',
    true_false: 'ถูกผิด',
    numeric: 'ตัวเลข',
  }
  const SHOWN_ERRORS = 50

  /** Import from an Excel or CSV file: template, choose, preview every row (or every problem), confirm. */
  const importPanel = () => {
    const a = importing.analysis
    const ok = a && a.errors.length === 0
    return html`<section class="space-y-3 rounded-xl border-2 border-brand-200 bg-white p-5 text-sm" data-import-panel>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold text-brand-700">นำเข้าข้อสอบจากไฟล์ Excel หรือ CSV</h2>
        <button type="button" class="${secondary}" data-action="close-import">ปิด</button>
      </div>
      <ol class="list-decimal space-y-1 pl-5 text-ink-600">
        <li>ดาวน์โหลดแม่แบบ แล้วกรอกใน Excel หรือ Google Sheets (บันทึกเป็น .xlsx หรือ CSV ก็ได้)</li>
        <li>เลือกไฟล์ — ระบบแสดงตัวอย่างทุกข้อให้ตรวจก่อน ยังไม่มีอะไรถูกบันทึก</li>
        <li>กด “นำเข้า” เมื่อไม่มีแถวที่ผิด — ข้อจะถูกเพิ่มต่อท้ายฉบับร่างนี้ทั้งหมด หรือไม่เพิ่มเลย</li>
      </ol>
      <p class="text-xs text-ink-500">
        รองรับ: เลือกตอบ · เลือกหลายคำตอบ · ถูกผิด · ตัวเลข (ไม่มีรูป — เพิ่มรูปในหน้าแก้ข้อหลังนำเข้า) ·
        ครั้งละไม่เกิน ${MAX_IMPORT_ROWS} ข้อ · ทุกข้อต้องมีเฉลย
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <span class="inline-flex flex-wrap gap-2">
          <button type="button" class="${secondary}" data-action="download-import-template-xlsx">ดาวน์โหลดแม่แบบ (Excel)</button>
          <button type="button" class="${secondary}" data-action="download-import-template">ดาวน์โหลดแม่แบบ (CSV)</button>
        </span>
        ${filePicker({
          name: 'import_file',
          accept: TABLE_FILE_ACCEPT,
          button: a ? 'เลือกไฟล์อื่น…' : 'เลือกไฟล์ Excel หรือ CSV…',
          label: 'ไฟล์ข้อสอบ (Excel หรือ CSV)',
          none: a ? '' : undefined, // the file name is shown below once one is read
        })}
      </div>
      ${a ? html`<p class="text-ink-700" data-import-file>ไฟล์: <strong>${importing.fileName}</strong> · ${a.total} แถว</p>` : ''}
      ${
        a && !ok
          ? html`<div class="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800" role="alert" data-import-errors>
              <p class="font-medium">
                ยังนำเข้าไม่ได้ — พบปัญหา ${a.errors.length} จุด แก้ในไฟล์แล้วเลือกไฟล์ใหม่ (ยังไม่มีข้อใดถูกบันทึก)
              </p>
              <ul class="mt-2 list-disc space-y-0.5 pl-5">
                ${a.errors
                  .slice(0, SHOWN_ERRORS)
                  .map(
                    (e) => html`<li>${e.row ? html`<strong>แถว ${e.row}:</strong> ` : ''}${e.message}</li>`
                  )}
              </ul>
              ${a.errors.length > SHOWN_ERRORS ? html`<p class="mt-1 text-xs">… และอีก ${a.errors.length - SHOWN_ERRORS} จุด</p>` : ''}
            </div>`
          : ''
      }
      ${
        ok
          ? html`<div data-import-preview>
              <p class="mb-2 font-medium text-emerald-700">พร้อมนำเข้า ${a.items.length} ข้อ — ตรวจให้ครบก่อนกดนำเข้า</p>
              <div class="relative overflow-x-auto rounded-lg border border-ink-200">
                <table class="min-w-full text-left text-xs">
                  <thead class="bg-ink-50 text-ink-500">
                    <tr>
                      <th scope="col" class="px-3 py-2 font-medium">ข้อ</th>
                      <th scope="col" class="px-3 py-2 font-medium">ประเภท</th>
                      <th scope="col" class="px-3 py-2 font-medium">โจทย์</th>
                      <th scope="col" class="px-3 py-2 font-medium">คะแนน</th>
                      <th scope="col" class="px-3 py-2 font-medium">ตัวเลือก</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-ink-100">
                    ${a.items.map(
                      (it, i) => html`<tr data-import-row="${i + 1}">
                        <td class="px-3 py-2 font-semibold text-ink-700">${items.length + i + 1}</td>
                        <td class="px-3 py-2">${TYPE_LABELS[it.item_type]}</td>
                        <td class="max-w-xs truncate px-3 py-2" title="${it.prompt}">${it.prompt}</td>
                        <td class="px-3 py-2">${Number(it.max_score)}</td>
                        <td class="px-3 py-2 text-ink-500">${it.options_json?.options ? `${it.options_json.options.length} ตัว` : '—'}</td>
                      </tr>`
                    )}
                  </tbody>
                </table>
              </div>
              <p class="mt-2 text-xs text-ink-500">เฉลยจะถูกบันทึกพร้อมข้อ แต่ระบบไม่แสดงเฉลยกลับมา</p>
              <button type="button" class="${primary} mt-3" data-action="confirm-import">นำเข้า ${a.items.length} ข้อ</button>
            </div>`
          : ''
      }
    </section>`
  }

  const draw = () =>
    render(
      el,
      html`<a href="#/courses/${courseId}/quizzes" class="text-sm text-brand-700 hover:underline">← แบบทดสอบของหลักสูตร</a>
        <div class="mt-3">${pageHeader(instrument.title, `${instrument.code} · ${course.title}`)}</div>
        ${archivedBar()}
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
                : importing
                  ? importPanel()
                  : html`<div class="flex flex-wrap gap-2 rounded-xl border border-dashed border-ink-200 bg-white p-3">
                    <span class="self-center text-sm text-ink-500">เพิ่มข้อ:</span>
                    ${Object.entries(ITEM_TYPES).map(
                      ([t, meta]) =>
                        html`<button type="button" class="${secondary}" data-action="new-item" data-type="${t}">
                          ${meta.icon} ${meta.label}
                        </button>`
                    )}
                    <span class="flex-1"></span>
                    <button type="button" class="${secondary}" data-action="open-import">นำเข้าจากไฟล์ (Excel/CSV)</button>
                  </div>`
              : ''
          }
          <section class="pt-6" data-delete-zone data-kind="instrument" data-id="${instrument.id}"></section>
        </div>`
    )

  const run = async (fn, okMessage) => {
    if (busy) return
    busy = true
    try {
      const result = await fn()
      editing = null
      importing = null
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

  // "ลบแบบทดสอบ": unused → delete with the typed code; used → reasons + archive
  watchDeleteZones(el, {
    services,
    config: () => ({
      confirmWord: instrument.code,
      archive:
        instrument.status === 'archived'
          ? null
          : {
              label: 'เก็บถาวรแบบทดสอบ',
              run: () =>
                run(
                  () => services.quizzes.setInstrumentStatus(instrument.id, 'archived'),
                  'เก็บถาวรแบบทดสอบแล้ว'
                ),
            },
      onDeleted: () => navigate(`/courses/${courseId}/quizzes`),
    }),
  })

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
    for (const [k, v] of f.entries()) if (k.startsWith('key:') && v) keySlots[k.slice(4)] = String(v)
    if (type === 'image_labelling') lists.labels = readList(f, 'labels')
    if (isListType(type)) {
      for (const def of LIST_EDITORS[type]) {
        lists[def.name] = []
        for (const row of readList(f, def.name)) {
          const uploaded = await upload(row.file)
          lists[def.name].push({ id: row.id, text: row.text, image_path: uploaded ?? row.image_path })
        }
      }
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
        text: f.get('tpl_text'),
        blanks: isBlankType(type) ? readBlanks(f, type) : [],
        markers: type === 'image_labelling' ? readMarkers(f) : [],
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
    if (
      !(await confirmDialog({
        title: `ลบรูปที่ไม่มีข้อใดใช้ ${candidates.length} ไฟล์?`,
        text: 'ลบแล้วกู้คืนไม่ได้',
        confirmText: 'ลบรูป',
        danger: true,
      }))
    )
      return undefined
    return run(
      () => services.assessmentMedia.remove(candidates),
      (removed) =>
        removed.length === candidates.length
          ? `ลบรูปที่ไม่ได้ใช้แล้ว ${removed.length} ไฟล์`
          : `ลบแล้ว ${removed.length} จาก ${candidates.length} ไฟล์ — ที่เหลือถูกใช้อยู่ ระบบจึงไม่ลบ`
    )
  }

  el.onclick = async (e) => {
    const picture = e.target.closest('[data-label-image]')
    if (picture) {
      const form = picture.closest('form')
      const problem = placeMarker(form, e)
      if (problem) render(form.querySelector('[data-form-error]'), alertBox(problem))
      return
    }
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return
    const { action, id: targetId, delta, type } = b.dataset
    switch (action) {
      case 'select-version':
        selectedVersionId = targetId
        editing = null
        message = null
        return run(async () => {}, null)
      case 'open-import':
        editing = null
        importing = { fileName: '', analysis: null }
        message = null
        return draw()
      case 'close-import':
        importing = null
        return draw()
      case 'download-import-template':
        return downloadText(IMPORT_TEMPLATE_FILENAME, importTemplateCsv())
      case 'download-import-template-xlsx':
        return downloadBytes(IMPORT_TEMPLATE_XLSX_FILENAME, importTemplateXlsx(), XLSX_MIME)
      case 'confirm-import': {
        const toImport = importing?.analysis
        if (!toImport || toImport.errors.length) return undefined
        return run(
          () => services.quizzes.importItems(version.id, toImport.items),
          (n) => `นำเข้า ${n} ข้อแล้ว — ตรวจแต่ละข้อในรายการด้านบน แล้วเผยแพร่เมื่อพร้อม`
        )
      }
      case 'new-item':
        editing = { type, itemId: null }
        importing = null
        message = null
        return draw()
      case 'edit-item':
        importing = null
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
      case 'insert-blank':
      case 'remove-blank':
      case 'add-bopt':
      case 'remove-bopt':
      case 'remove-marker': {
        const problem = handleBlankAction(b)
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
        if (!(await confirmDialog({ title: 'ลบข้อนี้?', confirmText: 'ลบ', danger: true }))) return undefined
        return run(() => services.quizzes.deleteItem(targetId), 'ลบข้อแล้ว')
      case 'publish':
        if (
          !(await confirmDialog({
            title: 'เผยแพร่ฉบับนี้?',
            text: 'เมื่อเผยแพร่แล้วจะแก้ไขข้อสอบและเฉลยของฉบับนี้ไม่ได้อีก',
            confirmText: 'เผยแพร่',
          }))
        )
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
      case 'unarchive':
        return run(
          () => services.quizzes.setInstrumentStatus(instrument.id, 'active'),
          'นำแบบทดสอบกลับมาใช้แล้ว'
        )
    }
    return undefined
  }

  // Typing a choice updates the key menus of the slots.
  el.oninput = (e) => {
    const form = e.target.closest?.('form[data-form=item]')
    if (!form) return
    if (e.target.closest('[data-entries]')) refreshKeySelects(form)
    if (e.target.name === 'marker_x' || e.target.name === 'marker_y') redrawDots(form)
    if (e.target.matches?.('[data-blank-kind]')) toggleBlankKind(e.target)
  }

  // Labelling: preview a newly chosen picture so markers can be placed before saving.
  let previewUrl = null
  el.onchange = async (e) => {
    if (e.target?.name === 'import_file' && importing) {
      const file = e.target.files?.[0]
      if (!file) return
      try {
        importing = { fileName: file.name, analysis: analyzeQuizImportRows(await readTableFile(file)) }
      } catch (err) {
        // readTableFile explains size, old .xls, password-protected and broken files in Thai
        importing = {
          fileName: file.name,
          analysis: {
            items: [],
            total: 0,
            errors: [{ row: 0, message: err instanceof AppError ? err.message : 'อ่านไฟล์นี้ไม่ได้' }],
          },
        }
      }
      return draw()
    }
    const form = e.target.closest?.('form[data-form=item]')
    if (!form || form.dataset.type !== 'image_labelling' || e.target.name !== 'media_file') return
    const file = e.target.files?.[0]
    if (!file) return
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    previewUrl = URL.createObjectURL(file)
    form.querySelector('[data-label-image]').src = previewUrl
    form.querySelector('[data-label-canvas]').hidden = false
    form.querySelector('[data-no-image]').hidden = true
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

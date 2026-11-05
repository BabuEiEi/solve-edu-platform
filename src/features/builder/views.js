import { html, render, safeUrl } from '../../shared/ui/html.js'
import {
  pageHeader,
  emptyState,
  alertBox,
  statusBadge,
  loading,
  filePicker,
} from '../../shared/ui/components.js'
import { richTextEditorMarkup } from '../../shared/ui/richTextEditor.js'
import { toUserMessage } from '../../core/errors.js'
import { moveId, nextOrder, learnerVisibility } from './service.js'
import {
  BLOCK_TYPES,
  AUTHORING_TYPES,
  buildBlockContent,
  blockSummary,
  mediaPathsOf,
} from '../lessons/blocks.js'
import { acceptAttr } from '../lessons/media.js'
import { renderBlock } from '../lessons/render.js'

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

const STATUS_OPTIONS = [
  ['draft', 'ฉบับร่าง'],
  ['published', 'เผยแพร่'],
  ['archived', 'เก็บถาวร'],
]
const statusSelect = (current) =>
  html`<select name="status" class="${input}">
    ${STATUS_OPTIONS.map(([v, l]) => html`<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`)}
  </select>`

const moveButtons = (action, item, list, extra = {}) => {
  const i = list.findIndex((x) => x.id === item.id)
  const attrs = (delta) =>
    html`data-action="${action}" data-id="${item.id}" data-delta="${delta}" ${
      extra.unit ? html`data-unit="${extra.unit}"` : ''
    }`
  return html`<button type="button" class="${iconBtn}" ${attrs(-1)} ${i === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น">
      ↑</button
    ><button
      type="button"
      class="${iconBtn}"
      ${attrs(1)}
      ${i === list.length - 1 ? 'disabled' : ''}
      aria-label="เลื่อนลง"
    >
      ↓
    </button>`
}

const publishToggle = (action, item) =>
  html`<button type="button" class="${iconBtn}" data-action="${action}" data-id="${item.id}">
    ${item.status === 'published' ? 'ซ่อน (ร่าง)' : 'เผยแพร่'}
  </button>`

const accessDenied = () =>
  html`${pageHeader('แก้ไขหลักสูตร')}${emptyState('ท่านไม่มีสิทธิ์แก้ไขหลักสูตรนี้ หรือไม่พบหลักสูตร')}`

// =====================================================================
// Course builder: course info, units, lessons
// =====================================================================
export async function renderCourseBuilderView(el, { services }, { id }) {
  render(el, loading)
  let course = null
  let editing = null // 'course' | `unit:<id>`
  let message = null
  let tone = 'success'
  let busy = false

  try {
    if ((await services.courses.getAccess(id)) !== 'manage') return render(el, accessDenied())
    course = await services.builder.getCourseTree(id)
    if (!course) return render(el, accessDenied())
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }

  const units = () => course.course_units

  const courseInfo = () =>
    editing === 'course'
      ? html`<form data-form="course" class="grid gap-4 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2">
          <label class="${label}">รหัสหลักสูตร<input name="code" required maxlength="50" value="${course.code}" class="${input}" /></label>
          <label class="${label}"
            >ระยะเวลา (นาที)<input
              name="duration_minutes"
              type="number"
              min="0"
              value="${course.duration_minutes ?? ''}"
              class="${input}"
          /></label>
          <label class="${label} sm:col-span-2"
            >ชื่อหลักสูตร<input name="title" required maxlength="300" value="${course.title}" class="${input}"
          /></label>
          <label class="${label} sm:col-span-2"
            >คำอธิบายสั้น<input name="summary" maxlength="500" value="${course.summary ?? ''}" class="${input}"
          /></label>
          <label class="${label} sm:col-span-2"
            >รายละเอียด<textarea name="description" rows="4" class="${input}">${course.description ?? ''}</textarea>
          </label>
          <label class="${label}">สถานะ${statusSelect(course.status)}</label>
          <div class="flex items-end gap-2">
            <button class="${primary}" type="submit">บันทึก</button>
            <button class="${secondary}" type="button" data-action="cancel">ยกเลิก</button>
          </div>
        </form>`
      : html`<section class="rounded-xl border border-ink-200 bg-white p-5 text-sm">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <dl class="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
              <dt class="text-ink-500">รหัส</dt>
              <dd class="font-medium text-ink-800">${course.code}</dd>
              <dt class="text-ink-500">คำอธิบาย</dt>
              <dd class="text-ink-700">${course.summary || '—'}</dd>
              <dt class="text-ink-500">ระยะเวลา</dt>
              <dd class="text-ink-700">${course.duration_minutes ? `${course.duration_minutes} นาที` : '—'}</dd>
            </dl>
            <button type="button" class="${secondary}" data-action="edit-course">แก้ไขข้อมูล</button>
          </div>
        </section>`

  const lessonRow = (u, l) =>
    html`<li class="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
      <a href="#/courses/${course.id}/builder/lessons/${l.id}" class="min-w-0 flex-1 font-medium text-ink-800 hover:text-brand-700"
        >${l.title}</a
      >
      ${statusBadge(l.status)}
      ${l.required === false ? html`<span class="text-xs text-ink-400">ไม่บังคับ</span>` : ''}
      <span class="flex gap-1">
        ${moveButtons('move-lesson', l, u.lessons, { unit: u.id })} ${publishToggle('toggle-lesson', l)}
        <a class="${iconBtn}" href="#/courses/${course.id}/builder/lessons/${l.id}">แก้ไขเนื้อหา</a>
        <button type="button" class="${dangerBtn}" data-action="delete-lesson" data-id="${l.id}">ลบ</button>
      </span>
    </li>`

  const unitCard = (u, index) =>
    html`<li class="rounded-xl border border-ink-200 bg-white">
      ${
        editing === `unit:${u.id}`
          ? html`<form data-form="unit" data-id="${u.id}" class="grid gap-3 border-b border-ink-100 p-4 sm:grid-cols-[1fr_200px]">
            <label class="${label}">ชื่อหน่วย<input name="title" required maxlength="300" value="${u.title}" class="${input}" /></label>
            <label class="${label}">สถานะ${statusSelect(u.status)}</label>
            <label class="${label} sm:col-span-2"
              >คำอธิบาย<textarea name="description" rows="2" class="${input}">${u.description ?? ''}</textarea>
            </label>
            <div class="flex gap-2">
              <button class="${primary}" type="submit">บันทึก</button>
              <button class="${secondary}" type="button" data-action="cancel">ยกเลิก</button>
            </div>
          </form>`
          : html`<div class="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-3">
            <span class="text-xs font-semibold text-ink-400">หน่วย ${index + 1}</span>
            <h2 class="min-w-0 flex-1 font-semibold text-ink-900">${u.title}</h2>
            ${statusBadge(u.status)}
            <span class="flex gap-1">
              ${moveButtons('move-unit', u, units())} ${publishToggle('toggle-unit', u)}
              <button type="button" class="${iconBtn}" data-action="edit-unit" data-id="${u.id}">แก้ไข</button>
              <button type="button" class="${dangerBtn}" data-action="delete-unit" data-id="${u.id}">ลบ</button>
            </span>
          </div>`
      }
      <ul class="divide-y divide-ink-100">
        ${
          u.lessons.length
            ? u.lessons.map((l) => lessonRow(u, l))
            : html`<li class="px-4 py-3 text-sm text-ink-400">ยังไม่มีบทเรียน</li>`
        }
      </ul>
      <form data-form="add-lesson" data-unit="${u.id}" class="flex gap-2 border-t border-ink-100 p-3">
        <label class="sr-only" for="add-lesson-${u.id}">ชื่อบทเรียนใหม่</label>
        <input id="add-lesson-${u.id}" name="title" required maxlength="300" placeholder="ชื่อบทเรียนใหม่" class="${inputInline}" />
        <button class="${secondary} shrink-0" type="submit">+ เพิ่มบทเรียน</button>
      </form>
    </li>`

  const draw = () =>
    render(
      el,
      html`
        <a href="#/courses/${course.id}" class="text-sm text-brand-700 hover:underline">← หน้าหลักสูตร</a>
        <div class="mt-3 flex flex-wrap items-start justify-between gap-3">
          ${pageHeader(course.title, 'ตัวสร้างหลักสูตร — จัดหน่วย บทเรียน และสถานะการเผยแพร่')}
          <div class="flex flex-wrap items-center gap-2">
            ${statusBadge(course.status)} ${publishToggle('toggle-course', course)}
            <a href="#/courses/${course.id}/preview" class="${secondary}">ดูมุมมองผู้เรียน</a>
            <a href="#/courses/${course.id}/quizzes" class="${secondary}">แบบทดสอบ</a>
            <a href="#/courses/${course.id}/rubrics" class="${secondary}">Rubric</a>
            <a href="#/courses/${course.id}/tasks" class="${secondary}">ภาระงาน</a>
          </div>
        </div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <p class="mb-4 text-xs text-ink-500">
          ผู้เรียนจะเห็นบทเรียนเมื่อ <strong>หลักสูตร</strong> <strong>หน่วย</strong> และ
          <strong>บทเรียน</strong> อยู่ในสถานะ “เผยแพร่” ทั้งหมด
        </p>
        ${courseInfo()}
        <ol class="mt-6 space-y-4">
          ${units().map(unitCard)}
        </ol>
        <form data-form="add-unit" class="mt-4 flex gap-2 rounded-xl border border-dashed border-ink-200 bg-white p-3">
          <label class="sr-only" for="add-unit-title">ชื่อหน่วยใหม่</label>
          <input id="add-unit-title" name="title" required maxlength="300" placeholder="ชื่อหน่วยการเรียนรู้ใหม่" class="${inputInline}" />
          <button class="${primary} shrink-0" type="submit">+ เพิ่มหน่วย</button>
        </form>
      `
    )

  const run = async (fn, okMessage) => {
    if (busy) return
    busy = true
    try {
      await fn()
      course = await services.builder.getCourseTree(id)
      message = okMessage
      tone = 'success'
      editing = null
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
    } finally {
      busy = false
      draw()
    }
  }

  const unitOf = (unitId) => units().find((u) => u.id === unitId)
  const lessonOf = (lessonId) =>
    units()
      .flatMap((u) => u.lessons)
      .find((l) => l.id === lessonId)
  const flip = (s) => (s === 'published' ? 'draft' : 'published')

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return
    const { action, id: itemId, unit, delta } = b.dataset
    switch (action) {
      case 'edit-course':
        editing = 'course'
        return draw()
      case 'edit-unit':
        editing = `unit:${itemId}`
        return draw()
      case 'cancel':
        editing = null
        return draw()
      case 'toggle-course':
        return run(
          () => services.builder.updateCourse(id, { status: flip(course.status) }),
          'บันทึกสถานะหลักสูตรแล้ว'
        )
      case 'toggle-unit':
        return run(
          () => services.builder.updateUnit(itemId, { status: flip(unitOf(itemId).status) }),
          'บันทึกสถานะหน่วยแล้ว'
        )
      case 'toggle-lesson':
        return run(
          () => services.builder.updateLesson(itemId, { status: flip(lessonOf(itemId).status) }),
          'บันทึกสถานะบทเรียนแล้ว'
        )
      case 'move-unit':
        return run(
          () =>
            services.builder.reorder(
              'unit',
              id,
              moveId(
                units().map((u) => u.id),
                itemId,
                Number(delta)
              )
            ),
          'จัดลำดับหน่วยแล้ว'
        )
      case 'move-lesson':
        return run(
          () =>
            services.builder.reorder(
              'lesson',
              unit,
              moveId(
                unitOf(unit).lessons.map((l) => l.id),
                itemId,
                Number(delta)
              )
            ),
          'จัดลำดับบทเรียนแล้ว'
        )
      case 'delete-unit':
        if (!window.confirm(`ลบหน่วย “${unitOf(itemId).title}” และบทเรียนทั้งหมดในหน่วยนี้?`)) return
        return run(() => services.builder.deleteUnit(itemId), 'ลบหน่วยแล้ว')
      case 'delete-lesson':
        if (!window.confirm(`ลบบทเรียน “${lessonOf(itemId).title}” และเนื้อหาทั้งหมด?`)) return
        return run(() => services.builder.deleteLesson(itemId), 'ลบบทเรียนแล้ว')
    }
  }

  el.onsubmit = (e) => {
    e.preventDefault()
    const form = e.target
    const f = Object.fromEntries(new FormData(form))
    switch (form.dataset.form) {
      case 'course':
        return run(() => services.builder.updateCourse(id, f), 'บันทึกข้อมูลหลักสูตรแล้ว')
      case 'unit':
        return run(() => services.builder.updateUnit(form.dataset.id, f), 'บันทึกหน่วยแล้ว')
      case 'add-unit':
        return run(() => services.builder.addUnit(id, f.title, nextOrder(units())), 'เพิ่มหน่วยแล้ว')
      case 'add-lesson':
        return run(
          () =>
            services.builder.addLesson(
              form.dataset.unit,
              f.title,
              nextOrder(unitOf(form.dataset.unit).lessons)
            ),
          'เพิ่มบทเรียนแล้ว'
        )
    }
  }

  draw()
}

// =====================================================================
// Lesson editor: lesson info + content blocks
// =====================================================================
const MEDIA_KIND = { image: 'image', document: 'document', video: 'video' }

const PURPOSE_SHORT = { pretest: 'ก่อนเรียน', posttest: 'หลังเรียน', formative: 'ระหว่างเรียน' }

function blockForm(type, block, media, assignments = []) {
  const c = block?.content_json ?? {}
  const current = c.object_path && media[c.object_path]
  const fileInput = (kind, required) => {
    const replacing = Boolean(block?.content_json?.object_path)
    const text = replacing ? 'เปลี่ยนไฟล์ (ไม่บังคับ)' : 'เลือกไฟล์'
    return html`<div>
      <span class="${label}">${text}</span>
      <div class="mt-1">
        ${filePicker({
          name: 'file',
          accept: acceptAttr(kind),
          button: kind === 'image' ? 'เลือกรูป…' : 'เลือกไฟล์…',
          label: text,
          required,
        })}
      </div>
    </div>`
  }
  const fields = {
    rich_text: () => richTextEditorMarkup(),
    video: () =>
      html`<label class="${label}"
          >ลิงก์ YouTube / Vimeo<input
            name="url"
            type="url"
            placeholder="https://www.youtube.com/watch?v=…"
            value="${c.provider && c.provider !== 'storage' ? (c.provider === 'vimeo' ? `https://vimeo.com/${c.video_id}` : `https://youtu.be/${c.video_id}`) : ''}"
            class="${input}"
        /></label>
        <p class="text-xs text-ink-500">หรืออัปโหลดไฟล์วิดีโอ (MP4/WebM ไม่เกิน 50 MB)</p>
        ${fileInput('video', false)}
        <label class="${label}">คำบรรยายใต้วิดีโอ<input name="caption" maxlength="300" value="${c.caption ?? ''}" class="${input}" /></label>`,
    image: () =>
      html`${current ? html`<img src="${safeUrl(current)}" alt="" class="max-h-40 rounded-lg" />` : ''}
        ${fileInput('image', !block)}
        <label class="${label}"
          >คำอธิบายรูปภาพ (alt)<input name="alt" required maxlength="300" value="${c.alt ?? ''}" class="${input}"
        /></label>
        <label class="${label}">คำบรรยายใต้ภาพ<input name="caption" maxlength="300" value="${c.caption ?? ''}" class="${input}" /></label>`,
    document: () =>
      html`${c.file_name ? html`<p class="text-sm text-ink-600">ไฟล์ปัจจุบัน: ${c.file_name}</p>` : ''}
        ${fileInput('document', !block)}
        <label class="${label}">ชื่อที่แสดง<input name="label" maxlength="300" value="${c.label ?? ''}" class="${input}" /></label>`,
    link: () =>
      html`<label class="${label}"
          >ลิงก์ (https://)<input name="url" type="url" required value="${c.url ?? ''}" class="${input}"
        /></label>
        <label class="${label}">ข้อความที่แสดง<input name="label" maxlength="300" value="${c.label ?? ''}" class="${input}" /></label>`,
    quiz_reference: () =>
      assignments.length
        ? html`<label class="${label}"
              >แบบทดสอบที่มอบหมายในหลักสูตรนี้
              <select name="assessment_assignment_id" required class="${input}">
                <option value="">— เลือก —</option>
                ${assignments.map(
                  (a) =>
                    html`<option value="${a.id}" ${a.id === c.assessment_assignment_id ? 'selected' : ''}>
                      ${a.title} (${PURPOSE_SHORT[a.purpose] ?? a.purpose} · ${a.cohorts?.code ?? ''}${
                        a.status === 'published' ? '' : ' · ยังไม่เผยแพร่'
                      })
                    </option>`
                )}
              </select>
            </label>
            <label class="${label}"
              >ข้อความที่แสดง (ไม่บังคับ)<input name="title" maxlength="300" value="${c.title ?? ''}" class="${input}"
            /></label>`
        : html`<p class="text-sm text-ink-500">
            ยังไม่มีแบบทดสอบที่มอบหมายในหลักสูตรนี้ — สร้างและมอบหมายแบบทดสอบก่อน แล้วจึงเพิ่มบล็อกนี้
          </p>`,
  }
  return html`<form data-form="block" class="space-y-3 rounded-xl border-2 border-brand-200 bg-white p-4">
    <p class="text-sm font-semibold text-brand-700">
      ${block ? 'แก้ไข' : 'เพิ่ม'}${BLOCK_TYPES[type].label}
    </p>
    ${fields[type]()}
    <div data-form-error></div>
    <div class="flex gap-2">
      <button class="${primary}" type="submit">บันทึก</button>
      <button class="${secondary}" type="button" data-action="cancel-block">ยกเลิก</button>
    </div>
  </form>`
}

export async function renderLessonEditorView(el, { services }, { id: courseId, lessonId }) {
  render(el, loading)
  let course, lesson
  let media = {}
  let assignments = [] // for quiz_reference blocks
  let editing = null // { type, blockId|null }
  let editor = null
  let message = null
  let tone = 'success'
  let busy = false

  const load = async () => {
    ;[course, lesson] = await Promise.all([
      services.builder.getCourseTree(courseId),
      services.lessons.getLesson(lessonId),
    ])
    media = lesson ? await services.media.signedUrls(mediaPathsOf(lesson.lesson_blocks)) : {}
    assignments = services.quizzes ? await services.quizzes.listCourseAssignments(courseId) : []
  }

  try {
    if ((await services.courses.getAccess(courseId)) !== 'manage') return render(el, accessDenied())
    await load()
    if (!course || !lesson || lesson.course_units?.course_id !== courseId) return render(el, accessDenied())
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }

  const blocks = () => lesson.lesson_blocks
  const unit = () => course.course_units.find((u) => u.id === lesson.unit_id)

  const closeEditor = () => {
    editor?.destroy()
    editor = null
    editing = null
  }

  const blockCard = (b) => {
    if (editing?.blockId === b.id) return blockForm(b.block_type, b, media, assignments)
    const canEdit = BLOCK_TYPES[b.block_type]?.authoring
    return html`<li class="rounded-xl border border-ink-200 bg-white">
      <div class="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-2 text-sm">
        <span aria-hidden="true" class="w-5 text-center text-ink-400">${BLOCK_TYPES[b.block_type]?.icon}</span>
        <span class="font-medium text-ink-700">${BLOCK_TYPES[b.block_type]?.label ?? b.block_type}</span>
        <span class="min-w-0 flex-1 truncate text-ink-400">${blockSummary(b)}</span>
        <span class="flex gap-1">
          ${moveButtons('move-block', b, blocks())}
          ${canEdit ? html`<button type="button" class="${iconBtn}" data-action="edit-block" data-id="${b.id}">แก้ไข</button>` : ''}
          <button type="button" class="${dangerBtn}" data-action="delete-block" data-id="${b.id}">ลบ</button>
        </span>
      </div>
      <div class="p-4">${renderBlock(b, media)}</div>
    </li>`
  }

  const draw = () => {
    const vis = learnerVisibility(course, unit(), lesson)
    render(
      el,
      html`
        <a href="#/courses/${courseId}/builder" class="text-sm text-brand-700 hover:underline">← ${course.title}</a>
        <div class="mt-3 flex flex-wrap items-start justify-between gap-3">
          ${pageHeader(lesson.title, unit()?.title ?? '')}
          <div class="flex flex-wrap items-center gap-2">
            ${statusBadge(lesson.status)} ${publishToggle('toggle-lesson', lesson)}
            <a href="#/learn/${courseId}/${lessonId}" class="${secondary}">ดูตัวอย่างมุมมองผู้เรียน</a>
          </div>
        </div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        ${
          vis.visible
            ? ''
            : html`<div class="mb-4">
              ${alertBox(`ผู้เรียนยังมองไม่เห็นบทเรียนนี้ เพราะ${vis.hiddenBy.join(' / ')}ยังไม่เผยแพร่`, 'info')}
            </div>`
        }

        <form data-form="lesson" class="grid gap-3 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-[1fr_200px]">
          <label class="${label}">ชื่อบทเรียน<input name="title" required maxlength="300" value="${lesson.title}" class="${input}" /></label>
          <label class="${label}">สถานะ${statusSelect(lesson.status)}</label>
          <label class="${label} sm:col-span-2"
            >จุดประสงค์การเรียนรู้<textarea name="learning_objectives" rows="3" class="${input}">${lesson.learning_objectives ?? ''}</textarea>
          </label>
          <label class="flex items-center gap-2 text-sm text-ink-700"
            ><input type="checkbox" name="required" ${lesson.required !== false ? 'checked' : ''} />
            บทเรียนบังคับ (นับในความก้าวหน้า)</label
          >
          <div class="sm:text-right"><button class="${primary}" type="submit">บันทึกข้อมูลบทเรียน</button></div>
        </form>

        <h2 class="mt-8 text-lg font-semibold text-ink-900">เนื้อหา</h2>
        <ol class="mt-3 space-y-4">
          ${
            blocks().length
              ? blocks().map(blockCard)
              : html`<li>${emptyState('ยังไม่มีเนื้อหา เลือกประเภทด้านล่างเพื่อเพิ่ม')}</li>`
          }
        </ol>
        <div class="mt-4">
          ${
            editing && !editing.blockId
              ? blockForm(editing.type, null, media, assignments)
              : html`<div class="flex flex-wrap gap-2 rounded-xl border border-dashed border-ink-200 bg-white p-3">
                <span class="self-center text-sm text-ink-500">เพิ่มเนื้อหา:</span>
                ${AUTHORING_TYPES.map(
                  (t) =>
                    html`<button type="button" class="${secondary}" data-action="new-block" data-type="${t}">
                      ${BLOCK_TYPES[t].icon} ${BLOCK_TYPES[t].label}
                    </button>`
                )}
              </div>`
          }
        </div>
      `
    )
    mountEditorIfNeeded()
  }

  const mountEditorIfNeeded = async () => {
    if (editing?.type !== 'rich_text') return
    const host = el.querySelector('[data-editor-host]')
    if (!host) return
    const initial = editing.blockId ? blocks().find((b) => b.id === editing.blockId)?.content_json?.html : ''
    try {
      editor = await services.editor.mount(host, initial)
      editor.focus()
    } catch (err) {
      // Fallback: plain HTML textarea (still sanitised on save).
      console.warn('[editor] falling back to textarea', err?.message)
      render(
        host,
        html`<label class="${label}"
          >เนื้อหา (HTML พื้นฐาน)<textarea name="html" rows="8" class="${input}">${initial}</textarea></label
        >`
      )
    }
  }

  const run = async (fn, okMessage) => {
    if (busy) return
    busy = true
    try {
      await fn()
      closeEditor()
      await load()
      message = okMessage
      tone = 'success'
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
    } finally {
      busy = false
      draw()
    }
  }

  const saveBlock = async (form) => {
    const f = new FormData(form)
    const { type, blockId } = editing
    const existing = blockId ? blocks().find((b) => b.id === blockId) : null
    const prev = existing?.content_json ?? {}
    const file = f.get('file')
    const hasFile = file && typeof file === 'object' && file.size > 0
    const fields = Object.fromEntries([...f.entries()].filter(([k]) => k !== 'file'))
    if (type === 'rich_text') fields.html = editor ? editor.getHTML() : f.get('html')
    if (type === 'quiz_reference' && !String(fields.title ?? '').trim())
      fields.title = assignments.find((a) => a.id === fields.assessment_assignment_id)?.title ?? ''

    let uploaded = null
    try {
      const wantsFile =
        type === 'image' || type === 'document' || (type === 'video' && !String(fields.url ?? '').trim())
      if (wantsFile) {
        if (hasFile) {
          uploaded = await services.media.upload(lessonId, MEDIA_KIND[type], file)
          fields.object_path = uploaded
          fields.file_name = file.name
        } else if (prev.object_path) {
          fields.object_path = prev.object_path
          fields.file_name = prev.file_name
        }
      }
      const content = buildBlockContent(type, fields)
      if (existing) await services.builder.updateBlock(existing.id, content)
      else await services.builder.addBlock(lessonId, type, content, nextOrder(blocks()))
      // Old file no longer referenced → clean up (best effort; storage policy re-checks).
      if (prev.object_path && prev.object_path !== content.object_path)
        services.media.remove([prev.object_path]).catch(() => {})
    } catch (err) {
      if (uploaded) services.media.remove([uploaded]).catch(() => {})
      throw err
    }
  }

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return
    const { action, id: blockId, delta, type } = b.dataset
    switch (action) {
      case 'new-block':
        closeEditor()
        editing = { type, blockId: null }
        message = null
        return draw()
      case 'edit-block':
        closeEditor()
        editing = { type: blocks().find((x) => x.id === blockId).block_type, blockId }
        message = null
        return draw()
      case 'cancel-block':
        closeEditor()
        return draw()
      case 'move-block':
        return run(
          () =>
            services.builder.reorder(
              'block',
              lessonId,
              moveId(
                blocks().map((x) => x.id),
                blockId,
                Number(delta)
              )
            ),
          'จัดลำดับเนื้อหาแล้ว'
        )
      case 'delete-block': {
        if (!window.confirm('ลบเนื้อหานี้?')) return
        const path = blocks().find((x) => x.id === blockId)?.content_json?.object_path
        return run(async () => {
          await services.builder.deleteBlock(blockId)
          if (path) services.media.remove([path]).catch(() => {})
        }, 'ลบเนื้อหาแล้ว')
      }
      case 'toggle-lesson':
        return run(
          () =>
            services.builder.updateLesson(lessonId, {
              status: lesson.status === 'published' ? 'draft' : 'published',
            }),
          'บันทึกสถานะบทเรียนแล้ว'
        )
    }
  }

  el.onsubmit = (e) => {
    e.preventDefault()
    const form = e.target
    if (form.dataset.form === 'lesson') {
      const f = new FormData(form)
      return run(
        () =>
          services.builder.updateLesson(lessonId, {
            title: f.get('title'),
            learning_objectives: f.get('learning_objectives'),
            required: f.get('required') === 'on',
            status: f.get('status'),
          }),
        'บันทึกข้อมูลบทเรียนแล้ว'
      )
    }
    if (form.dataset.form === 'block') {
      // On failure keep the open form (and what the user typed); show the error inside it.
      if (busy) return
      busy = true
      saveBlock(form).then(
        () => {
          busy = false
          run(async () => {}, 'บันทึกเนื้อหาแล้ว')
        },
        (err) => {
          busy = false
          render(form.querySelector('[data-form-error]'), alertBox(toUserMessage(err)))
        }
      )
    }
  }

  draw()
}

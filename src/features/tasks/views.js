import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { canAssessHint } from '../assignments/logic.js'
import { dateField, watchDateLabels } from '../assignments/views.js'
import {
  TASK_ATTEMPTS_DEFAULT,
  TASK_ATTEMPTS_MAX,
  buildAllocationPayload,
  buildTaskPayload,
  cohortsLeft,
  rubricOptions,
} from './logic.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary =
  'rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-60'
const danger = 'rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-rose-700 hover:bg-rose-50'
const backLink = 'text-sm text-brand-700 hover:underline'

const accessDenied = () =>
  html`${pageHeader('ภาระงานของหลักสูตร')}${emptyState('ท่านไม่มีสิทธิ์จัดการภาระงานของหลักสูตรนี้ หรือไม่พบหลักสูตร')}`
const cohortLabel = (c) => (c ? `${c.name} (${c.code})` : '—')

async function loadManagedCourse(services, courseId) {
  if ((await services.courses.getAccess(courseId)) !== 'manage') return null
  return services.builder.getCourseTree(courseId)
}

/** Rubric choice shared by "create" and "edit". */
function rubricSelect(options, current) {
  return html`<label class="${label} sm:col-span-2"
    >Rubric ที่ใช้ตรวจ
    <select name="rubric_version_id" class="${input}">
      <option value="">ไม่ใช้ Rubric (ให้ข้อเสนอแนะและผลผ่าน/ส่งกลับแก้ไขอย่างเดียว)</option>
      ${options.map((o) => html`<option value="${o.id}" ${current === o.id ? html`selected` : ''}>${o.label}</option>`)}
    </select>
    <span class="mt-1 block text-xs font-normal text-ink-500"
      >เลือกได้เฉพาะ Rubric ฉบับที่เผยแพร่แล้ว — เมื่อมีผู้ส่งงานแล้วเปลี่ยน Rubric ไม่ได้ เพื่อให้คะแนนที่ให้ไปแล้วยังมีความหมายเดิม</span
    >
  </label>`
}

function taskFields(t, rubrics) {
  return html`<label class="${label} sm:col-span-2"
      >ชื่อภาระงาน<input name="title" required maxlength="300" value="${t.title ?? ''}" class="${input}"
    /></label>
    <label class="${label} sm:col-span-2"
      >คำชี้แจง (ผู้เรียนเห็น)<textarea name="instructions" rows="4" maxlength="10000" class="${input}">${t.instructions ?? ''}</textarea>
    </label>
    ${rubricSelect(rubrics, t.rubric_version_id)}
    <label class="${label}"
      >ส่งได้สูงสุดกี่รอบ
      <input
        name="max_attempts"
        type="number"
        min="1"
        max="${TASK_ATTEMPTS_MAX}"
        value="${t.max_attempts ?? TASK_ATTEMPTS_DEFAULT}"
        class="${input}"
      />
      <span class="mt-1 block text-xs font-normal text-ink-500">รอบใหม่ส่งได้เมื่อผู้ตรวจ “ส่งกลับแก้ไข”</span>
    </label>`
}

// =====================================================================
// #/courses/:id/tasks — the tasks of a course
// =====================================================================
export async function renderCourseTasksView(el, { services }, { id }) {
  render(el, loading)
  let course, tasks, rubrics
  try {
    course = await loadManagedCourse(services, id)
    if (!course) return render(el, accessDenied())
    ;[tasks, rubrics] = await Promise.all([
      services.tasks.listForCourse(id),
      services.quizzes.listForCourse(id, 'rubric'),
    ])
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  const options = rubricOptions(rubrics)
  let message = null
  let values = {}

  const draw = () =>
    render(
      el,
      html`<a href="#/courses/${course.id}/builder" class="${backLink}">← ${course.title}</a>
        <div class="mt-3">${pageHeader('ภาระงานของหลักสูตร', 'งานที่ผู้เรียนส่ง (ข้อความ ไฟล์ ลิงก์) แล้วผู้ตรวจให้คะแนนด้วย Rubric และข้อเสนอแนะ ส่งแก้ไขได้หลายรอบ')}</div>
        ${
          tasks.length
            ? html`<ul class="space-y-3" data-tasks>
                ${tasks.map(
                  (t) => html`<li>
                    <a
                      href="#/courses/${course.id}/tasks/${t.id}"
                      class="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-white px-5 py-4 hover:border-brand-300"
                    >
                      <span class="min-w-0 flex-1 basis-56">
                        <span class="block font-semibold text-ink-900">${t.title}</span>
                        <span class="text-xs text-ink-500"
                          >${
                            t.instrument_versions
                              ? `${t.instrument_versions.instruments?.title} · ฉบับที่ ${t.instrument_versions.version_no}`
                              : 'ไม่ใช้ Rubric'
                          }
                          · เปิดให้ ${t.task_allocations?.length ?? 0} รุ่น</span
                        >
                      </span>
                      ${statusBadge(t.status)}
                    </a>
                  </li>`
                )}
              </ul>`
            : emptyState('ยังไม่มีภาระงานในหลักสูตรนี้')
        }
        <form data-form="create-task" class="mt-6 grid gap-4 rounded-xl border border-dashed border-ink-200 bg-white p-5 sm:grid-cols-2">
          <p class="text-sm font-semibold text-ink-800 sm:col-span-2">สร้างภาระงานใหม่ (เริ่มเป็นฉบับร่าง)</p>
          ${message ? html`<div class="sm:col-span-2">${alertBox(message)}</div>` : ''}
          ${taskFields(values, options)}
          <div class="sm:col-span-2"><button class="${primary}" type="submit">สร้างภาระงาน</button></div>
        </form>`
    )

  el.onsubmit = async (e) => {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.target))
    const button = e.target.querySelector('button[type=submit]')
    button.disabled = true
    values = f
    try {
      const created = await services.tasks.create(course.id, buildTaskPayload(f))
      navigate(`/courses/${course.id}/tasks/${created.id}`)
    } catch (err) {
      message = toUserMessage(err)
      draw()
    }
  }

  draw()
}

// =====================================================================
// #/courses/:id/tasks/:taskId — settings, status, opening to cohorts
// =====================================================================
export async function renderTaskDetailView(el, { services, caps, context }, { id: courseId, taskId }) {
  render(el, loading)
  let course, task, rubrics, cohorts
  const load = async () => {
    task = await services.tasks.get(taskId)
  }
  try {
    course = await loadManagedCourse(services, courseId)
    if (!course) return render(el, accessDenied())
    await load()
    if (!task || task.course_id !== courseId) return render(el, accessDenied())
    ;[rubrics, cohorts] = await Promise.all([
      services.quizzes.listForCourse(courseId, 'rubric'),
      services.assignments.listCohortsForCourse(courseId),
    ])
    cohorts = cohorts.filter((c) => canAssessHint(caps, context, c.id))
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  const options = rubricOptions(rubrics)
  let message = null
  let tone = 'success'
  let busy = false

  const allocations = () =>
    [...(task.task_allocations ?? [])].sort((a, b) => a.cohorts.code.localeCompare(b.cohorts.code))

  const allocationRow = (
    a
  ) => html`<form data-form="allocation" data-id="${a.id}" class="grid gap-3 rounded-lg border border-ink-100 p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
    <p class="font-medium text-ink-800 sm:self-center">${cohortLabel(a.cohorts)}</p>
    ${dateField(`available_at_${a.id}`, 'เปิดรับงาน', a.available_at)}
    ${dateField(`due_at_${a.id}`, 'กำหนดส่ง', a.due_at)}
    <div class="flex gap-2">
      <button class="${secondary}" type="submit">บันทึกวัน</button>
      <button class="${danger}" type="button" data-action="remove-allocation" data-id="${a.id}">เลิกเปิด</button>
    </div>
  </form>`

  const allocationPanel = () => {
    if (task.status !== 'published')
      return html`<section class="rounded-xl border border-ink-200 bg-white p-5 text-sm text-ink-600" data-allocations>
        <h2 class="font-semibold text-ink-800">เปิดให้รุ่น</h2>
        <p class="mt-2">เผยแพร่ภาระงานก่อน จึงเปิดให้รุ่นได้ (ผู้เรียนเห็นเฉพาะภาระงานที่เผยแพร่และเปิดให้รุ่นของตนแล้ว)</p>
      </section>`
    const rest = cohortsLeft(cohorts, task.task_allocations ?? [])
    return html`<section class="space-y-3 rounded-xl border border-ink-200 bg-white p-5 text-sm" data-allocations>
      <h2 class="font-semibold text-ink-800">เปิดให้รุ่น</h2>
      ${
        allocations().length
          ? html`<div class="space-y-2">${allocations().map(allocationRow)}</div>`
          : html`<p class="text-ink-500">ยังไม่ได้เปิดให้รุ่นใด</p>`
      }
      ${
        rest.length
          ? html`<form data-form="new-allocation" class="grid gap-3 rounded-lg border border-dashed border-ink-200 p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <label class="${label}"
                >รุ่น
                <select name="cohort_id" required class="${input}">
                  ${rest.map((c) => html`<option value="${c.id}">${cohortLabel(c)} — ${c.program_name}</option>`)}
                </select>
              </label>
              ${dateField('available_at', 'เปิดรับงาน (ไม่บังคับ)', '')}
              ${dateField('due_at', 'กำหนดส่ง (ไม่บังคับ)', '')}
              <button class="${primary}" type="submit">เปิดให้รุ่น</button>
            </form>`
          : html`<p class="text-xs text-ink-500">
              ${cohorts.length ? 'เปิดให้ทุกรุ่นที่ท่านดูแลแล้ว' : 'ไม่พบรุ่นที่ท่านเปิดให้ได้ (รุ่นต้องอยู่ในโปรแกรมที่มีหลักสูตรนี้ และท่านเป็นวิทยากร/ผู้ประสานงานของรุ่น)'}
            </p>`
      }
      <p class="text-xs text-ink-500">ส่งช้าได้ แต่ระบบจะติดป้าย “ส่งช้า” ให้ผู้ตรวจเห็น</p>
    </section>`
  }

  const statusButtons = () => {
    if (task.status === 'draft')
      return html`<button type="button" class="${primary}" data-action="set-status" data-status="published">เผยแพร่</button>`
    if (task.status === 'published')
      return html`<button type="button" class="${secondary}" data-action="set-status" data-status="draft">ซ่อน (ย้อนเป็นร่าง)</button>
        <button type="button" class="${secondary}" data-action="set-status" data-status="archived">เก็บถาวร</button>`
    return html`<button type="button" class="${secondary}" data-action="set-status" data-status="published">เผยแพร่อีกครั้ง</button>`
  }

  const draw = () =>
    render(
      el,
      html`<a href="#/courses/${courseId}/tasks" class="${backLink}">← ภาระงานของหลักสูตร</a>
        <div class="mt-3 flex flex-wrap items-start justify-between gap-3">
          ${pageHeader(task.title, course.title)}
          <div class="flex flex-wrap items-center gap-2" data-status-bar>${statusBadge(task.status)} ${statusButtons()}</div>
        </div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <div class="space-y-4">
          <form data-form="task" class="grid gap-4 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2">
            ${taskFields(task, options)}
            <div class="flex flex-wrap gap-2 sm:col-span-2">
              <button class="${primary}" type="submit">บันทึกการตั้งค่า</button>
              ${
                task.status === 'draft' && !(task.task_allocations ?? []).length
                  ? html`<button class="${danger}" type="button" data-action="delete-task">ลบภาระงาน</button>`
                  : ''
              }
            </div>
          </form>
          ${allocationPanel()}
          <p class="text-xs text-ink-500">สร้างเมื่อ ${formatThaiDateTime(task.created_at)}</p>
        </div>`
    )

  const run = async (fn, okMessage) => {
    if (busy) return
    busy = true
    try {
      await fn()
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

  el.onsubmit = (e) => {
    e.preventDefault()
    const form = e.target
    const kind = form.dataset.form
    const f = Object.fromEntries(new FormData(form))
    try {
      if (kind === 'task') {
        const patch = buildTaskPayload(f)
        return run(() => services.tasks.update(task.id, patch), 'บันทึกการตั้งค่าแล้ว')
      }
      if (kind === 'new-allocation') {
        const dates = buildAllocationPayload(f)
        return run(() => services.tasks.addAllocation(task.id, f.cohort_id, dates), 'เปิดภาระงานให้รุ่นแล้ว')
      }
      if (kind === 'allocation') {
        const id = form.dataset.id
        const dates = buildAllocationPayload({
          available_at: f[`available_at_${id}`],
          due_at: f[`due_at_${id}`],
        })
        return run(() => services.tasks.updateAllocation(id, dates), 'บันทึกวันที่แล้ว')
      }
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
      draw()
    }
    return undefined
  }

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return undefined
    const { action, status, id } = b.dataset
    if (action === 'set-status') {
      return run(
        () => services.tasks.update(task.id, { status }),
        `เปลี่ยนสถานะเป็น “${{ draft: 'ร่าง', published: 'เผยแพร่', archived: 'เก็บถาวร' }[status]}” แล้ว`
      )
    }
    if (action === 'remove-allocation') {
      if (!window.confirm('เลิกเปิดภาระงานนี้ให้รุ่นนี้? (ทำได้เฉพาะเมื่อยังไม่มีผู้เริ่มส่งงาน)'))
        return undefined
      return run(() => services.tasks.removeAllocation(id), 'เลิกเปิดให้รุ่นแล้ว')
    }
    if (action === 'delete-task') {
      if (!window.confirm('ลบภาระงานฉบับร่างนี้?')) return undefined
      return (async () => {
        try {
          await services.tasks.remove(task.id)
          navigate(`/courses/${courseId}/tasks`)
        } catch (err) {
          message = toUserMessage(err)
          tone = 'error'
          draw()
        }
      })()
    }
    return undefined
  }

  watchDateLabels(el)
  draw()
}

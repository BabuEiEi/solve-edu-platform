import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, loading } from '../../shared/ui/components.js'
import { confirmDialog } from '../../shared/ui/dialog.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDate, formatThaiDateTime } from '../../shared/utils/date.js'
import { dateField, watchDateLabels } from '../assignments/views.js'
import {
  COHORT_STATUS,
  ENROLLMENT_MODES,
  PROGRAM_STATUS,
  buildCohortPayload,
  buildProgramPayload,
  currentFiscalYear,
  joiningHint,
  ownerOrgChoices,
} from './logic.js'

// #/programs · #/programs/new · #/programs/:id — programmes, their courses and
// cohorts (Phase 4g). Buttons are offered to programme managers and Staff
// (caps.canAdministerPrograms); the database decides every write.

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary =
  'rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-60'
const backLink = 'text-sm text-brand-700 hover:underline'

const TONE = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  open: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  in_progress: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  approval: 'bg-amber-50 text-amber-800 ring-amber-600/20',
}
const chip = (key, text) =>
  html`<span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
      TONE[key] ?? 'bg-slate-100 text-slate-600 ring-slate-500/20'
    }"
    >${text}</span
  >`
const programChip = (s) => chip(s, PROGRAM_STATUS[s] ?? s)
const cohortChip = (s) => chip(s, COHORT_STATUS[s] ?? s)
const MODE_SHORT = {
  closed: 'ปิดรับสมัคร',
  approval: 'รับสมัคร: ต้องอนุมัติ',
  open: 'รับสมัคร: เข้าได้ทันที',
}
const modeChip = (m) => chip(m, MODE_SHORT[m] ?? m)
const options = (map, current) =>
  Object.entries(map).map(
    ([v, t]) => html`<option value="${v}" ${v === current ? html`selected` : ''}>${t}</option>`
  )
const fieldsOf = (form) => Object.fromEntries(new FormData(form).entries())

// =====================================================================
// #/programs — the list
// =====================================================================
export async function renderProgramsView(el, { services, caps }) {
  render(el, html`${pageHeader('โครงการและรุ่น')}${loading}`)
  try {
    const programs = await services.programs.listVisiblePrograms()
    const can = Boolean(caps?.canAdministerPrograms)
    render(
      el,
      html`
        <div class="flex flex-wrap items-start justify-between gap-3">
          ${pageHeader('โครงการและรุ่น', 'โครงการที่ท่านบริหารหรือเข้าร่วม')}
          ${can ? html`<a href="#/programs/new" class="${primary}" data-action-link="new-program">สร้างโครงการ</a>` : ''}
        </div>
        ${
          programs.length === 0
            ? emptyState('ยังไม่มีโครงการที่ท่านเข้าถึงได้')
            : html`<div class="space-y-4" data-programs>
                ${programs.map(
                  (p) =>
                    html`<article class="rounded-xl border border-ink-200 bg-white p-6" data-program-id="${p.id}">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p class="text-xs font-semibold uppercase tracking-wide text-brand-600">
                            ปีงบประมาณ ${p.fiscal_year} · ${p.code}
                          </p>
                          <h2 class="mt-1 text-lg font-semibold text-ink-900">
                            ${can ? html`<a href="#/programs/${p.id}" class="hover:underline">${p.name}</a>` : p.name}
                          </h2>
                          <p class="text-sm text-ink-500">${p.organizations?.name ?? ''}</p>
                        </div>
                        ${programChip(p.status)}
                      </div>
                      ${p.description ? html`<p class="mt-3 text-sm text-ink-600">${p.description}</p>` : ''}
                      ${
                        (p.cohorts ?? []).length
                          ? html`<ul class="mt-4 divide-y divide-ink-100 rounded-lg border border-ink-100">
                              ${p.cohorts.map(
                                (c) =>
                                  html`<li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                                    <span class="font-medium text-ink-800"
                                      >${c.name} <span class="text-ink-400">(${c.code})</span></span
                                    >
                                    <span class="flex flex-wrap items-center gap-2 text-ink-500"
                                      >${formatThaiDate(c.start_at)} – ${formatThaiDate(c.end_at)} ${cohortChip(c.status)}
                                      ${can ? modeChip(c.enrollment_mode) : ''}</span
                                    >
                                  </li>`
                              )}
                            </ul>`
                          : ''
                      }
                    </article>`
                )}
              </div>`
        }
      `
    )
  } catch (err) {
    render(el, html`${pageHeader('โครงการและรุ่น')}${alertBox(toUserMessage(err))}`)
  }
}

// =====================================================================
// shared form pieces
// =====================================================================
const programFields = (p, { owners = null } = {}) => html`
  <label class="${label}"
    >รหัสโครงการ<input name="code" required maxlength="50" value="${p.code ?? ''}" placeholder="เช่น AFL-2570" class="${input}"
  /></label>
  <label class="${label}"
    >ปีงบประมาณ (พ.ศ.)<input
      name="fiscal_year"
      type="number"
      min="2500"
      max="2700"
      required
      value="${p.fiscal_year ?? currentFiscalYear()}"
      class="${input}"
  /></label>
  <label class="${label} sm:col-span-2"
    >ชื่อโครงการ<input name="name" required maxlength="300" value="${p.name ?? ''}" class="${input}"
  /></label>
  ${
    owners
      ? html`<label class="${label} sm:col-span-2"
          >หน่วยงานเจ้าของโครงการ<select name="owner_org_id" required class="${input}">
            <option value="">— เลือก —</option>
            ${owners.map(
              (o) =>
                html`<option value="${o.id}" ${o.id === p.owner_org_id ? html`selected` : ''}>${o.name}</option>`
            )}
          </select></label
        >`
      : ''
  }
  <label class="${label} sm:col-span-2"
    >รายละเอียด<textarea name="description" rows="3" maxlength="5000" class="${input}">${p.description ?? ''}</textarea></label
  >
  <label class="${label}">สถานะ<select name="status" class="${input}">${options(PROGRAM_STATUS, p.status ?? 'draft')}</select></label>
  <span></span>
  ${dateField('start_at', 'วันเริ่มโครงการ', p.start_at)} ${dateField('end_at', 'วันสิ้นสุดโครงการ', p.end_at)}
`

const cohortFields = (c) => html`
  <label class="${label}"
    >รหัสรุ่น<input name="code" required maxlength="50" value="${c.code ?? ''}" placeholder="เช่น C1" class="${input}"
  /></label>
  <label class="${label}"
    >ชื่อรุ่น<input name="name" required maxlength="300" value="${c.name ?? ''}" placeholder="เช่น รุ่นที่ 1/2570" class="${input}"
  /></label>
  <label class="${label}">สถานะ<select name="status" class="${input}">${options(COHORT_STATUS, c.status ?? 'draft')}</select></label>
  <span></span>
  ${dateField('start_at', 'วันเริ่มรุ่น', c.start_at)} ${dateField('end_at', 'วันจบรุ่น', c.end_at)}
  <fieldset class="rounded-lg border border-ink-200 p-3 sm:col-span-2">
    <legend class="px-1 text-sm font-medium text-ink-700">การสมัครเข้ารุ่นด้วยตนเอง</legend>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="${label} sm:col-span-2"
        >การรับสมัคร<select name="enrollment_mode" class="${input}" data-enrollment-mode>
          ${options(ENROLLMENT_MODES, c.enrollment_mode ?? 'closed')}
        </select></label
      >
      <label class="${label}"
        >จำนวนที่นั่ง (เว้นว่าง = ไม่จำกัด)<input
          name="seat_limit"
          type="number"
          min="1"
          max="10000"
          value="${c.seat_limit ?? ''}"
          class="${input}"
      /></label>
      <span></span>
      ${dateField('enroll_from', 'เปิดรับสมัครตั้งแต่ (ไม่บังคับ)', c.enroll_from)}
      ${dateField('enroll_until', 'ปิดรับสมัคร (ไม่บังคับ)', c.enroll_until)}
    </div>
  </fieldset>
`

// =====================================================================
// #/programs/new
// =====================================================================
export async function renderNewProgramView(el, { services, caps, context }) {
  render(el, html`${pageHeader('สร้างโครงการ')}${loading}`)
  if (!caps?.canAdministerPrograms)
    return render(
      el,
      html`<a href="#/programs" class="${backLink}">← โครงการและรุ่น</a>${pageHeader('สร้างโครงการ')}${emptyState('ท่านไม่มีสิทธิ์สร้างโครงการ')}`
    )
  let owners
  try {
    owners = ownerOrgChoices((await services.organizations.listActiveOrganizations()) ?? [], context, caps)
  } catch (err) {
    return render(el, html`${pageHeader('สร้างโครงการ')}${alertBox(toUserMessage(err))}`)
  }
  let message = null
  const draw = (values = {}) =>
    render(
      el,
      html`<a href="#/programs" class="${backLink}">← โครงการและรุ่น</a>
        <div class="mt-3">${pageHeader('สร้างโครงการ', 'สร้างแล้วเพิ่มหลักสูตรและรุ่นได้ในหน้าถัดไป')}</div>
        <form data-form="program-new" class="grid gap-4 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2">
          ${message ? html`<div class="sm:col-span-2">${alertBox(message)}</div>` : ''} ${programFields(values, { owners })}
          <div class="sm:col-span-2"><button type="submit" class="${primary}">สร้างโครงการ</button></div>
        </form>`
    )
  draw()
  watchDateLabels(el)
  el.onsubmit = async (e) => {
    e.preventDefault()
    const form = e.target
    const values = fieldsOf(form)
    form.querySelector('button[type=submit]').disabled = true
    try {
      const created = await services.programs.createProgram(buildProgramPayload(values, { isNew: true }))
      window.location.hash = `#/programs/${created.id}`
    } catch (err) {
      message = toUserMessage(err)
      draw(values) // keep what was typed
    }
  }
  return undefined
}

// =====================================================================
// #/programs/:id — edit, courses, cohorts
// =====================================================================
export async function renderProgramDetailView(el, { services, caps }, { id }) {
  render(el, html`${pageHeader('โครงการ')}${loading}`)
  let program, courses
  let message = null
  let tone = 'success'
  let editing = null // 'program' | 'new-cohort' | a cohort id
  let formError = ''
  let typed = null // what was typed in the open form, kept when a save is refused
  let busy = false

  const load = async () => {
    ;[program, courses] = await Promise.all([
      services.programs.getProgram(id),
      services.programs.listCourses(),
    ])
  }
  try {
    await load()
  } catch (err) {
    return render(el, html`${pageHeader('โครงการ')}${alertBox(toUserMessage(err))}`)
  }
  if (!program)
    return render(
      el,
      html`<a href="#/programs" class="${backLink}">← โครงการและรุ่น</a>${pageHeader('ไม่พบโครงการ')}${emptyState('ไม่พบโครงการนี้ หรือท่านไม่มีสิทธิ์')}`
    )
  const can = Boolean(caps?.canAdministerPrograms)

  const linked = () =>
    [...(program.program_courses ?? [])].sort(
      (a, b) =>
        a.display_order - b.display_order ||
        String(a.courses?.title).localeCompare(String(b.courses?.title), 'th')
    )
  const addable = () => {
    const have = new Set(linked().map((pc) => pc.course_id))
    return (courses ?? []).filter((c) => !have.has(c.id))
  }
  const cohorts = () =>
    [...(program.cohorts ?? [])].sort((a, b) => String(a.code).localeCompare(String(b.code), 'th'))
  const errorBox = () => (formError ? html`<div class="sm:col-span-2">${alertBox(formError)}</div>` : '')
  const formButtons = (text) => html`<div class="flex gap-2 sm:col-span-2">
    <button type="submit" class="${primary}">${text}</button>
    <button type="button" class="${secondary}" data-action="cancel">ยกเลิก</button>
  </div>`

  const programSection = () =>
    editing === 'program'
      ? html`<form data-form="program-edit" class="grid gap-4 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2">
          ${errorBox()} ${programFields({ ...program, ...typed })} ${formButtons('บันทึกโครงการ')}
        </form>`
      : html`<section class="rounded-xl border border-ink-200 bg-white p-5" data-program-info>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <dl class="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div><dt class="inline text-ink-500">ปีงบประมาณ</dt> <dd class="inline font-medium text-ink-800">${program.fiscal_year}</dd></div>
              <div>
                <dt class="inline text-ink-500">หน่วยงาน</dt>
                <dd class="inline font-medium text-ink-800">${program.organizations?.name ?? '—'}</dd>
              </div>
              <div>
                <dt class="inline text-ink-500">ช่วงเวลา</dt>
                <dd class="inline text-ink-800">${formatThaiDate(program.start_at)} – ${formatThaiDate(program.end_at)}</dd>
              </div>
              <div><dt class="inline text-ink-500">สถานะ</dt> <dd class="inline">${programChip(program.status)}</dd></div>
            </dl>
            ${can ? html`<button type="button" class="${secondary}" data-action="edit-program">แก้ไขโครงการ</button>` : ''}
          </div>
          ${program.description ? html`<p class="mt-3 text-sm text-ink-600">${program.description}</p>` : ''}
        </section>`

  const coursesSection = () => html`<section
    class="rounded-xl border border-ink-200 bg-white p-5"
    data-program-courses
    aria-labelledby="courses-title"
  >
    <h2 id="courses-title" class="text-base font-semibold text-ink-900">หลักสูตรในโครงการ</h2>
    <p class="mt-1 text-xs text-ink-500">ผู้เข้าอบรมของรุ่นในโครงการนี้ลงทะเบียนได้เฉพาะหลักสูตรในรายการนี้ (ทีละหลักสูตร)</p>
    ${
      linked().length
        ? html`<ul class="mt-3 divide-y divide-ink-100 rounded-lg border border-ink-100">
            ${linked().map(
              (
                pc
              ) => html`<li class="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm" data-course-id="${pc.course_id}">
                <span class="text-ink-800"
                  >${pc.courses?.title ?? '(หลักสูตรที่ท่านมองไม่เห็น)'}
                  ${
                    pc.courses && pc.courses.status !== 'published'
                      ? html`<span class="ml-1 text-xs text-amber-700">ยังไม่เผยแพร่ — ผู้เรียนลงทะเบียนเองไม่ได้</span>`
                      : ''
                  }</span
                >
                ${
                  can
                    ? html`<button type="button" class="text-xs text-rose-700 hover:underline" data-action="remove-course" data-id="${pc.course_id}">นำออก</button>`
                    : ''
                }
              </li>`
            )}
          </ul>`
        : html`<p class="mt-3 text-sm text-ink-500">ยังไม่มีหลักสูตร</p>`
    }
    ${
      can && addable().length
        ? html`<form data-form="add-course" class="mt-3 flex flex-wrap items-end gap-2">
            <label class="${label} min-w-0 flex-1 basis-60"
              >เพิ่มหลักสูตร<select name="course_id" class="${input}" required>
                <option value="">— เลือกหลักสูตร —</option>
                ${addable().map(
                  (c) =>
                    html`<option value="${c.id}">${c.title}${c.status !== 'published' ? ' (ร่าง)' : ''}</option>`
                )}
              </select></label
            >
            <button type="submit" class="${secondary}">เพิ่ม</button>
          </form>`
        : ''
    }
  </section>`

  const cohortRow = (c) => {
    if (editing === c.id)
      return html`<li class="p-4">
        <form data-form="cohort-edit" data-id="${c.id}" class="grid gap-4 sm:grid-cols-2">
          ${errorBox()} ${cohortFields({ ...c, ...typed })} ${formButtons('บันทึกรุ่น')}
        </form>
      </li>`
    const hint = joiningHint(program, c)
    return html`<li class="space-y-2 px-4 py-3 text-sm" data-cohort-id="${c.id}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-medium text-ink-800">${c.name} <span class="text-ink-400">(${c.code})</span></span>
        <span class="flex flex-wrap items-center gap-2 text-ink-500"
          >${formatThaiDate(c.start_at)} – ${formatThaiDate(c.end_at)} ${cohortChip(c.status)} ${modeChip(c.enrollment_mode)}</span
        >
      </div>
      <p class="text-xs ${hint.open ? 'text-emerald-700' : 'text-ink-500'}" data-joining-hint>
        ${hint.text}${c.seat_limit ? ` · ${c.seat_limit} ที่นั่ง` : ''}${c.enroll_until ? ` · ปิดรับ ${formatThaiDateTime(c.enroll_until)}` : ''}
      </p>
      <div class="flex flex-wrap gap-2">
        <a href="#/programs/${program.id}/cohorts/${c.id}" class="${secondary}" data-action-link="members">สมาชิกและการลงทะเบียน</a>
        ${can ? html`<button type="button" class="${secondary}" data-action="edit-cohort" data-id="${c.id}">แก้ไขรุ่น</button>` : ''}
      </div>
    </li>`
  }

  const cohortsSection =
    () => html`<section class="rounded-xl border border-ink-200 bg-white p-5" data-cohorts aria-labelledby="cohorts-title">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="cohorts-title" class="text-base font-semibold text-ink-900">รุ่น</h2>
      ${can && editing !== 'new-cohort' ? html`<button type="button" class="${secondary}" data-action="new-cohort">เพิ่มรุ่น</button>` : ''}
    </div>
    ${
      editing === 'new-cohort'
        ? html`<form data-form="cohort-new" class="mt-3 grid gap-4 rounded-lg border border-brand-200 bg-brand-50/30 p-4 sm:grid-cols-2">
            ${errorBox()} ${cohortFields(typed ?? {})} ${formButtons('สร้างรุ่น')}
          </form>`
        : ''
    }
    ${
      cohorts().length
        ? html`<ul class="mt-3 divide-y divide-ink-100 rounded-lg border border-ink-100">${cohorts().map(cohortRow)}</ul>`
        : html`<p class="mt-3 text-sm text-ink-500">ยังไม่มีรุ่น</p>`
    }
  </section>`

  const draw = () =>
    render(
      el,
      html`<a href="#/programs" class="${backLink}">← โครงการและรุ่น</a>
        <div class="mt-3">${pageHeader(program.name, program.code)}</div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <div class="space-y-4">${programSection()} ${coursesSection()} ${cohortsSection()}</div>`
    )

  const open = (what) => {
    editing = what
    formError = ''
    typed = null
    message = null
    draw()
  }

  /** Save, reload, close the form; a refusal stays in the open form (or above, for list actions). */
  const run = async (fn, ok, values = null) => {
    if (busy) return
    busy = true
    try {
      await fn()
      await load()
      message = ok
      tone = 'success'
      editing = null
      formError = ''
      typed = null
    } catch (err) {
      if (editing) {
        formError = toUserMessage(err)
        typed = values
      } else {
        message = toUserMessage(err)
        tone = 'error'
      }
    } finally {
      busy = false
      draw()
    }
  }

  draw()
  watchDateLabels(el)

  el.onclick = async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b) return undefined
    const action = b.dataset.action
    if (action === 'edit-program') return open('program')
    if (action === 'new-cohort') return open('new-cohort')
    if (action === 'edit-cohort') return open(b.dataset.id)
    if (action === 'cancel') return open(null)
    if (action === 'remove-course') {
      const pc = linked().find((x) => x.course_id === b.dataset.id)
      const ok = await confirmDialog({
        title: `นำหลักสูตร “${pc?.courses?.title ?? ''}” ออกจากโครงการ?`,
        text: 'ผู้ที่ลงทะเบียนไว้แล้วยังเรียนต่อได้ แต่จะลงทะเบียนหลักสูตรนี้ผ่านโครงการนี้เพิ่มไม่ได้',
        confirmText: 'นำออก',
        danger: true,
      })
      if (!ok) return undefined
      return run(
        () => services.programs.removeCourse(program.id, b.dataset.id),
        'นำหลักสูตรออกจากโครงการแล้ว'
      )
    }
    return undefined
  }

  el.onsubmit = async (e) => {
    e.preventDefault()
    const form = e.target
    const kind = form.dataset.form
    const values = fieldsOf(form)
    const cohortId = form.dataset.id
    if (kind === 'add-course') {
      const order = Math.max(0, ...linked().map((pc) => pc.display_order)) + 1
      return run(
        () => services.programs.addCourse(program.id, values.course_id, order),
        'เพิ่มหลักสูตรในโครงการแล้ว'
      )
    }
    let payload
    try {
      payload = kind === 'program-edit' ? buildProgramPayload(values) : buildCohortPayload(values)
    } catch (err) {
      formError = toUserMessage(err)
      typed = values
      return draw()
    }
    if (kind === 'program-edit')
      return run(() => services.programs.updateProgram(program.id, payload), 'บันทึกโครงการแล้ว', values)
    if (kind === 'cohort-new')
      return run(() => services.programs.createCohort(program.id, payload), 'สร้างรุ่นแล้ว', values)
    if (kind === 'cohort-edit')
      return run(() => services.programs.updateCohort(cohortId, payload), 'บันทึกรุ่นแล้ว', values)
    return undefined
  }
  return undefined
}

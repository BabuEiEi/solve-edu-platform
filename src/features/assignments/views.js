import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { toCsv } from '../../shared/utils/csv.js'
import { downloadText } from '../../shared/ui/download.js'
import { PURPOSE_LABELS, attemptPercent } from '../assessments/logic.js'
import { purposeChip, resultBadge, windowText, timeLimitText } from '../assessments/views.js'
import {
  ATTEMPT_LIMIT_MAX,
  TIME_LIMIT_MAX,
  GRACE_MAX,
  GRACE_DEFAULT,
  toBangkokInput,
  bangkokInputLabel,
  buildAssignmentPayload,
  canAssessHint,
  traineeOnlyCohorts,
  summarizeResults,
  resultsCsvRows,
} from './logic.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:bg-ink-50 disabled:text-ink-400'
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary =
  'rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-60'
const danger = 'rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-rose-700 hover:bg-rose-50'
const backLink = 'text-sm text-brand-700 hover:underline'

const LIST_PATH = '/staff/assessments'
const cohortLabel = (c) => (c ? `${c.name} (${c.code})` : '—')
const versionText = (v) =>
  v ? `${v.instruments?.title ?? 'แบบทดสอบ'} · ฉบับที่ ${v.version_no}` : 'แบบทดสอบ'

/** datetime-local + its value echoed as พ.ศ. (kept current by watchDateLabels). */
function dateField(name, text, value) {
  const v = toBangkokInput(value)
  return html`<label class="${label}"
    >${text}<input name="${name}" type="datetime-local" value="${v}" class="${input}" />
    <span class="mt-1 block text-xs font-normal text-ink-500" data-date-label="${name}" aria-live="polite"
      >${bangkokInputLabel(v)}</span
    >
  </label>`
}

function watchDateLabels(el) {
  el.oninput = (e) => {
    const name = e.target.matches?.('input[type=datetime-local]') ? e.target.name : null
    const out = name && e.target.form?.querySelector(`[data-date-label="${name}"]`)
    if (out) out.textContent = bangkokInputLabel(e.target.value)
  }
}

/** Settings shared by "create" and "edit". `locked`: an attempt exists (server freezes purpose / pass mark). */
function settingsFields(a, { locked = false } = {}) {
  return html`<label class="${label} sm:col-span-2"
      >ชื่อที่ผู้เรียนเห็น<input name="title" required maxlength="300" value="${a.title ?? ''}" class="${input}"
    /></label>
    <label class="${label}"
      >ประเภท
      <select name="purpose" class="${input}" ${locked ? html`disabled` : ''}>
        ${Object.entries(PURPOSE_LABELS).map(
          ([v, l]) => html`<option value="${v}" ${a.purpose === v ? html`selected` : ''}>${l}</option>`
        )}
      </select>
    </label>
    <label class="${label}"
      >เกณฑ์ผ่าน (%)
      <input
        name="passing_percent"
        type="number"
        min="0"
        max="100"
        step="0.01"
        value="${a.passing_percent === null || a.passing_percent === undefined || a.passing_percent === '' ? '' : Number(a.passing_percent)}"
        placeholder="เว้นว่าง = ไม่ตัดสินผ่าน/ไม่ผ่าน"
        class="${input}"
        ${locked ? html`disabled` : ''}
      />
    </label>
    ${dateField('open_at', 'เปิดให้ทำ (เวลาไทย)', a.open_at)} ${dateField('close_at', 'ปิดรับ (เวลาไทย)', a.close_at)}
    <label class="${label}"
      >จำนวนครั้งที่ทำได้
      <input
        name="attempt_limit"
        type="number"
        min="1"
        max="${ATTEMPT_LIMIT_MAX}"
        step="1"
        required
        value="${a.attempt_limit ?? 1}"
        class="${input}"
      />
    </label>
    <p class="self-end text-xs text-ink-500">
      เว้นเวลาเปิด/ปิดว่างได้ (ไม่จำกัดช่วงเวลา) · การกดเริ่มทำนับเป็น 1 ครั้งทันที
    </p>
    <label class="${label}"
      >เวลาทำต่อครั้ง (นาที)
      <input
        name="time_limit_minutes"
        type="number"
        min="1"
        max="${TIME_LIMIT_MAX}"
        step="1"
        value="${a.time_limit_minutes ?? ''}"
        placeholder="เว้นว่าง = ใช้แค่ช่วงเปิด–ปิด"
        class="${input}"
        ${locked ? html`disabled` : ''}
      />
    </label>
    <label class="${label}"
      >ช่วงผ่อนผันหลังหมดเวลา (นาที)
      <input
        name="grace_minutes"
        type="number"
        min="0"
        max="${GRACE_MAX}"
        step="1"
        value="${a.grace_minutes ?? GRACE_DEFAULT}"
        class="${input}"
      />
    </label>
    <p class="text-xs text-ink-500 sm:col-span-2">
      เวลาทำนับจากที่ผู้เรียนกดเริ่ม และไม่เกินเวลาปิดรับ · เมื่อหมดเวลา ระบบส่งคำตอบที่บันทึกไว้ให้อัตโนมัติ ·
      ช่วงผ่อนผันกันเน็ตช้าตอนกดส่ง (ผู้เรียนไม่เห็นเวลาส่วนนี้)
    </p>
    ${
      locked
        ? html`<p class="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600 sm:col-span-2">
            มีผู้เริ่มทำแล้ว จึงแก้ประเภท เกณฑ์ผ่าน และเวลาทำไม่ได้ เพื่อให้ทุกคนสอบภายใต้เงื่อนไขเดียวกัน
            (แก้ช่วงเวลาเปิด–ปิด จำนวนครั้ง ช่วงผ่อนผัน ชื่อ และคำชี้แจงได้)
          </p>`
        : ''
    }
    <label class="${label} sm:col-span-2"
      >คำชี้แจง (ไม่บังคับ)<textarea name="instructions" rows="3" maxlength="5000" class="${input}">${a.instructions ?? ''}</textarea>
    </label>`
}

// =====================================================================
// #/staff/assessments — assignments the caller runs or follows
// =====================================================================
export async function renderStaffAssessmentsView(el, { services, context }) {
  render(el, html`${pageHeader('ผลแบบทดสอบ')}${loading}`)
  let rows
  try {
    const hidden = traineeOnlyCohorts(context)
    rows = (await services.assignments.listVisible()).filter((a) => !hidden.has(a.cohort_id))
  } catch (err) {
    return render(el, html`${pageHeader('ผลแบบทดสอบ')}${alertBox(toUserMessage(err))}`)
  }
  render(
    el,
    html`${pageHeader('ผลแบบทดสอบ', 'แบบทดสอบที่มอบหมายให้รุ่นที่ท่านดูแล — ตั้งค่า ติดตาม และดาวน์โหลดผล')}
    ${
      rows.length === 0
        ? emptyState(
            'ยังไม่มีแบบทดสอบที่มอบหมาย — เริ่มจากหน้า “แบบทดสอบ” ของหลักสูตร แล้วกด “มอบหมายให้รุ่น”'
          )
        : html`<ul class="space-y-3">
            ${rows.map(
              (a) => html`<li>
                <a
                  href="#${LIST_PATH}/${a.id}"
                  class="block rounded-xl border border-ink-200 bg-white p-5 transition hover:border-brand-300"
                  data-assignment-id="${a.id}"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    ${purposeChip(a.purpose)} ${statusBadge(a.status)}
                    <span class="text-xs text-ink-500">${cohortLabel(a.cohorts)}</span>
                  </div>
                  <p class="mt-2 font-semibold text-ink-900">${a.title}</p>
                  <p class="mt-1 text-sm text-ink-500">
                    ${versionText(a.instrument_versions)}${a.courses?.title ? ` · ${a.courses.title}` : ''}
                  </p>
                  <p class="mt-1 text-sm text-ink-500">${windowText(a)}</p>
                </a>
              </li>`
            )}
          </ul>`
    }`
  )
}

// =====================================================================
// #/staff/assessments/new/:versionId — assign a published version
// =====================================================================
export async function renderNewAssignmentView(el, { services, caps, context }, { versionId }) {
  render(el, loading)
  let version, cohorts
  try {
    version = await services.assignments.getVersion(versionId)
    const courseId = version?.instruments?.course_id
    cohorts = courseId
      ? (await services.assignments.listCohortsForCourse(courseId)).filter((c) =>
          canAssessHint(caps, context, c.id)
        )
      : []
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  const instrument = version?.instruments
  const back = instrument?.course_id
    ? html`<a href="#/courses/${instrument.course_id}/quizzes/${instrument.id}" class="${backLink}"
        >← ${instrument.title}</a
      >`
    : html`<a href="#${LIST_PATH}" class="${backLink}">← ผลแบบทดสอบ</a>`

  if (!version)
    return render(el, html`${pageHeader('ไม่พบแบบทดสอบ')}${emptyState('ไม่พบฉบับนี้ หรือท่านไม่มีสิทธิ์')}`)
  if (version.status !== 'published')
    return render(
      el,
      html`${back}${pageHeader('ยังมอบหมายไม่ได้')}${emptyState('มอบหมายได้เฉพาะฉบับที่เผยแพร่แล้ว')}`
    )

  let message = null
  let values = { title: instrument.title, purpose: 'pretest', attempt_limit: 1, passing_percent: null }

  const draw = () =>
    render(
      el,
      html`${back}
        <div class="mt-3">${pageHeader('มอบหมายให้รุ่น', `${instrument.title} · ฉบับที่ ${version.version_no}`)}</div>
        ${
          cohorts.length === 0
            ? emptyState(
                'ไม่พบรุ่นที่ท่านมอบหมายได้ (รุ่นต้องอยู่ในโครงการที่มีหลักสูตรนี้ และท่านเป็นวิทยากร/ผู้ประสานงานของรุ่น)'
              )
            : html`<form data-form="assignment" class="grid gap-4 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2">
                ${message ? html`<div class="sm:col-span-2">${alertBox(message)}</div>` : ''}
                <label class="${label} sm:col-span-2"
                  >รุ่น
                  <select name="cohort_id" required class="${input}">
                    ${cohorts.map(
                      (c) =>
                        html`<option value="${c.id}" ${values.cohort_id === c.id ? html`selected` : ''}>
                          ${cohortLabel(c)} — ${c.program_name}
                        </option>`
                    )}
                  </select>
                </label>
                ${settingsFields(values)}
                <div class="flex flex-wrap gap-2 sm:col-span-2">
                  <button class="${primary}" type="submit" name="intent" value="published">บันทึกและเผยแพร่</button>
                  <button class="${secondary}" type="submit" name="intent" value="draft">บันทึกเป็นร่าง</button>
                </div>
              </form>`
        }`
    )

  watchDateLabels(el)
  el.onsubmit = async (e) => {
    e.preventDefault()
    const form = e.target
    const fields = Object.fromEntries(new FormData(form))
    values = { ...values, ...fields }
    const status = e.submitter?.value === 'draft' ? 'draft' : 'published'
    form.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      const created = await services.assignments.create({
        ...buildAssignmentPayload(fields),
        versionId: version.id,
        cohortId: fields.cohort_id,
        courseId: instrument.course_id,
        status,
      })
      navigate(`${LIST_PATH}/${created.id}`)
    } catch (err) {
      message = toUserMessage(err)
      draw()
    }
  }

  draw()
}

// =====================================================================
// #/staff/assessments/:id — settings + cohort results
// =====================================================================
const statCard = (title, value, note = '') =>
  html`<div class="rounded-xl border border-ink-200 bg-white px-4 py-3">
    <p class="text-xs text-ink-500">${title}</p>
    <p class="mt-1 text-2xl font-semibold text-ink-900">${value}</p>
    ${note ? html`<p class="text-xs text-ink-400">${note}</p>` : ''}
  </div>`

const PERSON_STATUS = {
  submitted: html`<span class="text-emerald-700">ส่งแล้ว</span>`,
  in_progress: html`<span class="text-sky-700">กำลังทำ</span>`,
  not_started: html`<span class="text-ink-400">ยังไม่เริ่ม</span>`,
}

const pct = (t) => (t ? `${attemptPercent(t)}%` : '—')

function resultsTable(rows, canEdit) {
  if (rows.length === 0) return emptyState('ยังไม่มีผู้เรียนในรายชื่อที่ท่านดูได้')
  return html`<div class="overflow-x-auto rounded-xl border border-ink-200 bg-white">
    <table class="min-w-full text-sm" data-results>
      <thead class="bg-ink-50 text-left text-xs text-ink-500">
        <tr>
          <th scope="col" class="px-4 py-2 font-medium">ชื่อ</th>
          <th scope="col" class="px-4 py-2 font-medium">สถานะ</th>
          <th scope="col" class="px-4 py-2 font-medium">ครั้งที่ใช้</th>
          <th scope="col" class="px-4 py-2 font-medium">ครั้งแรก</th>
          <th scope="col" class="px-4 py-2 font-medium">สูงสุด</th>
          <th scope="col" class="px-4 py-2 font-medium">ผล</th>
          <th scope="col" class="px-4 py-2 font-medium">ส่งล่าสุด</th>
          ${canEdit ? html`<th scope="col" class="px-4 py-2 font-medium"><span class="sr-only">จัดการ</span></th>` : ''}
        </tr>
      </thead>
      <tbody class="divide-y divide-ink-100">
        ${rows.map(
          (r) => html`<tr data-user-id="${r.user_id}">
            <td class="px-4 py-2 text-ink-900">
              ${r.name}${r.offRoster ? html` <span class="text-xs text-ink-400">(ไม่อยู่ในรายชื่อแล้ว)</span>` : ''}
            </td>
            <td class="px-4 py-2">
              ${PERSON_STATUS[r.status]}
              ${r.autoSubmitted ? html`<span class="block text-xs text-ink-400">ส่งอัตโนมัติ ${r.autoSubmitted} ครั้ง</span>` : ''}
            </td>
            <td class="px-4 py-2 text-ink-600">
              ${r.used} / ${r.limit}${r.extra ? html` <span class="text-xs text-ink-400">(เพิ่ม ${r.extra})</span>` : ''}
            </td>
            <td class="px-4 py-2 text-ink-600">${pct(r.first)}</td>
            <td class="px-4 py-2 font-semibold text-ink-900">${pct(r.best)}</td>
            <td class="px-4 py-2">${r.best ? resultBadge(r.best.passed) : ''}</td>
            <td class="px-4 py-2 text-ink-500">${r.lastSubmittedAt ? formatThaiDateTime(r.lastSubmittedAt) : '—'}</td>
            ${
              canEdit
                ? html`<td class="px-4 py-2 text-right">
                    ${
                      r.offRoster
                        ? ''
                        : html`<button
                            type="button"
                            class="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-700 hover:bg-ink-50"
                            data-action="grant-extra"
                            data-user-id="${r.user_id}"
                            data-name="${r.name}"
                          >
                            +1 ครั้ง
                          </button>`
                    }
                  </td>`
                : ''
            }
          </tr>`
        )}
      </tbody>
    </table>
  </div>`
}

export async function renderAssignmentDetailView(el, { services, session, caps, context }, { id }) {
  render(el, loading)
  let assignment, attempts, roster, extras
  const load = async () => {
    assignment = await services.assignments.get(id)
    if (!assignment) return
    ;[attempts, roster, extras] = await Promise.all([
      services.assignments.listAttempts(id),
      services.assignments.listRoster(assignment.cohort_id, session.user.id),
      services.assignments.listExtraAttempts(id),
    ])
  }
  try {
    await load()
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  if (!assignment)
    return render(
      el,
      html`${pageHeader('ไม่พบแบบทดสอบ')}${emptyState('ไม่พบการมอบหมายนี้ หรือท่านไม่มีสิทธิ์เข้าถึง')}`
    )

  const canEdit = canAssessHint(caps, context, assignment.cohort_id)
  let message = null
  let tone = 'success'
  let busy = false

  const draw = () => {
    const { rows, summary } = summarizeResults(roster, attempts, assignment, extras)
    const locked = attempts.length > 0
    const judged = summary.passed !== null
    render(
      el,
      html`<a href="#${LIST_PATH}" class="${backLink}">← ผลแบบทดสอบ</a>
        <div class="mt-4 flex flex-wrap items-center gap-2">${purposeChip(assignment.purpose)} ${statusBadge(assignment.status)}</div>
        ${pageHeader(
          assignment.title,
          `${cohortLabel(assignment.cohorts)} · ${versionText(assignment.instrument_versions)} · ${windowText(assignment)}`
        )}
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}

        <section aria-label="สรุปผล" class="grid gap-3 sm:grid-cols-4" data-summary>
          ${statCard('ส่งแล้ว', `${summary.submitted} / ${summary.total}`, `เริ่มทำ ${summary.started} คน`)}
          ${statCard('คะแนนเฉลี่ย', summary.average === null ? '—' : `${summary.average}%`, 'คิดจากครั้งที่ได้คะแนนสูงสุด')}
          ${statCard(
            'ผ่านเกณฑ์',
            judged ? `${summary.passed} / ${summary.submitted}` : '—',
            judged ? `เกณฑ์ ${Number(assignment.passing_percent)}%` : 'ไม่ได้กำหนดเกณฑ์ผ่าน'
          )}
          ${statCard('จำนวนครั้งที่ทำได้', `${assignment.attempt_limit} ครั้ง`, `เวลาทำ ${timeLimitText(assignment)}`)}
        </section>

        <section class="mt-6">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-sm font-semibold text-ink-700">ผลรายบุคคล</h2>
            ${rows.length ? html`<button type="button" class="${secondary}" data-action="export">ดาวน์โหลด CSV</button>` : ''}
          </div>
          ${canEdit ? '' : html`<p class="mb-2 text-xs text-ink-500">แสดงเฉพาะผู้เรียนที่ท่านมีสิทธิ์ดูผล</p>`}
          ${resultsTable(rows, canEdit)}
          <p class="mt-2 text-xs text-ink-400">ระบบแสดงคะแนนรวมรายครั้งเท่านั้น ไม่แสดงคะแนนหรือเฉลยรายข้อ</p>
        </section>

        ${
          canEdit
            ? html`<section class="mt-8">
                <h2 class="text-sm font-semibold text-ink-700">ตั้งค่าการมอบหมาย</h2>
                <form data-form="assignment" class="mt-2 grid gap-4 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2">
                  ${settingsFields(assignment, { locked })}
                  <div class="flex flex-wrap gap-2 sm:col-span-2">
                    <button class="${primary}" type="submit">บันทึกการตั้งค่า</button>
                  </div>
                </form>
                <div class="mt-3 flex flex-wrap gap-2">
                  ${
                    assignment.status !== 'published'
                      ? html`<button type="button" class="${primary}" data-action="publish">
                          ${assignment.status === 'draft' ? 'เผยแพร่ให้ผู้เรียน' : 'เผยแพร่อีกครั้ง'}
                        </button>`
                      : html`<button type="button" class="${secondary}" data-action="close-now">ปิดรับคำตอบตอนนี้</button>
                          <button type="button" class="${secondary}" data-action="archive">เก็บถาวร (ซ่อนจากผู้เรียน)</button>`
                  }
                  ${
                    assignment.status === 'draft' && !locked
                      ? html`<button type="button" class="${danger}" data-action="delete">ลบการมอบหมาย</button>`
                      : ''
                  }
                </div>
              </section>`
            : ''
        }`
    )
  }

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

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return undefined
    switch (b.dataset.action) {
      case 'export': {
        const { rows } = summarizeResults(roster, attempts, assignment, extras)
        return downloadText(
          `results-${assignment.cohorts?.code ?? 'cohort'}-${assignment.id.slice(0, 8)}.csv`,
          toCsv(resultsCsvRows(rows))
        )
      }
      case 'grant-extra': {
        const reason = window.prompt(
          `ให้สิทธิ์ทำเพิ่ม 1 ครั้งแก่ ${b.dataset.name}\nเหตุผล (ไม่บังคับ เช่น สัญญาณขาด):`,
          ''
        )
        if (reason === null) return undefined
        return run(
          () => services.assignments.grantExtraAttempt(id, b.dataset.userId, reason),
          `ให้สิทธิ์ทำเพิ่ม 1 ครั้งแก่ ${b.dataset.name} แล้ว`
        )
      }
      case 'publish':
        return run(
          () => services.assignments.update(id, { status: 'published' }),
          'เผยแพร่แล้ว — ผู้เรียนในรุ่นเห็นแบบทดสอบนี้แล้ว'
        )
      case 'close-now':
        if (
          !window.confirm(
            'ปิดรับคำตอบตอนนี้? ผู้ที่กำลังทำจะถูกส่งคำตอบที่บันทึกไว้อัตโนมัติหลังช่วงผ่อนผัน (แก้เวลาปิดเพื่อเปิดใหม่ได้)'
          )
        )
          return undefined
        return run(
          () => services.assignments.update(id, { close_at: new Date().toISOString() }),
          'ปิดรับคำตอบแล้ว'
        )
      case 'archive':
        if (!window.confirm('เก็บถาวร? ผู้เรียนจะไม่เห็นแบบทดสอบนี้ในรายการ (ผลยังเก็บไว้ครบ)'))
          return undefined
        return run(() => services.assignments.update(id, { status: 'archived' }), 'เก็บถาวรแล้ว')
      case 'delete':
        if (!window.confirm('ลบการมอบหมายนี้?')) return undefined
        busy = true
        return services.assignments.remove(id).then(
          () => navigate(LIST_PATH),
          (err) => {
            busy = false
            message = toUserMessage(err)
            tone = 'error'
            draw()
          }
        )
    }
    return undefined
  }

  watchDateLabels(el)
  el.onsubmit = (e) => {
    e.preventDefault()
    if (e.target.dataset.form !== 'assignment') return
    let patch
    try {
      patch = buildAssignmentPayload(Object.fromEntries(new FormData(e.target)), {
        locked: attempts.length > 0,
      })
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
      return draw()
    }
    return run(() => services.assignments.update(id, patch), 'บันทึกการตั้งค่าแล้ว')
  }

  draw()
}

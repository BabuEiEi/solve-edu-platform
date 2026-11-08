import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { downloadTable, exportButtons } from '../../shared/ui/download.js'
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
  difficultyLabel,
  discriminationLabel,
  reliabilityLabel,
  choicesText,
  partName,
  partStatText,
  itemStatsCsvRows,
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
export function dateField(name, text, value, { required = false } = {}) {
  const v = toBangkokInput(value)
  return html`<label class="${label}"
    >${text}<input
      name="${name}"
      type="datetime-local"
      value="${v}"
      class="${input}"
      ${required ? html`required` : ''}
    />
    <span class="mt-1 block text-xs font-normal text-ink-500" data-date-label="${name}" aria-live="polite"
      >${bangkokInputLabel(v)}</span
    >
  </label>`
}

export function watchDateLabels(el) {
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
    ${dateField('open_at', 'เปิดให้ทำ (เวลาไทย)', a.open_at)} ${dateField('close_at', 'ปิดรับ (เวลาไทย) — บังคับ', a.close_at, { required: true })}
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
      เว้นเวลาเปิดว่างได้ (เปิดทันทีเมื่อเผยแพร่) · ต้องกำหนดเวลาปิดรับ เมื่อถึงเวลาระบบปิดและส่งคำตอบที่บันทึกไว้ให้ทุกคน · การกดเริ่มทำนับเป็น 1 ครั้งทันที
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
    <fieldset class="space-y-2 sm:col-span-2">
      <legend class="${label}">สลับลำดับ (แต่ละคนเห็นลำดับต่างกัน)</legend>
      <label class="flex items-center gap-2 text-sm text-ink-700"
        ><input type="checkbox" name="shuffle_items" ${a.shuffle_items ? html`checked` : ''} /> สลับลำดับข้อ</label
      >
      <label class="flex items-center gap-2 text-sm text-ink-700"
        ><input type="checkbox" name="shuffle_choices" ${a.shuffle_choices ? html`checked` : ''} /> สลับลำดับตัวเลือก</label
      >
      <p class="text-xs text-ink-500">ข้อเรียงลำดับและฝั่งขวาของข้อจับคู่สลับเสมอ · ลำดับของแต่ละคนกำหนดตอนเริ่มทำและบันทึกไว้</p>
    </fieldset>
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
  return html`<div class="relative overflow-x-auto rounded-xl border border-ink-200 bg-white">
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

const fmt = (x, digits = 2) => (x === null || x === undefined ? '—' : Number(x).toFixed(digits))

/** Choice counts, or the share right per part for the new item types. */
function choicesOrParts(it) {
  if (!it.slots?.length) return choicesText(it.choices) || '—'
  return html`<ul class="min-w-48 space-y-0.5 text-xs" data-parts>
    ${it.slots.map(
      (p) =>
        html`<li>${partName(it.item_type, p)} <span class="whitespace-nowrap">${partStatText(p)}</span></li>`
    )}
  </ul>`
}

/** Item analysis for cohort assessors (aggregates of first attempts; never the key). */
function itemAnalysis(stats) {
  if (!stats) return ''
  if (stats.error)
    return html`<section class="mt-8" data-item-analysis>${alertBox(`วิเคราะห์ข้อสอบไม่สำเร็จ: ${stats.error}`)}</section>`
  const head = html`<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-sm font-semibold text-ink-700">วิเคราะห์ข้อสอบ</h2>
    ${stats.suppressed ? '' : exportButtons({ action: 'export-items', label: 'ดาวน์โหลดผลวิเคราะห์', className: secondary })}
  </div>`
  if (stats.suppressed)
    return html`<section class="mt-8" data-item-analysis>
      ${head}${emptyState(`ต้องมีผู้ส่งอย่างน้อย ${stats.min_n} คนจึงจะวิเคราะห์ได้ (ตอนนี้ ${stats.n} คน)`)}
    </section>`
  const kind = stats.reliability_kind === 'kr20' ? 'KR-20' : 'Cronbach α'
  return html`<section class="mt-8" data-item-analysis>
    ${head}
    <p class="mb-3 text-sm text-ink-600">
      ผู้สอบ ${stats.n} คน (ใช้ครั้งแรกของแต่ละคน) · คะแนนเฉลี่ย ${fmt(stats.mean_score)} / ${Number(stats.max_score)} · SD ${fmt(stats.sd_score)}
      · ความเชื่อมั่น (${kind}) <strong data-reliability>${fmt(stats.reliability, 3)}</strong> ${reliabilityLabel(stats.reliability)}
    </p>
    <ol class="space-y-3 md:hidden" data-item-cards>
      ${stats.items.map(
        (
          it,
          i
        ) => html`<li class="rounded-xl border border-ink-200 bg-white p-4 text-sm" data-item-card="${i + 1}">
          <p class="font-semibold text-ink-700">ข้อ ${i + 1} <span class="font-normal text-ink-700">${it.prompt}</span></p>
          <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            <div>
              <dt class="text-xs text-ink-500">ความยาก (p)</dt>
              <dd>${fmt(it.p)} <span class="text-xs text-ink-400">${difficultyLabel(it.p)}</span></dd>
            </div>
            <div>
              <dt class="text-xs text-ink-500">อำนาจจำแนก (D)</dt>
              <dd>${fmt(it.d)} <span class="text-xs text-ink-400">${discriminationLabel(it.d)}</span></dd>
            </div>
            <div>
              <dt class="text-xs text-ink-500">r</dt>
              <dd>${fmt(it.r_it)}</dd>
            </div>
            <div>
              <dt class="text-xs text-ink-500">ไม่ตอบ</dt>
              <dd>${it.blank}</dd>
            </div>
            <div class="col-span-2">
              <dt class="text-xs text-ink-500">${it.slots?.length ? 'ถูกรายส่วน' : 'ตัวเลือกที่ถูกเลือก'}</dt>
              <dd class="text-ink-600">${choicesOrParts(it)}</dd>
            </div>
          </dl>
        </li>`
      )}
    </ol>
    <div class="relative hidden overflow-x-auto rounded-xl border border-ink-200 bg-white md:block">
      <table class="min-w-full text-sm" data-items>
        <thead class="bg-ink-50 text-left text-xs text-ink-500">
          <tr>
            <th scope="col" class="px-3 py-2 font-medium">ข้อ</th>
            <th scope="col" class="px-3 py-2 font-medium">โจทย์</th>
            <th scope="col" class="px-3 py-2 font-medium">ความยาก (p)</th>
            <th scope="col" class="px-3 py-2 font-medium">อำนาจจำแนก (D)</th>
            <th scope="col" class="px-3 py-2 font-medium">r</th>
            <th scope="col" class="px-3 py-2 font-medium">ตัวเลือกที่ถูกเลือก / ถูกรายส่วน</th>
            <th scope="col" class="px-3 py-2 font-medium">ไม่ตอบ</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-ink-100">
          ${stats.items.map(
            (it, i) => html`<tr data-item-row="${i + 1}">
              <td class="px-3 py-2 font-semibold text-ink-700">${i + 1}</td>
              <td class="max-w-xs truncate px-3 py-2 text-ink-700" title="${it.prompt}">${it.prompt}</td>
              <td class="px-3 py-2">${fmt(it.p)} <span class="block text-xs text-ink-400">${difficultyLabel(it.p)}</span></td>
              <td class="px-3 py-2">${fmt(it.d)} <span class="block text-xs text-ink-400">${discriminationLabel(it.d)}</span></td>
              <td class="px-3 py-2 text-ink-600">${fmt(it.r_it)}</td>
              <td class="px-3 py-2 text-ink-600">${choicesOrParts(it)}</td>
              <td class="px-3 py-2 text-ink-600">${it.blank}</td>
            </tr>`
          )}
        </tbody>
      </table>
    </div>
    <p class="mt-2 text-xs text-ink-400">
      p = สัดส่วนคะแนนที่ได้ (0–1) · D = กลุ่มสูง − กลุ่มต่ำ (27% ละ ${stats.group_size} คน) · r = สหสัมพันธ์ข้อกับคะแนนรวมที่เหลือ ·
      ถูกรายส่วน = สัดส่วนคนที่ตอบส่วนนั้นถูก (ข้อเรียงลำดับ จับคู่ จัดกลุ่ม ตาราง ดรอปดาวน์ เติมคำ ติดป้าย) ·
      เกณฑ์แปลผลเป็นแนวทางทั่วไป · ระบบไม่ระบุว่าตัวเลือกใดเป็นคำตอบที่ถูก (เฉลยอ่านกลับไม่ได้)
    </p>
  </section>`
}

export async function renderAssignmentDetailView(el, { services, caps, context }, { id }) {
  render(el, loading)
  let assignment, results, stats
  let canEdit = false
  const load = async () => {
    assignment = await services.assignments.get(id)
    if (!assignment) return
    canEdit = canAssessHint(caps, context, assignment.cohort_id)
    ;[results, stats] = await Promise.all([
      services.assignments.results(id),
      // Item analysis is for cohort assessors; a failure there must not hide the results.
      canEdit
        ? services.assignments.itemStatistics(id).catch((err) => ({ error: toUserMessage(err) }))
        : null,
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

  let message = null
  let tone = 'success'
  let busy = false

  const draw = () => {
    const { rows, summary } = summarizeResults(results, assignment)
    const locked = rows.some((r) => r.used > 0)
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
            ${rows.length ? exportButtons({ action: 'export', label: 'ดาวน์โหลด', className: secondary }) : ''}
          </div>
          ${canEdit ? '' : html`<p class="mb-2 text-xs text-ink-500">แสดงเฉพาะผู้เรียนที่ท่านมีสิทธิ์ดูผล</p>`}
          ${resultsTable(rows, canEdit)}
          <p class="mt-2 text-xs text-ink-400">ระบบแสดงคะแนนรวมรายครั้งเท่านั้น ไม่แสดงคะแนนหรือเฉลยรายข้อ</p>
        </section>
        ${canEdit ? itemAnalysis(stats) : ''}

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
      case 'export-xlsx':
      case 'export-csv': {
        const { rows } = summarizeResults(results, assignment)
        return downloadTable(
          `results-${assignment.cohorts?.code ?? 'cohort'}-${assignment.id.slice(0, 8)}`,
          resultsCsvRows(rows),
          b.dataset.action.slice('export-'.length),
          { sheetName: 'ผลสอบ' }
        )
      }
      case 'export-items-xlsx':
      case 'export-items-csv':
        return downloadTable(
          `item-analysis-${assignment.cohorts?.code ?? 'cohort'}-${assignment.id.slice(0, 8)}`,
          itemStatsCsvRows(stats),
          b.dataset.action.slice('export-items-'.length),
          { sheetName: 'วิเคราะห์ข้อสอบ' }
        )
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
        if (!assignment.close_at) {
          message = 'กรุณากำหนดวันเวลาปิดรับและบันทึกการตั้งค่าก่อนเผยแพร่'
          tone = 'error'
          return draw()
        }
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
        locked: results.some((r) => r.used > 0),
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

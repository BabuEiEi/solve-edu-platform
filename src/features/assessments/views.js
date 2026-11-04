import { html, render, safeUrl } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import {
  PURPOSE_LABELS,
  attemptPercent,
  assignmentState,
  buildResponses,
  readAnswers,
  itemMediaPaths,
  answersFromResponses,
  clockOffset,
  remainingMs,
  formatRemaining,
} from './logic.js'

const AUTOSAVE_DELAY_MS = 1500
const LEAVE_PROMPT = 'ยังบันทึกไม่เสร็จ ออกจากหน้านี้หรือไม่'
const AUTOSAVE_RETRY_MS = 10_000

const primaryBtn =
  'rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondaryLink = 'text-sm text-brand-700 hover:underline'

export const purposeChip = (purpose) =>
  html`<span class="inline-flex rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
    >${PURPOSE_LABELS[purpose] ?? purpose}</span
  >`

export const resultBadge = (passed) =>
  passed === true
    ? html`<span class="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-600/20"
        >ผ่านเกณฑ์</span
      >`
    : passed === false
      ? html`<span class="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-600/20"
          >ยังไม่ผ่านเกณฑ์</span
        >`
      : ''

export const timeLimitText = (a) =>
  a.time_limit_minutes ? `${a.time_limit_minutes} นาทีต่อครั้ง` : 'ไม่จำกัด (ภายในช่วงเปิด–ปิด)'

export function windowText(a) {
  if (a.open_at && a.close_at)
    return `เปิด ${formatThaiDateTime(a.open_at)} – ปิด ${formatThaiDateTime(a.close_at)}`
  if (a.close_at) return `ปิดรับ ${formatThaiDateTime(a.close_at)}`
  if (a.open_at) return `เปิด ${formatThaiDateTime(a.open_at)}`
  return 'ไม่จำกัดช่วงเวลา'
}

function stateText(a, s) {
  if (s.window === 'upcoming') return 'ยังไม่เปิดให้ทำ'
  if (s.window === 'closed') return 'ปิดรับแล้ว'
  if (s.inProgress) return 'กำลังทำอยู่ — ทำต่อได้'
  if (s.remaining === 0) return 'ทำครบจำนวนครั้งแล้ว'
  return `ทำได้อีก ${s.remaining} จาก ${s.limit} ครั้ง`
}

const traineeCohortIds = (context) =>
  (context.cohortMemberships ?? []).filter((m) => m.cohort_role === 'trainee').map((m) => m.cohort_id)

// ---------------------------------------------------------------------
// /assessments — my tests
// ---------------------------------------------------------------------
export async function renderMyAssessmentsView(el, { services, session, context }) {
  render(el, html`${pageHeader('แบบทดสอบของฉัน')}${loading}`)
  let rows
  try {
    rows = await services.assessments.listMyAssignments(session.user.id, traineeCohortIds(context))
  } catch (err) {
    return render(el, html`${pageHeader('แบบทดสอบของฉัน')}${alertBox(toUserMessage(err))}`)
  }
  const now = new Date()
  render(
    el,
    html`${pageHeader('แบบทดสอบของฉัน', 'แบบทดสอบที่ได้รับมอบหมายในรุ่นที่ท่านเข้าร่วม')}
    ${
      rows.length === 0
        ? emptyState('ยังไม่มีแบบทดสอบที่ได้รับมอบหมาย')
        : html`<ul class="space-y-3">
            ${rows.map((a) => {
              const s = assignmentState(a, a.assessment_attempts ?? [], now)
              return html`<li>
                <a
                  href="#/assessments/${a.id}"
                  class="block rounded-xl border border-ink-200 bg-white p-5 transition hover:border-brand-300"
                  data-assignment-id="${a.id}"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    ${purposeChip(a.purpose)}
                    ${a.courses?.title ? html`<span class="text-xs text-ink-500">${a.courses.title}</span>` : ''}
                  </div>
                  <p class="mt-2 font-semibold text-ink-900">${a.title}</p>
                  <p class="mt-1 text-sm text-ink-500">${windowText(a)}</p>
                  <div class="mt-3 flex flex-wrap items-center gap-3 text-sm">
                    <span class="text-ink-700">${stateText(a, s)}</span>
                    ${
                      s.latest
                        ? html`<span class="text-ink-500">ล่าสุด ${attemptPercent(s.latest)}%</span>
                            ${resultBadge(s.latest.passed)}`
                        : ''
                    }
                  </div>
                </a>
              </li>`
            })}
          </ul>`
    }`
  )
}

// ---------------------------------------------------------------------
// Exam form
// ---------------------------------------------------------------------
function choiceLabel(option, media) {
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

function renderItem(item, index, draft, media) {
  const name = `q:${item.id}`
  const saved = draft[item.id]
  const choice = (type, value, content, checked) =>
    html`<label
      class="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 px-4 py-3 text-sm hover:border-brand-300 has-checked:border-brand-500 has-checked:bg-brand-50"
    >
      <input type="${type}" name="${name}" value="${value}" class="mt-0.5" ${checked ? html`checked` : ''} />
      <span class="flex flex-col gap-2">${content}</span>
    </label>`

  let body
  switch (item.item_type) {
    case 'mcq_single':
    case 'mcq_multiple': {
      const multi = item.item_type === 'mcq_multiple'
      const picked = multi ? (Array.isArray(saved) ? saved : []) : [saved]
      body = html`${multi ? html`<p class="text-xs text-ink-500">เลือกได้มากกว่า 1 ข้อ</p>` : ''}
        <div class="mt-2 grid gap-2">
          ${(item.options_json?.options ?? []).map((o) =>
            choice(multi ? 'checkbox' : 'radio', o.id, choiceLabel(o, media), picked.includes(o.id))
          )}
        </div>`
      break
    }
    case 'true_false':
      body = html`<div class="mt-2 grid gap-2 sm:grid-cols-2">
        ${choice('radio', 'true', 'ถูก', saved === 'true')} ${choice('radio', 'false', 'ผิด', saved === 'false')}
      </div>`
      break
    case 'numeric':
      body = html`<div class="mt-2 flex items-center gap-2">
        <input
          type="text"
          inputmode="decimal"
          name="${name}"
          value="${typeof saved === 'string' ? saved : ''}"
          aria-label="คำตอบข้อ ${index + 1}"
          class="w-40 rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
        />
        ${item.options_json?.unit ? html`<span class="text-sm text-ink-600">${item.options_json.unit}</span>` : ''}
      </div>`
      break
    default:
      body = html`<p class="text-sm text-ink-500">ข้อนี้ยังไม่รองรับในเวอร์ชันนี้</p>`
  }

  const image = item.media_path ? media[item.media_path] : null
  return html`<fieldset class="rounded-xl border border-ink-200 bg-white p-5" data-item-id="${item.id}">
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
    <div class="mt-3">${body}</div>
  </fieldset>`
}

// ---------------------------------------------------------------------
// /assessments/:id — overview, start, exam
// ---------------------------------------------------------------------
export async function renderAssessmentView(el, { services, session }, { id }) {
  render(el, loading)
  let assignment
  try {
    assignment = await services.assessments.getAssignment(id, session.user.id)
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  if (!assignment || assignment.status !== 'published') {
    return render(
      el,
      html`${pageHeader('ไม่พบแบบทดสอบ')}${emptyState('ไม่พบแบบทดสอบ หรือท่านไม่มีสิทธิ์เข้าถึง')}`
    )
  }

  const attempts = assignment.assessment_attempts ?? []
  const state = assignmentState(assignment, attempts)
  let message = null
  let tone = 'error'

  // ---------- overview ----------
  const drawOverview = () =>
    render(
      el,
      html`<a href="#/assessments" class="${secondaryLink}">← แบบทดสอบของฉัน</a>
        <div class="mt-4">${purposeChip(assignment.purpose)}</div>
        ${pageHeader(assignment.title, windowText(assignment))}
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <section class="rounded-xl border border-ink-200 bg-white p-5 text-sm">
          ${assignment.instructions ? html`<p class="whitespace-pre-line text-ink-700">${assignment.instructions}</p>` : ''}
          <dl class="mt-3 grid gap-2 sm:grid-cols-4">
            <div>
              <dt class="text-ink-500">จำนวนครั้งที่ทำได้</dt>
              <dd class="font-semibold">
                ${state.limit} ครั้ง${state.limit > assignment.attempt_limit ? ` (รวมสิทธิ์เพิ่ม ${state.limit - assignment.attempt_limit})` : ''}
              </dd>
            </div>
            <div><dt class="text-ink-500">ใช้ไปแล้ว</dt><dd class="font-semibold">${state.used} ครั้ง</dd></div>
            <div><dt class="text-ink-500">เวลาทำ</dt><dd class="font-semibold">${timeLimitText(assignment)}</dd></div>
            <div>
              <dt class="text-ink-500">เกณฑ์ผ่าน</dt>
              <dd class="font-semibold">
                ${assignment.passing_percent === null ? 'ไม่กำหนด' : `${Number(assignment.passing_percent)}%`}
              </dd>
            </div>
          </dl>
          <div class="mt-5 border-t border-ink-100 pt-4">
            ${
              state.canStart
                ? html`<p class="mb-3 text-ink-600">
                      เมื่อกดเริ่ม ระบบจะนับเป็น 1 ครั้งทันที แม้ยังไม่ได้ส่งคำตอบ (เหลือ ${state.remaining} ครั้ง)
                      ${
                        assignment.time_limit_minutes || assignment.close_at
                          ? ' · เวลาเริ่มนับทันที เมื่อหมดเวลาระบบจะส่งคำตอบที่บันทึกไว้ให้อัตโนมัติ'
                          : ''
                      }
                    </p>
                    <button data-action="start-attempt" class="${primaryBtn}">เริ่มทำแบบทดสอบ</button>`
                : html`<p class="font-medium text-ink-700">${stateText(assignment, state)}</p>`
            }
          </div>
        </section>
        ${
          state.submitted.length
            ? html`<section class="mt-6">
                <h2 class="text-sm font-semibold text-ink-700">ประวัติการทำ</h2>
                <ul class="mt-2 divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white text-sm">
                  ${state.submitted.map(
                    (t) =>
                      html`<li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                        <span>ครั้งที่ ${t.attempt_no} · ${formatThaiDateTime(t.submitted_at)}</span>
                        <span class="flex items-center gap-2">
                          <span class="font-semibold">${attemptPercent(t)}%</span>${resultBadge(t.passed)}
                          <a href="#/assessments/attempts/${t.id}" class="${secondaryLink}">ดูผล</a>
                        </span>
                      </li>`
                  )}
                </ul>
              </section>`
            : ''
        }`
    )

  // ---------- exam ----------
  const resultPath = (attemptId) => `/assessments/attempts/${attemptId}`

  const startExam = async (attempt) => {
    if (attempt.timed_out) return navigate(resultPath(attempt.attempt_id))
    render(el, loading)
    let items, media
    try {
      items = await services.assessments.getItems(assignment.instrument_version_id)
      media = await services.assessmentMedia.signedUrls(itemMediaPaths(items))
    } catch (err) {
      return render(el, alertBox(toUserMessage(err)))
    }
    const saved = answersFromResponses(items, attempt.draft)
    let confirmUnanswered = false
    let finished = false
    let saving = false
    let pending = false // a change arrived while a save was in flight
    let saveTimer = null
    let tick = null
    let lastSaved = JSON.stringify(attempt.draft ?? {})

    render(
      el,
      html`${
        attempt.deadline_at
          ? html`<div
                class="sticky top-12 z-10 mb-4 flex items-center justify-between gap-3 rounded-xl border border-brand-200 bg-white/95 px-4 py-2 text-sm shadow-sm backdrop-blur lg:top-2"
                data-timer
              >
                <span>ส่งภายใน ${formatThaiDateTime(attempt.deadline_at)}</span>
                <span>เหลือเวลา <strong class="tabular-nums" data-remaining></strong></span>
              </div>
              <p class="sr-only" aria-live="assertive" data-time-alert></p>`
          : ''
      }
        <div class="flex flex-wrap items-center gap-2">${purposeChip(assignment.purpose)}
          <span class="text-sm text-ink-500">ครั้งที่ ${attempt.attempt_no} · เริ่ม ${formatThaiDateTime(attempt.started_at)}</span>
        </div>
        ${pageHeader(assignment.title, '')}
        <form data-form="attempt" class="space-y-4" novalidate>
          ${items.map((item, i) => renderItem(item, i, saved, media))}
          <div data-slot="message" aria-live="polite"></div>
          <div class="flex flex-wrap items-center gap-3 pt-2">
            <button type="submit" class="${primaryBtn}">ส่งคำตอบ</button>
            <span class="text-xs text-ink-500" data-save-status data-state="saved" aria-live="polite"
              >ระบบบันทึกคำตอบให้อัตโนมัติระหว่างทำ</span
            >
          </div>
        </form>`
    )
    const form = el.querySelector('form[data-form=attempt]')
    const slot = el.querySelector('[data-slot=message]')
    const saveStatus = el.querySelector('[data-save-status]')
    const say = (msg, kind = 'error') => render(slot, msg ? alertBox(msg, kind) : html``)
    const stop = () => {
      clearTimeout(saveTimer)
      clearInterval(tick)
    }
    const done = () => {
      finished = true
      stop()
      detach()
      navigate(resultPath(attempt.attempt_id))
    }

    // ---------- autosave (server draft) ----------
    // data-state: saved = what is on screen is stored on the server; dirty / saving / error otherwise.
    const onScreen = () =>
      JSON.stringify(buildResponses(items, readAnswers(form, items), { lenient: true }).responses)
    const saveNow = async () => {
      if (finished || !form.isConnected) return
      if (saving) {
        pending = true
        return
      }
      const body = onScreen()
      if (body === lastSaved) {
        saveStatus.dataset.state = 'saved'
        return
      }
      saving = true
      saveStatus.dataset.state = 'saving'
      try {
        const r = await services.assessments.saveDraft(attempt.attempt_id, JSON.parse(body))
        if (r?.finalized) return done() // time was up: submitted from earlier saved answers
        lastSaved = body
        saveStatus.textContent = `บันทึกคำตอบแล้ว ${formatThaiDateTime(r?.saved_at ?? new Date())}`
        saveStatus.dataset.state = onScreen() === lastSaved ? 'saved' : 'dirty'
      } catch (err) {
        if (err?.code === 'SE003') return done()
        saveStatus.textContent = 'บันทึกไม่สำเร็จ — ระบบจะลองใหม่อัตโนมัติ'
        saveStatus.dataset.state = 'error'
        saveTimer = setTimeout(saveNow, AUTOSAVE_RETRY_MS)
      } finally {
        saving = false
        if (pending && !finished) {
          pending = false
          saveNow()
        }
      }
      return undefined
    }

    // ---------- submit (button, or time up) ----------
    const submitNow = async ({ timeUp = false } = {}) => {
      if (finished) return
      let built
      try {
        built = buildResponses(items, readAnswers(form, items), { lenient: timeUp })
      } catch (err) {
        return say(toUserMessage(err))
      }
      if (!timeUp && built.unanswered.length && !confirmUnanswered) {
        confirmUnanswered = true
        return say(
          `ยังไม่ได้ตอบ ${built.unanswered.length} ข้อ (ข้อ ${built.unanswered.join(', ')}) — ข้อที่ไม่ตอบจะได้ 0 คะแนน กด "ส่งคำตอบ" อีกครั้งเพื่อยืนยัน`,
          'info'
        )
      }
      finished = true
      stop()
      form.querySelectorAll('input, button').forEach((c) => (c.disabled = true))
      if (timeUp) say('หมดเวลา — กำลังส่งคำตอบ', 'info')
      try {
        await services.assessments.submit(attempt.attempt_id, built.responses)
        navigate(resultPath(attempt.attempt_id))
      } catch (err) {
        // Already submitted (another tab, or the server finalised it): show the stored result.
        if (err?.code === 'SE003') return navigate(resultPath(attempt.attempt_id))
        if (timeUp) {
          return say('หมดเวลา และส่งไม่สำเร็จ — ระบบจะให้คะแนนจากคำตอบที่บันทึกไว้ล่าสุดโดยอัตโนมัติ', 'info')
        }
        finished = false
        form.querySelectorAll('input, button').forEach((c) => (c.disabled = false))
        say(toUserMessage(err))
      }
      return undefined
    }

    // A choice is saved at once; typing (numeric answers) waits for a pause.
    form.oninput = (e) => {
      confirmUnanswered = false
      saveStatus.dataset.state = 'dirty'
      saveStatus.textContent = 'กำลังบันทึก…'
      clearTimeout(saveTimer)
      saveTimer = setTimeout(saveNow, e.target?.type === 'text' ? AUTOSAVE_DELAY_MS : 0)
    }
    form.onsubmit = (e) => {
      e.preventDefault()
      submitNow()
    }

    // ---------- countdown ----------
    if (attempt.deadline_at) {
      const offset = clockOffset(attempt.server_now)
      const remainingEl = el.querySelector('[data-remaining]')
      const timerEl = el.querySelector('[data-timer]')
      const alertEl = el.querySelector('[data-time-alert]')
      const announced = new Set()
      const update = () => {
        if (!form.isConnected) return stop() // left the page
        const ms = remainingMs(attempt.deadline_at, offset)
        remainingEl.textContent = formatRemaining(ms)
        for (const min of [5, 1]) {
          if (ms <= min * 60_000 && ms > 0 && !announced.has(min)) {
            announced.add(min)
            alertEl.textContent = `เหลือเวลา ${min} นาที`
            timerEl.classList.add('border-amber-400', 'bg-amber-50')
          }
        }
        if (ms <= 0) submitNow({ timeUp: true })
        return undefined
      }
      update()
      tick = setInterval(update, 1000)
    }

    // ---------- leaving with unsaved answers ----------
    const unsaved = () => !finished && saveStatus.dataset.state !== 'saved'
    // Prompts only while this exam is on screen; a stale page removes its own listeners.
    const promptNeeded = () => {
      if (!form.isConnected) {
        detach()
        return false
      }
      return unsaved()
    }
    // Keepalive: the browser completes it even if the page is frozen or closed right after.
    const flushKeepalive = () => {
      if (!unsaved()) return
      const body = onScreen()
      if (body !== lastSaved) services.assessments.saveDraftKeepalive?.(attempt.attempt_id, JSON.parse(body))
    }
    // Closing the tab / reloading: browsers show their own wording, not ours.
    const onBeforeUnload = (e) => {
      if (!promptNeeded()) return
      e.preventDefault()
      e.returnValue = ''
    }
    const onPageHide = () => flushKeepalive()
    // Switching apps or locking the phone hides the page; it may never come back.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushKeepalive()
      else saveNow() // back again: reconcile with the server and refresh the status
    }
    // Links and sign-out inside the app: our own Thai prompt.
    const onLeaveClick = (e) => {
      const target = e.target.closest?.('a[href^="#"], [data-action="sign-out"]')
      if (!target || form.contains(target) || !promptNeeded()) return
      if (!window.confirm(LEAVE_PROMPT)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      flushKeepalive()
    }
    const onHashChange = () => {
      if (form.isConnected) return
      flushKeepalive()
      stop()
      detach()
    }
    function detach() {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('hashchange', onHashChange)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('click', onLeaveClick, true)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('hashchange', onHashChange)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('click', onLeaveClick, true)
    return undefined
  }

  el.onclick = async (e) => {
    const b = e.target.closest('[data-action="start-attempt"]')
    if (!b) return
    b.disabled = true
    try {
      const attempt = await services.assessments.start(assignment.id)
      await startExam(attempt)
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
      drawOverview()
    }
  }

  if (state.inProgress) {
    // Resume through the RPC: the server re-checks eligibility and, if time is
    // up, submits from the saved answers (timed_out) instead of resuming.
    try {
      return await startExam(await services.assessments.start(assignment.id))
    } catch (err) {
      message = toUserMessage(err)
    }
  }
  drawOverview()
}

// ---------------------------------------------------------------------
// /assessments/attempts/:attemptId — result (totals only)
// ---------------------------------------------------------------------
export async function renderAttemptResultView(el, { services }, { attemptId }) {
  render(el, loading)
  let attempt
  try {
    attempt = await services.assessments.getAttempt(attemptId)
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  if (!attempt) {
    return render(
      el,
      html`${pageHeader('ไม่พบผลการทดสอบ')}${emptyState('ไม่พบผลการทดสอบ หรือท่านไม่มีสิทธิ์เข้าถึง')}`
    )
  }
  const assignment = attempt.assessment_assignments ?? {}
  const back = html`<a href="#/assessments/${attempt.assignment_id}" class="${secondaryLink}"
    >← ${assignment.title ?? 'แบบทดสอบ'}</a
  >`

  if (attempt.status !== 'submitted') {
    return render(
      el,
      html`${back}${pageHeader('ยังไม่ได้ส่งคำตอบ')}
        <p class="text-sm text-ink-600">ครั้งที่ ${attempt.attempt_no} ${statusBadge(attempt.status)}</p>
        <a href="#/assessments/${attempt.assignment_id}" class="mt-4 inline-block ${primaryBtn}">ทำต่อ</a>`
    )
  }

  const percent = attemptPercent(attempt)
  render(
    el,
    html`${back}
      <div class="mt-4">${purposeChip(assignment.purpose)}</div>
      ${pageHeader('ผลการทดสอบ', `ครั้งที่ ${attempt.attempt_no} · ส่งเมื่อ ${formatThaiDateTime(attempt.submitted_at)}`)}
      <section class="rounded-2xl border border-ink-200 bg-white p-6" data-result>
        <div class="flex flex-wrap items-end gap-6">
          <div>
            <p class="text-sm text-ink-500">คะแนน</p>
            <p class="text-4xl font-semibold text-ink-900" data-score>
              ${Number(attempt.score)}<span class="text-xl text-ink-400"> / ${Number(attempt.max_score)}</span>
            </p>
          </div>
          <div>
            <p class="text-sm text-ink-500">ร้อยละ</p>
            <p class="text-2xl font-semibold text-ink-900">${percent}%</p>
          </div>
          <div>
            <p class="text-sm text-ink-500">ตอบถูก (คะแนนเต็ม)</p>
            <p class="text-2xl font-semibold text-ink-900">${attempt.correct_count} / ${attempt.item_count} ข้อ</p>
          </div>
          <div class="ml-auto">${resultBadge(attempt.passed)}</div>
        </div>
        <div
          class="mt-4 h-2 rounded-full bg-ink-100"
          role="progressbar"
          aria-label="ร้อยละของคะแนน"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="${percent}"
        >
          <div class="h-2 rounded-full ${attempt.passed === false ? 'bg-amber-500' : 'bg-brand-600'}" style="width:${percent}%"></div>
        </div>
        ${
          assignment.passing_percent !== null && assignment.passing_percent !== undefined
            ? html`<p class="mt-3 text-sm text-ink-500">เกณฑ์ผ่าน ${Number(assignment.passing_percent)}%</p>`
            : ''
        }
        ${
          attempt.auto_submitted
            ? html`<p class="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800" data-auto-submitted>
                หมดเวลา — ระบบส่งคำตอบที่บันทึกไว้ล่าสุดให้อัตโนมัติ
              </p>`
            : ''
        }
        <p class="mt-4 text-xs text-ink-400">ระบบแสดงคะแนนรวมเท่านั้น ไม่แสดงเฉลยรายข้อ</p>
      </section>`
  )
}

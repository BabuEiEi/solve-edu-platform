import { html, render, safeUrl } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { toCsv } from '../../shared/utils/csv.js'
import { downloadText } from '../../shared/ui/download.js'
import { canAssessHint, traineeOnlyCohorts } from '../assignments/logic.js'
import { sortedLevels } from '../rubrics/logic.js'
import { reviewsOf } from '../submissions/logic.js'
import {
  FILTERS,
  buildReviewPayload,
  countWaiting,
  displayName,
  filterRows,
  groupByPerson,
  reviewCsvRows,
  scoreText,
  STATE_LABELS,
} from './logic.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary =
  'rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-60'
const dangerBtn =
  'rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-rose-700 hover:bg-rose-50'
const backLink = 'text-sm text-brand-700 hover:underline'

const STATE_TONE = {
  waiting: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  revise: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  passed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  none: 'bg-slate-100 text-slate-500 ring-slate-500/20',
}
const stateBadge = (state) =>
  html`<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATE_TONE[state] ?? STATE_TONE.none}"
    >${STATE_LABELS[state] ?? 'ยังไม่ส่ง'}</span
  >`
const lateBadge = html`<span class="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20">ส่งช้า</span>`
const cohortLabel = (c) => (c ? `${c.name} (${c.code})` : '—')

// =====================================================================
// #/staff/tasks — tasks of my cohorts with the number waiting
// =====================================================================
export async function renderReviewQueueView(el, { services, context }) {
  render(el, html`${pageHeader('ตรวจงาน')}${loading}`)
  let allocations, submissions, reviews
  try {
    const hidden = traineeOnlyCohorts(context)
    allocations = (await services.reviews.listAllocations()).filter((a) => !hidden.has(a.cohort_id))
    ;({ submissions, reviews } = await services.reviews.submissionsOf(allocations.map((a) => a.id)))
  } catch (err) {
    return render(el, html`${pageHeader('ตรวจงาน')}${alertBox(toUserMessage(err))}`)
  }
  const waitingOf = (a) =>
    countWaiting(
      groupByPerson(
        submissions.filter((s) => s.allocation_id === a.id),
        reviews
      )
    )
  const people = (a) =>
    new Set(submissions.filter((s) => s.allocation_id === a.id).map((s) => s.user_id)).size
  render(
    el,
    html`${pageHeader('ตรวจงาน', 'ภาระงานที่เปิดให้รุ่นที่ท่านดูแล — ครูพี่เลี้ยงเห็นเฉพาะครูที่ตนดูแล')}
      ${
        allocations.length
          ? html`<ul class="space-y-3" data-review-queue>
              ${allocations.map((a) => {
                const waiting = waitingOf(a)
                return html`<li>
                  <a
                    href="#/staff/tasks/${a.id}"
                    class="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-white px-5 py-4 hover:border-brand-300"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block font-semibold text-ink-900">${a.tasks.title}</span>
                      <span class="text-xs text-ink-500">${cohortLabel(a.cohorts)} · ${a.tasks.courses?.title ?? ''} · ส่งแล้ว ${people(a)} คน</span>
                    </span>
                    ${
                      waiting
                        ? html`<span class="rounded-full bg-sky-50 px-3 py-1 text-sm font-semibold text-sky-700" data-waiting>รอตรวจ ${waiting}</span>`
                        : html`<span class="text-xs text-ink-500">ไม่มีงานรอตรวจ</span>`
                    }
                  </a>
                </li>`
              })}
            </ul>`
          : emptyState('ยังไม่มีภาระงานที่เปิดให้รุ่นที่ท่านดูแล')
      }`
  )
}

// =====================================================================
// #/staff/tasks/:allocationId — people, state, CSV
// =====================================================================
export async function renderTaskPeopleView(el, { services, caps, context }, { allocationId }) {
  render(el, html`${pageHeader('ตรวจงาน')}${loading}`)
  let allocation, submissions, reviews, roster
  try {
    allocation = await services.reviews.getAllocation(allocationId)
    if (!allocation || allocation.tasks?.status !== 'published')
      return render(
        el,
        html`<a href="#/staff/tasks" class="${backLink}">← ตรวจงาน</a>${pageHeader('ไม่พบภาระงาน')}${emptyState('ไม่พบภาระงานนี้ หรือท่านไม่มีสิทธิ์')}`
      )
    ;({ submissions, reviews } = await services.reviews.submissionsOf([allocationId]))
    roster = canAssessHint(caps, context, allocation.cohort_id)
      ? await services.reviews.roster(allocation.cohort_id)
      : []
  } catch (err) {
    return render(el, html`${pageHeader('ตรวจงาน')}${alertBox(toUserMessage(err))}`)
  }
  const task = allocation.tasks
  const all = groupByPerson(submissions, reviews, roster)
  let filter = 'all'

  const draw = () => {
    const rows = filterRows(all, filter)
    render(
      el,
      html`<a href="#/staff/tasks" class="${backLink}">← ตรวจงาน</a>
        <div class="mt-3 flex flex-wrap items-start justify-between gap-3">
          ${pageHeader(task.title, `${cohortLabel(allocation.cohorts)} · ${task.courses?.title ?? ''}${allocation.due_at ? ` · กำหนดส่ง ${formatThaiDateTime(allocation.due_at)}` : ''}`)}
          <button type="button" class="${secondary}" data-action="export-csv">ดาวน์โหลดผล (CSV)</button>
        </div>
        <div class="mb-3 flex flex-wrap gap-2" role="group" aria-label="กรองตามสถานะ">
          ${Object.entries(FILTERS).map(
            ([key, text]) => html`<button
              type="button"
              data-filter="${key}"
              class="${key === filter ? 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white' : secondary}"
              ${key === filter ? html`aria-pressed="true"` : html`aria-pressed="false"`}
            >
              ${text} ${key === 'all' ? all.length : all.filter((r) => r.state === key).length}
            </button>`
          )}
        </div>
        ${
          rows.length
            ? html`<div class="relative overflow-x-auto rounded-xl border border-ink-200 bg-white">
                <table class="min-w-full text-sm" data-people>
                  <thead class="bg-ink-50 text-left text-xs text-ink-500">
                    <tr>
                      <th scope="col" class="px-4 py-2 font-medium">ชื่อ</th>
                      <th scope="col" class="px-4 py-2 font-medium">สถานะ</th>
                      <th scope="col" class="px-4 py-2 font-medium">รอบที่ส่ง</th>
                      <th scope="col" class="px-4 py-2 font-medium">ส่งล่าสุด</th>
                      <th scope="col" class="px-4 py-2 font-medium">คะแนน</th>
                      <th scope="col" class="px-4 py-2 font-medium"><span class="sr-only">ตรวจ</span></th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-ink-100">
                    ${rows.map(
                      (r) => html`<tr data-user-id="${r.user_id}">
                        <td class="px-4 py-2 font-medium text-ink-800">
                          ${r.latest ? html`<a href="#/staff/tasks/review/${r.latest.id}" class="text-brand-700 hover:underline">${r.name}</a>` : r.name}
                        </td>
                        <td class="px-4 py-2">${stateBadge(r.state)} ${r.is_late ? lateBadge : ''}</td>
                        <td class="px-4 py-2">${r.attempts}/${task.max_attempts}</td>
                        <td class="whitespace-nowrap px-4 py-2 text-ink-600">${r.submitted_at ? formatThaiDateTime(r.submitted_at) : '—'}</td>
                        <td class="px-4 py-2">${scoreText(r.review) || '—'}</td>
                        <td class="px-4 py-2 text-right">
                          ${
                            r.latest
                              ? html`<a href="#/staff/tasks/review/${r.latest.id}" class="${r.state === 'waiting' ? primary : secondary} inline-block" data-review-link
                                  >${r.state === 'waiting' ? 'ตรวจ' : 'ดู/ตรวจใหม่'}</a
                                >`
                              : ''
                          }
                        </td>
                      </tr>`
                    )}
                  </tbody>
                </table>
              </div>`
            : emptyState('ไม่มีรายการในสถานะนี้')
        }
        <p class="mt-2 text-xs text-ink-400">CSV มีชื่อ สถานะ จำนวนรอบ เวลาส่ง ป้ายส่งช้า และคะแนน — ไม่มีเนื้อหางานหรือไฟล์</p>`
    )
  }

  el.onclick = (e) => {
    const f = e.target.closest('button[data-filter]')
    if (f) {
      filter = f.dataset.filter
      return draw()
    }
    if (e.target.closest('button[data-action=export-csv]')) {
      downloadText(
        `task-${allocation.cohorts?.code ?? 'cohort'}-${allocation.id.slice(0, 8)}.csv`,
        toCsv(reviewCsvRows(all, task))
      )
    }
    return undefined
  }
  draw()
}

// =====================================================================
// #/staff/tasks/review/:submissionId — read the work, score, release
// =====================================================================
export async function renderReviewView(el, { services, session }, { submissionId }) {
  render(el, html`${pageHeader('ตรวจงาน')}${loading}`)
  const me = session.user.id
  let d, urls
  let message = null
  let tone = 'success'
  let busy = false
  const load = async () => {
    d = await services.reviews.getSubmission(submissionId)
    if (d) urls = await services.reviews.signedUrls(d.files.map((f) => f.object_path))
  }
  try {
    await load()
  } catch (err) {
    return render(el, html`${pageHeader('ตรวจงาน')}${alertBox(toUserMessage(err))}`)
  }
  if (!d)
    return render(
      el,
      html`<a href="#/staff/tasks" class="${backLink}">← ตรวจงาน</a>${pageHeader('ไม่พบงาน')}${emptyState('ไม่พบงานนี้ หรือท่านไม่มีสิทธิ์ตรวจ')}`
    )

  const task = () => d.allocation.tasks
  const person = () => displayName(d.submission.profiles)
  const released = () => d.reviews.filter((r) => r.status === 'released')
  const myDraft = () => d.reviews.find((r) => r.status === 'draft' && r.reviewer_id === me) ?? null
  const scoresOf = (reviewId) =>
    new Map(d.scores.filter((s) => s.review_id === reviewId).map((s) => [s.criterion_id, s]))
  const isOwn = () => d.submission.user_id === me

  /** What the form starts from: my draft, else the review in force (to re-grade), else nothing. */
  const startingPoint = () => {
    const base = myDraft() ?? reviewsOf(released()).current
    if (!base)
      return { levels: {}, comments: {}, feedback: '', outcome: '', reason: myDraft()?.regrade_reason ?? '' }
    const sc = scoresOf(base.id)
    return {
      levels: Object.fromEntries([...sc].map(([k, v]) => [k, v.level_id])),
      comments: Object.fromEntries([...sc].map(([k, v]) => [k, v.comment ?? ''])),
      feedback: base.feedback ?? '',
      outcome: base.outcome ?? '',
      reason: base.status === 'draft' ? (base.regrade_reason ?? '') : '',
    }
  }

  const levelChoice = (c, l, checked) =>
    html`<label class="flex cursor-pointer items-start gap-2 rounded-lg border border-ink-200 p-2 text-sm hover:border-brand-300 has-checked:border-brand-500 has-checked:bg-brand-50">
      <input type="radio" name="level:${c.id}" value="${l.id}" class="mt-1" ${checked ? html`checked` : ''} />
      <span>
        <span class="font-medium text-ink-800">${l.label}</span> <span class="text-xs text-ink-500">${Number(l.score)} คะแนน</span>
        ${l.description ? html`<span class="block text-xs text-ink-600">${l.description}</span>` : ''}
      </span>
    </label>`

  const reviewForm = () => {
    const start = startingPoint()
    const regrade = released().length > 0
    return html`<form data-form="review" class="space-y-4 rounded-xl border-2 border-brand-200 bg-white p-5">
      <p class="text-sm font-semibold text-brand-700">${regrade ? 'ตรวจใหม่ (ผลเดิมถูกเก็บไว้เป็นประวัติ)' : 'ตรวจงานรอบที่ ' + d.submission.attempt_no}</p>
      ${
        d.criteria.length
          ? html`<div class="space-y-4" data-criteria>
              ${d.criteria.map(
                (c) => html`<fieldset class="space-y-2" data-criterion="${c.id}">
                  <legend class="text-sm font-medium text-ink-900">${c.prompt}</legend>
                  ${c.options_json.description ? html`<p class="text-xs text-ink-600">${c.options_json.description}</p>` : ''}
                  <div class="grid gap-2 sm:grid-cols-2">${sortedLevels(c).map((l) => levelChoice(c, l, start.levels[c.id] === l.id))}</div>
                  <label class="${label}"
                    >ความเห็นรายเกณฑ์ (ไม่บังคับ)<input name="comment:${c.id}" maxlength="2000" value="${start.comments[c.id] ?? ''}" class="${input}"
                  /></label>
                </fieldset>`
              )}
            </div>`
          : html`<p class="text-sm text-ink-600">ภาระงานนี้ไม่ใช้ Rubric — ให้ข้อเสนอแนะและผลการตรวจอย่างเดียว</p>`
      }
      <label class="${label}"
        >ข้อเสนอแนะ (ผู้เรียนเห็นเมื่อส่งผล)<textarea name="feedback" rows="5" maxlength="10000" class="${input}">${start.feedback}</textarea>
      </label>
      <fieldset class="space-y-1">
        <legend class="${label}">ผลการตรวจ</legend>
        <label class="mr-4 inline-flex items-center gap-2 text-sm"><input type="radio" name="outcome" value="passed" ${start.outcome === 'passed' ? html`checked` : ''} /> ผ่าน</label>
        <label class="inline-flex items-center gap-2 text-sm"><input type="radio" name="outcome" value="revise" ${start.outcome === 'revise' ? html`checked` : ''} /> ส่งกลับแก้ไข (ผู้เรียนส่งรอบใหม่ได้)</label>
      </fieldset>
      ${
        regrade
          ? html`<label class="${label}"
              >เหตุผลที่ตรวจใหม่ (บังคับ — ผู้เรียนเห็นและระบบบันทึกไว้)<textarea name="reason" rows="2" maxlength="1000" class="${input}">${start.reason}</textarea>
            </label>`
          : ''
      }
      <div data-form-error></div>
      <div class="flex flex-wrap gap-2">
        <button class="${secondary}" type="submit" data-intent="save">บันทึกร่างการตรวจ</button>
        <button class="${primary}" type="submit" data-intent="release">ส่งผลให้ผู้เรียน</button>
        ${myDraft() ? html`<button class="${dangerBtn}" type="button" data-action="discard">ทิ้งร่าง</button>` : ''}
      </div>
      <p class="text-xs text-ink-500">ร่างการตรวจเห็นเฉพาะท่าน — ผู้เรียนเห็นผลเมื่อกด “ส่งผลให้ผู้เรียน” เท่านั้น ส่งแล้วแก้ไม่ได้ (ตรวจใหม่ได้โดยระบุเหตุผล)</p>
    </form>`
  }

  const releasedList = () => {
    const { current, earlier } = reviewsOf(released())
    if (!current) return ''
    const block = (r, isCurrent) => {
      const sc = scoresOf(r.id)
      return html`<div class="rounded-lg ${isCurrent ? 'bg-ink-50' : 'border border-ink-100 bg-white'} p-3 text-sm" data-released="${r.id}">
        <p class="font-medium text-ink-800">
          ${isCurrent ? 'ผลที่ใช้อยู่: ' : 'ผลก่อนหน้า: '}${stateBadge(r.outcome)}
          ${scoreText(r) ? html`<span class="ml-2">คะแนน ${scoreText(r)}</span>` : ''}
          <span class="ml-2 text-xs font-normal text-ink-500">${formatThaiDateTime(r.released_at)}</span>
        </p>
        ${r.regrade_reason ? html`<p class="text-xs text-ink-600">เหตุผลที่ตรวจใหม่: ${r.regrade_reason}</p>` : ''}
        ${r.feedback ? html`<p class="mt-1 whitespace-pre-line">${r.feedback}</p>` : ''}
        ${
          sc.size
            ? html`<ul class="mt-1 text-xs text-ink-600">
                ${d.criteria
                  .filter((c) => sc.has(c.id))
                  .map(
                    (c) =>
                      html`<li>${c.prompt}: ${c.options_json.levels.find((l) => l.id === sc.get(c.id).level_id)?.label ?? ''} (${Number(sc.get(c.id).score)})</li>`
                  )}
              </ul>`
            : ''
        }
      </div>`
    }
    return html`<section class="space-y-2" data-released-reviews>
      <h2 class="text-sm font-semibold text-ink-700">ผลการตรวจที่ส่งแล้ว</h2>
      ${block(current, true)} ${earlier.map((r) => block(r, false))}
    </section>`
  }

  const draw = () => {
    const s = d.submission
    render(
      el,
      html`<a href="#/staff/tasks/${s.allocation_id}" class="${backLink}">← ${task().title}</a>
        <div class="mt-3">${pageHeader(person(), `${task().title} · ${cohortLabel(d.allocation.cohorts)}`)}</div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <div class="space-y-4">
          <nav class="flex flex-wrap gap-2" aria-label="รอบที่ส่ง" data-attempts>
            ${d.attempts.map(
              (a) => html`<a
                href="#/staff/tasks/review/${a.id}"
                class="${a.id === s.id ? 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white' : secondary}"
                ${a.id === s.id ? html`aria-current="true"` : ''}
                >รอบที่ ${a.attempt_no} ${a.is_late ? '(ส่งช้า)' : ''}</a
              >`
            )}
          </nav>
          <section class="rounded-xl border border-ink-200 bg-white p-5 text-sm" data-work>
            <p class="text-xs text-ink-500">รอบที่ ${s.attempt_no} · ส่งเมื่อ ${formatThaiDateTime(s.submitted_at)} ${s.is_late ? lateBadge : ''}</p>
            ${s.text_response ? html`<p class="mt-2 whitespace-pre-line text-ink-900">${s.text_response}</p>` : ''}
            ${
              s.links.length
                ? html`<ul class="mt-3 space-y-1">
                    ${s.links.map((l) => html`<li>🔗 <a href="${safeUrl(l.url)}" target="_blank" rel="noopener noreferrer" class="text-brand-700 hover:underline">${l.label || l.url}</a></li>`)}
                  </ul>`
                : ''
            }
            ${
              d.files.length
                ? html`<ul class="mt-3 space-y-1">
                    ${d.files.map(
                      (f) =>
                        html`<li>📎 ${
                          urls[f.object_path]
                            ? html`<a href="${safeUrl(urls[f.object_path])}" target="_blank" rel="noopener noreferrer" class="text-brand-700 hover:underline">${f.file_name}</a>`
                            : f.file_name
                        }</li>`
                    )}
                  </ul>`
                : ''
            }
            ${!s.text_response && !s.links.length && !d.files.length ? html`<p class="text-ink-500">ไม่มีเนื้อหา</p>` : ''}
          </section>
          ${releasedList()}
          ${isOwn() ? html`${alertBox('งานนี้เป็นของท่านเอง — ตรวจงานของตนเองไม่ได้', 'info')}` : reviewForm()}
        </div>`
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

  const readForm = (form) => {
    const f = new FormData(form)
    const levels = {}
    const comments = {}
    for (const c of d.criteria) {
      if (f.get(`level:${c.id}`)) levels[c.id] = String(f.get(`level:${c.id}`))
      comments[c.id] = String(f.get(`comment:${c.id}`) ?? '')
    }
    return {
      levels,
      comments,
      feedback: f.get('feedback'),
      outcome: f.get('outcome'),
      reason: f.get('reason'),
    }
  }

  el.onsubmit = (e) => {
    e.preventDefault()
    const form = e.target
    if (form.dataset.form !== 'review' || busy) return undefined
    const intent = e.submitter?.dataset.intent ?? 'save'
    const slot = form.querySelector('[data-form-error]')
    const regrade = released().length > 0
    let payload
    try {
      payload = buildReviewPayload(readForm(form), d.criteria, { release: intent === 'release', regrade })
    } catch (err) {
      return render(slot, alertBox(toUserMessage(err)))
    }
    if (
      intent === 'release' &&
      !window.confirm('ส่งผลให้ผู้เรียน? ส่งแล้วแก้ไม่ได้ (ตรวจใหม่ได้โดยระบุเหตุผล)')
    )
      return undefined
    busy = true
    ;(async () => {
      try {
        const reviewId = await services.reviews.saveReview(submissionId, payload)
        if (intent === 'release') await services.reviews.release(reviewId)
        await load()
        message = intent === 'release' ? 'ส่งผลให้ผู้เรียนแล้ว' : 'บันทึกร่างการตรวจแล้ว (ผู้เรียนยังไม่เห็น)'
        tone = 'success'
        busy = false
        draw()
      } catch (err) {
        // The form stays as it is; the draft may have been saved even if the release was refused.
        busy = false
        render(slot, alertBox(toUserMessage(err)))
      }
    })()
    return undefined
  }

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action=discard]')
    if (!b || !myDraft()) return undefined
    if (!window.confirm('ทิ้งร่างการตรวจนี้?')) return undefined
    return run(() => services.reviews.discard(myDraft().id), 'ทิ้งร่างการตรวจแล้ว')
  }

  draw()
  return undefined
}

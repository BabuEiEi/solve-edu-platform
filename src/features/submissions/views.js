import { html, render, safeUrl } from '../../shared/ui/html.js'
import {
  pageHeader,
  emptyState,
  alertBox,
  loading,
  filePicker,
  bindFilePickers,
} from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { sortedLevels } from '../rubrics/logic.js'
import {
  FILE_ACCEPT,
  MAX_FILES,
  MAX_LINKS,
  STATE_LABELS,
  attemptState,
  buildDraft,
  hasContent,
  isOverdue,
  nextAction,
  reviewsOf,
  scoreText,
} from './logic.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary =
  'rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-60'
const dangerBtn =
  'rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50'
const backLink = 'text-sm text-brand-700 hover:underline'

const STATE_TONE = {
  draft: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  waiting: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  passed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  revise: 'bg-amber-50 text-amber-800 ring-amber-600/20',
}
const stateBadge = (state) =>
  html`<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATE_TONE[state]}">${STATE_LABELS[state]}</span>`
const lateBadge = html`<span class="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20">ส่งช้า</span>`

const sizeText = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

// =====================================================================
// #/tasks — my tasks
// =====================================================================
export async function renderMyTasksView(el, { services, session }) {
  render(el, loading)
  let data
  try {
    data = await services.submissions.listMine(session.user.id)
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  const { allocations, submissions } = data
  const stateOf = (allocationId) => {
    const mine = submissions.filter((s) => s.allocation_id === allocationId)
    if (!mine.length) return null
    return mine.some((s) => s.status === 'draft') ? 'draft' : 'submitted'
  }

  render(
    el,
    html`${pageHeader('ภาระงานของฉัน', 'งานที่ผู้เรียนส่ง แล้วผู้ตรวจให้ข้อเสนอแนะ ส่งแก้ไขได้ตามจำนวนรอบที่กำหนด')}
      ${
        allocations.length
          ? html`<ul class="space-y-3" data-my-tasks>
              ${allocations.map((a) => {
                const state = stateOf(a.id)
                const count = submissions.filter(
                  (s) => s.allocation_id === a.id && s.status === 'submitted'
                ).length
                return html`<li>
                  <a
                    href="#/tasks/${a.id}"
                    class="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-white px-5 py-4 hover:border-brand-300"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block font-semibold text-ink-900">${a.tasks.title}</span>
                      <span class="text-xs text-ink-500"
                        >${a.tasks.courses?.title ?? ''} · ${a.due_at ? `กำหนดส่ง ${formatThaiDateTime(a.due_at)}` : 'ไม่กำหนดวันส่ง'} · ส่งแล้ว ${count}/${a.tasks.max_attempts} รอบ</span
                      >
                    </span>
                    ${
                      state === 'draft'
                        ? stateBadge('draft')
                        : state
                          ? html`<span class="text-xs text-ink-500">เปิดดูผลและประวัติ</span>`
                          : isOverdue(a)
                            ? html`<span class="text-xs text-rose-700">เลยกำหนด</span>`
                            : html`<span class="text-xs text-brand-700">ยังไม่ได้ส่ง</span>`
                    }
                  </a>
                </li>`
              })}
            </ul>`
          : emptyState('ยังไม่มีภาระงานที่เปิดให้รุ่นของท่าน')
      }`
  )
}

// =====================================================================
// #/tasks/:allocationId — read the task, work on a draft, see results
// =====================================================================
function linkRow(link = {}) {
  return html`<div class="grid gap-2 rounded-lg border border-ink-100 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" data-link-row>
    <label class="${label}"
      >ลิงก์ (https://)<input name="link_url" type="url" inputmode="url" maxlength="2000" value="${link.url ?? ''}" placeholder="https://drive.google.com/…" class="${input}"
    /></label>
    <label class="${label}"
      >ชื่อลิงก์ (ไม่บังคับ)<input name="link_label" maxlength="200" value="${link.label ?? ''}" class="${input}"
    /></label>
    <button type="button" class="${dangerBtn}" data-action="remove-link">ลบ</button>
  </div>`
}

export async function renderTaskPageView(el, { services, session }, { allocationId }) {
  render(el, loading)
  const userId = session.user.id
  let detail, urls
  let message = null
  let tone = 'success'
  let busy = false

  const load = async () => {
    detail = await services.submissions.getDetail(allocationId, userId)
    if (!detail) return
    urls = await services.submissions.signedUrls(detail.files.map((f) => f.object_path))
  }
  try {
    await load()
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  if (!detail)
    return render(
      el,
      html`<a href="#/tasks" class="${backLink}">← ภาระงานของฉัน</a>${pageHeader('ไม่พบภาระงาน')}${emptyState('ไม่พบภาระงานนี้ หรือยังไม่ได้เปิดให้รุ่นของท่าน')}`
    )
  // A draft left by a closed page: remove files that were uploaded but never recorded.
  const openDraft = detail.submissions.find((s) => s.status === 'draft')
  if (openDraft)
    services.submissions
      .cleanOrphans(
        openDraft.id,
        detail.files.filter((f) => f.submission_id === openDraft.id)
      )
      .catch(() => {})

  const reviewsFor = (submissionId) =>
    reviewsOf(detail.reviews.filter((r) => r.submission_id === submissionId))
  const filesOf = (submissionId) => detail.files.filter((f) => f.submission_id === submissionId)

  const criterionTable = (review) => {
    const byCriterion = new Map(
      detail.scores.filter((s) => s.review_id === review.id).map((s) => [s.criterion_id, s])
    )
    if (!byCriterion.size) return ''
    return html`<ul class="mt-2 space-y-1 text-sm" data-review-scores>
      ${detail.criteria.map((c) => {
        const s = byCriterion.get(c.id)
        const level = s && c.options_json.levels.find((l) => l.id === s.level_id)
        return s
          ? html`<li class="rounded-lg border border-ink-100 p-2">
              <span class="font-medium text-ink-800">${c.prompt}</span>
              <span class="ml-1 text-ink-600">— ${level?.label ?? s.level_id} (${Number(s.score)}/${Number(c.max_score)})</span>
              ${s.comment ? html`<span class="mt-0.5 block text-xs text-ink-600">${s.comment}</span>` : ''}
            </li>`
          : ''
      })}
    </ul>`
  }

  const reviewBlock = (submission) => {
    const { current, earlier } = reviewsFor(submission.id)
    if (!current) return ''
    return html`<div class="mt-3 rounded-lg bg-ink-50 p-3 text-sm" data-review>
      <p class="font-medium text-ink-800">
        ผลการตรวจ: ${stateBadge(current.outcome)}
        ${scoreText(current) ? html`<span class="ml-2">คะแนน ${scoreText(current)}</span>` : ''}
        <span class="ml-2 text-xs font-normal text-ink-500">เมื่อ ${formatThaiDateTime(current.released_at)}</span>
      </p>
      ${current.feedback ? html`<p class="mt-2 whitespace-pre-line text-ink-800">${current.feedback}</p>` : ''}
      ${criterionTable(current)}
      ${
        earlier.length
          ? html`<details class="mt-3 text-xs text-ink-600" data-earlier-reviews>
              <summary class="cursor-pointer">ผลการตรวจก่อนหน้า (ถูกแทนที่ด้วยการตรวจใหม่) ${earlier.length} ครั้ง</summary>
              ${earlier.map(
                (r) => html`<div class="mt-2 rounded border border-ink-100 bg-white p-2">
                  ${STATE_LABELS[r.outcome]}${scoreText(r) ? ` · ${scoreText(r)}` : ''} · ${formatThaiDateTime(r.released_at)}
                  ${r.feedback ? html`<span class="mt-1 block whitespace-pre-line">${r.feedback}</span>` : ''}
                </div>`
              )}
              ${current.regrade_reason ? html`<p class="mt-2">เหตุผลที่ตรวจใหม่: ${current.regrade_reason}</p>` : ''}
            </details>`
          : ''
      }
    </div>`
  }

  const attemptCard = (s) => {
    const { current } = reviewsFor(s.id)
    const state = attemptState(s, current)
    const files = filesOf(s.id)
    return html`<li class="rounded-xl border border-ink-200 bg-white p-4" data-attempt="${s.attempt_no}">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="font-semibold text-brand-700">รอบที่ ${s.attempt_no}</span>
        ${stateBadge(state)} ${s.is_late ? lateBadge : ''}
        <span class="text-xs text-ink-500">ส่งเมื่อ ${formatThaiDateTime(s.submitted_at)}</span>
      </div>
      ${s.text_response ? html`<p class="mt-2 whitespace-pre-line text-sm text-ink-800">${s.text_response}</p>` : ''}
      ${
        s.links.length
          ? html`<ul class="mt-2 space-y-1 text-sm">
              ${s.links.map(
                (l) =>
                  html`<li>🔗 <a href="${safeUrl(l.url)}" target="_blank" rel="noopener noreferrer" class="text-brand-700 hover:underline">${l.label || l.url}</a></li>`
              )}
            </ul>`
          : ''
      }
      ${
        files.length
          ? html`<ul class="mt-2 space-y-1 text-sm">
              ${files.map(
                (f) =>
                  html`<li>📎 ${
                    urls[f.object_path]
                      ? html`<a href="${safeUrl(urls[f.object_path])}" target="_blank" rel="noopener noreferrer" class="text-brand-700 hover:underline">${f.file_name}</a>`
                      : f.file_name
                  } <span class="text-xs text-ink-500">${f.size_bytes ? sizeText(f.size_bytes) : ''}</span></li>`
              )}
            </ul>`
          : ''
      }
      ${reviewBlock(s)}
    </li>`
  }

  const draftForm = (draft) => {
    const files = filesOf(draft.id)
    const links = draft.links.length ? draft.links : [{}]
    return html`<form data-form="draft" class="space-y-4 rounded-xl border-2 border-brand-200 bg-white p-5" data-draft="${draft.id}">
      <p class="text-sm font-semibold text-brand-700">งานรอบที่ ${draft.attempt_no} (ร่าง — ยังไม่ส่ง)</p>
      <label class="${label}"
        >ข้อความ (เช่น คำอธิบาย การสะท้อนคิด)<textarea name="text" rows="6" maxlength="20000" class="${input}">${draft.text_response ?? ''}</textarea>
      </label>
      <fieldset class="space-y-2">
        <legend class="${label}">ลิงก์ (ไม่เกิน ${MAX_LINKS} ลิงก์ — วิดีโอให้ส่งเป็นลิงก์ เช่น YouTube)</legend>
        <div data-links class="space-y-2">${links.map(linkRow)}</div>
        <button type="button" class="${secondary}" data-action="add-link">+ เพิ่มลิงก์</button>
      </fieldset>
      <fieldset class="space-y-2" data-files>
        <legend class="${label}">ไฟล์ (ไม่เกิน ${MAX_FILES} ไฟล์ ไฟล์ละไม่เกิน 20 MB — PDF, Word, Excel, PowerPoint, รูปภาพ)</legend>
        ${
          files.length
            ? html`<ul class="space-y-1 text-sm">
                ${files.map(
                  (f) => html`<li class="flex flex-wrap items-center gap-2" data-file="${f.id}">
                    📎 <span>${f.file_name}</span>
                    <span class="text-xs text-ink-500">${f.size_bytes ? sizeText(f.size_bytes) : ''}</span>
                    <button type="button" class="${dangerBtn}" data-action="remove-file" data-id="${f.id}">เอาออก</button>
                  </li>`
                )}
              </ul>`
            : html`<p class="text-sm text-ink-500">ยังไม่ได้แนบไฟล์</p>`
        }
        ${
          files.length < MAX_FILES
            ? filePicker({
                name: 'task_file',
                accept: FILE_ACCEPT,
                button: 'แนบไฟล์…',
                label: 'แนบไฟล์งาน',
                none: '',
              })
            : html`<p class="text-xs text-ink-500">แนบครบ ${MAX_FILES} ไฟล์แล้ว</p>`
        }
      </fieldset>
      <div data-form-error></div>
      <div class="flex flex-wrap gap-2">
        <button class="${secondary}" type="submit" data-intent="save">บันทึกร่าง</button>
        <button class="${primary}" type="submit" data-intent="submit">ส่งงาน</button>
      </div>
      <p class="text-xs text-ink-500">ส่งแล้วแก้ไขไม่ได้ ถ้าผู้ตรวจ “ส่งกลับแก้ไข” จึงส่งรอบใหม่ได้</p>
    </form>`
  }

  const actionPanel = () => {
    const { allocation, submissions } = detail
    const action = nextAction({
      allocation,
      task: allocation.tasks,
      submissions,
      currentOf: (id) => reviewsFor(id).current,
    })
    const open = (text) => html`<button type="button" class="${primary}" data-action="start">${text}</button>`
    switch (action) {
      case 'start':
        return html`${open('เริ่มทำงาน (เปิดร่างรอบที่ 1)')}${
          isOverdue(allocation)
            ? html`<p class="mt-2 text-sm text-rose-700">เลยกำหนดส่งแล้ว ส่งได้ แต่จะมีป้าย “ส่งช้า”</p>`
            : ''
        }`
      case 'again':
        return html`<p class="mb-2 text-sm text-amber-800">ผู้ตรวจส่งงานกลับให้แก้ไข — แก้ตามข้อเสนอแนะแล้วส่งรอบใหม่ได้</p>${open(`แก้ไขและส่งรอบที่ ${submissions.length + 1}`)}`
      case 'not_open':
        return html`<p class="text-sm text-ink-600">ยังไม่เปิดรับงาน (เปิด ${formatThaiDateTime(allocation.available_at)})</p>`
      case 'waiting':
        return html`<p class="text-sm text-sky-700">ส่งแล้ว — รอผู้ตรวจ</p>`
      case 'passed':
        return html`<p class="text-sm text-emerald-700">ผ่านแล้ว — ไม่ต้องส่งเพิ่ม</p>`
      case 'used_up':
        return html`<p class="text-sm text-rose-700">ส่งครบ ${allocation.tasks.max_attempts} รอบแล้ว — หากต้องการส่งเพิ่ม โปรดติดต่อวิทยากร</p>`
      default:
        return ''
    }
  }

  const rubricPreview = () =>
    detail.criteria.length
      ? html`<details class="rounded-xl border border-ink-200 bg-white p-4 text-sm" data-rubric>
          <summary class="cursor-pointer font-medium text-ink-800">เกณฑ์ที่ใช้ตรวจ (${detail.criteria.length} เกณฑ์)</summary>
          <ul class="mt-3 space-y-3">
            ${detail.criteria.map(
              (c) => html`<li>
                <p class="font-medium text-ink-900">${c.prompt}</p>
                ${c.options_json.description ? html`<p class="text-ink-600">${c.options_json.description}</p>` : ''}
                <ul class="mt-1 grid gap-1 sm:grid-cols-2">
                  ${sortedLevels(c).map(
                    (l) => html`<li class="rounded border border-ink-100 p-2 text-xs">
                      <span class="font-medium">${l.label}</span> · ${Number(l.score)} คะแนน
                      ${l.description ? html`<span class="mt-0.5 block text-ink-600">${l.description}</span>` : ''}
                    </li>`
                  )}
                </ul>
              </li>`
            )}
          </ul>
        </details>`
      : ''

  const draw = () => {
    const { allocation, submissions } = detail
    const task = allocation.tasks
    const draft = submissions.find((s) => s.status === 'draft')
    const sent = submissions.filter((s) => s.status === 'submitted')
    render(
      el,
      html`<a href="#/tasks" class="${backLink}">← ภาระงานของฉัน</a>
        <div class="mt-3">${pageHeader(task.title, `${task.courses?.title ?? ''} · ${allocation.cohorts?.name ?? ''}`)}</div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <div class="space-y-4">
          <section class="rounded-xl border border-ink-200 bg-white p-5 text-sm">
            ${task.instructions ? html`<p class="whitespace-pre-line text-ink-900" data-instructions>${task.instructions}</p>` : ''}
            <p class="mt-3 text-ink-600" data-meta>
              ${allocation.due_at ? `กำหนดส่ง ${formatThaiDateTime(allocation.due_at)}` : 'ไม่กำหนดวันส่ง'}
              ${isOverdue(allocation) ? html` <span class="text-rose-700">(เลยกำหนดแล้ว — ส่งได้ แต่จะมีป้าย “ส่งช้า”)</span>` : ''}
              · ส่งได้สูงสุด ${task.max_attempts} รอบ · ส่งแล้ว ${sent.length} รอบ
            </p>
          </section>
          ${rubricPreview()}
          ${draft ? draftForm(draft) : html`<section class="rounded-xl border border-ink-200 bg-white p-5" data-actions>${actionPanel()}</section>`}
          ${
            sent.length
              ? html`<section>
                  <h2 class="mb-2 text-sm font-semibold text-ink-700">ประวัติการส่งงาน</h2>
                  <ol class="space-y-3" data-history>${sent.map(attemptCard)}</ol>
                </section>`
              : ''
          }
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

  const readDraft = (form) => {
    const f = new FormData(form)
    const urlsIn = f.getAll('link_url').map(String)
    const labels = f.getAll('link_label').map(String)
    return buildDraft({
      text: f.get('text'),
      linkRows: urlsIn.map((url, i) => ({ url, label: labels[i] })),
    })
  }

  el.onsubmit = (e) => {
    e.preventDefault()
    const form = e.target
    if (form.dataset.form !== 'draft' || busy) return
    const submissionId = form.dataset.draft
    const intent = e.submitter?.dataset.intent ?? 'save'
    const slot = form.querySelector('[data-form-error]')
    let draft
    try {
      draft = readDraft(form)
      if (intent === 'submit' && !hasContent(draft, filesOf(submissionId).length)) throw new Error('EMPTY')
    } catch (err) {
      return render(
        slot,
        alertBox(
          err.message === 'EMPTY' ? 'ใส่ข้อความ ลิงก์ หรือไฟล์อย่างน้อยหนึ่งอย่างก่อนส่ง' : toUserMessage(err)
        )
      )
    }
    if (intent === 'submit' && !window.confirm('ส่งงานรอบนี้? ส่งแล้วแก้ไขไม่ได้')) return undefined
    busy = true
    ;(async () => {
      try {
        await services.submissions.saveDraft(submissionId, draft)
        if (intent === 'submit') await services.submissions.submit(submissionId)
        await load()
        message = intent === 'submit' ? 'ส่งงานแล้ว — รอผู้ตรวจ' : 'บันทึกร่างแล้ว'
        tone = 'success'
        busy = false
        draw()
      } catch (err) {
        // Keep the open form (and what was typed); the error shows inside it.
        busy = false
        render(slot, alertBox(toUserMessage(err)))
      }
    })()
    return undefined
  }

  el.onchange = async (e) => {
    if (e.target?.name !== 'task_file') return
    const form = e.target.closest('form[data-form=draft]')
    const file = e.target.files?.[0]
    if (!form || !file || busy) return
    const slot = form.querySelector('[data-form-error]')
    const submissionId = form.dataset.draft
    let draft
    try {
      draft = readDraft(form) // keep what is typed: the page is redrawn after the upload
    } catch {
      draft = null
    }
    busy = true
    try {
      await services.submissions.addFile(submissionId, file, filesOf(submissionId).length)
      if (draft) await services.submissions.saveDraft(submissionId, draft).catch(() => {})
      await load()
      message = `แนบไฟล์ “${file.name}” แล้ว`
      tone = 'success'
      busy = false
      draw()
    } catch (err) {
      busy = false
      e.target.value = ''
      render(slot, alertBox(toUserMessage(err)))
    }
  }

  el.onclick = (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return undefined
    const { action, id } = b.dataset
    switch (action) {
      case 'start':
        return run(async () => {
          await services.submissions.start(allocationId)
        }, 'เปิดร่างแล้ว — เขียนงาน แนบไฟล์หรือลิงก์ แล้วกด “ส่งงาน”')
      case 'add-link': {
        const form = b.closest('form')
        const box = form.querySelector('[data-links]')
        if (box.querySelectorAll('[data-link-row]').length >= MAX_LINKS)
          return render(
            form.querySelector('[data-form-error]'),
            alertBox(`แนบลิงก์ได้ไม่เกิน ${MAX_LINKS} ลิงก์`)
          )
        const holder = document.createElement('div')
        render(holder, linkRow())
        box.append(holder.firstElementChild)
        return undefined
      }
      case 'remove-link': {
        const form = b.closest('form')
        const rows = form.querySelectorAll('[data-link-row]')
        if (rows.length <= 1) {
          rows[0].querySelectorAll('input').forEach((i) => (i.value = ''))
          return undefined
        }
        b.closest('[data-link-row]').remove()
        return undefined
      }
      case 'remove-file': {
        const file = detail.files.find((f) => f.id === id)
        return run(() => services.submissions.removeFile(file), `เอาไฟล์ “${file.file_name}” ออกแล้ว`)
      }
    }
    return undefined
  }

  bindFilePickers(el)
  draw()
  return undefined
}

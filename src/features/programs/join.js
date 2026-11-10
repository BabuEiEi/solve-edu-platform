import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, loading } from '../../shared/ui/components.js'
import { confirmDialog } from '../../shared/ui/dialog.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDate, formatThaiDateTime } from '../../shared/utils/date.js'

// #/join — "รุ่นของฉัน" (cohorts the person is a trainee of, to choose courses —
// my_cohort_courses, also those closed to joining) and the cohorts open for
// joining (list_open_cohorts). The server decides what is open, who may join and
// what may be enrolled (request_cohort_join, enroll_in_course) — this page only shows it.

const small = 'rounded-lg px-4 py-2 text-sm font-semibold'
const primary = `${small} bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:opacity-60`
const secondary = `${small} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 disabled:opacity-60`

/**
 * What a card offers, from the person's own status in the cohort.
 *   member   already a trainee (choose courses)
 *   waiting  a request is waiting for a manager
 *   again    was taken out once: must ask again, even in a cohort that is open (the server decides the same)
 *   full     no seat left (for someone who has not been in)
 *   join     joins at once (open cohort)
 *   request  asks a manager to accept (approval cohort)
 */
export function joinAction(cohort) {
  const mine = cohort.my_status
  if (mine === 'active') return 'member'
  if (mine === 'requested') return 'waiting'
  if (mine === 'withdrawn') return 'again'
  if (cohort.seats_left === 0) return 'full'
  return cohort.enrollment_mode === 'open' ? 'join' : 'request'
}

/** A course row of "รุ่นของฉัน": enrolled (or finished) / may enroll / cohort no longer running. */
export function courseState(cohort, course) {
  if (course.enrollment_status === 'completed') return 'completed'
  if (course.enrollment_status === 'active') return 'enrolled'
  return cohort.can_enroll ? 'can-enroll' : 'closed'
}

const seatsText = (c) =>
  c.seats_left === null || c.seats_left === undefined
    ? ''
    : c.seats_left === 0
      ? 'ที่นั่งเต็มแล้ว'
      : `เหลือ ${c.seats_left.toLocaleString('th-TH')} ที่นั่ง`

export async function renderOpenCohortsView(el, { services, refresh }) {
  render(el, html`${pageHeader('รุ่นที่เปิดรับสมัคร')}${loading}`)
  let cohorts // open for joining (minus the ones the person is already in)
  let mine // the person's own cohorts with their courses
  let message = null
  let tone = 'success'
  let busy = false

  const load = async () => {
    const [list, own] = await Promise.all([
      services.programs.listOpenCohorts(),
      services.programs.myCohortCourses(),
    ])
    mine = own
    const inside = new Set(own.map((c) => c.cohort_id))
    cohorts = list.filter((c) => !inside.has(c.cohort_id) && c.my_status !== 'active')
  }
  try {
    await load()
  } catch (err) {
    return render(el, html`${pageHeader('รุ่นที่เปิดรับสมัคร')}${alertBox(toUserMessage(err))}`)
  }

  const courseTitles = (c) =>
    c.courses?.length
      ? html`<ul class="mt-3 list-inside list-disc text-sm text-ink-700" data-courses>
          ${c.courses.map((course) => html`<li data-course="${course.id}">${course.title}</li>`)}
        </ul>`
      : html`<p class="mt-3 text-sm text-ink-500">รุ่นนี้ยังไม่มีหลักสูตรที่เปิดให้ลงทะเบียน</p>`

  const myCourses = (c) =>
    c.courses?.length
      ? html`<ul class="mt-3 divide-y divide-ink-100 rounded-lg border border-ink-100" data-courses>
          ${c.courses.map((course) => {
            const state = courseState(c, course)
            return html`<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-course="${course.id}">
              <span class="text-ink-800">${course.title}</span>
              ${
                state === 'enrolled' || state === 'completed'
                  ? html`<span class="flex items-center gap-3"
                      ><span class="text-xs font-medium text-emerald-700">${state === 'completed' ? 'เรียนจบแล้ว' : 'ลงทะเบียนแล้ว'}</span
                      ><a href="#/courses/${course.id}" class="text-sm text-brand-700 hover:underline" data-action-link="open-course">เปิดเรียน</a></span
                    >`
                  : state === 'can-enroll'
                    ? html`<button type="button" class="${secondary}" data-action="enroll" data-cohort="${c.cohort_id}" data-course="${course.id}">
                        ลงทะเบียนหลักสูตรนี้
                      </button>`
                    : html`<span class="text-xs text-ink-400">รุ่นนี้ปิดแล้ว — ติดต่อผู้จัดการรุ่น</span>`
              }
            </li>`
          })}
        </ul>`
      : html`<p class="mt-3 text-sm text-ink-500">โครงการของรุ่นนี้ยังไม่มีหลักสูตรที่เผยแพร่</p>`

  const actionOf = (c) => {
    switch (joinAction(c)) {
      case 'member':
        return html`<p class="text-sm font-medium text-emerald-700" data-status="member">ท่านอยู่ในรุ่นนี้แล้ว — ดูที่ "รุ่นของฉัน"</p>`
      case 'waiting':
        return html`<div class="flex flex-wrap items-center gap-3" data-status="waiting">
          <span class="text-sm font-medium text-amber-800">ส่งคำขอแล้ว รอผู้จัดการรุ่นอนุมัติ</span>
          <button type="button" class="${secondary}" data-action="cancel" data-cohort="${c.cohort_id}">ถอนคำขอ</button>
        </div>`
      case 'again':
        return html`<div class="space-y-2" data-status="again">
          <p class="text-xs text-ink-500">ท่านเคยถูกนำออกจากรุ่นนี้ จึงต้องรอผู้จัดการรุ่นอนุมัติใหม่</p>
          <button type="button" class="${primary}" data-action="request" data-cohort="${c.cohort_id}">ขอเข้ารุ่นอีกครั้ง</button>
        </div>`
      case 'full':
        return html`<p class="text-sm font-medium text-rose-700" data-status="full">ที่นั่งเต็มแล้ว</p>`
      case 'join':
        return html`<button type="button" class="${primary}" data-action="join" data-cohort="${c.cohort_id}">สมัครเข้ารุ่นนี้</button>`
      default:
        return html`<div class="space-y-2">
          <p class="text-xs text-ink-500">รุ่นนี้ต้องให้ผู้จัดการอนุมัติก่อน ท่านจะเรียนได้เมื่อได้รับอนุมัติ</p>
          <button type="button" class="${primary}" data-action="request" data-cohort="${c.cohort_id}">ขอเข้ารุ่นนี้</button>
        </div>`
    }
  }

  const heading = (c) => html`<p class="text-xs font-semibold uppercase tracking-wide text-brand-600">
      ${c.program_name} · ปีงบประมาณ ${c.fiscal_year}
    </p>
    <h3 class="mt-1 text-lg font-semibold text-ink-900">
      ${c.cohort_name} <span class="text-sm font-normal text-ink-400">(${c.cohort_code})</span>
    </h3>
    <p class="text-sm text-ink-500">${c.owner_org ?? ''}</p>`

  const draw = () =>
    render(
      el,
      html`${pageHeader('รุ่นที่เปิดรับสมัคร', 'เลือกรุ่นที่ต้องการเข้าร่วม แล้วเลือกลงทะเบียนหลักสูตรของรุ่นที่ท่านอยู่')}
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        ${
          mine.length
            ? html`<section class="mb-6" data-my-cohorts aria-labelledby="mine-title">
                <h2 id="mine-title" class="mb-3 text-base font-semibold text-ink-900">รุ่นของฉัน</h2>
                <div class="space-y-4">
                  ${mine.map(
                    (
                      c
                    ) => html`<article class="rounded-xl border border-emerald-200 bg-white p-5" data-cohort="${c.cohort_id}" data-mine>
                      ${heading(c)}
                      <p class="mt-2 text-sm text-ink-600">อบรม ${formatThaiDate(c.start_at)} – ${formatThaiDate(c.end_at)}</p>
                      ${myCourses(c)}
                    </article>`
                  )}
                </div>
              </section>`
            : ''
        }
        <section data-open-section aria-labelledby="open-title">
          <h2 id="open-title" class="mb-3 text-base font-semibold text-ink-900">เปิดรับสมัครอยู่ตอนนี้</h2>
          ${
            cohorts.length === 0
              ? emptyState('ขณะนี้ยังไม่มีรุ่นที่เปิดรับสมัคร')
              : html`<div class="space-y-4" data-open-cohorts>
                  ${cohorts.map(
                    (
                      c
                    ) => html`<article class="rounded-xl border border-ink-200 bg-white p-5" data-cohort="${c.cohort_id}">
                      ${heading(c)}
                      <p class="mt-2 text-sm text-ink-600">
                        อบรม ${formatThaiDate(c.start_at)} – ${formatThaiDate(c.end_at)}
                        ${c.enroll_until ? html` · ปิดรับสมัคร ${formatThaiDateTime(c.enroll_until)}` : ''}
                        ${seatsText(c) ? html` · <span data-seats>${seatsText(c)}</span>` : ''}
                      </p>
                      ${courseTitles(c)}
                      <div class="mt-4">${actionOf(c)}</div>
                    </article>`
                  )}
                </div>`
          }
        </section>`
    )

  /** Run one action; on any outcome reload (seats and statuses may have changed). */
  const run = async (fn, ok) => {
    if (busy) return
    busy = true
    try {
      const out = await fn()
      if (out === 'active') {
        // a trainee now: the menu (tests, tasks) and the page need the new role — reload the account
        busy = false
        if (refresh) return await refresh()
      }
      message = out === 'requested' ? 'ส่งคำขอเข้ารุ่นแล้ว รอผู้จัดการรุ่นอนุมัติ' : ok
      tone = 'success'
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
    }
    try {
      await load()
    } catch {
      /* keep the last list */
    }
    busy = false
    return draw()
  }

  draw()

  el.onclick = async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b) return undefined
    const { action, cohort, course } = b.dataset
    const c = [...cohorts, ...mine].find((x) => x.cohort_id === cohort)
    if (action === 'join') {
      const ok = await confirmDialog({
        title: `เข้าร่วมรุ่น “${c?.cohort_name ?? ''}”?`,
        text: 'ท่านจะเป็นผู้เข้าอบรมของรุ่นนี้ทันที และเลือกลงทะเบียนหลักสูตรของรุ่นได้',
        confirmText: 'เข้าร่วม',
      })
      if (!ok) return undefined
      return run(() => services.programs.requestJoin(cohort), 'เข้าร่วมรุ่นแล้ว')
    }
    if (action === 'request') return run(() => services.programs.requestJoin(cohort), 'ส่งคำขอแล้ว')
    if (action === 'cancel') {
      const ok = await confirmDialog({ title: 'ถอนคำขอเข้ารุ่นนี้?', confirmText: 'ถอนคำขอ', danger: true })
      if (!ok) return undefined
      return run(() => services.programs.cancelRequest(cohort), 'ถอนคำขอแล้ว')
    }
    if (action === 'enroll')
      return run(async () => {
        await services.programs.enroll(cohort, course)
      }, 'ลงทะเบียนหลักสูตรแล้ว — กด “เปิดเรียน” ได้เลย')
    return undefined
  }
  return undefined
}

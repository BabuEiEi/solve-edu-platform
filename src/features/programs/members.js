import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, loading } from '../../shared/ui/components.js'
import { confirmDialog } from '../../shared/ui/dialog.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDate } from '../../shared/utils/date.js'
import { COHORT_STATUS, joiningHint } from './logic.js'

// #/programs/:id/cohorts/:cohortId — who is in a cohort and which courses they
// are enrolled in (Phase 4g step 3). Offered to whoever may manage the cohort
// (programme managers, Staff, its coordinators); the database decides each write.

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const small = 'rounded-md px-3 py-1.5 text-xs font-semibold'
const secondary = `${small} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 disabled:opacity-60`
const primary = `${small} bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60`
const danger = `${small} border border-rose-200 bg-white text-rose-700 hover:bg-rose-50`
const backLink = 'text-sm text-brand-700 hover:underline'

export const ROLE_ORDER = ['trainer', 'coordinator', 'mentor', 'trainee']
const ROLE_GROUP = {
  trainer: 'วิทยากร',
  coordinator: 'ผู้ประสานงานรุ่น',
  mentor: 'ครูพี่เลี้ยง',
  trainee: 'ผู้เข้าอบรม',
}

const personName = (p) => (p?.full_name || p?.display_name || '').trim() || 'ไม่ทราบชื่อ'
const personLine = (p) =>
  html`<span class="font-medium text-ink-800">${personName(p)}</span>${
    p?.user_code ? html` <span class="font-mono text-xs text-ink-500">${p.user_code}</span>` : ''
  }${p?.email ? html`<span class="block text-xs text-ink-500">${p.email}</span>` : ''}`

/** May the caller change this cohort's people? (a hint for the buttons; RLS decides) */
export function canManageCohort(caps, context, cohortId) {
  if (caps?.canAdministerPrograms) return true
  return (context?.cohortMemberships ?? []).some(
    (m) => m.cohort_id === cohortId && m.cohort_role === 'coordinator' && (m.status ?? 'active') === 'active'
  )
}

/** Roles the caller may give (a coordinator may not make another coordinator — authz.can_grant_cohort_role). */
export function grantableCohortRoles(caps) {
  return caps?.canAdministerPrograms
    ? ['trainee', 'trainer', 'mentor', 'coordinator']
    : ['trainee', 'trainer', 'mentor']
}

/** Members by role (active only), requests, and the enrollment grid of the active trainees. */
export function rosterView({ members = [], enrollments = [] }, courses = []) {
  const active = members.filter((m) => m.status === 'active')
  const byRole = Object.fromEntries(ROLE_ORDER.map((r) => [r, active.filter((m) => m.cohort_role === r)]))
  const requests = members.filter((m) => m.status === 'requested' && m.cohort_role === 'trainee')
  const enrollmentOf = new Map(enrollments.map((e) => [`${e.user_id}:${e.course_id}`, e]))
  const trainees = byRole.trainee
  const grid = trainees.map((m) => ({
    member: m,
    cells: courses.map((c) => ({ course: c, enrollment: enrollmentOf.get(`${m.user_id}:${c.id}`) ?? null })),
  }))
  return { byRole, requests, grid, activeIds: new Set(active.map((m) => `${m.user_id}:${m.cohort_role}`)) }
}

export async function renderCohortMembersView(el, { services, caps, context }, { id: programId, cohortId }) {
  render(el, html`${pageHeader('สมาชิกรุ่น')}${loading}`)
  let data
  let message = null
  let tone = 'success'
  let busy = false
  let search = { q: '', results: null, error: '' }
  const can = canManageCohort(caps, context, cohortId)
  const withEmail = Boolean(caps?.canApproveUsers) // account managers search e-mails too

  const load = async () => {
    data = await services.programs.getCohortRoster(cohortId)
  }
  try {
    await load()
  } catch (err) {
    return render(el, html`${pageHeader('สมาชิกรุ่น')}${alertBox(toUserMessage(err))}`)
  }
  if (!data || data.cohort.program_id !== programId)
    return render(
      el,
      html`<a href="#/programs" class="${backLink}">← โครงการและรุ่น</a>${pageHeader('ไม่พบรุ่น')}${emptyState('ไม่พบรุ่นนี้ หรือท่านไม่มีสิทธิ์')}`
    )

  const courses = () =>
    [...(data.cohort.programs?.program_courses ?? [])]
      .sort((a, b) => a.display_order - b.display_order)
      .map((pc) => pc.courses)
      .filter(Boolean)

  const requestsSection = (requests) =>
    requests.length
      ? html`<section class="rounded-xl border border-amber-200 bg-amber-50/40 p-5" data-requests aria-labelledby="req-title">
          <h2 id="req-title" class="text-base font-semibold text-ink-900">คำขอเข้ารุ่น (${requests.length})</h2>
          <ul class="mt-3 divide-y divide-amber-100">
            ${requests.map(
              (
                m
              ) => html`<li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-request-id="${m.id}">
                <span>${personLine(m.profiles)} <span class="block text-xs text-ink-500">ขอเมื่อ ${formatThaiDate(m.created_at)}</span></span>
                ${
                  can
                    ? html`<span class="flex gap-2">
                        <button type="button" class="${primary}" data-action="accept" data-id="${m.id}">รับเข้ารุ่น</button>
                        <button type="button" class="${danger}" data-action="decline" data-id="${m.id}">ไม่รับ</button>
                      </span>`
                    : ''
                }
              </li>`
            )}
          </ul>
        </section>`
      : ''

  const addSection = (activeIds) =>
    can
      ? html`<section class="rounded-xl border border-ink-200 bg-white p-5" data-add-people aria-labelledby="add-title">
          <h2 id="add-title" class="text-base font-semibold text-ink-900">เพิ่มคนเข้ารุ่น</h2>
          <form data-form="people-search" class="mt-2 flex flex-wrap items-end gap-2" role="search">
            <label class="${label} min-w-0 flex-1 basis-60"
              >ค้นหา<input
                name="q"
                type="search"
                value="${search.q}"
                placeholder="${withEmail ? 'ชื่อ อีเมล หรือรหัสประจำตัว' : 'ชื่อ หรือรหัสประจำตัว'}"
                class="${input}"
            /></label>
            <button type="submit" class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">ค้นหา</button>
          </form>
          ${search.error ? html`<div class="mt-2">${alertBox(search.error)}</div>` : ''}
          ${
            search.results
              ? search.results.length
                ? html`<ul class="mt-3 divide-y divide-ink-100 rounded-lg border border-ink-100" data-search-results>
                    ${search.results.map(
                      (
                        p
                      ) => html`<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-person-id="${p.id}">
                        <span>${personLine(p)}</span>
                        <form data-form="add-member" data-user="${p.id}" class="flex items-center gap-2">
                          <label class="sr-only" for="role-${p.id}">บทบาท</label>
                          <select id="role-${p.id}" name="role" class="rounded-md border border-ink-200 px-2 py-1 text-xs">
                            ${grantableCohortRoles(caps).map(
                              (r) =>
                                html`<option value="${r}" ${activeIds.has(`${p.id}:${r}`) ? html`disabled` : ''}>${ROLE_GROUP[r]}${activeIds.has(`${p.id}:${r}`) ? ' (อยู่แล้ว)' : ''}</option>`
                            )}
                          </select>
                          <button type="submit" class="${primary}">เพิ่ม</button>
                        </form>
                      </li>`
                    )}
                  </ul>`
                : html`<p class="mt-3 text-sm text-ink-500">ไม่พบบัญชีที่ตรงกัน</p>`
              : ''
          }
        </section>`
      : ''

  const membersSection = (
    byRole
  ) => html`<section class="rounded-xl border border-ink-200 bg-white p-5" data-members aria-labelledby="mem-title">
    <h2 id="mem-title" class="text-base font-semibold text-ink-900">สมาชิก</h2>
    ${ROLE_ORDER.map(
      (r) => html`<div class="mt-3" data-role-group="${r}">
        <h3 class="text-sm font-medium text-ink-600">${ROLE_GROUP[r]} (${byRole[r].length})</h3>
        ${
          byRole[r].length
            ? html`<ul class="mt-1 divide-y divide-ink-100 rounded-lg border border-ink-100">
                ${byRole[r].map(
                  (
                    m
                  ) => html`<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-member-id="${m.id}">
                    <span>${personLine(m.profiles)}</span>
                    ${can ? html`<button type="button" class="${danger}" data-action="remove" data-id="${m.id}">นำออกจากรุ่น</button>` : ''}
                  </li>`
                )}
              </ul>`
            : html`<p class="mt-1 text-xs text-ink-400">—</p>`
        }
      </div>`
    )}
  </section>`

  const enrollSection = (
    grid
  ) => html`<section class="rounded-xl border border-ink-200 bg-white p-5" data-enrollments aria-labelledby="enr-title">
    <h2 id="enr-title" class="text-base font-semibold text-ink-900">การลงทะเบียนหลักสูตร</h2>
    <p class="mt-1 text-xs text-ink-500">ลงทะเบียนทีละหลักสูตร · ผู้เข้าอบรมกดลงทะเบียนเองได้เช่นกัน (หลักสูตรที่เผยแพร่แล้ว) · ยกเลิกแล้วความก้าวหน้าการเรียนยังเก็บไว้</p>
    ${
      !courses().length
        ? html`<p class="mt-3 text-sm text-ink-500">โครงการนี้ยังไม่มีหลักสูตร — เพิ่มได้ที่หน้าโครงการ</p>`
        : !grid.length
          ? html`<p class="mt-3 text-sm text-ink-500">ยังไม่มีผู้เข้าอบรมในรุ่นนี้</p>`
          : html`<div class="relative mt-3 overflow-x-auto rounded-lg border border-ink-100">
              <table class="min-w-full text-sm">
                <thead class="bg-ink-50 text-left text-xs text-ink-500">
                  <tr>
                    <th scope="col" class="px-3 py-2 font-medium">ผู้เข้าอบรม</th>
                    ${courses().map(
                      (c) => html`<th scope="col" class="px-3 py-2 font-medium" data-course-col="${c.id}">
                        ${c.title}
                        ${
                          can
                            ? html`<button type="button" class="ml-1 text-brand-700 hover:underline" data-action="enroll-all" data-course="${c.id}">ลงทะเบียนทุกคน</button>`
                            : ''
                        }
                      </th>`
                    )}
                  </tr>
                </thead>
                <tbody class="divide-y divide-ink-100">
                  ${grid.map(
                    (row) => html`<tr data-trainee="${row.member.user_id}">
                      <td class="px-3 py-2">${personLine(row.member.profiles)}</td>
                      ${row.cells.map((cell) => {
                        const e = cell.enrollment
                        const on = e && e.status !== 'withdrawn'
                        return html`<td class="px-3 py-2" data-cell="${cell.course.id}">
                          ${
                            on
                              ? html`<span class="text-xs font-medium text-emerald-700">${e.status === 'completed' ? 'เรียนจบแล้ว' : 'ลงทะเบียนแล้ว'}</span>
                                  ${can && e.status === 'active' ? html`<button type="button" class="ml-1 text-xs text-rose-700 hover:underline" data-action="unenroll" data-id="${e.id}">ยกเลิก</button>` : ''}`
                              : can
                                ? html`<button type="button" class="${secondary}" data-action="enroll" data-course="${cell.course.id}" data-user="${row.member.user_id}">ลงทะเบียน</button>`
                                : html`<span class="text-xs text-ink-400">—</span>`
                          }
                        </td>`
                      })}
                    </tr>`
                  )}
                </tbody>
              </table>
            </div>`
    }
  </section>`

  const draw = () => {
    const program = data.cohort.programs
    const v = rosterView(data, courses())
    const hint = joiningHint(program ?? {}, data.cohort)
    render(
      el,
      html`<a href="#/programs/${programId}" class="${backLink}">← ${program?.name ?? 'โครงการ'}</a>
        <div class="mt-3">${pageHeader(`${data.cohort.name} (${data.cohort.code})`, `สถานะ: ${COHORT_STATUS[data.cohort.status] ?? data.cohort.status} · ${hint.text}`)}</div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <div class="space-y-4">${requestsSection(v.requests)} ${addSection(v.activeIds)} ${membersSection(v.byRole)} ${enrollSection(v.grid)}</div>`
    )
  }

  const run = async (fn, ok) => {
    if (busy) return
    busy = true
    try {
      await fn()
      await load()
      message = ok
      tone = 'success'
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
      try {
        await load()
      } catch {
        /* keep the last view */
      }
    } finally {
      busy = false
      draw()
    }
  }

  draw()

  el.onsubmit = async (e) => {
    e.preventDefault()
    const form = e.target
    if (form.dataset.form === 'people-search') {
      const q = String(new FormData(form).get('q') ?? '')
      search = { q, results: null, error: '' }
      try {
        search.results = (await services.programs.searchPeople(q, { withEmail })) ?? []
      } catch (err) {
        search.error = toUserMessage(err)
      }
      return draw()
    }
    if (form.dataset.form === 'add-member') {
      const role = String(new FormData(form).get('role') ?? 'trainee')
      return run(
        () => services.programs.addMember(cohortId, form.dataset.user, role),
        `เพิ่มเป็น${ROLE_GROUP[role] ?? ''}แล้ว`
      )
    }
    return undefined
  }

  el.onclick = async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b || !can) return undefined
    const action = b.dataset.action
    if (action === 'accept')
      return run(() => services.programs.decideRequest(b.dataset.id, true), 'รับเข้ารุ่นแล้ว')
    if (action === 'decline') {
      if (!(await confirmDialog({ title: 'ไม่รับคำขอเข้ารุ่นนี้?', confirmText: 'ไม่รับ', danger: true })))
        return undefined
      return run(() => services.programs.decideRequest(b.dataset.id, false), 'ปฏิเสธคำขอแล้ว')
    }
    if (action === 'remove') {
      const m = data.members.find((x) => x.id === b.dataset.id)
      const ok = await confirmDialog({
        title: `นำ ${personName(m?.profiles)} ออกจากรุ่น?`,
        text: 'ประวัติและผลการเรียนยังเก็บไว้ เพิ่มกลับเข้ารุ่นได้ภายหลัง ถ้ารุ่นเปิดรับสมัคร คนนี้ต้องขออนุมัติใหม่',
        confirmText: 'นำออก',
        danger: true,
      })
      if (!ok) return undefined
      return run(() => services.programs.setMemberStatus(b.dataset.id, 'withdrawn'), 'นำออกจากรุ่นแล้ว')
    }
    if (action === 'enroll')
      return run(() => services.programs.enroll(cohortId, b.dataset.course, b.dataset.user), 'ลงทะเบียนแล้ว')
    if (action === 'unenroll') {
      if (
        !(await confirmDialog({
          title: 'ยกเลิกการลงทะเบียนหลักสูตรนี้?',
          text: 'ความก้าวหน้าการเรียนยังเก็บไว้ ลงทะเบียนใหม่ได้ภายหลัง',
          confirmText: 'ยกเลิกการลงทะเบียน',
          danger: true,
        }))
      )
        return undefined
      return run(() => services.programs.withdrawEnrollment(b.dataset.id), 'ยกเลิกการลงทะเบียนแล้ว')
    }
    if (action === 'enroll-all') {
      const courseId = b.dataset.course
      const missing = rosterView(data, courses()).grid.filter((row) => {
        const e = row.cells.find((c) => c.course.id === courseId)?.enrollment
        return !e || e.status === 'withdrawn'
      })
      if (!missing.length) {
        message = 'ทุกคนลงทะเบียนหลักสูตรนี้แล้ว'
        tone = 'success'
        return draw()
      }
      return run(async () => {
        for (const row of missing) await services.programs.enroll(cohortId, courseId, row.member.user_id)
      }, `ลงทะเบียนแล้ว ${missing.length} คน`)
    }
    return undefined
  }
  return undefined
}

import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { navigate } from '../../core/router.js'
import { computeCourseCompletion } from './service.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'

/** Orgs in which the caller may create courses (authz.can_create_course_in_org re-checks). */
async function courseOwnerOrgs({ caps, context, services }) {
  if (caps.isPlatformAdmin) return services.organizations.listActiveOrganizations()
  const seen = new Map()
  for (const m of context.orgMemberships ?? [])
    if (['district_admin', 'supervisor'].includes(m.org_role) && m.organizations)
      seen.set(m.organizations.id, m.organizations)
  return [...seen.values()]
}

export async function renderCoursesView(el, ctx) {
  const { services, caps } = ctx
  let creating = false
  let orgs = []
  let message = null

  render(el, html`${pageHeader('หลักสูตร')}${loading}`)
  let courses
  try {
    courses = await services.courses.listVisibleCourses()
  } catch (err) {
    return render(el, html`${pageHeader('หลักสูตร')}${alertBox(toUserMessage(err))}`)
  }

  const createForm = () =>
    html`<form data-form="create-course" class="mb-6 grid gap-4 rounded-xl border border-brand-200 bg-white p-5 sm:grid-cols-2">
      ${message ? html`<div class="sm:col-span-2">${alertBox(message)}</div>` : ''}
      <label class="${label} sm:col-span-2"
        >หน่วยงานเจ้าของหลักสูตร
        <select name="owner_org_id" required class="${input}">
          ${orgs.length !== 1 ? html`<option value="">— เลือกหน่วยงาน —</option>` : ''}
          ${orgs.map((o) => html`<option value="${o.id}">${o.name}</option>`)}
        </select>
      </label>
      <label class="${label}">รหัสหลักสูตร<input name="code" required maxlength="50" class="${input}" /></label>
      <label class="${label}"
        >ระยะเวลา (นาที)<input name="duration_minutes" type="number" min="0" class="${input}"
      /></label>
      <label class="${label} sm:col-span-2"
        >ชื่อหลักสูตร<input name="title" required maxlength="300" class="${input}"
      /></label>
      <label class="${label} sm:col-span-2">คำอธิบายสั้น<input name="summary" maxlength="500" class="${input}" /></label>
      <div class="flex gap-2">
        <button
          type="submit"
          class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          สร้างเป็นฉบับร่าง
        </button>
        <button
          type="button"
          data-action="cancel-create"
          class="rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50"
        >
          ยกเลิก
        </button>
      </div>
    </form>`

  const draw = () =>
    render(
      el,
      html`
        <div class="flex flex-wrap items-start justify-between gap-3">
          ${pageHeader('หลักสูตร', 'แสดงหลักสูตรที่ท่านลงทะเบียน ดูแล หรือได้รับมอบหมาย')}
          ${
            caps?.canCreateCourses && !creating
              ? html`<button
                data-action="create-course"
                class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
              >
                + สร้างหลักสูตรใหม่
              </button>`
              : ''
          }
        </div>
        ${creating ? createForm() : ''}
        ${
          courses.length === 0
            ? emptyState('ยังไม่มีหลักสูตรที่ท่านเข้าถึงได้')
            : html`<div class="grid gap-4 sm:grid-cols-2">
              ${courses.map(
                (c) =>
                  html`<a
                    href="#/courses/${c.id}"
                    class="group rounded-xl border border-ink-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-xs font-semibold text-brand-600">${c.code}</span>${statusBadge(c.status)}
                    </div>
                    <h2 class="mt-2 font-semibold text-ink-900 group-hover:text-brand-700">${c.title}</h2>
                    ${c.summary ? html`<p class="mt-1 line-clamp-2 text-sm text-ink-500">${c.summary}</p>` : ''}
                    ${
                      c.duration_minutes
                        ? html`<p class="mt-3 text-xs text-ink-400">${Math.round(c.duration_minutes / 60)} ชั่วโมง</p>`
                        : ''
                    }
                  </a>`
              )}
            </div>`
        }
      `
    )

  el.onclick = async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action
    if (action === 'create-course') {
      try {
        orgs = await courseOwnerOrgs(ctx)
        message = orgs.length ? null : 'ท่านยังไม่มีหน่วยงานที่สร้างหลักสูตรได้'
      } catch (err) {
        message = toUserMessage(err)
      }
      creating = true
      draw()
    } else if (action === 'cancel-create') {
      creating = false
      message = null
      draw()
    }
  }
  el.onsubmit = async (e) => {
    if (e.target.dataset.form !== 'create-course') return
    e.preventDefault()
    const btn = e.target.querySelector('button[type=submit]')
    btn.disabled = true
    try {
      const created = await services.builder.createCourse(Object.fromEntries(new FormData(e.target)))
      navigate(`/courses/${created.id}/builder`)
    } catch (err) {
      message = toUserMessage(err)
      draw()
    }
  }
  draw()
}

/** What a learner would see: published units and lessons only. */
export function learnerOutline(course) {
  return {
    ...course,
    course_units: course.course_units
      .filter((u) => u.status === 'published')
      .map((u) => ({ ...u, lessons: u.lessons.filter((l) => l.status === 'published') })),
  }
}

export async function renderCourseOutlineView(el, { services, session }, { id, preview = false }) {
  render(el, loading)
  try {
    const [loaded, enrollments, access] = await Promise.all([
      services.courses.getCourseOutline(id),
      services.courses.listMyEnrollments(session.user.id),
      services.courses.getAccess(id),
    ])
    if (!loaded) {
      render(
        el,
        html`${pageHeader('ไม่พบหลักสูตร')}${emptyState('ไม่พบหลักสูตร หรือท่านไม่มีสิทธิ์เข้าถึง')}`
      )
      return
    }
    const course = preview ? learnerOutline(loaded) : loaded
    const enrollment = enrollments.find((e) => e.course_id === course.id)
    const progress = enrollment?.lesson_progress ?? []
    const statusOf = (lessonId) => progress.find((p) => p.lesson_id === lessonId)?.status
    const percent = enrollment && !preview ? computeCourseCompletion(course, progress) : null

    render(
      el,
      html`
        <a href="${preview ? `#/courses/${id}/builder` : '#/courses'}" class="text-sm text-brand-700 hover:underline"
          >${preview ? '← กลับไปแก้ไขหลักสูตร' : '← หลักสูตรทั้งหมด'}</a
        >
        ${
          preview
            ? html`<div class="mt-4">
              ${alertBox(
                course.status === 'published'
                  ? 'โหมดตัวอย่าง: แสดงเฉพาะหน่วยและบทเรียนที่เผยแพร่แล้ว ตามที่ผู้เรียนเห็น'
                  : 'โหมดตัวอย่าง: หลักสูตรยังเป็นฉบับร่าง — ผู้เรียนจะยังมองไม่เห็นหลักสูตรนี้ (แสดงส่วนที่เผยแพร่แล้วเพื่อตรวจทาน)',
                'info'
              )}
            </div>`
            : ''
        }
        <div class="mt-3 flex flex-wrap items-start justify-between gap-3">
          ${pageHeader(course.title, course.summary ?? '')}
          <div class="flex items-center gap-2">
            ${statusBadge(course.status)}
            ${
              access === 'manage' && !preview
                ? html`<a
                  href="#/courses/${course.id}/builder"
                  class="rounded-lg border border-brand-200 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50"
                  >แก้ไขหลักสูตร</a
                >`
                : ''
            }
          </div>
        </div>
        ${
          percent !== null
            ? html`<div class="mb-6 rounded-xl border border-ink-200 bg-white p-5">
              <div class="flex justify-between text-sm">
                <span class="text-ink-600">ความก้าวหน้าของฉัน</span
                ><span class="font-semibold text-ink-900">${percent}%</span>
              </div>
              <div
                class="mt-2 h-2 rounded-full bg-ink-100"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow="${percent}"
              >
                <div class="h-2 rounded-full bg-brand-600" style="width:${percent}%"></div>
              </div>
            </div>`
            : ''
        }
        ${course.course_units.length === 0 ? emptyState('ยังไม่มีหน่วยการเรียนรู้ที่เผยแพร่') : ''}
        <ol class="space-y-4">
          ${course.course_units.map(
            (u) =>
              html`<li class="rounded-xl border border-ink-200 bg-white">
                <div class="flex items-center justify-between border-b border-ink-100 px-5 py-3">
                  <h2 class="font-semibold text-ink-900">${u.title}</h2>
                  ${u.status !== 'published' ? statusBadge(u.status) : ''}
                </div>
                <ul class="divide-y divide-ink-100">
                  ${u.lessons.map((l) => {
                    const s = statusOf(l.id)
                    return html`<li class="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                      <a href="#/learn/${course.id}/${l.id}" class="text-ink-700 hover:text-brand-700 hover:underline"
                        >${l.title}</a
                      >
                      <span class="flex items-center gap-2">
                        ${l.status !== 'published' ? statusBadge(l.status) : ''}
                        ${
                          s === 'completed'
                            ? html`<span class="text-xs font-semibold text-emerald-700">✓ เรียนจบแล้ว</span>`
                            : s === 'in_progress'
                              ? html`<span class="text-xs text-sky-700">กำลังเรียน</span>`
                              : ''
                        }
                      </span>
                    </li>`
                  })}
                </ul>
              </li>`
          )}
        </ol>
      `
    )
  } catch (err) {
    render(el, alertBox(toUserMessage(err)))
  }
}

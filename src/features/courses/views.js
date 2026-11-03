import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { computeCourseCompletion } from './service.js'

export async function renderCoursesView(el, { services }) {
  render(el, html`${pageHeader('หลักสูตร')}${loading}`)
  try {
    const courses = await services.courses.listVisibleCourses()
    render(
      el,
      html`
        ${pageHeader('หลักสูตร', 'แสดงหลักสูตรที่ท่านลงทะเบียน ดูแล หรือได้รับมอบหมาย')}
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
                        <span class="text-xs font-semibold text-brand-600">${c.code}</span
                        >${statusBadge(c.status)}
                      </div>
                      <h2 class="mt-2 font-semibold text-ink-900 group-hover:text-brand-700">${c.title}</h2>
                      ${c.summary ? html`<p class="mt-1 line-clamp-2 text-sm text-ink-500">${c.summary}</p>` : ''}
                      ${c.duration_minutes ? html`<p class="mt-3 text-xs text-ink-400">${Math.round(c.duration_minutes / 60)} ชั่วโมง</p>` : ''}
                    </a>`
                )}
              </div>`
        }
      `
    )
  } catch (err) {
    render(el, html`${pageHeader('หลักสูตร')}${alertBox(toUserMessage(err))}`)
  }
}

export async function renderCourseOutlineView(el, { services, session }, { id }) {
  render(el, loading)
  try {
    const [course, enrollments, access] = await Promise.all([
      services.courses.getCourseOutline(id),
      services.courses.listMyEnrollments(session.user.id),
      services.courses.getAccess(id),
    ])
    if (!course) {
      render(
        el,
        html`${pageHeader('ไม่พบหลักสูตร')}${emptyState('ไม่พบหลักสูตร หรือท่านไม่มีสิทธิ์เข้าถึง')}`
      )
      return
    }
    const enrollment = enrollments.find((e) => e.course_id === course.id)
    const progress = enrollment?.lesson_progress ?? []
    const statusOf = (lessonId) => progress.find((p) => p.lesson_id === lessonId)?.status
    const percent = enrollment ? computeCourseCompletion(course, progress) : null

    render(
      el,
      html`
        <a href="#/courses" class="text-sm text-brand-700 hover:underline">← หลักสูตรทั้งหมด</a>
        <div class="mt-3 flex flex-wrap items-start justify-between gap-3">
          ${pageHeader(course.title, course.summary ?? '')}
          <div class="flex items-center gap-2">
            ${statusBadge(course.status)}
            ${
              access === 'manage'
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
                        ${s === 'completed' ? html`<span class="text-xs font-semibold text-emerald-700">✓ เรียนจบแล้ว</span>` : s === 'in_progress' ? html`<span class="text-xs text-sky-700">กำลังเรียน</span>` : ''}
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

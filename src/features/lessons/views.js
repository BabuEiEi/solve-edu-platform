import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { computeCourseCompletion } from '../courses/service.js'
import { renderBlocks } from './render.js'
import { mediaPathsOf } from './blocks.js'
import { neighbours, lessonSequence } from './service.js'

/**
 * Lesson page. Learners: read + "เรียนจบ" (records lesson_progress).
 * Course managers without an enrollment get the same page as a PREVIEW of
 * the learner view, with a banner explaining which parts are still drafts.
 */
export async function renderLessonView(el, { services, session }, { courseId, lessonId }) {
  render(el, loading)
  let course, lesson, enrollment, access, media
  try {
    ;[course, lesson, enrollment, access] = await Promise.all([
      services.courses.getCourseOutline(courseId),
      services.lessons.getLesson(lessonId),
      services.lessons.getMyEnrollment(courseId, session.user.id),
      services.courses.getAccess(courseId),
    ])
    if (!course || !lesson || lesson.course_units?.course_id !== courseId) {
      render(el, html`${pageHeader('ไม่พบบทเรียน')}${emptyState('ไม่พบบทเรียน หรือท่านไม่มีสิทธิ์เข้าถึง')}`)
      return
    }
    media = await services.media.signedUrls(mediaPathsOf(lesson.lesson_blocks))
  } catch (err) {
    render(el, alertBox(toUserMessage(err)))
    return
  }

  const canRecord = enrollment?.status === 'active'
  const isPreview = !enrollment && access === 'manage'
  let progress = enrollment?.lesson_progress ?? []
  let message = null
  let tone = 'success'

  const drafts = [
    course.status !== 'published' && 'หลักสูตร',
    lesson.course_units?.status !== 'published' && 'หน่วย',
    lesson.status !== 'published' && 'บทเรียน',
  ].filter(Boolean)

  const draw = () => {
    const mine = progress.find((p) => p.lesson_id === lessonId)
    const { prev, next } = neighbours(course, lessonId)
    const percent = enrollment ? computeCourseCompletion(course, progress) : null
    const statusOf = (id) => progress.find((p) => p.lesson_id === id)?.status
    render(
      el,
      html`
        <a href="#/courses/${courseId}" class="text-sm text-brand-700 hover:underline">← ${course.title}</a>
        ${
          isPreview
            ? html`<div class="mt-4">
              ${alertBox(
                drafts.length
                  ? `โหมดตัวอย่าง: มุมมองผู้เรียน — ${drafts.join(' / ')} ยังเป็นฉบับร่าง ผู้เรียนจะยังมองไม่เห็นจนกว่าจะเผยแพร่`
                  : 'โหมดตัวอย่าง: มุมมองผู้เรียน (ท่านไม่ได้ลงทะเบียนเรียน จึงไม่บันทึกความก้าวหน้า)',
                'info'
              )}
            </div>`
            : ''
        }
        <div class="mt-4 lg:grid lg:grid-cols-[1fr_240px] lg:gap-8">
          <article>
            <p class="text-xs font-semibold uppercase tracking-wide text-brand-600">
              ${lesson.course_units?.title ?? ''}
            </p>
            <div class="mt-1 flex flex-wrap items-start justify-between gap-3">
              <h1 class="text-2xl font-semibold tracking-tight text-ink-900">${lesson.title}</h1>
              ${lesson.status !== 'published' ? statusBadge(lesson.status) : ''}
            </div>
            ${
              lesson.learning_objectives
                ? html`<section class="mt-4 rounded-xl border border-brand-100 bg-brand-50/60 px-5 py-4 text-sm">
                  <h2 class="font-semibold text-brand-800">จุดประสงค์การเรียนรู้</h2>
                  <p class="mt-1 whitespace-pre-line text-ink-700">${lesson.learning_objectives}</p>
                </section>`
                : ''
            }
            <div class="mt-6">${renderBlocks(lesson.lesson_blocks, media)}</div>

            <footer class="mt-10 space-y-4 border-t border-ink-200 pt-6">
              ${message ? alertBox(message, tone) : ''}
              ${
                mine?.status === 'completed'
                  ? html`<p class="text-sm font-semibold text-emerald-700">
                    ✓ เรียนจบแล้ว เมื่อ ${formatThaiDateTime(mine.completed_at)}
                  </p>`
                  : canRecord
                    ? html`<button
                      data-action="complete-lesson"
                      class="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
                    >
                      ทำเครื่องหมายว่าเรียนจบบทเรียนนี้
                    </button>`
                    : enrollment
                      ? html`<p class="text-sm text-ink-500">การลงทะเบียนนี้ปิดแล้ว จึงไม่บันทึกความก้าวหน้าเพิ่ม</p>`
                      : ''
              }
              <nav class="flex flex-wrap justify-between gap-3 text-sm" aria-label="บทเรียนก่อนหน้า/ถัดไป">
                ${
                  prev
                    ? html`<a href="#/learn/${courseId}/${prev.id}" class="text-brand-700 hover:underline"
                      >← ${prev.title}</a
                    >`
                    : html`<span></span>`
                }
                ${
                  next
                    ? html`<a href="#/learn/${courseId}/${next.id}" class="text-brand-700 hover:underline"
                      >${next.title} →</a
                    >`
                    : ''
                }
              </nav>
            </footer>
          </article>

          <aside class="mt-10 lg:mt-0">
            ${
              percent !== null
                ? html`<div class="mb-4 rounded-xl border border-ink-200 bg-white p-4 text-sm">
                  <div class="flex justify-between">
                    <span class="text-ink-600">ความก้าวหน้า</span
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
            <nav aria-label="บทเรียนในหลักสูตร" class="rounded-xl border border-ink-200 bg-white p-2 text-sm">
              <ol>
                ${lessonSequence(course).map(
                  (l) =>
                    html`<li>
                      <a
                        href="#/learn/${courseId}/${l.id}"
                        class="flex items-center justify-between gap-2 rounded-lg px-3 py-2 ${
                          l.id === lessonId
                            ? 'bg-brand-50 font-semibold text-brand-800'
                            : 'text-ink-600 hover:bg-ink-50'
                        }"
                        ${l.id === lessonId ? html`aria-current="page"` : ''}
                        ><span>${l.title}</span>${
                          statusOf(l.id) === 'completed'
                            ? html`<span class="text-emerald-600" aria-label="เรียนจบแล้ว">✓</span>`
                            : ''
                        }</a
                      >
                    </li>`
                )}
              </ol>
            </nav>
          </aside>
        </div>
      `
    )
  }

  el.onclick = async (e) => {
    const b = e.target.closest('[data-action="complete-lesson"]')
    if (!b || !canRecord) return
    b.disabled = true
    try {
      const row = await services.lessons.markCompleted(enrollment.id, lessonId)
      progress = [...progress.filter((p) => p.lesson_id !== lessonId), row]
      message = 'บันทึกว่าเรียนจบแล้ว'
      tone = 'success'
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
    }
    draw()
  }

  draw()

  // Record the first visit (server stamps started_at). Failure must not block reading.
  if (canRecord && !progress.some((p) => p.lesson_id === lessonId)) {
    try {
      await services.lessons.markStarted(enrollment.id, lessonId)
      progress = [...progress, { lesson_id: lessonId, status: 'in_progress' }]
    } catch (err) {
      console.warn('[lesson] could not record start', err?.code)
    }
  }
}

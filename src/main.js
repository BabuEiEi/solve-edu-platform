import './styles/main.css'
import { supabase, isConfigured, restConfig } from './core/supabaseClient.js'
import { createAuthService } from './core/auth.js'
import { deriveCapabilities } from './core/permissions.js'
import { compileRoutes, createNavigationGuard, resolveRoute } from './core/router.js'
import { toUserMessage } from './core/errors.js'
import { html, render } from './shared/ui/html.js'
import { appShell, centeredCard, updateNavBadges } from './shared/ui/layout.js'
import { alertBox, loading, bindFilePickers } from './shared/ui/components.js'
import { createProfileService } from './features/profiles/service.js'
import { createAdminService } from './features/admin/service.js'
import { createOrganizationService } from './features/organizations/service.js'
import { createProgramService } from './features/programs/service.js'
import { createCourseService } from './features/courses/service.js'
import { createLessonService } from './features/lessons/service.js'
import { createMediaService } from './features/lessons/media.js'
import { createBuilderService } from './features/builder/service.js'
import { createPreregistrationService } from './features/preregistration/service.js'
import { createAssessmentService } from './features/assessments/service.js'
import { createQuizBuilderService } from './features/quizzes/service.js'
import { renderCourseQuizzesView, renderQuizEditorView } from './features/quizzes/views.js'
import { renderCourseRubricsView, renderRubricEditorView } from './features/rubrics/views.js'
import { createTaskService } from './features/tasks/service.js'
import { createSubmissionService } from './features/submissions/service.js'
import { createReviewService } from './features/reviews/service.js'
import { createDriveService } from './features/drive/service.js'
import { createDeletionService } from './features/deletion/service.js'
import { createNoticeService } from './features/notices/service.js'
import { renderReviewQueueView, renderTaskPeopleView, renderReviewView } from './features/reviews/views.js'
import { renderMyTasksView, renderTaskPageView } from './features/submissions/views.js'
import { renderCourseTasksView, renderTaskDetailView } from './features/tasks/views.js'
import { createAssignmentService } from './features/assignments/service.js'
import {
  renderStaffAssessmentsView,
  renderNewAssignmentView,
  renderAssignmentDetailView,
} from './features/assignments/views.js'
import { mountRichTextEditor } from './shared/ui/richTextEditor.js'
import {
  renderAuthScreen,
  renderPendingScreen,
  renderSuspendedScreen,
  renderDeletedScreen,
  renderProfileView,
} from './features/profiles/views.js'
import { renderApprovalsView } from './features/admin/views.js'
import { renderAccountsView } from './features/admin/accounts.js'
import { renderImportView } from './features/preregistration/views.js'
import {
  renderNewProgramView,
  renderProgramDetailView,
  renderProgramsView,
} from './features/programs/views.js'
import { renderCohortMembersView } from './features/programs/members.js'
import { renderOpenCohortsView } from './features/programs/join.js'
import { renderCoursesView, renderCourseOutlineView } from './features/courses/views.js'
import { renderLessonView } from './features/lessons/views.js'
import { renderCourseBuilderView, renderLessonEditorView } from './features/builder/views.js'
import {
  renderMyAssessmentsView,
  renderAssessmentView,
  renderAttemptResultView,
} from './features/assessments/views.js'
import { renderDashboard } from './features/dashboard.js'

const root = document.getElementById('app')

const routes = compileRoutes([
  { path: '/', view: renderDashboard },
  { path: '/profile', view: renderProfileView },
  { path: '/programs', view: renderProgramsView, allow: (c) => c.isActive },
  { path: '/join', view: renderOpenCohortsView, allow: (c) => c.isActive },
  { path: '/programs/new', view: renderNewProgramView, allow: (c) => c.canAdministerPrograms },
  { path: '/programs/:id', view: renderProgramDetailView, allow: (c) => c.isActive },
  { path: '/programs/:id/cohorts/:cohortId', view: renderCohortMembersView, allow: (c) => c.isActive },
  { path: '/courses', view: renderCoursesView, allow: (c) => c.isActive },
  { path: '/courses/:id', view: renderCourseOutlineView, allow: (c) => c.isActive },
  {
    path: '/courses/:id/preview',
    view: (el, ctx, p) => renderCourseOutlineView(el, ctx, { ...p, preview: true }),
    allow: (c) => c.isActive,
  },
  // Builder routes are open to active users; course_access() + RLS decide what they can do.
  { path: '/courses/:id/builder', view: renderCourseBuilderView, allow: (c) => c.isActive },
  { path: '/courses/:id/builder/lessons/:lessonId', view: renderLessonEditorView, allow: (c) => c.isActive },
  { path: '/courses/:id/quizzes', view: renderCourseQuizzesView, allow: (c) => c.isActive },
  { path: '/courses/:id/quizzes/:quizId', view: renderQuizEditorView, allow: (c) => c.isActive },
  { path: '/courses/:id/rubrics', view: renderCourseRubricsView, allow: (c) => c.isActive },
  { path: '/courses/:id/rubrics/:rubricId', view: renderRubricEditorView, allow: (c) => c.isActive },
  { path: '/courses/:id/tasks', view: renderCourseTasksView, allow: (c) => c.isActive },
  { path: '/courses/:id/tasks/:taskId', view: renderTaskDetailView, allow: (c) => c.isActive },
  { path: '/learn/:courseId/:lessonId', view: renderLessonView, allow: (c) => c.isActive },
  // start_attempt / submit_attempt + RLS decide eligibility; the guard only needs an active account.
  { path: '/tasks', view: renderMyTasksView, allow: (c) => c.isActive },
  { path: '/tasks/:allocationId', view: renderTaskPageView, allow: (c) => c.isActive },
  { path: '/assessments', view: renderMyAssessmentsView, allow: (c) => c.isActive },
  { path: '/assessments/attempts/:attemptId', view: renderAttemptResultView, allow: (c) => c.isActive },
  { path: '/assessments/:id', view: renderAssessmentView, allow: (c) => c.isActive },
  // Staff side: RLS shows each person only the cohorts they assess (or their mentees).
  { path: '/staff/tasks', view: renderReviewQueueView, allow: (c) => c.isActive },
  { path: '/staff/tasks/review/:submissionId', view: renderReviewView, allow: (c) => c.isActive },
  { path: '/staff/tasks/:allocationId', view: renderTaskPeopleView, allow: (c) => c.isActive },
  { path: '/staff/assessments', view: renderStaffAssessmentsView, allow: (c) => c.isActive },
  { path: '/staff/assessments/new/:versionId', view: renderNewAssignmentView, allow: (c) => c.isActive },
  { path: '/staff/assessments/:id', view: renderAssignmentDetailView, allow: (c) => c.isActive },
  { path: '/admin/approvals', view: renderApprovalsView, allow: (c) => c.canApproveUsers },
  { path: '/admin/accounts', view: renderAccountsView, allow: (c) => c.canApproveUsers },
  { path: '/admin/import', view: renderImportView, allow: (c) => c.canImportRoster },
])

function renderConfigMissing() {
  render(
    root,
    centeredCard(html`
      <h1 class="text-lg font-semibold text-ink-900">ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase</h1>
      <p class="mt-3 text-sm text-ink-600">
        คัดลอก <code>.env.example</code> เป็น <code>.env.local</code> แล้วใส่
        <code>VITE_SUPABASE_URL</code> และ <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> จากคำสั่ง
        <code>npx supabase start</code>
      </p>
    `)
  )
}

async function boot() {
  if (!isConfigured) return renderConfigMissing()

  const auth = createAuthService(supabase)
  const services = {
    profiles: createProfileService(supabase),
    admin: createAdminService(supabase),
    organizations: createOrganizationService(supabase),
    programs: createProgramService(supabase),
    courses: createCourseService(supabase),
    lessons: createLessonService(supabase),
    media: createMediaService(supabase),
    builder: createBuilderService(supabase),
    preregistration: createPreregistrationService(supabase),
    assessments: createAssessmentService(supabase, restConfig),
    quizzes: createQuizBuilderService(supabase),
    tasks: createTaskService(supabase),
    submissions: createSubmissionService(supabase),
    reviews: createReviewService(supabase),
    // the Google Drive copy needs a Shared Drive; off unless VITE_DRIVE_EXPORT=true (the zip replaces it)
    drive: import.meta.env.VITE_DRIVE_EXPORT === 'true' ? createDriveService(supabase) : null,
    deletion: createDeletionService(supabase),
    notices: createNoticeService(supabase),
    assignments: createAssignmentService(supabase),
    assessmentMedia: createMediaService(supabase, 'assessment-media'),
    editor: { mount: mountRichTextEditor },
  }
  let state = { session: null, context: null, caps: null }

  const refresh = async (session) => {
    root.onclick = null // drop handlers installed by auth/pending screens
    root.onsubmit = null
    state.session = session === undefined ? await auth.getSession().catch(() => null) : session
    if (!state.session) {
      state = { session: null, context: null, caps: null }
      return renderAuthScreen(root, { auth })
    }
    render(root, centeredCard(loading))
    // Apply any roster rows for this account's VERIFIED email before loading the
    // context, so a pre-registered person lands directly on an active account.
    // Failure must never block sign-in.
    await services.preregistration
      .claimMine()
      .catch((err) => console.warn('[prereg] claim skipped', err?.code))
    try {
      state.context = await services.profiles.getMyContext(state.session.user.id)
    } catch (err) {
      return render(root, centeredCard(alertBox(toUserMessage(err))))
    }
    if (!state.context.profile) {
      // Profile row is created by a DB trigger; it can lag a moment after OAuth sign-up.
      return render(root, centeredCard(alertBox('กำลังสร้างโปรไฟล์ กรุณารีเฟรชหน้าอีกครั้ง', 'info')))
    }
    state.caps = deriveCapabilities(state.context)
    const ctx = { ...state, services, auth, refresh: () => refresh() }
    if (state.caps.isDeleted) return renderDeletedScreen(root, ctx)
    if (state.caps.isSuspended) return renderSuspendedScreen(root, ctx)
    if (state.caps.isPending) return renderPendingScreen(root, ctx)
    route()
  }

  const navigation = createNavigationGuard()
  const route = async () => {
    if (!state.caps?.isActive) return
    const ticket = navigation.begin()
    // The previous page goes at once: until the next one is drawn, nothing on the
    // old page can be clicked (a click there would act on a page that is leaving).
    const leaving = document.getElementById('view')
    if (leaving) render(leaving, loading)
    const hit = resolveRoute(routes, window.location.hash, state.caps, '/')
    const currentPath = (window.location.hash || '#/').slice(1)
    const notices = await services.notices.counts() // never throws: a failure shows no badge
    if (!navigation.isCurrent(ticket)) return // a newer page was opened meanwhile: it draws, not us
    render(
      root,
      appShell({
        profile: state.context.profile,
        caps: state.caps,
        context: state.context,
        currentPath,
        notices,
      })
    )
    const refreshNotices = async () => updateNavBadges(await services.notices.counts())
    const view = document.getElementById('view')
    await hit.route.view(
      view,
      { ...state, services, auth, refresh: () => refresh(), refreshNotices },
      hit.params
    )
    if (navigation.isCurrent(ticket)) view.focus({ preventScroll: true })
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="sign-out"]') && state.caps?.isActive) {
      await auth.signOut()
      refresh(null)
    }
  })
  window.addEventListener('hashchange', route)
  bindFilePickers(root)
  auth.onChange((session) => {
    if (session?.user?.id !== state.session?.user?.id) refresh(session)
  })
  await refresh()
}

boot()

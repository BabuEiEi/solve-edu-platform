import './styles/main.css'
import { supabase, isConfigured } from './core/supabaseClient.js'
import { createAuthService } from './core/auth.js'
import { deriveCapabilities } from './core/permissions.js'
import { compileRoutes, resolveRoute } from './core/router.js'
import { toUserMessage } from './core/errors.js'
import { html, render } from './shared/ui/html.js'
import { appShell, centeredCard } from './shared/ui/layout.js'
import { alertBox, loading } from './shared/ui/components.js'
import { createProfileService } from './features/profiles/service.js'
import { createAdminService } from './features/admin/service.js'
import { createOrganizationService } from './features/organizations/service.js'
import { createProgramService } from './features/programs/service.js'
import { createCourseService } from './features/courses/service.js'
import { createLessonService } from './features/lessons/service.js'
import { createMediaService } from './features/lessons/media.js'
import {
  renderAuthScreen,
  renderPendingScreen,
  renderSuspendedScreen,
  renderProfileView,
} from './features/profiles/views.js'
import { renderApprovalsView } from './features/admin/views.js'
import { renderProgramsView } from './features/programs/views.js'
import { renderCoursesView, renderCourseOutlineView } from './features/courses/views.js'
import { renderLessonView } from './features/lessons/views.js'
import { renderDashboard } from './features/dashboard.js'

const root = document.getElementById('app')

const routes = compileRoutes([
  { path: '/', view: renderDashboard },
  { path: '/profile', view: renderProfileView },
  { path: '/programs', view: renderProgramsView, allow: (c) => c.isActive },
  { path: '/courses', view: renderCoursesView, allow: (c) => c.isActive },
  { path: '/courses/:id', view: renderCourseOutlineView, allow: (c) => c.isActive },
  { path: '/learn/:courseId/:lessonId', view: renderLessonView, allow: (c) => c.isActive },
  { path: '/admin/approvals', view: renderApprovalsView, allow: (c) => c.canApproveUsers },
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
    if (state.caps.isSuspended) return renderSuspendedScreen(root, ctx)
    if (state.caps.isPending) return renderPendingScreen(root, ctx)
    route()
  }

  const route = async () => {
    if (!state.caps?.isActive) return
    const hit = resolveRoute(routes, window.location.hash, state.caps, '/')
    const currentPath = (window.location.hash || '#/').slice(1)
    render(
      root,
      appShell({ profile: state.context.profile, caps: state.caps, context: state.context, currentPath })
    )
    const view = document.getElementById('view')
    await hit.route.view(view, { ...state, services, auth, refresh: () => refresh() }, hit.params)
    view.focus({ preventScroll: true })
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="sign-out"]') && state.caps?.isActive) {
      await auth.signOut()
      refresh(null)
    }
  })
  window.addEventListener('hashchange', route)
  auth.onChange((session) => {
    if (session?.user?.id !== state.session?.user?.id) refresh(session)
  })
  await refresh()
}

boot()

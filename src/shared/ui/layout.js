import { html, trusted } from './html.js'
import { roleChip } from './components.js'

/** Navigation entries; `show(caps)` only affects visibility — RLS enforces access. */
export const NAV_ITEMS = [
  { path: '/', label: 'ภาพรวม', icon: '◧', show: () => true },
  { path: '/programs', label: 'โครงการและรุ่น', icon: '▤', show: (c) => c.isActive },
  { path: '/courses', label: 'หลักสูตร', icon: '❏', show: (c) => c.isActive },
  { path: '/assessments', label: 'แบบทดสอบ', icon: '✎', show: (c) => c.isTrainee },
  {
    path: '/staff/assessments',
    label: 'ผลแบบทดสอบ',
    icon: '▦',
    show: (c) => c.isTrainer || c.isMentor || c.isCoordinator || c.canManagePrograms,
  },
  { path: '/admin/approvals', label: 'อนุมัติผู้ใช้', icon: '✓', show: (c) => c.canApproveUsers },
  { path: '/admin/import', label: 'นำเข้ารายชื่อ', icon: '⇪', show: (c) => c.canApproveUsers },
  { path: '/profile', label: 'โปรไฟล์ของฉัน', icon: '◉', show: () => true },
]

export function appShell({ profile, caps, currentPath, context }) {
  const roles = [...context.platformRoles.map((r) => r.role), ...caps.orgRoles, ...caps.cohortRoles].filter(
    (v, i, a) => a.indexOf(v) === i
  )
  const items = NAV_ITEMS.filter((i) => i.show(caps))
  const link = (i) => {
    const active = i.path === '/' ? currentPath === '/' : currentPath.startsWith(i.path)
    return html`<a
      href="#${i.path}"
      class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
        active ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
      }"
      ${active ? trusted('aria-current="page"') : ''}
      ><span aria-hidden="true" class="w-4 text-center">${i.icon}</span>${i.label}</a
    >`
  }

  return html`<div class="min-h-screen lg:grid lg:grid-cols-[260px_1fr]">
    <aside class="hidden border-r border-ink-200 bg-white lg:flex lg:flex-col">
      <div class="border-b border-ink-100 px-5 py-5">
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">SolveEdu</p>
        <p class="text-sm text-ink-500">Integrated Platform</p>
      </div>
      <nav class="flex-1 space-y-1 p-3" aria-label="เมนูหลัก">${items.map(link)}</nav>
      <div class="border-t border-ink-100 p-4">
        <p class="truncate text-sm font-semibold text-ink-900">
          ${profile.display_name || profile.full_name || 'ผู้ใช้งาน'}
        </p>
        <div class="mt-2 flex flex-wrap gap-1">${roles.map(roleChip)}</div>
        <button
          data-action="sign-out"
          class="mt-4 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-600 hover:bg-ink-50"
        >
          ออกจากระบบ
        </button>
      </div>
    </aside>

    <div class="flex min-w-0 flex-col">
      <header
        class="sticky top-0 z-10 flex items-center justify-between border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden"
      >
        <span class="text-sm font-semibold text-brand-700">SolveEdu</span>
        <button data-action="sign-out" class="text-sm text-ink-600">ออกจากระบบ</button>
      </header>
      <nav
        class="flex gap-1 overflow-x-auto border-b border-ink-200 bg-white px-2 py-2 lg:hidden"
        aria-label="เมนูหลัก (มือถือ)"
      >
        ${items.map(link)}
      </nav>
      <main id="view" class="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-8 sm:py-10" tabindex="-1"></main>
    </div>
  </div>`
}

export function centeredCard(content) {
  return html`<div class="flex min-h-screen items-center justify-center px-4 py-10">
    <div class="w-full max-w-md rounded-2xl border border-ink-200 bg-white p-8 shadow-sm">${content}</div>
  </div>`
}

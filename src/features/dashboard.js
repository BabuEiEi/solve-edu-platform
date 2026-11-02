import { html, render } from '../shared/ui/html.js'
import { pageHeader, roleChip } from '../shared/ui/components.js'
import { formatThaiDate } from '../shared/utils/date.js'

export function renderDashboard(el, { context, caps }) {
  const name = context.profile.display_name || context.profile.full_name || 'ผู้ใช้งาน'
  const card = (href, title, desc) =>
    html`<a
      href="${href}"
      class="rounded-xl border border-ink-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm"
    >
      <h2 class="font-semibold text-ink-900">${title}</h2>
      <p class="mt-1 text-sm text-ink-500">${desc}</p>
    </a>`

  render(
    el,
    html`
      ${pageHeader(`สวัสดี ${name}`, `วันนี้ ${formatThaiDate(new Date(), { month: 'long' })}`)}
      <section class="mb-8 rounded-xl border border-ink-200 bg-white p-5">
        <p class="text-sm text-ink-500">บทบาทของท่านในระบบ</p>
        <div class="mt-2 flex flex-wrap gap-2">
          ${[...context.platformRoles.map((r) => r.role), ...caps.orgRoles, ...caps.cohortRoles].map(roleChip)}
          ${
            !caps.orgRoles.length && !caps.cohortRoles.length && !caps.isPlatformAdmin
              ? html`<span class="text-sm text-ink-400"
                  >ยังไม่ได้รับมอบหมายบทบาท — ติดต่อผู้ดูแลหน่วยงาน</span
                >`
              : ''
          }
        </div>
      </section>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        ${caps.isTrainee ? card('#/courses', 'หลักสูตรของฉัน', 'บทเรียนที่ลงทะเบียนและความก้าวหน้า') : ''}
        ${caps.isTrainer || caps.canManagePrograms ? card('#/courses', 'จัดการหลักสูตร', 'โครงสร้างหน่วย/บทเรียน (ตัวแก้ไขใน Phase 2)') : ''}
        ${caps.isActive ? card('#/programs', 'โครงการและรุ่น', 'โครงการพัฒนาครูที่เกี่ยวข้อง') : ''}
        ${caps.canApproveUsers ? card('#/admin/approvals', 'อนุมัติผู้ใช้', 'คำขอสมัครในขอบเขตหน่วยงานของท่าน') : ''}
        ${card('#/profile', 'โปรไฟล์ของฉัน', 'ชื่อที่แสดงและสังกัด')}
      </div>
    `
  )
}

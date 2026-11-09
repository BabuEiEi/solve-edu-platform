import { html, render } from '../../shared/ui/html.js'
import { promptDialog } from '../../shared/ui/dialog.js'
import {
  pageHeader,
  emptyState,
  alertBox,
  statusBadge,
  roleChip,
  loading,
} from '../../shared/ui/components.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'

const TABS = [
  { status: 'pending', label: 'รออนุมัติ' },
  { status: 'active', label: 'ใช้งานได้' },
  { status: 'suspended', label: 'ระงับแล้ว' },
]

export async function renderApprovalsView(el, { services, session }) {
  const myId = session?.user?.id ?? null
  let tab = 'pending'
  let rows = []
  let message = null
  let tone = 'success'

  const load = async () => {
    render(el, html`${pageHeader('อนุมัติผู้ใช้')}${loading}`)
    try {
      rows = await services.admin.listProfilesByStatus(tab)
    } catch (err) {
      rows = []
      message = toUserMessage(err)
      tone = 'error'
    }
    draw()
  }

  const actionsFor = (p) => {
    // The server rejects self-changes anyway (admin_set_profile_status); don't offer them.
    if (p.id === myId) return html`<span class="text-xs text-ink-400">บัญชีของท่าน</span>`
    const btn = (status, label, cls) =>
      html`<button
        data-action="set-status"
        data-id="${p.id}"
        data-status="${status}"
        class="rounded-md px-3 py-1.5 text-xs font-semibold ${cls}"
      >
        ${label}
      </button>`
    if (p.status === 'pending')
      return [
        btn('active', 'อนุมัติ', 'bg-brand-600 text-white hover:bg-brand-700'),
        btn('suspended', 'ปฏิเสธ/ระงับ', 'border border-ink-200 text-ink-600 hover:bg-ink-50'),
      ]
    if (p.status === 'active')
      return btn('suspended', 'ระงับ', 'border border-rose-200 text-rose-700 hover:bg-rose-50')
    return btn('active', 'เปิดใช้งานอีกครั้ง', 'border border-ink-200 text-ink-700 hover:bg-ink-50')
  }

  // Pending: the school the applicant asked for. Active/suspended: current memberships.
  const affiliationOf = (p) => {
    if (tab === 'pending') return p.organizations?.name ?? '—'
    const current = (p.organization_memberships ?? []).filter((m) => !m.ended_at)
    if (current.length === 0)
      return html`<span class="text-ink-400">ยังไม่มีสังกัด</span>${
        p.organizations?.name
          ? html`<span class="block text-xs text-ink-400">ขอสังกัด: ${p.organizations.name}</span>`
          : ''
      }`
    return html`<ul class="space-y-1">
      ${current.map(
        (m) =>
          html`<li class="flex flex-wrap items-center gap-1.5">
            ${roleChip(m.org_role)}<span>${m.organizations?.name ?? '—'}</span>
          </li>`
      )}
    </ul>`
  }

  const draw = () =>
    render(
      el,
      html`
        ${pageHeader('อนุมัติผู้ใช้', 'แสดงเฉพาะบุคคลในขอบเขตหน่วยงานที่ท่านมีสิทธิ์ ทุกการเปลี่ยนสถานะถูกบันทึกใน Audit Log')}
        <div class="mb-4 flex gap-2" role="tablist">
          ${TABS.map(
            (t) =>
              html`<button
                role="tab"
                aria-selected="${String(t.status === tab)}"
                data-action="tab"
                data-status="${t.status}"
                class="rounded-full px-4 py-1.5 text-sm ${t.status === tab ? 'bg-ink-900 text-white' : 'bg-white text-ink-600 ring-1 ring-ink-200'}"
              >
                ${t.label}
              </button>`
          )}
        </div>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        ${
          rows.length === 0
            ? emptyState('ไม่มีรายการในขอบเขตของท่าน')
            : html`<div class="relative overflow-x-auto rounded-xl border border-ink-200 bg-white">
                <table class="min-w-full divide-y divide-ink-100 text-sm">
                  <thead class="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th class="px-4 py-3">ชื่อ</th>
                      <th class="px-4 py-3">${tab === 'pending' ? 'สถานศึกษาที่ขอสังกัด' : 'สังกัดปัจจุบัน'}</th>
                      <th class="px-4 py-3">สมัครเมื่อ</th>
                      <th class="px-4 py-3">สถานะ</th>
                      <th class="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-ink-100">
                    ${rows.map(
                      (p) =>
                        html`<tr>
                          <td class="px-4 py-3 font-medium text-ink-900">
                            ${p.full_name || '(ไม่ระบุชื่อ)'}
                          </td>
                          <td class="px-4 py-3 text-ink-600">${affiliationOf(p)}</td>
                          <td class="px-4 py-3 text-ink-500">${formatThaiDateTime(p.created_at)}</td>
                          <td class="px-4 py-3">${statusBadge(p.status)}</td>
                          <td class="px-4 py-3">
                            <div class="flex justify-end gap-2">${actionsFor(p)}</div>
                          </td>
                        </tr>`
                    )}
                  </tbody>
                </table>
              </div>`
        }
      `
    )

  el.onclick = async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b) return
    if (b.dataset.action === 'tab') {
      tab = b.dataset.status
      message = null
      return load()
    }
    if (b.dataset.action === 'set-status') {
      const status = b.dataset.status
      let reason = ''
      if (status === 'suspended') {
        reason =
          (await promptDialog({
            title: 'ระงับ/ปฏิเสธบัญชีนี้?',
            label: 'เหตุผล (บันทึกใน Audit Log)',
            confirmText: 'ยืนยัน',
            danger: true,
            validate: (v) => (v.trim() ? undefined : 'กรุณาระบุเหตุผล'),
          })) ?? ''
        if (!reason.trim()) return
      }
      b.disabled = true
      try {
        await services.admin.setProfileStatus(b.dataset.id, status, reason)
        message = 'บันทึกการเปลี่ยนสถานะแล้ว'
        tone = 'success'
      } catch (err) {
        message = toUserMessage(err)
        tone = 'error'
      }
      return load()
    }
  }
  await load()
}

import { html, render } from '../../shared/ui/html.js'
import { pageHeader, emptyState, alertBox, statusBadge, loading } from '../../shared/ui/components.js'
import { ROLE_LABELS } from '../../core/permissions.js'
import { toUserMessage } from '../../core/errors.js'
import { formatThaiDateTime } from '../../shared/utils/date.js'
import { analyzeRoster, MAX_ROWS } from './service.js'

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const primary =
  'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-60'
const secondary = 'rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 hover:bg-ink-50'

/** Roles the UI offers; authz.can_grant_org_role is the real gate. */
export function grantableRoles(caps) {
  if (caps.isPlatformAdmin) return ['teacher', 'school_admin', 'supervisor', 'district_admin']
  if (caps.orgRoles.includes('district_admin')) return ['teacher', 'school_admin', 'supervisor']
  return ['teacher']
}

/** Orgs the caller administers (+ their children); platform admins get every org. */
export function importableOrgs(orgs, context, caps) {
  if (caps.isPlatformAdmin) return orgs
  const mine = new Set(
    (context.orgMemberships ?? [])
      .filter((m) => ['district_admin', 'school_admin'].includes(m.org_role))
      .map((m) => m.organization_id)
  )
  return orgs.filter((o) => mine.has(o.id) || mine.has(o.parent_id))
}

export async function renderImportView(el, { services, context, caps }) {
  render(el, html`${pageHeader('นำเข้ารายชื่อล่วงหน้า')}${loading}`)
  let orgs, cohorts, pending
  try {
    const [allOrgs, programs, list] = await Promise.all([
      services.organizations.listActiveOrganizations(),
      services.programs.listVisiblePrograms(),
      services.preregistration.list('pending'),
    ])
    orgs = importableOrgs(allOrgs, context, caps)
    cohorts = programs.flatMap((p) => (p.cohorts ?? []).map((c) => ({ ...c, programName: p.name })))
    pending = list
  } catch (err) {
    return render(el, alertBox(toUserMessage(err)))
  }
  if (orgs.length === 0)
    return render(
      el,
      html`${pageHeader('นำเข้ารายชื่อล่วงหน้า')}${emptyState('ท่านไม่มีหน่วยงานที่นำเข้ารายชื่อได้')}`
    )

  const roles = grantableRoles(caps)
  let target = { organizationId: orgs[0].id, orgRole: roles[0], cohortId: '', cohortRole: 'trainee' }
  let analysis = null
  let message = null
  let tone = 'success'
  let busy = false

  const form = () =>
    html`<form data-form="roster" class="grid gap-4 rounded-xl border border-ink-200 bg-white p-5 sm:grid-cols-2">
      <label class="${label}"
        >หน่วยงาน
        <select name="organizationId" class="${input}">
          ${orgs.map((o) => html`<option value="${o.id}" ${o.id === target.organizationId ? 'selected' : ''}>${o.name}</option>`)}
        </select></label
      >
      <label class="${label}"
        >บทบาทในหน่วยงาน
        <select name="orgRole" class="${input}">
          ${roles.map((r) => html`<option value="${r}" ${r === target.orgRole ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)}
        </select></label
      >
      <label class="${label}"
        >เพิ่มเข้ารุ่น (ไม่บังคับ)
        <select name="cohortId" class="${input}">
          <option value="">— ไม่เพิ่มเข้ารุ่น —</option>
          ${cohorts.map(
            (c) =>
              html`<option value="${c.id}" ${c.id === target.cohortId ? 'selected' : ''}>${c.programName} · ${c.name}</option>`
          )}
        </select></label
      >
      <label class="${label}"
        >บทบาทในรุ่น
        <select name="cohortRole" class="${input}">
          ${['trainee', 'trainer', 'mentor', 'coordinator'].map(
            (r) =>
              html`<option value="${r}" ${r === target.cohortRole ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`
          )}
        </select></label
      >
      <label class="${label} sm:col-span-2"
        >ไฟล์ CSV (UTF-8)
        <input name="file" type="file" accept=".csv,text/csv" required class="${input}" />
      </label>
      <p class="text-xs text-ink-500 sm:col-span-2">
        แถวแรกเป็นหัวตาราง ต้องมีคอลัมน์ <code>email</code> และอาจมี <code>full_name</code> · สูงสุด ${MAX_ROWS} แถว ·
        ใช้ข้อมูลสมมติ (<code>*.example.test</code>) เมื่อทดสอบ
      </p>
      <div class="sm:col-span-2"><button class="${primary}" type="submit">ตรวจสอบไฟล์</button></div>
    </form>`

  const preview = () =>
    !analysis
      ? ''
      : html`<section class="mt-6 rounded-xl border border-ink-200 bg-white">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 p-4 text-sm">
            <p>
              <strong class="text-emerald-700">ถูกต้อง ${analysis.validCount}</strong> ·
              <strong class="${analysis.errorCount ? 'text-rose-700' : 'text-ink-500'}">มีข้อผิดพลาด ${analysis.errorCount}</strong>
              ${analysis.errorCount ? html`<span class="text-ink-500">(แถวที่ผิดจะไม่ถูกนำเข้า)</span>` : ''}
            </p>
            <div class="flex gap-2">
              <button class="${secondary}" data-action="clear-preview">ยกเลิก</button>
              <button class="${primary}" data-action="confirm-import" ${analysis.validCount && !busy ? '' : 'disabled'}>
                นำเข้า ${analysis.validCount} รายการ
              </button>
            </div>
          </div>
          <div class="max-h-96 overflow-auto">
            <table class="min-w-full divide-y divide-ink-100 text-sm">
              <thead class="bg-ink-50 text-left text-xs text-ink-500">
                <tr><th class="px-4 py-2">แถว</th><th class="px-4 py-2">อีเมล</th><th class="px-4 py-2">ชื่อ</th><th class="px-4 py-2">ผลตรวจ</th></tr>
              </thead>
              <tbody class="divide-y divide-ink-100">
                ${analysis.rows.map(
                  (r) =>
                    html`<tr class="${r.errors.length ? 'bg-rose-50/60' : ''}">
                      <td class="px-4 py-2 text-ink-400">${r.line}</td>
                      <td class="px-4 py-2">${r.email || '—'}</td>
                      <td class="px-4 py-2">${r.full_name || '—'}</td>
                      <td class="px-4 py-2 ${r.errors.length ? 'text-rose-700' : 'text-emerald-700'}">
                        ${r.errors.length ? r.errors.join(' · ') : '✓ พร้อมนำเข้า'}
                      </td>
                    </tr>`
                )}
              </tbody>
            </table>
          </div>
        </section>`

  const pendingList = () =>
    html`<h2 class="mt-10 text-lg font-semibold text-ink-900">รอผูกบัญชี (${pending.length})</h2>
      <p class="mt-1 text-xs text-ink-500">ผูกอัตโนมัติเมื่อผู้ใช้ล็อกอินครั้งแรกด้วยอีเมลที่ <strong>ยืนยันแล้ว</strong> ตรงกับรายชื่อ</p>
      ${
        pending.length === 0
          ? html`<div class="mt-3">${emptyState('ไม่มีรายการรอผูกบัญชี')}</div>`
          : html`<div class="mt-3 overflow-x-auto rounded-xl border border-ink-200 bg-white">
            <table class="min-w-full divide-y divide-ink-100 text-sm">
              <tbody class="divide-y divide-ink-100">
                ${pending.map(
                  (p) =>
                    html`<tr>
                      <td class="px-4 py-2 font-medium text-ink-800">${p.email}<span class="block text-xs font-normal text-ink-400">${p.full_name}</span></td>
                      <td class="px-4 py-2 text-ink-600">${p.organizations?.name ?? ''}<span class="block text-xs text-ink-400">${ROLE_LABELS[p.org_role]}${p.cohorts ? ` · ${p.cohorts.name}` : ''}</span></td>
                      <td class="px-4 py-2 text-xs text-ink-500">${formatThaiDateTime(p.created_at)}</td>
                      <td class="px-4 py-2">${statusBadge('pending')}</td>
                      <td class="px-4 py-2 text-right"><button class="${secondary}" data-action="cancel" data-id="${p.id}">ยกเลิก</button></td>
                    </tr>`
                )}
              </tbody>
            </table>
          </div>`
      }`

  const draw = () =>
    render(
      el,
      html`${pageHeader('นำเข้ารายชื่อล่วงหน้า', 'ลงทะเบียนครูล่วงหน้าจากไฟล์ CSV — ระบบไม่ส่งอีเมลและไม่สร้างบัญชีแทนผู้ใช้')}
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''} ${form()} ${preview()} ${pendingList()}`
    )

  const readTarget = (f) => {
    target = {
      organizationId: f.get('organizationId'),
      orgRole: f.get('orgRole'),
      cohortId: f.get('cohortId') || '',
      cohortRole: f.get('cohortRole'),
    }
  }

  const refreshPending = async () => {
    pending = await services.preregistration.list('pending')
  }

  el.onsubmit = async (e) => {
    e.preventDefault()
    const f = new FormData(e.target)
    readTarget(f)
    message = null
    analysis = null
    try {
      const file = f.get('file')
      if (!file || !file.size) throw new Error('no file')
      const existing = await services.preregistration.pendingEmails(
        target.organizationId,
        target.orgRole,
        target.cohortId || null
      )
      analysis = analyzeRoster(await file.text(), { existing })
    } catch (err) {
      message = err?.message === 'no file' ? 'กรุณาเลือกไฟล์ CSV' : toUserMessage(err)
      tone = 'error'
    }
    draw()
  }

  el.onclick = async (e) => {
    const b = e.target.closest('button[data-action]')
    if (!b || b.disabled) return
    const { action, id } = b.dataset
    if (action === 'clear-preview') {
      analysis = null
      return draw()
    }
    if (busy) return
    busy = true
    try {
      if (action === 'confirm-import') {
        const ok = analysis.rows.filter((r) => r.errors.length === 0)
        const res = await services.preregistration.importRows(ok, {
          ...target,
          cohortId: target.cohortId || null,
        })
        message = `นำเข้าแล้ว ${res.count} รายการ — จะผูกบัญชีเมื่อผู้ใช้ล็อกอินด้วยอีเมลที่ยืนยันแล้ว`
        analysis = null
      } else if (action === 'cancel') {
        await services.preregistration.cancel(id)
        message = 'ยกเลิกรายการแล้ว'
      }
      tone = 'success'
      await refreshPending()
    } catch (err) {
      message = toUserMessage(err)
      tone = 'error'
    } finally {
      busy = false
      draw()
    }
  }

  draw()
}

import { html, render } from '../../shared/ui/html.js'
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
import { ACCOUNTS_PAGE_SIZE } from './service.js'

// #/admin/accounts — search, edit name/code, change status, delete (platform admin)
// Every row carries what the database allows (can_edit / can_manage /
// can_delete): the page never offers an action the server would refuse.

const input =
  'mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30'
const label = 'block text-sm font-medium text-ink-700'
const small = 'rounded-md px-3 py-1.5 text-xs font-semibold'
const secondary = `${small} border border-ink-200 text-ink-700 hover:bg-ink-50`
const STATUS_FILTERS = [
  ['', 'ทุกสถานะ'],
  ['pending', 'รออนุมัติ'],
  ['active', 'ใช้งานได้'],
  ['suspended', 'ระงับแล้ว'],
  ['deleted', 'ถูกลบ'],
]
const sameEmail = (a, b) =>
  String(a ?? '')
    .trim()
    .toLowerCase() ===
  String(b ?? '')
    .trim()
    .toLowerCase()

export async function renderAccountsView(el, { services, caps }) {
  const state = {
    search: '',
    status: '',
    page: 0,
    total: 0,
    rows: [],
    editing: null,
    deleting: null,
    typed: '',
  }
  let message = null
  let tone = 'success'
  let rowError = ''

  const load = async () => {
    render(el, html`${pageHeader('จัดการบัญชี')}${loading}`)
    try {
      const res = await services.admin.listAccounts(state)
      state.rows = res?.rows ?? []
      state.total = Number(res?.total) || 0
    } catch (err) {
      state.rows = []
      state.total = 0
      message = toUserMessage(err)
      tone = 'error'
    }
    draw()
  }

  const affiliation = (a) => html`<ul class="space-y-1">
    ${(a.platform_roles ?? []).map((r) => html`<li>${roleChip(r)}</li>`)}
    ${(a.orgs ?? []).map(
      (o) =>
        html`<li class="flex flex-wrap items-center gap-1.5">${roleChip(o.role)}<span>${o.name}</span></li>`
    )}
    ${
      !(a.orgs ?? []).length && !(a.platform_roles ?? []).length
        ? html`<li class="text-ink-400">ยังไม่มีสังกัด${a.requested_org ? html`<span class="block text-xs">ขอสังกัด: ${a.requested_org}</span>` : ''}</li>`
        : ''
    }
  </ul>`

  const actions = (a) => {
    if (a.status === 'deleted') return html`<span class="text-xs text-ink-400">—</span>`
    const out = []
    if (a.is_self) out.push(html`<span class="text-xs text-ink-400">บัญชีของท่าน</span>`)
    if (a.can_edit)
      out.push(
        html`<button type="button" class="${secondary}" data-action="edit" data-id="${a.id}">แก้ไข</button>`
      )
    if (a.can_manage) {
      const btn = (status, text, cls) =>
        html`<button type="button" class="${small} ${cls}" data-action="set-status" data-id="${a.id}" data-status="${status}">${text}</button>`
      if (a.status === 'pending')
        out.push(btn('active', 'อนุมัติ', 'bg-brand-600 text-white hover:bg-brand-700'))
      if (a.status !== 'suspended')
        out.push(btn('suspended', 'ระงับ', 'border border-rose-200 text-rose-700 hover:bg-rose-50'))
      if (a.status === 'suspended')
        out.push(btn('active', 'เปิดใช้งานอีกครั้ง', 'border border-ink-200 text-ink-700 hover:bg-ink-50'))
    }
    if (a.can_delete)
      out.push(
        html`<button type="button" class="${small} border border-rose-300 text-rose-800 hover:bg-rose-50" data-action="delete" data-id="${a.id}">ลบบัญชี</button>`
      )
    return out
  }

  const editRow = (a) => html`<tr data-edit-row="${a.id}" class="bg-ink-50/60">
    <td colspan="6" class="px-4 py-3">
      <form data-form="account-edit" data-id="${a.id}" class="grid gap-3 sm:grid-cols-3">
        <label class="${label}">ชื่อ-นามสกุล<input name="full_name" required maxlength="200" value="${a.full_name ?? ''}" class="${input}" /></label>
        <label class="${label}">ชื่อที่แสดง<input name="display_name" maxlength="100" value="${a.display_name ?? ''}" class="${input}" /></label>
        <label class="${label}">รหัสประจำตัว<input name="user_code" maxlength="50" value="${a.user_code ?? ''}" placeholder="เช่น T-0001" class="${input}" /></label>
        <p class="text-xs text-ink-500 sm:col-span-3">รหัสประจำตัวไม่ซ้ำกัน (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ใช้ตัวอักษร ตัวเลข . _ - ไม่เว้นวรรค · เว้นว่าง = ไม่มีรหัส</p>
        ${rowError ? html`<div class="sm:col-span-3">${alertBox(rowError, 'error')}</div>` : ''}
        <div class="flex gap-2 sm:col-span-3">
          <button type="submit" class="${small} bg-brand-600 text-white hover:bg-brand-700">บันทึก</button>
          <button type="button" class="${secondary}" data-action="cancel">ยกเลิก</button>
        </div>
      </form>
    </td>
  </tr>`

  const deleteRow = (a) => {
    const ready = sameEmail(state.typed, a.email)
    return html`<tr data-delete-row="${a.id}" class="bg-rose-50/60">
      <td colspan="6" class="px-4 py-3">
        <form data-form="account-delete" data-id="${a.id}" class="space-y-3">
          <p class="text-sm text-rose-900">
            ลบบัญชี <strong>${a.full_name}</strong> อย่างถาวร: ลบชื่อ อีเมล รหัส รูปโปรไฟล์ สิทธิ์ทั้งหมด และปิดการเข้าสู่ระบบ ·
            ผลการอบรม (คะแนน งานที่ส่ง) ยังเก็บไว้แบบไม่ระบุตัว · <strong>ย้อนคืนไม่ได้</strong>
          </p>
          <label class="${label}"
            >พิมพ์อีเมลของบัญชีนี้เพื่อยืนยัน (${a.email})<input
              name="confirm_email"
              autocomplete="off"
              value="${state.typed}"
              class="${input}"
          /></label>
          ${rowError ? alertBox(rowError, 'error') : ''}
          <div class="flex gap-2">
            <button type="submit" class="${small} bg-rose-700 text-white hover:bg-rose-800 disabled:opacity-50" ${ready ? '' : html`disabled`} data-confirm-delete>
              ลบบัญชีถาวร
            </button>
            <button type="button" class="${secondary}" data-action="cancel">ยกเลิก</button>
          </div>
        </form>
      </td>
    </tr>`
  }

  const draw = () => {
    const pages = Math.max(1, Math.ceil(state.total / ACCOUNTS_PAGE_SIZE))
    render(
      el,
      html`
        ${pageHeader(
          'จัดการบัญชี',
          `แสดงเฉพาะบุคคลในขอบเขตของท่าน · แก้ชื่อและรหัสประจำตัว เปลี่ยนสถานะ${caps?.isPlatformAdmin ? ' และลบบัญชี' : ''} · ทุกการเปลี่ยนแปลงบันทึกใน Audit Log`
        )}
        <form data-form="account-search" class="mb-4 flex flex-wrap items-end gap-2" role="search">
          <label class="${label} min-w-0 flex-1 basis-60"
            >ค้นหา<input name="q" type="search" value="${state.search}" placeholder="ชื่อ อีเมล หรือรหัสประจำตัว" class="${input}"
          /></label>
          <label class="${label}"
            >สถานะ<select name="status" class="${input}">
              ${STATUS_FILTERS.map(([v, t]) => html`<option value="${v}" ${v === state.status ? html`selected` : ''}>${t}</option>`)}
            </select></label
          >
          <button type="submit" class="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">ค้นหา</button>
        </form>
        ${message ? html`<div class="mb-4">${alertBox(message, tone)}</div>` : ''}
        <p class="mb-2 text-sm text-ink-500" data-total>พบ ${state.total} บัญชี</p>
        ${
          state.rows.length === 0
            ? emptyState('ไม่พบบัญชีในขอบเขตของท่าน')
            : html`<div class="relative overflow-x-auto rounded-xl border border-ink-200 bg-white">
                <table class="min-w-full divide-y divide-ink-100 text-sm" data-accounts>
                  <thead class="bg-ink-50 text-left text-xs text-ink-500">
                    <tr>
                      <th scope="col" class="px-4 py-3">ชื่อ / อีเมล</th>
                      <th scope="col" class="px-4 py-3">รหัส</th>
                      <th scope="col" class="px-4 py-3">สังกัด / บทบาท</th>
                      <th scope="col" class="px-4 py-3">สถานะ</th>
                      <th scope="col" class="hidden px-4 py-3 md:table-cell">เข้าใช้ล่าสุด</th>
                      <th scope="col" class="hidden px-4 py-3 sm:table-cell"><span class="sr-only">การจัดการ</span></th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-ink-100">
                    ${state.rows.map(
                      (a) => html`<tr data-account-id="${a.id}">
                          <td class="px-4 py-3">
                            <span class="font-medium text-ink-900">${a.full_name || '(ไม่ระบุชื่อ)'}</span>
                            ${a.display_name ? html`<span class="block text-xs text-ink-500">${a.display_name}</span>` : ''}
                            ${a.email ? html`<span class="block text-xs text-ink-500">${a.email}</span>` : ''}
                            <div class="mt-2 flex flex-wrap gap-2 sm:hidden" data-mobile-actions>${actions(a)}</div>
                          </td>
                          <td class="whitespace-nowrap px-4 py-3 font-mono text-xs text-ink-700" data-code>${a.user_code || '—'}</td>
                          <td class="px-4 py-3 text-ink-600">${affiliation(a)}</td>
                          <td class="px-4 py-3">${statusBadge(a.status)}</td>
                          <td class="hidden whitespace-nowrap px-4 py-3 text-ink-500 md:table-cell">${a.last_sign_in_at ? formatThaiDateTime(a.last_sign_in_at) : '—'}</td>
                          <td class="hidden px-4 py-3 sm:table-cell"><div class="flex flex-wrap justify-end gap-2">${actions(a)}</div></td>
                        </tr>
                        ${state.editing === a.id ? editRow(a) : ''}${state.deleting === a.id ? deleteRow(a) : ''}`
                    )}
                  </tbody>
                </table>
              </div>
              <nav class="mt-3 flex items-center justify-between text-sm" aria-label="หน้ารายชื่อ">
                <button type="button" class="${secondary}" data-action="page" data-page="${state.page - 1}" ${state.page > 0 ? '' : html`disabled`}>← ก่อนหน้า</button>
                <span class="text-ink-500">หน้า ${state.page + 1} / ${pages}</span>
                <button type="button" class="${secondary}" data-action="page" data-page="${state.page + 1}" ${state.page + 1 < pages ? '' : html`disabled`}>ถัดไป →</button>
              </nav>`
        }
      `
    )
  }

  const find = (id) => state.rows.find((r) => r.id === id)

  el.onsubmit = async (e) => {
    const form = e.target
    e.preventDefault()
    if (form.dataset.form === 'account-search') {
      const fd = new FormData(form)
      Object.assign(state, {
        search: String(fd.get('q') ?? ''),
        status: String(fd.get('status') ?? ''),
        page: 0,
        editing: null,
        deleting: null,
      })
      message = null
      return load()
    }
    if (form.dataset.form === 'account-edit') {
      const fd = new FormData(form)
      try {
        await services.admin.updateAccount(form.dataset.id, {
          full_name: fd.get('full_name'),
          display_name: fd.get('display_name'),
          user_code: fd.get('user_code'),
        })
        state.editing = null
        rowError = ''
        message = 'บันทึกข้อมูลบัญชีแล้ว'
        tone = 'success'
        return load()
      } catch (err) {
        rowError = toUserMessage(err)
        return draw()
      }
    }
    if (form.dataset.form === 'account-delete') {
      const a = find(form.dataset.id)
      if (!a || !sameEmail(state.typed, a.email)) return undefined
      form.querySelector('[data-confirm-delete]').disabled = true
      try {
        await services.admin.deleteAccount(a.id, state.typed)
        Object.assign(state, { deleting: null, typed: '' })
        rowError = ''
        message = 'ลบบัญชีแล้ว — ข้อมูลส่วนตัวถูกลบและเข้าสู่ระบบไม่ได้อีก ผลการอบรมยังอยู่แบบไม่ระบุตัว'
        tone = 'success'
        return load()
      } catch (err) {
        rowError = toUserMessage(err)
        return draw()
      }
    }
    return undefined
  }

  el.oninput = (e) => {
    if (e.target.name !== 'confirm_email') return
    state.typed = e.target.value
    const a = find(state.deleting)
    const btn = el.querySelector('[data-confirm-delete]')
    if (a && btn) btn.disabled = !sameEmail(state.typed, a.email) // no re-render: keep the caret
  }

  el.onclick = async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b) return undefined
    const action = b.dataset.action
    if (action === 'edit') {
      Object.assign(state, { editing: b.dataset.id, deleting: null })
      rowError = ''
      return draw()
    }
    if (action === 'delete') {
      Object.assign(state, { deleting: b.dataset.id, editing: null, typed: '' })
      rowError = ''
      draw()
      el.querySelector('input[name=confirm_email]')?.focus()
      return undefined
    }
    if (action === 'cancel') {
      Object.assign(state, { editing: null, deleting: null, typed: '' })
      rowError = ''
      return draw()
    }
    if (action === 'page') {
      state.page = Math.max(0, Number(b.dataset.page) || 0)
      return load()
    }
    if (action === 'set-status') {
      const status = b.dataset.status
      let reason = ''
      if (status === 'suspended') {
        reason = window.prompt('ระบุเหตุผลในการระงับ (บันทึกใน Audit Log)') ?? ''
        if (!reason.trim()) return undefined
      }
      b.disabled = true
      try {
        await services.admin.setProfileStatus(b.dataset.id, status, reason)
        message = status === 'active' ? 'เปิดใช้งานบัญชีแล้ว' : 'ระงับบัญชีแล้ว'
        tone = 'success'
      } catch (err) {
        message = toUserMessage(err)
        tone = 'error'
      }
      return load()
    }
    return undefined
  }

  await load()
}

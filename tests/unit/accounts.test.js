/**
 * "จัดการบัญชี": the service (RPC arguments, Thai errors) and the page
 * (offers only what each row allows, edit, status, typed-e-mail delete).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAdminService } from '../../src/features/admin/service.js'
import { renderAccountsView } from '../../src/features/admin/accounts.js'
import { deriveCapabilities } from '../../src/core/permissions.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
const row = (o = {}) => ({
  id: 'u1',
  full_name: 'ครู ก',
  display_name: null,
  user_code: 'T-1',
  email: 'kru.k@example.test',
  status: 'active',
  created_at: '2026-11-01T01:00:00Z',
  last_sign_in_at: null,
  requested_org: null,
  orgs: [{ name: 'โรงเรียน ก', role: 'teacher' }],
  platform_roles: [],
  is_self: false,
  can_manage: true,
  can_edit: true,
  can_delete: false,
  ...o,
})

describe('service', () => {
  it('lists through the RPC with paging and blanks as null', async () => {
    const rpc = vi.fn(async () => ({ data: { total: 0, rows: [] }, error: null }))
    await createAdminService({ rpc }).listAccounts({ search: '  T-1 ', status: '', page: 2 })
    expect(rpc).toHaveBeenCalledWith('admin_list_accounts', {
      p_search: 'T-1',
      p_status: null,
      p_limit: 50,
      p_offset: 100,
    })
  })

  it('update: name required, code checked on the page too, duplicate code in Thai', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }))
    const s = createAdminService({ rpc })
    await expect(s.updateAccount('u1', { full_name: '  ' })).rejects.toThrow('กรุณากรอกชื่อ')
    await expect(s.updateAccount('u1', { full_name: 'ก', user_code: 'T 1' })).rejects.toThrow('ไม่เว้นวรรค')
    expect(rpc).not.toHaveBeenCalled()
    await expect(s.updateAccount('u1', { full_name: 'ก', user_code: 'T-1' })).rejects.toThrow(
      'รหัสประจำตัวนี้มีผู้ใช้แล้ว'
    )
    expect(rpc).toHaveBeenCalledWith('admin_update_profile', {
      p_target: 'u1',
      p_full_name: 'ก',
      p_display_name: null,
      p_user_code: 'T-1',
    })
  })

  it('delete goes through the Edge Function; its error codes become Thai', async () => {
    const httpError = (body, status) => ({
      message: 'non-2xx',
      context: new Response(JSON.stringify(body), { status }),
    })
    const invoke = vi.fn(async () => ({ data: { deleted: true }, error: null }))
    await createAdminService({ functions: { invoke } }).deleteAccount('u1', '  A@B.test ')
    expect(invoke).toHaveBeenCalledWith('delete-account', {
      body: { user_id: 'u1', confirm_email: 'A@B.test' },
    })
    for (const [code, text] of [
      ['confirm_mismatch', 'ไม่ตรง'],
      ['forbidden', 'เฉพาะผู้ดูแลระบบ'],
      ['sign_in_not_removed', 'อีกครั้ง'],
    ]) {
      const s = createAdminService({
        functions: { invoke: async () => ({ data: null, error: httpError({ error: code }, 400) }) },
      })
      await expect(s.deleteAccount('u1', 'x')).rejects.toThrow(text)
    }
  })

  it('a deleted account gets its own screen flag and label', () => {
    expect(deriveCapabilities({ profile: { status: 'deleted' } })).toMatchObject({
      isDeleted: true,
      isActive: false,
      canApproveUsers: false,
    })
  })
})

describe('page', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })
  const open = async ({ rows = [row()], total, caps = { isPlatformAdmin: false }, over = {} } = {}) => {
    const admin = {
      listAccounts: vi.fn(async () => ({ total: total ?? rows.length, rows })),
      updateAccount: vi.fn(async () => ({})),
      setProfileStatus: vi.fn(async () => {}),
      deleteAccount: vi.fn(async () => ({ deleted: true })),
      ...over,
    }
    const el = document.createElement('div')
    document.body.append(el)
    await renderAccountsView(el, { services: { admin }, caps })
    return { el, admin }
  }

  it('lists people as text, with code, affiliation, status; only allowed actions are offered', async () => {
    const { el } = await open({
      rows: [
        row({ full_name: XSS }),
        row({ id: 'me', is_self: true, can_manage: false, can_edit: false }),
        row({
          id: 'gone',
          status: 'deleted',
          full_name: 'ผู้ใช้ที่ถูกลบ',
          email: null,
          user_code: null,
          can_manage: false,
          can_edit: false,
        }),
      ],
    })
    expect(el.querySelector('img')).toBeNull()
    const first = el.querySelector('[data-account-id="u1"]')
    expect(first.textContent).toContain(XSS)
    expect(first.querySelector('[data-code]').textContent).toBe('T-1')
    expect(first.textContent).toContain('โรงเรียน ก')
    expect(first.querySelector('[data-action=edit]')).not.toBeNull()
    expect(first.querySelector('[data-action=set-status][data-status=suspended]')).not.toBeNull()
    expect(first.querySelector('[data-action=delete]')).toBeNull() // can_delete false
    const me = el.querySelector('[data-account-id="me"]')
    expect(me.textContent).toContain('บัญชีของท่าน')
    expect(me.querySelectorAll('button')).toHaveLength(0)
    const gone = el.querySelector('[data-account-id="gone"]')
    expect(gone.textContent).toContain('บัญชีถูกลบ')
    expect(gone.querySelectorAll('button')).toHaveLength(0)
  })

  it('search sends the words and the status; paging moves 50 at a time', async () => {
    const { el, admin } = await open({ total: 120 })
    el.querySelector('input[name=q]').value = 'T-1'
    el.querySelector('select[name=status]').value = 'active'
    el.querySelector('form[data-form=account-search]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await settle()
    expect(admin.listAccounts).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'T-1', status: 'active', page: 0 })
    )
    expect(el.textContent).toContain('หน้า 1 / 3')
    el.querySelector('[data-action=page][data-page="1"]').click()
    await settle()
    expect(admin.listAccounts).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }))
  })

  it('edit: saves the three fields; a refusal stays in the form with its Thai reason', async () => {
    const updateAccount = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({})
    const { el, admin } = await open({ over: { updateAccount } })
    el.querySelector('[data-action=edit]').click()
    const form = el.querySelector('form[data-form=account-edit]')
    form.querySelector('[name=user_code]').value = 'T-9'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(el.querySelector('form[data-form=account-edit] [role=alert]')).not.toBeNull()
    el.querySelector('form[data-form=account-edit]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await settle()
    expect(admin.updateAccount).toHaveBeenLastCalledWith('u1', {
      full_name: 'ครู ก',
      display_name: '',
      user_code: 'T-1',
    })
    expect(el.textContent).toContain('บันทึกข้อมูลบัญชีแล้ว')
  })

  it('suspending asks for a reason; cancelling the question changes nothing', async () => {
    const { el, admin } = await open()
    vi.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValueOnce('ย้ายโรงเรียน')
    el.querySelector('[data-status=suspended]').click()
    await settle()
    expect(admin.setProfileStatus).not.toHaveBeenCalled()
    el.querySelector('[data-status=suspended]').click()
    await settle()
    expect(admin.setProfileStatus).toHaveBeenCalledWith('u1', 'suspended', 'ย้ายโรงเรียน')
  })

  it('delete (platform admin): the button stays disabled until the e-mail is typed, then deletes', async () => {
    const { el, admin } = await open({ rows: [row({ can_delete: true })], caps: { isPlatformAdmin: true } })
    el.querySelector('[data-action=delete]').click()
    const confirmBtn = () => el.querySelector('[data-confirm-delete]')
    expect(el.querySelector('[data-delete-row]').textContent).toContain('ย้อนคืนไม่ได้')
    expect(confirmBtn().disabled).toBe(true)
    const typed = el.querySelector('input[name=confirm_email]')
    typed.value = 'someone@example.test'
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    expect(confirmBtn().disabled).toBe(true)
    el.querySelector('form[data-form=account-delete]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await settle()
    expect(admin.deleteAccount).not.toHaveBeenCalled() // a forced submit with the wrong e-mail does nothing
    typed.value = '  KRU.K@example.test '
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    expect(confirmBtn().disabled).toBe(false)
    el.querySelector('form[data-form=account-delete]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await settle()
    expect(admin.deleteAccount).toHaveBeenCalledWith('u1', '  KRU.K@example.test ')
    expect(el.textContent).toContain('ลบบัญชีแล้ว')
  })

  it('a failed delete keeps the panel open with the reason', async () => {
    const { el } = await open({
      rows: [row({ can_delete: true })],
      caps: { isPlatformAdmin: true },
      over: { deleteAccount: vi.fn(async () => Promise.reject(new Error('x'))) },
    })
    el.querySelector('[data-action=delete]').click()
    const typed = el.querySelector('input[name=confirm_email]')
    typed.value = 'kru.k@example.test'
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    el.querySelector('form[data-form=account-delete]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await settle()
    expect(el.querySelector('[data-delete-row] [role=alert]')).not.toBeNull()
  })
})

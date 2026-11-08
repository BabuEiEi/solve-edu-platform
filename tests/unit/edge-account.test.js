// @vitest-environment node
/** delete-account logic with fakes: order, error mapping, retries, avatars. */
import { describe, it, expect, vi } from 'vitest'
import { deleteAccount } from '../../supabase/functions/delete-account/deleter.js'

const ID = '99999999-0000-4000-a000-0000000000aa'
function fakes({
  rpc = { data: { deleted: true, already_deleted: false }, error: null },
  auth = { error: null },
  files = [],
} = {}) {
  const order = []
  const asPerson = { rpc: vi.fn(async (name, args) => (order.push(['rpc', name, args]), rpc)) }
  const adminAuth = { deleteUser: vi.fn(async (id, soft) => (order.push(['auth', id, soft]), auth)) }
  const avatars = {
    list: vi.fn(
      async (folder) => (order.push(['list', folder]), { data: files.map((name) => ({ name })), error: null })
    ),
    remove: vi.fn(
      async (paths) => (order.push(['remove', paths]), { data: paths.map((name) => ({ name })), error: null })
    ),
  }
  return { asPerson, adminAuth, avatars, order }
}

describe('delete-account logic', () => {
  it('the database decides first (as the caller), then the sign-in is soft-deleted, then avatars go', async () => {
    const f = fakes({ files: ['a.png', 'b.webp'] })
    const out = await deleteAccount({ ...f, userId: ID, confirmEmail: 'x@example.test' })
    expect(out).toEqual({ deleted: true, already_deleted: false, sign_in: 'removed', avatars_removed: 2 })
    expect(f.order.map(([k]) => k)).toEqual(['rpc', 'auth', 'list', 'remove'])
    expect(f.order[0]).toEqual([
      'rpc',
      'admin_delete_account',
      { p_target: ID, p_confirm_email: 'x@example.test' },
    ])
    expect(f.order[1]).toEqual(['auth', ID, true]) // soft delete: the row stays for the anonymised results
    expect(f.order[3][1]).toEqual([`${ID}/a.png`, `${ID}/b.webp`])
  })

  it('refusals from the database stop everything before the server key is used', async () => {
    const cases = { 42501: 403, 22023: 400, P0002: 404 }
    for (const [code, status] of Object.entries(cases)) {
      const f = fakes({ rpc: { data: null, error: { code, message: 'x' } } })
      await expect(deleteAccount({ ...f, userId: ID, confirmEmail: 'x' })).rejects.toMatchObject({ status })
      expect(f.adminAuth.deleteUser).not.toHaveBeenCalled()
      expect(f.avatars.list).not.toHaveBeenCalled()
    }
  })

  it('a sign-in already removed is fine (retry); any other Auth failure is reported so the admin retries', async () => {
    const again = fakes({
      rpc: { data: { deleted: true, already_deleted: true }, error: null },
      auth: { error: { status: 404, message: 'User not found' } },
    })
    expect(await deleteAccount({ ...again, userId: ID, confirmEmail: '' })).toMatchObject({
      already_deleted: true,
      sign_in: 'already_removed',
      avatars_removed: 0,
    })
    const down = fakes({ auth: { error: { status: 500, message: 'database error' } } })
    await expect(deleteAccount({ ...down, userId: ID, confirmEmail: 'x' })).rejects.toMatchObject({
      status: 502,
      code: 'sign_in_not_removed',
    })
  })
})

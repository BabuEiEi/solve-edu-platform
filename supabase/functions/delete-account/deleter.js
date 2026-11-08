/**
 * Delete an account (Phase 4a), without Deno or network of its own.
 *
 *   1. asPerson.rpc('admin_delete_account')  — AS THE CALLER: the database
 *      decides (platform admin, not self, typed e-mail) and removes the
 *      personal data in one transaction; the account is then blocked
 *      everywhere (status 'deleted').
 *   2. adminAuth.deleteUser(id, true)        — soft delete in Supabase Auth:
 *      e-mail and identities hashed, sessions revoked, the row kept so the
 *      anonymised results stay attached. A later call repeats this safely.
 *   3. avatars: every file under avatars/<id>/ is removed.
 */
import { HttpError } from '../_shared/http.js'

const notFound = (e) => e?.status === 404 || /not.?found/i.test(e?.message ?? '')

export async function deleteAccount({ asPerson, adminAuth, avatars, userId, confirmEmail }) {
  const { data, error } = await asPerson.rpc('admin_delete_account', {
    p_target: userId,
    p_confirm_email: confirmEmail,
  })
  if (error) {
    if (error.code === '42501') throw new HttpError(403, 'forbidden')
    if (error.code === '22023') throw new HttpError(400, 'confirm_mismatch')
    if (error.code === 'P0002') throw new HttpError(404, 'not_found')
    throw new Error(`admin_delete_account: ${error.code} ${error.message}`)
  }

  const auth = await adminAuth.deleteUser(userId, true)
  let signIn = 'removed'
  if (auth?.error) {
    if (!notFound(auth.error)) throw new HttpError(502, 'sign_in_not_removed')
    signIn = 'already_removed'
  }

  let avatarsRemoved = 0
  const listed = await avatars.list(userId, { limit: 100 })
  const paths = (listed?.data ?? []).filter((f) => f?.name).map((f) => `${userId}/${f.name}`)
  if (paths.length) {
    const removed = await avatars.remove(paths)
    avatarsRemoved = removed?.error ? 0 : (removed?.data ?? []).length
  }

  return {
    deleted: true,
    already_deleted: data?.already_deleted === true,
    sign_in: signIn,
    avatars_removed: avatarsRemoved,
  }
}

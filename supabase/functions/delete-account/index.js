/**
 * Edge Function: delete-account (Phase 4a step 3)
 *
 * The page calls it when a platform admin deletes an account:
 *   POST { "user_id": "<uuid>", "confirm_email": "<the account's e-mail>" }
 *   with the admin's own session token
 * → 200 { deleted, already_deleted, sign_in: removed|already_removed, avatars_removed }
 *   400 bad_request / confirm_mismatch · 401 unauthorized · 403 forbidden · 404 not_found
 *   502 sign_in_not_removed (personal data is already gone; call again) · 500 internal
 *
 * Who may: decided in the database (admin_delete_account, as the caller).
 * The server key only soft-deletes the sign-in and removes avatar files.
 * Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (provided
 * by Supabase) · ALLOWED_ORIGINS (the site's origin).
 */
import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handle, HttpError, readJson } from '../_shared/http.js'
import { requireEnv, requireUser } from '../_shared/auth.js'
import { deleteAccount } from './deleter.js'

const env = (name) => Deno.env.get(name)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

Deno.serve(
  handle(
    async (req) => {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
      const url = requireEnv(env, 'SUPABASE_URL')
      const anonKey = env('SUPABASE_ANON_KEY') ?? requireEnv(env, 'SUPABASE_PUBLISHABLE_KEY')
      const serviceKey = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY')

      const { user, client: asPerson } = await requireUser(req, (authorization) =>
        createClient(url, anonKey, { ...noSession, global: { headers: { Authorization: authorization } } })
      )
      const { user_id: userId, confirm_email: confirmEmail } = await readJson(req)
      if (
        typeof userId !== 'string' ||
        !UUID.test(userId) ||
        typeof confirmEmail !== 'string' ||
        confirmEmail.length > 320
      )
        throw new HttpError(400, 'bad_request')

      const admin = createClient(url, serviceKey, noSession)
      const result = await deleteAccount({
        asPerson,
        adminAuth: admin.auth.admin,
        avatars: admin.storage.from('avatars'),
        userId,
        confirmEmail,
      })
      // ids only in the log, never e-mail or names
      console.log(JSON.stringify({ fn: 'delete-account', by: user.id, target: userId, ...result }))
      return result
    },
    { cors: Deno.env.get('ALLOWED_ORIGINS') ?? '' }
  )
)

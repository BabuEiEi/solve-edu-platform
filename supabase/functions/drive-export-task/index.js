/**
 * Edge Function: drive-export-task (Phase 3b step 4)
 *
 * The page calls it when a cohort assessor presses "ส่งสำเนาไป Google Drive":
 *   POST { "allocation_id": "<uuid>" }   with the person's own session token
 * → 200 { run_id, status: done|partial|failed, copied, skipped, failed, remaining, folder_url }
 *   400 bad_request · 401 unauthorized · 403 forbidden · 409 already_running
 *   500 not_configured (Google secrets missing) · 500 internal
 *
 * Who may: decided in the database (begin_task_drive_export, as the person).
 * Files are downloaded as the person too (storage RLS). The server key is
 * used for one thing only: finish_task_drive_export (the result record).
 *
 * Secrets (owner sets them on the real project; never in git):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the service account key (JSON)
 *   GOOGLE_DRIVE_FOLDER_ID       folder in the Shared Drive that holds everything
 *   GOOGLE_SHARED_DRIVE_ID       optional: the Shared Drive's id (narrower searches)
 *   ALLOWED_ORIGINS              the site's origin(s), comma-separated
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  provided by Supabase
 * Tests only: GOOGLE_TOKEN_URL / GOOGLE_DRIVE_API / GOOGLE_DRIVE_UPLOAD (local fake Google)
 */
import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handle, HttpError, readJson } from '../_shared/http.js'
import { requireEnv, requireUser } from '../_shared/auth.js'
import {
  createTokenSource,
  googleUrl,
  GOOGLE_TOKEN_URL,
  parseServiceAccount,
  DriveError,
} from '../_shared/google.js'
import { createDrive, DRIVE_API, DRIVE_UPLOAD } from '../_shared/drive.js'
import { exportToDrive } from './exporter.js'

const env = (name) => Deno.env.get(name)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

function googleConfig() {
  const folderId = requireEnv(env, 'GOOGLE_DRIVE_FOLDER_ID')
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(folderId))
    throw new HttpError(500, 'not_configured', 'GOOGLE_DRIVE_FOLDER_ID')
  return {
    serviceAccount: parseServiceAccount(env('GOOGLE_SERVICE_ACCOUNT_JSON')),
    folderId,
    sharedDriveId: env('GOOGLE_SHARED_DRIVE_ID') ?? '',
    tokenUrl: googleUrl(env('GOOGLE_TOKEN_URL'), GOOGLE_TOKEN_URL),
    api: googleUrl(env('GOOGLE_DRIVE_API'), DRIVE_API),
    upload: googleUrl(env('GOOGLE_DRIVE_UPLOAD'), DRIVE_UPLOAD),
  }
}

Deno.serve(
  handle(
    async (req) => {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
      const google = googleConfig() // before anything is recorded
      const url = requireEnv(env, 'SUPABASE_URL')
      const anonKey = env('SUPABASE_ANON_KEY') ?? requireEnv(env, 'SUPABASE_PUBLISHABLE_KEY')
      const serviceKey = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY')

      const { user, client: asPerson } = await requireUser(req, (authorization) =>
        createClient(url, anonKey, { ...noSession, global: { headers: { Authorization: authorization } } })
      )
      const { allocation_id: allocationId } = await readJson(req)
      if (typeof allocationId !== 'string' || !UUID.test(allocationId))
        throw new HttpError(400, 'bad_request')

      const begun = await asPerson.rpc('begin_task_drive_export', { p_allocation: allocationId })
      if (begun.error) {
        if (begun.error.code === '42501') throw new HttpError(403, 'forbidden')
        if (begun.error.code === 'SE008') throw new HttpError(409, 'already_running')
        throw new Error(`begin: ${begun.error.code} ${begun.error.message}`)
      }
      const manifest = begun.data

      const admin = createClient(url, serviceKey, noSession)
      let result = {
        status: 'failed',
        copies: [],
        copied: 0,
        skipped: 0,
        failed: 0,
        remaining: 0,
        folderId: null,
        errors: [],
      }
      try {
        const getToken = createTokenSource({
          serviceAccount: google.serviceAccount,
          tokenUrl: google.tokenUrl,
        })
        const drive = createDrive({
          getToken,
          sharedDriveId: google.sharedDriveId,
          api: google.api,
          upload: google.upload,
        })
        result = await exportToDrive({
          manifest,
          drive,
          rootFolderId: google.folderId,
          download: async (path) => {
            const { data, error } = await asPerson.storage.from('task-files').download(path)
            if (error || !data) throw new DriveError('download_failed')
            return new Uint8Array(await data.arrayBuffer())
          },
        })
      } catch (e) {
        result.errors = [e?.code ? e.message : 'unexpected error']
        console.error(`[drive-export-task] ${e?.name}: ${e?.message}`)
      } finally {
        // always close the run, so the next press is not blocked
        const fin = await admin.rpc('finish_task_drive_export', {
          p_run: manifest.run_id,
          p_status: result.status,
          p_copies: result.copies,
          p_copied: result.copied,
          p_skipped: result.skipped,
          p_failed: result.failed + result.remaining,
          p_folder_id: result.folderId,
          p_error: result.errors.length ? [...new Set(result.errors)].join('; ') : null,
        })
        if (fin.error) console.error(`[drive-export-task] finish: ${fin.error.code} ${fin.error.message}`)
      }
      console.log(
        JSON.stringify({
          fn: 'drive-export-task',
          run: manifest.run_id,
          by: user.id,
          status: result.status,
          copied: result.copied,
          skipped: result.skipped,
          failed: result.failed,
          remaining: result.remaining,
        })
      )
      return {
        run_id: manifest.run_id,
        status: result.status,
        copied: result.copied,
        skipped: result.skipped,
        failed: result.failed,
        remaining: result.remaining,
        folder_url: result.folderId ? `https://drive.google.com/drive/folders/${result.folderId}` : null,
      }
    },
    { cors: Deno.env.get('ALLOWED_ORIGINS') ?? '' }
  )
)

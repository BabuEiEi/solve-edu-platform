/**
 * Edge Function: cleanup-task-files (Phase 3b step 3)
 *
 * Called once a night by the scheduler (pg_cron + pg_net, see
 * docs/EDGE_FUNCTIONS.md) with header `x-cron-secret: <CRON_SECRET>`.
 *   POST {}                 remove orphans, files of idle drafts, and media
 *                           of deleted lessons/quizzes (Phase 4a)
 *   POST {"dry_run": true}  list what would go, remove nothing
 *
 * Secrets (set by the owner on the real project, never in git):
 *   CRON_SECRET                at least 32 characters
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by Supabase
 */
import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handle, HttpError, readJson } from '../_shared/http.js'
import { requireCronSecret, requireEnv } from '../_shared/auth.js'
import { BUCKET, runCleanup } from './cleanup.js'

const env = (name) => Deno.env.get(name)

Deno.serve(
  handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    requireCronSecret(req, env('CRON_SECRET'))
    const db = createClient(requireEnv(env, 'SUPABASE_URL'), requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const body = await readJson(req)
    const result = await runCleanup({
      db,
      bucket: db.storage.from(BUCKET),
      storageFrom: (bucketId) => db.storage.from(bucketId),
      dryRun: body.dry_run === true,
    })
    const { orphans, stale_draft_files, media, failed, ...counts } = result
    console.log(
      JSON.stringify({
        fn: 'cleanup-task-files',
        ...counts,
        orphans: orphans?.length,
        stale_draft_files: stale_draft_files?.length,
        media: media?.length,
        failed: failed?.length,
      })
    )
    return result
  })
)

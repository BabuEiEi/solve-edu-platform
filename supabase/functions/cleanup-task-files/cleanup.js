/**
 * The nightly clean-up, without Deno or network: `db` is a supabase-js
 * client with the service-role key, `bucket` is `db.storage.from(BUCKET)`.
 * The database decides what may go (see migration 20261105090700); this
 * only deletes the objects it is handed and reports.
 *
 * Order matters for safety:
 *   stale drafts: the rows are deleted (and audited) in the database first,
 *     then the objects. If an object delete fails it is an orphan, and the
 *     next run removes it.
 *   orphans: objects are deleted, then the database logs only those that
 *     are really gone.
 *   media (Phase 4a): images of lessons and quizzes that were deleted
 *     (lesson-media / assessment-media; the database lists only those two
 *     buckets) — deleted, then logged like orphans.
 */
import { unwrap } from '../_shared/http.js'

export const BUCKET = 'task-files'
const CHUNK = 100 // paths per Storage API delete call

async function removeObjects(bucket, paths) {
  const removed = []
  const failed = []
  for (let i = 0; i < paths.length; i += CHUNK) {
    const part = paths.slice(i, i + CHUNK)
    const { data, error } = await bucket.remove(part)
    if (error) {
      failed.push(...part)
      continue
    }
    const gone = new Set((data ?? []).map((o) => o.name))
    for (const p of part) (gone.has(p) ? removed : failed).push(p)
  }
  return { removed, failed }
}

const paths = (rows) => (rows ?? []).map((r) => r.object_path)

/** storageFrom(bucketId) → a Storage bucket client; omit to skip media. */
export async function runCleanup({ db, bucket, storageFrom = null, dryRun = false, limit = 500 }) {
  const orphanPaths = paths(unwrap(await db.rpc('task_files_cleanup_orphans', { p_limit: limit }), 'orphans'))
  const mediaRows = storageFrom
    ? (unwrap(await db.rpc('media_cleanup_orphans', { p_limit: limit }), 'media orphans') ?? [])
    : []
  const stalePaths = paths(
    unwrap(
      await db.rpc('task_files_cleanup_stale_drafts', { p_limit: limit, p_dry_run: dryRun }),
      'stale drafts'
    )
  )
  if (dryRun)
    return {
      dry_run: true,
      orphans: orphanPaths,
      stale_draft_files: stalePaths,
      media: mediaRows.map((r) => `${r.bucket_id}/${r.object_path}`),
    }

  const stale = await removeObjects(bucket, stalePaths)
  const orphans = await removeObjects(bucket, orphanPaths)
  const logged = orphans.removed.length
    ? unwrap(await db.rpc('task_files_cleanup_record', { p_paths: orphans.removed }), 'record')
    : 0
  const media = { removed: 0, logged: 0, failed: [] }
  for (const bucketId of new Set(mediaRows.map((r) => r.bucket_id))) {
    const part = mediaRows.filter((r) => r.bucket_id === bucketId).map((r) => r.object_path)
    const res = await removeObjects(storageFrom(bucketId), part)
    media.removed += res.removed.length
    media.failed.push(...res.failed.map((p) => `${bucketId}/${p}`))
    if (res.removed.length)
      media.logged += unwrap(
        await db.rpc('media_cleanup_record', { p_bucket: bucketId, p_paths: res.removed }),
        'media record'
      )
  }
  return {
    dry_run: false,
    stale_draft_files_removed: stale.removed.length,
    orphans_removed: orphans.removed.length,
    orphans_logged: logged,
    media_removed: media.removed,
    media_logged: media.logged,
    // left in storage: the next run retries them (as orphans)
    failed: [...stale.failed, ...orphans.failed, ...media.failed],
  }
}

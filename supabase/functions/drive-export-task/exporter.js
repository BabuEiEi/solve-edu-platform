/**
 * Copy one task-in-a-cohort to Drive, from the list begin_task_drive_export
 * returned. No Deno, no network of its own: `drive` is createDrive(),
 * `download(path)` returns the file's bytes (as the person who pressed).
 *
 *   <root> / <course> / <cohort> / <task> / <trainee> / รอบที่ N (ส่ง YYYY-MM-DD[, ส่งช้า]) / files
 *
 * Files already in their attempt folder are skipped (found by our file id).
 * A time budget keeps the function inside the platform's limit: files not
 * reached are reported as `remaining` and the run is "partial" — pressing
 * again continues where it stopped.
 */

/** YYYY-MM-DD in Thailand (UTC+7, no daylight saving). */
export function bangkokDate(iso) {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return new Date(t.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

export function attemptFolderName(a) {
  const when = bangkokDate(a.submitted_at)
  return `รอบที่ ${a.attempt_no}${when ? ` (ส่ง ${when}${a.is_late ? ', ส่งช้า' : ''})` : ''}`
}

const safeCode = (e) => (typeof e?.code === 'string' ? e.message : 'unexpected error').slice(0, 200)

export async function exportToDrive({
  manifest,
  drive,
  download,
  rootFolderId,
  budgetMs = 100_000,
  now = Date.now,
}) {
  const started = now()
  const over = () => now() - started > budgetMs
  const result = {
    status: 'done',
    copies: [],
    copied: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    folderId: null,
    errors: [],
  }
  try {
    const course = await drive.ensureFolder(
      rootFolderId,
      manifest.course.title,
      `course:${manifest.course.id}`
    )
    const cohort = await drive.ensureFolder(course, manifest.cohort.name, `cohort:${manifest.cohort.id}`)
    result.folderId = await drive.ensureFolder(
      cohort,
      manifest.task.title,
      `allocation:${manifest.allocation_id}`
    )
  } catch (e) {
    return { ...result, status: 'failed', errors: [safeCode(e)] }
  }

  const people = new Map()
  for (const a of manifest.attempts ?? []) {
    if (over()) {
      result.remaining += a.files.length
      continue
    }
    let existing
    let folder
    try {
      if (!people.has(a.user_id))
        people.set(a.user_id, await drive.ensureFolder(result.folderId, a.person, `person:${a.user_id}`))
      folder = await drive.ensureFolder(
        people.get(a.user_id),
        attemptFolderName(a),
        `attempt:${a.submission_id}`
      )
      existing = await drive.filesIn(folder)
    } catch (e) {
      result.failed += a.files.length
      result.errors.push(safeCode(e))
      continue
    }
    for (const f of a.files) {
      if (existing.has(f.id)) {
        result.copies.push({ file_id: f.id, drive_file_id: existing.get(f.id) })
        result.skipped++
        continue
      }
      if (over()) {
        result.remaining++
        continue
      }
      try {
        const bytes = await download(f.object_path)
        const id = await drive.uploadFile(folder, {
          name: f.file_name,
          mimeType: f.mime_type,
          bytes,
          fileKey: f.id,
        })
        result.copies.push({ file_id: f.id, drive_file_id: id })
        result.copied++
      } catch (e) {
        result.failed++
        result.errors.push(safeCode(e))
      }
    }
  }
  // not reached yet → press again ("partial"); errors with nothing copied → "failed"
  if (result.remaining) result.status = 'partial'
  else if (result.failed) result.status = result.copied || result.skipped ? 'partial' : 'failed'
  return result
}

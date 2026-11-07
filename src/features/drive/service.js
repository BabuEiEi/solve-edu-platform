import { AppError } from '../../core/errors.js'
import { DRIVE_ERROR_TEXT, DRIVE_FALLBACK_TEXT } from './logic.js'

const RUN_COLUMNS =
  'id, started_at, finished_at, status, files_copied, files_skipped, files_failed, error, requested_by, profiles!task_drive_exports_requested_by_fkey ( full_name, display_name )'

/** The function's `{error: code}` body, when the failure came from it (not from the network). */
async function codeOf(error) {
  try {
    const body = await error?.context?.json?.()
    return typeof body?.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

/**
 * Copy a task's submitted files to the central Google Drive through the Edge
 * function `drive-export-task`. The browser sends only its own session token;
 * who may copy is decided in the database, and the function never returns
 * Google's error text — only a short code that is translated here.
 */
export function createDriveService(client) {
  return {
    /** → { run_id, status, copied, skipped, failed, remaining, folder_url } */
    async exportTask(allocationId) {
      const { data, error } = await client.functions.invoke('drive-export-task', {
        body: { allocation_id: allocationId },
      })
      if (error) {
        const code = await codeOf(error)
        throw new AppError(DRIVE_ERROR_TEXT[code] ?? DRIVE_FALLBACK_TEXT, { code, cause: error })
      }
      return data
    },

    /** Latest runs for a task in a cohort. A failure here must not break the page: no history. */
    async history(allocationId, limit = 5) {
      try {
        const { data, error } = await client
          .from('task_drive_exports')
          .select(RUN_COLUMNS)
          .eq('allocation_id', allocationId)
          .order('started_at', { ascending: false })
          .limit(limit)
        return error ? [] : (data ?? [])
      } catch {
        return []
      }
    },
  }
}

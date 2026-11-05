export const NO_NOTICES = { unread_results: 0, revise: 0, waiting: 0 }

/**
 * Menu badges for tasks (task_notice_counts: SECURITY INVOKER, so the numbers
 * only reflect what the person's own pages already show). A failure here must
 * never break navigation: it just shows no badge.
 */
export function createNoticeService(client) {
  return {
    async counts() {
      try {
        const { data, error } = await client.rpc('task_notice_counts')
        if (error || !data) return NO_NOTICES
        return {
          unread_results: Number(data.unread_results) || 0,
          revise: Number(data.revise) || 0,
          waiting: Number(data.waiting) || 0,
        }
      } catch {
        return NO_NOTICES
      }
    },
  }
}

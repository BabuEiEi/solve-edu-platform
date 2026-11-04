import { test as base, expect } from '@playwright/test'

/**
 * Every spec imports `test` from here. Contexts a test opens itself
 * (browser.newContext() for a second person or device) are closed when the
 * test ends. Left open, their pages keep timers, autosave and sockets
 * running for the rest of the run; on WebKit that piled up and made later
 * tests hang at random (2C.1).
 */
export const test = base.extend({
  closeOwnContexts: [
    async ({ browser }, use) => {
      const before = new Set(browser.contexts())
      await use()
      await Promise.all(
        browser
          .contexts()
          .filter((c) => !before.has(c))
          .map((c) => c.close().catch(() => {}))
      )
    },
    { auto: true },
  ],
})

export { expect }

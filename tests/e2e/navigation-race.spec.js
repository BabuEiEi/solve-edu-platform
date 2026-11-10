import { test, expect } from './fixtures.js'
import { signIn, IDS } from './helpers.js'

/**
 * Two quick page changes where the FIRST one is slow to load (its menu badge
 * count answers late): the screen must show the page in the address — the
 * later one — and never the earlier page drawn over it. Before the fix (4f
 * review) the late page won; it made dialogs.spec fail now and then on a slow
 * machine, and a person moving quickly between pages saw the wrong page.
 */
const LESSON = `#/courses/${IDS.course}/builder/lessons/60000000-0000-4000-a000-000000000004`

test('a slow earlier page never draws over the page that was opened after it', async ({ page }) => {
  await signIn(page, 'trainer@example.test')
  await expect(page.locator('#view')).toBeVisible()

  let held = null
  let release
  const gate = new Promise((r) => (release = r))
  await page.route('**/rest/v1/rpc/task_notice_counts', async (route) => {
    if (held) return route.continue() // later navigations answer at once
    held = route
    await gate // the first navigation's badge count waits here
    return route.continue()
  })

  await page.evaluate(() => {
    window.location.hash = '#/courses' // slow: held at its badge count
  })
  await expect.poll(() => held !== null).toBe(true)
  await page.evaluate((hash) => {
    window.location.hash = hash // fast: drawn first
  }, LESSON)
  await expect(page.locator('[data-action=new-block][data-type=video]')).toBeVisible()

  release() // now the earlier navigation finishes
  await page.waitForTimeout(500) // give a stale draw time to happen
  await expect(page.locator('[data-action=new-block][data-type=video]')).toBeVisible() // still the lesson
  await expect(page.getByRole('heading', { name: 'หลักสูตร', exact: true })).toHaveCount(0)
  expect(page.url()).toContain(LESSON)
})

test('opening the app draws the page once: the sign-in check at start-up does not draw it a second time', async ({
  page,
}) => {
  await signIn(page, 'trainer@example.test')
  // count how many times a fresh #view (the page area) is put on the screen after a full load
  await page.addInitScript(() => {
    window.__viewsDrawn = 0
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n.nodeType === 1 && (n.id === 'view' || n.querySelector?.('#view'))) window.__viewsDrawn += 1
    }).observe(document, { childList: true, subtree: true })
  })
  await page.goto(`/${LESSON}`)
  await page.reload() // a real full load (a hash-only goto keeps the document)
  await expect(page.locator('[data-action=new-block][data-type=video]')).toBeVisible()
  await page.waitForTimeout(1500) // a second, late draw would happen here
  expect(await page.evaluate(() => window.__viewsDrawn)).toBe(1)
})

test('while the next page loads, the previous page is gone at once (nothing on it can be clicked)', async ({
  page,
}) => {
  await signIn(page, 'trainer@example.test')
  await page.goto(`/${LESSON}`)
  await expect(page.locator('[data-action=new-block][data-type=video]')).toBeVisible()
  let release
  const gate = new Promise((r) => (release = r))
  await page.route('**/rest/v1/rpc/task_notice_counts', async (route) => {
    await gate // the next page is slow to arrive
    return route.continue()
  })
  await page.evaluate(() => {
    window.location.hash = '#/courses'
  })
  // the lesson's buttons must not stay clickable while the courses page is still loading
  await expect(page.locator('[data-action=new-block]')).toHaveCount(0, { timeout: 1000 })
  release()
  await expect(page.getByRole('heading', { name: 'หลักสูตร', exact: true })).toBeVisible()
})

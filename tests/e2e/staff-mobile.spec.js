import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('phone: the assignment results page fits the screen (tables scroll inside their box)', async ({
  page,
}) => {
  await signIn(page, 'trainer@example.test')
  await page.goto('/#/staff/assessments/a4000000-0000-4000-a000-000000000003')
  await expect(page.locator('[data-results]')).toBeVisible()
  await expect(page.locator('[data-item-analysis]')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390) // not innerWidth: a phone viewport widens to fit overflow
})

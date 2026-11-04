import { test, expect } from '@playwright/test'
import { signIn, watchCsp } from './helpers.js'

const FORMATIVE = 'a4000000-0000-4000-a000-000000000002'
const LEAVE_PROMPT = 'ยังบันทึกไม่เสร็จ ออกจากหน้านี้หรือไม่'

test('unsaved answers: in-app prompt, browser prompt on close, keepalive save when the tab closes', async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const page = await ctxA.newPage()
  const csp = watchCsp(page)
  await signIn(page, 'teacher.b1@example.test')
  await page.goto(`/#/assessments/${FORMATIVE}`)
  await page.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  const numeric = page.getByLabel('คำตอบข้อ 4')
  const status = page.locator('[data-save-status]')

  // In-app link while typing (not yet saved): our Thai prompt; cancel keeps the exam open
  await numeric.fill('7')
  const asked = page.waitForEvent('dialog')
  const click = page.getByRole('link', { name: 'แบบทดสอบ', exact: true }).first().click()
  const dialog = await asked
  expect(dialog.type()).toBe('confirm')
  expect(dialog.message()).toBe(LEAVE_PROMPT)
  await dialog.dismiss()
  await click
  await expect(page.locator('form[data-form=attempt]')).toBeVisible()
  await expect(status).toHaveAttribute('data-state', 'saved')

  // Closing the tab while unsaved: the browser's own beforeunload prompt; dismiss stays
  await numeric.fill('75')
  const unloadAsked = page.waitForEvent('dialog')
  await page.close({ runBeforeUnload: true })
  const unload = await unloadAsked
  expect(unload.type()).toBe('beforeunload')
  await unload.dismiss()
  await expect(page.locator('form[data-form=attempt]')).toBeVisible()
  await expect(status).toHaveAttribute('data-state', 'saved')

  // Type and close at once (before the 1.5 s autosave): the keepalive save still lands
  await numeric.fill('76')
  await expect(status).toHaveAttribute('data-state', 'dirty')
  await page.close()
  expect(csp).toEqual([])

  const other = await (await browser.newContext()).newPage()
  await signIn(other, 'teacher.b1@example.test')
  await other.goto(`/#/assessments/${FORMATIVE}`)
  await expect(other.getByLabel('คำตอบข้อ 4')).toHaveValue('76')
})

import { test, expect } from './fixtures.js'
import { signIn } from './helpers.js'

// Anything that would reveal the answer key if it reached the browser
const KEY_MARKERS = /"correct"|answer_json|scoring_json|tolerance|is_correct|awarded_score/

test('trainee takes the pretest: draft survives reload, totals only, no key on the wire', async ({
  page,
}) => {
  const bodies = []
  page.on('response', async (res) => {
    if (!res.url().includes('/rest/v1/')) return
    bodies.push(await res.text().catch(() => ''))
  })

  await signIn(page, 'teacher.a2@example.test')
  await page.getByRole('link', { name: 'แบบทดสอบ', exact: true }).first().click()
  await page.getByRole('link', { name: /แบบทดสอบก่อนเรียน AfL/ }).click()
  await expect(page.getByText('ระบบจะนับเป็น 1 ครั้งทันที')).toBeVisible()
  await page.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()

  await page.getByLabel('ใช้ข้อมูลปรับการเรียนการสอนระหว่างทาง').check()
  for (const choice of ['ทันเวลา', 'เฉพาะเจาะจง', 'นำไปปฏิบัติได้']) await page.getByLabel(choice).check()

  // Refresh mid-test: the open attempt resumes with the answers saved on the server
  await expect(page.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')
  await page.reload()
  await expect(page.getByLabel('ใช้ข้อมูลปรับการเรียนการสอนระหว่างทาง')).toBeChecked()
  await expect(page.getByLabel('นำไปปฏิบัติได้')).toBeChecked()

  await page.getByLabel('ถูก', { exact: true }).check()
  await page.getByLabel('คำตอบข้อ 4').fill('๗๕') // Thai digits are accepted
  await page.getByRole('button', { name: 'ส่งคำตอบ' }).click()

  await expect(page.getByRole('heading', { name: 'ผลการทดสอบ' })).toBeVisible()
  await expect(page.locator('[data-score]')).toHaveText(/5\s*\/\s*5/)
  await expect(page.getByText('ผ่านเกณฑ์', { exact: true })).toBeVisible()
  await expect(page.getByText('4 / 4 ข้อ')).toBeVisible()

  // Limit is 1: the assignment page no longer offers a start button
  await page.getByRole('link', { name: /แบบทดสอบก่อนเรียน AfL/ }).click()
  await expect(page.getByText('ทำครบจำนวนครั้งแล้ว')).toBeVisible()
  await expect(page.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' })).toHaveCount(0)

  expect(bodies.length).toBeGreaterThan(5)
  expect(bodies.join('\n')).not.toMatch(KEY_MARKERS)
})

test('staff without a trainee role do not see the tests menu', async ({ page }) => {
  await signIn(page, 'school.admin.b@example.test')
  await expect(page.getByRole('link', { name: 'แบบทดสอบ', exact: true })).toHaveCount(0)
})

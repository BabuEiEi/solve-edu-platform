import { test, expect } from './fixtures.js'
import { signIn } from './helpers.js'

test('the downloaded roster template is accepted by the importer as-is', async ({ page }, testInfo) => {
  await signIn(page, 'school.admin.a@example.test')
  await page.goto('/#/admin/import')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action=download-template]').click(),
  ])
  expect(download.suggestedFilename()).toBe('roster-template.csv')
  const path = testInfo.outputPath('roster-template.csv')
  await download.saveAs(path)

  await page.locator('input[name=file]').setInputFiles(path)
  await page.getByRole('button', { name: 'ตรวจสอบไฟล์' }).click()
  await expect(page.getByText('ถูกต้อง 2')).toBeVisible()
  await expect(page.getByText('มีข้อผิดพลาด 0')).toBeVisible()
})

test('the downloaded Excel roster template is accepted as-is, and so is a file made by another program', async ({
  page,
}, testInfo) => {
  await signIn(page, 'school.admin.a@example.test')
  await page.goto('/#/admin/import')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action=download-template-xlsx]').click(),
  ])
  expect(download.suggestedFilename()).toBe('roster-template.xlsx')
  const path = testInfo.outputPath('roster-template.xlsx')
  await download.saveAs(path)

  await page.locator('input[name=file]').setInputFiles(path)
  await page.getByRole('button', { name: 'ตรวจสอบไฟล์' }).click()
  await expect(page.getByText('ถูกต้อง 2')).toBeVisible()
  await expect(page.getByText('มีข้อผิดพลาด 0')).toBeVisible()

  // tests/fixtures/openpyxl-sample.xlsx: written by openpyxl, with a blank row,
  // a rich-text name, a second sheet and a last row without an e-mail
  await page.locator('input[name=file]').setInputFiles('tests/fixtures/openpyxl-sample.xlsx')
  await page.getByRole('button', { name: 'ตรวจสอบไฟล์' }).click()
  await expect(page.getByText('ถูกต้อง 2')).toBeVisible()
  await expect(page.getByText('มีข้อผิดพลาด 1')).toBeVisible()
  await expect(page.getByText('ครู ตัวหนา สอง')).toBeVisible()
  await expect(page.getByText('ไม่มีอีเมล')).toBeVisible()
})

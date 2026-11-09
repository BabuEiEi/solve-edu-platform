import { test, expect } from './fixtures.js'
import { signIn, watchCsp, IDS, answerDialog } from './helpers.js'

// Thai Excel's default "CSV (Comma delimited)": Windows-874 bytes, not UTF-8
const tis620 = (text) =>
  Buffer.from(
    [...text].map((ch) => {
      const c = ch.charCodeAt(0)
      return c >= 0x0e01 && c <= 0x0e5b ? c - 0x0e01 + 0xa1 : c
    })
  )
const HEADER =
  'ประเภท,โจทย์,คะแนน,ตัวเลือก1,ตัวเลือก2,ตัวเลือก3,ตัวเลือก4,ตัวเลือก5,ตัวเลือก6,คำตอบ,คลาดเคลื่อน,หน่วย,วิธีให้คะแนน'
const GOOD = [
  HEADER,
  'เลือกตอบ,ข้อใดเป็นเป้าหมายของ AfL,1,ตัดเกรด,ปรับการสอน,จัดอันดับ,,,,2,,,',
  'เลือกหลายคำตอบ,ข้อมูลป้อนกลับที่ดี,2,ทันเวลา,เฉพาะเจาะจง,บอกแค่คะแนน,,,,"1,2",,,บางส่วน',
  'ถูกผิด,ควรแจ้งเกณฑ์ก่อนเริ่ม,1,,,,,,,ถูก,,,',
  'ตัวเลข,40 คน ผ่าน 30 คน ร้อยละเท่าใด,1,,,,,,,75,0.5,%,',
].join('\r\n')
const BAD = [
  HEADER,
  GOOD.split('\r\n')[1],
  'เลือกตอบ,ข้อที่ผิด,1,ก,ข,,,,,9,,,',
  'อัตนัย,ประเภทที่ไม่รองรับ,1,,,,,,,,,,',
].join('\r\n')

test('trainer imports a Windows-874 CSV: errors first, then preview, import, publish; a trainee scores it', async ({
  browser,
}, testInfo) => {
  const trainer = await (await browser.newContext()).newPage()
  const csp = watchCsp(trainer)
  await signIn(trainer, 'trainer@example.test')
  await trainer.goto(`/#/courses/${IDS.course}/quizzes`)
  const create = trainer.locator('form[data-form=create-quiz]')
  await create.locator('[name=code]').fill('E2E-IMPORT')
  await create.locator('[name=title]').fill('ข้อสอบนำเข้าจากไฟล์ (E2E)')
  await create.getByRole('button', { name: 'สร้างแบบทดสอบ' }).click()
  await expect(trainer.getByRole('heading', { name: 'ข้อสอบนำเข้าจากไฟล์ (E2E)' })).toBeVisible()

  await trainer.getByRole('button', { name: 'นำเข้าจากไฟล์ (Excel/CSV)' }).click()
  const panel = trainer.locator('[data-import-panel]')
  await expect(panel.getByText('เลือกไฟล์ Excel หรือ CSV…')).toBeVisible() // Thai, not "Choose File"

  // The template downloads and is a valid file as it is
  const download = trainer.waitForEvent('download')
  await panel.getByRole('button', { name: 'ดาวน์โหลดแม่แบบ (CSV)' }).click()
  expect((await download).suggestedFilename()).toBe('quiz-import-template.csv')

  // The Excel template downloads too, and reads back as the same four rows
  const xlsxDownload = trainer.waitForEvent('download')
  await panel.getByRole('button', { name: 'ดาวน์โหลดแม่แบบ (Excel)' }).click()
  const xlsx = await xlsxDownload
  expect(xlsx.suggestedFilename()).toBe('quiz-import-template.xlsx')
  const xlsxPath = testInfo.outputPath('quiz-import-template.xlsx')
  await xlsx.saveAs(xlsxPath)
  await panel.locator('input[name=import_file]').setInputFiles(xlsxPath)
  await expect(panel.locator('[data-import-row]')).toHaveCount(4)
  await expect(panel.locator('[data-import-errors]')).toHaveCount(0)

  // A file with problems: every one listed by spreadsheet row, nothing can be confirmed
  await panel
    .locator('input[name=import_file]')
    .setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: tis620(BAD) })
  const errors = panel.locator('[data-import-errors] li')
  await expect(errors).toHaveCount(2)
  await expect(errors.nth(0)).toContainText('แถว 3:')
  await expect(errors.nth(1)).toContainText('แถว 4:')
  await expect(panel.getByRole('button', { name: /^นำเข้า \d+ ข้อ$/ })).toHaveCount(0)

  // The corrected file, in Windows-874: all four rows are previewed
  await panel
    .locator('input[name=import_file]')
    .setInputFiles({ name: 'ข้อสอบ.csv', mimeType: 'text/csv', buffer: tis620(GOOD) })
  await expect(panel.locator('[data-import-row]')).toHaveCount(4)
  await expect(panel.locator('[data-import-row="1"]')).toContainText('ข้อใดเป็นเป้าหมายของ AfL') // Thai read correctly
  await panel.getByRole('button', { name: 'นำเข้า 4 ข้อ' }).click()

  await expect(trainer.getByText('นำเข้า 4 ข้อแล้ว')).toBeVisible()
  await expect(trainer.locator('[data-import-panel]')).toHaveCount(0)
  await expect(trainer.locator('li[data-item-id]')).toHaveCount(4)
  await expect(trainer.getByText('พร้อมเผยแพร่ (4 ข้อ)')).toBeVisible() // every imported item has a valid key
  await trainer.locator('[data-action=publish]').click()

  await answerDialog(trainer)
  await expect(trainer.getByText(/เผยแพร่แล้ว/).first()).toBeVisible()
  await trainer.locator('a[data-action-link=assign]').click()
  const a = trainer.locator('form[data-form=assignment]')
  await a.locator('[name=purpose]').selectOption('formative')
  await a.locator('[name=title]').fill('ข้อสอบนำเข้า (E2E)')
  await a.locator('[name=close_at]').fill('2027-03-31T16:00')
  await a.getByRole('button', { name: 'บันทึกและเผยแพร่' }).click()
  await expect(trainer.getByRole('heading', { name: 'ข้อสอบนำเข้า (E2E)' })).toBeVisible()
  expect(csp).toEqual([])

  // A trainee answers all four correctly: the imported keys score as written
  const learner = await (await browser.newContext()).newPage()
  await signIn(learner, 'teacher.a1@example.test')
  await learner.goto('/#/assessments')
  await learner.getByRole('link', { name: /ข้อสอบนำเข้า \(E2E\)/ }).click()
  await learner.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  const form = learner.locator('form[data-form=attempt]')
  await expect(form.locator('fieldset[data-item-id]')).toHaveCount(4)
  await form.getByLabel('ปรับการสอน').check()
  await form.getByLabel('ทันเวลา').check()
  await form.getByLabel('เฉพาะเจาะจง').check()
  await form.getByLabel('ถูก', { exact: true }).check()
  await form.getByLabel('คำตอบข้อ 4').fill('75')
  await learner.getByRole('button', { name: 'ส่งคำตอบ' }).click()
  await expect(learner.getByRole('heading', { name: 'ผลการทดสอบ' })).toBeVisible()
  await expect(learner.locator('[data-score]')).toHaveText(/5\s*\/\s*5/)
})

test('a trainee has no import button and cannot open a quiz editor', async ({ page }) => {
  await signIn(page, 'teacher.a1@example.test')
  await page.goto(`/#/courses/${IDS.course}/quizzes`)
  await expect(page.getByRole('button', { name: 'นำเข้าจากไฟล์ (Excel/CSV)' })).toHaveCount(0)
})

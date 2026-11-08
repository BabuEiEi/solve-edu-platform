import { test, expect } from './fixtures.js'
import { signIn, watchCsp, reviewInUi, resetTaskWork, PEOPLE, DEMO, answerDialog } from './helpers.js'

const PDF = {
  name: 'แผนการสอน.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% fictitious test file\n'),
}

test('trainee submits work (text, link, file); the trainer reviews on the reviewer page: sent back, resubmit, pass, re-grade; history keeps every attempt', async ({
  page,
  browser,
}) => {
  const csp = watchCsp(page)
  resetTaskWork()
  const trainer = await (await browser.newContext()).newPage()
  await signIn(trainer, 'trainer@example.test')
  await signIn(page, 'teacher.a1@example.test')
  await page.locator('a[href="#/tasks"]:visible').click()
  await expect(page.getByRole('heading', { name: 'ภาระงานของฉัน' })).toBeVisible()
  await page.getByRole('link', { name: /ส่งแผนการสอน AfL 1 คาบ/ }).click()
  await expect(page.locator('[data-instructions]')).toContainText('แนบแผนการสอน 1 คาบ')
  await expect(page.locator('[data-meta]')).toContainText('31 มี.ค. 2570')
  await page.locator('[data-rubric] summary').click()
  await expect(page.locator('[data-rubric]')).toContainText('การกำหนดเป้าหมายการเรียนรู้')

  // Attempt 1: nothing to submit yet, then text + a link + a file
  await page.getByRole('button', { name: /เริ่มทำงาน/ }).click()
  const form = page.locator('form[data-form=draft]')
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'ส่งงาน' }).click()
  await expect(form.getByRole('alert')).toContainText('อย่างน้อยหนึ่งอย่าง')
  await form.locator('[name=text]').fill('แผนการสอนเรื่องเศษส่วน ใช้บัตรคำถามเช็คความเข้าใจ')
  await form.locator('[name=link_url]').fill('http://insecure.example.test')
  await form.getByRole('button', { name: 'บันทึกร่าง' }).click()
  await expect(form.getByRole('alert')).toContainText('https://')
  await form.locator('[name=link_url]').fill('https://docs.example.test/plan')
  await form.locator('[name=link_label]').fill('แผนฉบับเต็ม')
  await form.locator('input[name=task_file]').setInputFiles(PDF)
  await expect(page.locator('[data-file]')).toContainText('แผนการสอน.pdf')
  await expect(page.locator('form[data-form=draft] [name=text]')).toHaveValue(/เศษส่วน/) // typed text survives the upload
  await page.locator('form[data-form=draft]').getByRole('button', { name: 'บันทึกร่าง' }).click()
  await expect(page.getByText('บันทึกร่างแล้ว')).toBeVisible()
  await page.reload() // the draft is on the server
  await expect(page.locator('form[data-form=draft] [name=text]')).toHaveValue(/เศษส่วน/)
  await expect(page.locator('[data-file]')).toHaveCount(1)
  await page.locator('form[data-form=draft]').getByRole('button', { name: 'ส่งงาน' }).click()
  await answerDialog(page)
  await expect(page.getByText('ส่งงานแล้ว — รอผู้ตรวจ')).toBeVisible()
  const attempt1 = page.locator('[data-attempt="1"]')
  await expect(attempt1).toContainText('รอตรวจ')
  await expect(attempt1.getByRole('link', { name: 'แผนการสอน.pdf' })).toBeVisible()
  await expect(attempt1.getByRole('link', { name: 'แผนฉบับเต็ม' })).toHaveAttribute(
    'href',
    'https://docs.example.test/plan'
  )
  await expect(page.locator('[data-actions]')).toContainText('รอผู้ตรวจ')

  // The trainer returns it for revision, on the reviewer's page
  const C1 = DEMO.c1
  const C2 = DEMO.c2
  await reviewInUi(trainer, PEOPLE.a1.name, {
    levels: { [C1]: 'พอใช้', [C2]: 'ไม่มีหลักฐาน' },
    comments: { [C1]: 'เป้าหมายยังกว้าง' },
    feedback: 'เป้าหมายยังกว้าง ช่วยเพิ่มหลักฐาน',
    outcome: 'revise',
    release: true,
  })
  await page.reload()
  await expect(page.locator('[data-attempt="1"] [data-review]')).toContainText('ส่งกลับแก้ไข')
  await expect(page.locator('[data-attempt="1"] [data-review]')).toContainText('คะแนน 2 / 6')
  await expect(page.locator('[data-attempt="1"] [data-review-scores]')).toContainText('พอใช้ (2/4)')
  await expect(page.locator('[data-attempt="1"] [data-review-scores]')).toContainText('เป้าหมายยังกว้าง')
  await expect(page.locator('[data-actions]')).toContainText('ผู้ตรวจส่งงานกลับให้แก้ไข')

  // Attempt 2
  await page.getByRole('button', { name: 'แก้ไขและส่งรอบที่ 2' }).click()
  await page.locator('form[data-form=draft] [name=text]').fill('แผนฉบับแก้ไข เพิ่มหลักฐานจากบัตรคำถาม')
  await page.locator('form[data-form=draft]').getByRole('button', { name: 'ส่งงาน' }).click()
  await answerDialog(page)
  await expect(page.locator('[data-attempt="2"]')).toContainText('รอตรวจ')
  await reviewInUi(trainer, PEOPLE.a1.name, {
    levels: { [C1]: 'ดีมาก', [C2]: 'มีหลักฐานและนำไปใช้' },
    feedback: 'ผ่าน ดีมาก',
    outcome: 'passed',
    release: true,
  })
  await page.reload()
  await expect(page.locator('[data-attempt="2"] [data-review]')).toContainText('คะแนน 6 / 6')
  await expect(page.locator('[data-actions]')).toContainText('ผ่านแล้ว')
  await expect(page.locator('[data-attempt]')).toHaveCount(2) // both attempts kept
  await expect(page.locator('[data-attempt="1"]')).toContainText('แผนการสอนเรื่องเศษส่วน')

  // Re-grade of attempt 1: the old review moves to "earlier reviews" with the reason
  await reviewInUi(trainer, PEOPLE.a1.name, {
    attempt: 1,
    levels: { [C1]: 'ปรับปรุง', [C2]: 'ไม่มีหลักฐาน' },
    feedback: 'ให้คะแนนใหม่',
    outcome: 'revise',
    reason: 'ตรวจทานตามเกณฑ์',
    release: true,
  })
  await page.reload()
  await expect(page.locator('[data-attempt="1"] [data-review]')).toContainText('คะแนน 1 / 6')
  await page.locator('[data-attempt="1"] [data-earlier-reviews] summary').click()
  await expect(page.locator('[data-attempt="1"] [data-earlier-reviews]')).toContainText('2 / 6')
  await expect(page.locator('[data-attempt="1"] [data-earlier-reviews]')).toContainText('ตรวจทานตามเกณฑ์')

  // The list shows the task; a draft review the trainer has not released stays hidden
  await page.goto('/#/tasks')
  await expect(page.locator('[data-my-tasks]')).toContainText('ส่งแล้ว 2/3 รอบ')
  expect(csp).toEqual([])
})

test("another trainee does not see the first one's work; the menu item is for trainees only", async ({
  page,
  browser,
}) => {
  await signIn(page, 'teacher.a2@example.test')
  await page.goto(`/#/tasks/${DEMO.allocation}`)
  await expect(page.getByRole('button', { name: /เริ่มทำงาน/ })).toBeVisible() // nothing of A1's work is shown
  await expect(page.locator('[data-history]')).toHaveCount(0)
  const trainer = await (await browser.newContext()).newPage()
  await signIn(trainer, 'trainer@example.test')
  await expect(trainer.locator('a[href="#/tasks"]:visible')).toHaveCount(0)
})

import { test, expect } from './fixtures.js'
import { signIn, watchCsp, sqlAs, USERS } from './helpers.js'

const ALLOCATION = 'b2000000-0000-4000-a000-000000000001' // demo task opened to the demo cohort
const PDF = {
  name: 'แผนการสอน.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% fictitious test file\n'),
}

test('trainee submits work (text, link, file), is sent back, resubmits and passes; history keeps every attempt', async ({
  page,
}) => {
  const csp = watchCsp(page)
  await signIn(page, 'teacher.a1@example.test')
  await page.getByRole('link', { name: 'ภาระงาน', exact: true }).first().click()
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
  page.once('dialog', (d) => d.accept())
  await page.locator('form[data-form=draft]').getByRole('button', { name: 'ส่งงาน' }).click()
  await expect(page.getByText('ส่งงานแล้ว — รอผู้ตรวจ')).toBeVisible()
  const attempt1 = page.locator('[data-attempt="1"]')
  await expect(attempt1).toContainText('รอตรวจ')
  await expect(attempt1.getByRole('link', { name: 'แผนการสอน.pdf' })).toBeVisible()
  await expect(attempt1.getByRole('link', { name: 'แผนฉบับเต็ม' })).toHaveAttribute(
    'href',
    'https://docs.example.test/plan'
  )
  await expect(page.locator('[data-actions]')).toContainText('รอผู้ตรวจ')

  // The trainer returns it for revision (the reviewer page comes in the next step: SQL as the trainer)
  const review = (outcome, feedback, levels) =>
    sqlAs(
      USERS.trainer,
      `select public.release_task_review(public.save_task_review(
         (select id from public.task_submissions order by submitted_at desc limit 1),
         '${JSON.stringify(levels)}'::jsonb, '${feedback}', '${outcome}', ${outcome === 'passed' ? "'ตรวจใหม่หลังแก้'" : 'null'}));`
    )
  const C1 = 'a3000000-0000-4000-a000-000000000021'
  const C2 = 'a3000000-0000-4000-a000-000000000022'
  review('revise', 'เป้าหมายยังกว้าง ช่วยเพิ่มหลักฐาน', {
    [C1]: { level: 'b', comment: 'เป้าหมายยังกว้าง' },
    [C2]: { level: 'x' },
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
  page.once('dialog', (d) => d.accept())
  await page.locator('form[data-form=draft]').getByRole('button', { name: 'ส่งงาน' }).click()
  await expect(page.locator('[data-attempt="2"]')).toContainText('รอตรวจ')
  review('passed', 'ผ่าน ดีมาก', { [C1]: { level: 'd' }, [C2]: { level: 'y' } })
  await page.reload()
  await expect(page.locator('[data-attempt="2"] [data-review]')).toContainText('คะแนน 6 / 6')
  await expect(page.locator('[data-actions]')).toContainText('ผ่านแล้ว')
  await expect(page.locator('[data-attempt]')).toHaveCount(2) // both attempts kept
  await expect(page.locator('[data-attempt="1"]')).toContainText('แผนการสอนเรื่องเศษส่วน')

  // Re-grade of attempt 1: the old review moves to "earlier reviews" with the reason
  sqlAs(
    USERS.trainer,
    `select public.release_task_review(public.save_task_review(
       (select id from public.task_submissions where attempt_no = 1 limit 1),
       '${JSON.stringify({ [C1]: { level: 'a' }, [C2]: { level: 'x' } })}'::jsonb, 'ให้คะแนนใหม่', 'revise', 'ตรวจทานตามเกณฑ์'));`
  )
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
  await page.goto(`/#/tasks/${ALLOCATION}`)
  await expect(page.getByRole('button', { name: /เริ่มทำงาน/ })).toBeVisible() // nothing of A1's work is shown
  await expect(page.locator('[data-history]')).toHaveCount(0)
  const trainer = await (await browser.newContext()).newPage()
  await signIn(trainer, 'trainer@example.test')
  await expect(trainer.getByRole('link', { name: 'ภาระงาน', exact: true })).toHaveCount(0)
})

import { test, expect } from './fixtures.js'
import { signIn, watchCsp, IDS } from './helpers.js'

const FORMATIVE = 'a4000000-0000-4000-a000-000000000002'

// 1×1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

test('trainer builds and publishes a quiz with an image choice', async ({ page }) => {
  const csp = watchCsp(page)
  await signIn(page, 'trainer@example.test')
  await page.goto(`/#/courses/${IDS.course}/builder`)
  await page.locator(`a[href="#/courses/${IDS.course}/quizzes"]`).click()

  const create = page.locator('form[data-form=create-quiz]')
  await create.locator('[name=code]').fill('E2E-Q')
  await create.locator('[name=title]').fill('แบบทดสอบ E2E')
  await create.getByRole('button', { name: 'สร้างแบบทดสอบ' }).click()
  await expect(page.getByRole('heading', { name: 'แบบทดสอบ E2E' })).toBeVisible()

  // MCQ with an image choice
  await page.locator('[data-action=new-item][data-type=mcq_single]').click()
  const form = page.locator('form[data-form=item]')
  await form.locator('[name=prompt]').fill('ข้อใดเป็นแผนภาพ')
  await form.locator('[name=opt_text]').nth(0).fill('ข้อความธรรมดา')
  await form
    .locator('[name=opt_file]')
    .nth(1)
    .setInputFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: PNG })
  await form.locator('[name=correct][value=b]').check()
  await form.getByRole('button', { name: 'บันทึกข้อ' }).click()
  await expect(page.getByText('บันทึกข้อแล้ว')).toBeVisible()
  await expect(page.getByText('ตั้งเฉลยแล้ว')).toBeVisible()
  await expect(page.locator('li[data-item-id] img')).toHaveCount(1) // signed URL from the private bucket

  // True/false
  await page.locator('[data-action=new-item][data-type=true_false]').click()
  await page.locator('form[data-form=item] [name=prompt]').fill('ภาพประกอบช่วยให้เข้าใจง่ายขึ้น')
  await page.locator('form[data-form=item] [name=correct_tf][value=true]').check()
  await page.locator('form[data-form=item]').getByRole('button', { name: 'บันทึกข้อ' }).click()
  await expect(page.getByText('พร้อมเผยแพร่ (2 ข้อ)')).toBeVisible()

  page.once('dialog', (d) => d.accept())
  await page.locator('[data-action=publish]').click()
  await expect(page.getByText(/เผยแพร่แล้ว/).first()).toBeVisible()
  await expect(page.locator('[data-action=clone]')).toBeVisible()
  await expect(page.locator('[data-action=edit-item]')).toHaveCount(0)
  expect(csp).toEqual([])
})

test('a lesson links to an assignment; the trainee follows it to the test page', async ({ browser }) => {
  const trainer = await (await browser.newContext()).newPage()
  await signIn(trainer, 'trainer@example.test')
  await trainer.goto(`/#/courses/${IDS.course}/builder/lessons/${IDS.lesson2}`)
  await trainer.locator('[data-action=new-block][data-type=quiz_reference]').click()
  const select = trainer.locator('form[data-form=block] select[name=assessment_assignment_id]')
  await expect(select.locator('option', { hasText: 'แบบฝึกหัดทบทวน หน่วยที่ 1' })).toHaveCount(1)
  await select.selectOption(FORMATIVE) // demo seed assignment
  await trainer.locator('form[data-form=block] button[type=submit]').click()
  await expect(trainer.getByText('บันทึกเนื้อหาแล้ว')).toBeVisible()

  const learner = await (await browser.newContext()).newPage()
  await signIn(learner, 'teacher.a1@example.test')
  await learner.goto(`/#/learn/${IDS.course}/${IDS.lesson2}`)
  await learner.locator('a[data-quiz-link]').click()
  await expect(learner.getByRole('heading', { name: 'แบบฝึกหัดทบทวน หน่วยที่ 1' })).toBeVisible()
  await expect(learner.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' })).toBeVisible()
})

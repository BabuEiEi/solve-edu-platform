import { test, expect } from '@playwright/test'
import { signIn, watchCsp, IDS } from './helpers.js'

test('trainer builds ordering + matching items, publishes, assigns; a trainee scores 2/2', async ({
  browser,
}) => {
  const trainer = await (await browser.newContext()).newPage()
  const csp = watchCsp(trainer)
  await signIn(trainer, 'trainer@example.test')
  await trainer.goto(`/#/courses/${IDS.course}/quizzes`)
  const create = trainer.locator('form[data-form=create-quiz]')
  await create.locator('[name=code]').fill('E2E-LISTS')
  await create.locator('[name=title]').fill('ข้อสอบเรียงลำดับและจับคู่ (E2E)')
  await create.getByRole('button', { name: 'สร้างแบบทดสอบ' }).click()
  await expect(trainer.getByRole('heading', { name: 'ข้อสอบเรียงลำดับและจับคู่ (E2E)' })).toBeVisible()

  // Ordering: type the steps in the correct order (one typed wrong, fixed with ↑)
  await trainer.locator('[data-action=new-item][data-type=ordering]').click()
  let form = trainer.locator('form[data-form=item]')
  await form.locator('[name=prompt]').fill('เรียงขั้นตอน')
  const steps = form.locator('input[name=options_text]')
  await steps.nth(0).fill('ตั้งเป้าหมาย')
  await steps.nth(1).fill('ให้ข้อมูลย้อนกลับ')
  await steps.nth(2).fill('เก็บหลักฐาน')
  await form.locator('[data-entry-row]').nth(3).getByRole('button', { name: 'ลบ' }).click()
  await form.locator('[data-entry-row]').nth(2).getByRole('button', { name: 'เลื่อนขึ้น' }).click()
  await form.getByRole('button', { name: 'บันทึกข้อ' }).click()
  await expect(trainer.getByText('บันทึกข้อแล้ว')).toBeVisible()

  // Matching: two pairs and a distractor, key picked from the menus
  await trainer.locator('[data-action=new-item][data-type=matching]').click()
  form = trainer.locator('form[data-form=item]')
  await form.locator('[name=prompt]').fill('จับคู่')
  const left = form.locator('input[name=left_text]')
  await left.nth(0).fill('เกณฑ์ความสำเร็จ')
  await left.nth(1).fill('ข้อมูลย้อนกลับ')
  await form.locator('[data-entry-row][data-list=left]').nth(2).getByRole('button', { name: 'ลบ' }).click()
  const right = form.locator('input[name=right_text]')
  await right.nth(0).fill('บอกว่างานที่ดีเป็นอย่างไร')
  await right.nth(1).fill('บอกว่าควรปรับอะไร')
  await right.nth(2).fill('ตัดเกรด')
  await form.locator('[data-entry-row][data-list=right]').nth(3).getByRole('button', { name: 'ลบ' }).click()
  const menus = form.locator('select[data-key-select]')
  await menus.nth(0).selectOption({ label: 'บอกว่างานที่ดีเป็นอย่างไร' })
  await menus.nth(1).selectOption({ label: 'บอกว่าควรปรับอะไร' })
  await form.getByRole('button', { name: 'บันทึกข้อ' }).click()
  await expect(trainer.getByText('พร้อมเผยแพร่ (2 ข้อ)')).toBeVisible() // both keys valid (stored order does not give them away)

  trainer.once('dialog', (d) => d.accept())
  await trainer.locator('[data-action=publish]').click()
  await expect(trainer.getByText(/เผยแพร่แล้ว/).first()).toBeVisible()

  await trainer.locator('a[data-action-link=assign]').click()
  const a = trainer.locator('form[data-form=assignment]')
  await a.locator('[name=purpose]').selectOption('formative')
  await a.locator('[name=title]').fill('เรียงลำดับและจับคู่ (E2E)')
  await a.locator('[name=close_at]').fill('2027-03-31T16:00')
  await a.getByRole('button', { name: 'บันทึกและเผยแพร่' }).click()
  await expect(trainer.getByRole('heading', { name: 'เรียงลำดับและจับคู่ (E2E)' })).toBeVisible()
  expect(csp).toEqual([])

  // Trainee: put the steps right and pick the pairs
  const learner = await (await browser.newContext()).newPage()
  await signIn(learner, 'teacher.b1@example.test')
  await learner.goto('/#/assessments')
  await learner.getByRole('link', { name: /เรียงลำดับและจับคู่ \(E2E\)/ }).click()
  await learner.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  const ordering = learner.locator('fieldset[data-item-type=ordering]')
  await expect(ordering.locator('[data-order-id]')).toHaveCount(3) // exam rendered
  for (const [target, text] of ['ตั้งเป้าหมาย', 'เก็บหลักฐาน', 'ให้ข้อมูลย้อนกลับ'].entries()) {
    for (;;) {
      const texts = await ordering.locator('[data-order-id]').allInnerTexts()
      if (texts.findIndex((t) => t.includes(text)) <= target) break
      await ordering.locator('[data-order-id]', { hasText: text }).locator('[data-move="-1"]').click()
    }
  }
  const matching = learner.locator('fieldset[data-item-type=matching]')
  await matching.locator('select').nth(0).selectOption({ label: 'บอกว่างานที่ดีเป็นอย่างไร' })
  await matching.locator('select').nth(1).selectOption({ label: 'บอกว่าควรปรับอะไร' })
  await learner.getByRole('button', { name: 'ส่งคำตอบ' }).click()
  await expect(learner.getByRole('heading', { name: 'ผลการทดสอบ' })).toBeVisible()
  await expect(learner.locator('[data-score]')).toHaveText(/2\s*\/\s*2/)
})

import { test, expect } from './fixtures.js'
import { signIn, submitAs, resetTaskWork, sqlAs, DEMO, PEOPLE } from './helpers.js'

test('trainee: typing in the draft saves itself; reload keeps it; leaving unsaved asks first', async ({
  page,
}) => {
  resetTaskWork()
  await signIn(page, 'teacher.a1@example.test')
  await page.goto(`/#/tasks/${DEMO.allocation}`)
  await page.getByRole('button', { name: /เริ่มทำงาน/ }).click()
  const form = page.locator('form[data-form=draft]')
  await form.locator('[name=text]').fill('ร่างที่ไม่ได้กดบันทึก')
  await form.locator('[name=link_url]').fill('https://docs.example.test/auto')
  await expect(form.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved') // no button pressed
  await page.reload()
  await expect(page.locator('form[data-form=draft] [name=text]')).toHaveValue('ร่างที่ไม่ได้กดบันทึก')
  await expect(page.locator('form[data-form=draft] [name=link_url]')).toHaveValue(
    'https://docs.example.test/auto'
  )

  // A half-typed link is not saved and the status says why; typing more then saves
  await page.locator('form[data-form=draft] [name=link_url]').fill('http://ยังพิมพ์ไม่เสร็จ')
  await expect(page.locator('[data-save-status]')).toContainText('ตรวจข้อมูลที่กรอกก่อน')
  await page.locator('form[data-form=draft] [name=link_url]').fill('https://docs.example.test/final')
  await expect(page.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')

  // Unsaved text + an in-app link: our Thai prompt (declined, then accepted)
  await page.locator('form[data-form=draft] [name=link_url]').fill('http://ค้างอยู่')
  const prompts = []
  page.on('dialog', (d) => {
    prompts.push(d.message())
    return prompts.length === 1 ? d.dismiss() : d.accept()
  })
  await page.getByRole('link', { name: '← ภาระงานของฉัน' }).click()
  await expect(page.locator('form[data-form=draft]')).toBeVisible() // stayed
  await page.getByRole('link', { name: '← ภาระงานของฉัน' }).click()
  await expect(page.getByRole('heading', { name: 'ภาระงานของฉัน' })).toBeVisible()
  expect(prompts).toEqual([
    'ยังบันทึกไม่เสร็จ ออกจากหน้านี้หรือไม่',
    'ยังบันทึกไม่เสร็จ ออกจากหน้านี้หรือไม่',
  ])
})

test('reviewer: choosing levels keeps a private draft without pressing save; the trainee sees nothing', async ({
  page,
}) => {
  resetTaskWork()
  submitAs(PEOPLE.a1.id, 'งานของ ก1')
  await signIn(page, 'trainer@example.test')
  await page.goto(`/#/staff/tasks/${DEMO.allocation}`)
  await page.locator('tr', { hasText: PEOPLE.a1.name }).locator('[data-review-link]').click()
  const form = page.locator('form[data-form=review]')
  await expect(form.locator('[data-action=discard]')).toBeHidden()
  await form
    .locator(`[data-criterion="${DEMO.c1}"]`)
    .getByLabel(/^\s*พอใช้\s+\d/)
    .check()
  await form.locator('[name=feedback]').fill('เขียนค้างไว้')
  await expect(form.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')
  await expect(form.locator('[data-action=discard]')).toBeVisible()
  await page.reload()
  await expect(page.locator(`[data-criterion="${DEMO.c1}"] input:checked`)).toBeVisible()
  await expect(page.locator('[name=feedback]')).toHaveValue('เขียนค้างไว้')
  const seen = sqlAs(PEOPLE.a1.id, 'select count(*) from public.task_reviews;')
  expect(seen.split('\n').find((l) => /^\d+$/.test(l))).toBe('0') // a draft is private to the reviewer
  // Discarding removes it
  page.once('dialog', (d) => d.accept())
  await page.locator('form[data-form=review]').getByRole('button', { name: 'ทิ้งร่าง' }).click()
  await expect(page.getByText('ทิ้งร่างการตรวจแล้ว')).toBeVisible()
  await expect(page.locator('form[data-form=review] input:checked')).toHaveCount(0)
})

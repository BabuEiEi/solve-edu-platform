import { test, expect } from './fixtures.js'
import { signIn, watchCsp } from './helpers.js'

/**
 * Phase 4g step 2: Staff sets up a programme end to end on the pages — create,
 * put a course in it, add a cohort open for requests — and the page says who
 * will see the cohort. A teacher is offered none of it.
 */
test('Staff creates a programme, adds a course and a cohort open for requests', async ({ page }) => {
  const csp = watchCsp(page)
  await signIn(page, 'staff@example.test')
  await page.locator('a[href="#/programs"]:visible').first().click() // the menu (phone or desktop; the home page links there too)
  await page.locator('[data-action-link=new-program]').click()

  const form = page.locator('form[data-form=program-new]')
  await form.locator('[name=code]').fill('E2E-2570')
  await form.locator('[name=name]').fill('โครงการทดสอบ E2E')
  await form.locator('[name=owner_org_id]').selectOption({ label: 'สำนักงานเขตพื้นที่การศึกษาสาธิต (สมมติ)' })
  await form.locator('[name=status]').selectOption('active')
  await form.getByRole('button', { name: 'สร้างโครงการ' }).click()
  await expect(page.getByRole('heading', { name: 'โครงการทดสอบ E2E' })).toBeVisible()

  const add = page.locator('form[data-form=add-course]')
  await add
    .locator('select')
    .selectOption({ label: 'การประเมินเพื่อพัฒนาการเรียนรู้ (Assessment for Learning) — ทดลอง' })
  await add.getByRole('button', { name: 'เพิ่ม' }).click()
  await expect(page.getByText('เพิ่มหลักสูตรในโครงการแล้ว')).toBeVisible()
  await expect(page.locator('[data-program-courses] li')).toHaveCount(1)

  await page.locator('[data-action=new-cohort]').click()
  const cohort = page.locator('form[data-form=cohort-new]')
  await cohort.locator('[name=code]').fill('R1')
  await cohort.locator('[name=name]').fill('รุ่นที่ 1 ทดสอบ')
  await cohort.locator('[name=status]').selectOption('open')
  await cohort.locator('[name=enrollment_mode]').selectOption('approval')
  await cohort.locator('[name=seat_limit]').fill('20')
  await cohort.getByRole('button', { name: 'สร้างรุ่น' }).click()
  await expect(page.getByText('สร้างรุ่นแล้ว')).toBeVisible()
  const row = page.locator('[data-cohort-id]', { hasText: 'รุ่นที่ 1 ทดสอบ' })
  await expect(row).toContainText('รับสมัคร: ต้องอนุมัติ')
  await expect(row.locator('[data-joining-hint]')).toContainText('ผู้เรียนทุกคนที่บัญชีใช้งานได้เห็นรุ่นนี้')
  await expect(row.locator('[data-joining-hint]')).toContainText('20 ที่นั่ง')
  expect(csp).toEqual([])
})

test('a teacher sees programmes they take part in, with no buttons to change them', async ({ page }) => {
  await signIn(page, 'teacher.a1@example.test')
  await page.locator('a[href="#/programs"]:visible').first().click() // the menu (phone or desktop; the home page links there too)
  await expect(page.locator('[data-programs]')).toBeVisible()
  await expect(page.locator('[data-action-link=new-program]')).toHaveCount(0)
  await page.goto('/#/programs/new')
  await expect(page.locator('form[data-form=program-new]')).toHaveCount(0)
})

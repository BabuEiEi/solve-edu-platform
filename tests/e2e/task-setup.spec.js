import { test, expect } from './fixtures.js'
import { signIn, watchCsp, IDS } from './helpers.js'

test('trainer sets up a task: published rubric, publish, open to the cohort with a due date, change it, withdraw', async ({
  page,
}) => {
  const csp = watchCsp(page)
  await signIn(page, 'trainer@example.test')

  // A published rubric to score with
  await page.goto(`/#/courses/${IDS.course}/rubrics`)
  const rubric = page.locator('form[data-form=create-rubric]')
  await rubric.locator('[name=code]').fill('E2E-TASK-RUBRIC')
  await rubric.locator('[name=title]').fill('เกณฑ์ตรวจภาระงาน (E2E)')
  await rubric.getByRole('button', { name: 'สร้าง Rubric' }).click()
  await page.getByRole('button', { name: '+ เพิ่มเกณฑ์' }).click()
  await page.locator('form[data-form=criterion] [name=prompt]').fill('การกำหนดเป้าหมาย')
  await page.getByRole('button', { name: 'บันทึกเกณฑ์' }).click()
  await expect(page.locator('[data-criterion-id]')).toHaveCount(1)
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'เผยแพร่ฉบับนี้' }).click()
  await expect(page.getByText('เผยแพร่แล้ว — นำไปใช้กับภาระงานได้')).toBeVisible()

  // The task: reached from the course page, created as a draft
  await page.goto(`/#/courses/${IDS.course}/builder`)
  await page.getByRole('link', { name: 'ภาระงาน', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'ภาระงานของหลักสูตร' })).toBeVisible()
  const create = page.locator('form[data-form=create-task]')
  await create.locator('[name=title]').fill('ส่งแผนการสอน AfL (E2E)')
  await create.locator('[name=instructions]').fill('แนบแผนการสอน 1 คาบ พร้อมสะท้อนคิด')
  await create
    .locator('[name=rubric_version_id]')
    .selectOption({ label: 'เกณฑ์ตรวจภาระงาน (E2E) · ฉบับที่ 1' })
  await create.getByRole('button', { name: 'สร้างภาระงาน' }).click()
  await expect(page.getByRole('heading', { name: 'ส่งแผนการสอน AfL (E2E)' })).toBeVisible()
  await expect(page.locator('[data-allocations]')).toContainText('เผยแพร่ภาระงานก่อน') // draft: cannot open yet

  // Publish, then open to the cohort
  await page.getByRole('button', { name: 'เผยแพร่', exact: true }).click()
  await expect(page.getByText('เปลี่ยนสถานะเป็น “เผยแพร่” แล้ว')).toBeVisible()
  const open = page.locator('form[data-form=new-allocation]')
  await open.locator('[name=due_at]').fill('2027-03-31T23:59')
  await expect(open.locator('[data-date-label=due_at]')).toContainText('31 มี.ค. 2570 23:59') // พ.ศ. echo
  await open.getByRole('button', { name: 'เปิดให้รุ่น' }).click()
  await expect(page.getByText('เปิดภาระงานให้รุ่นแล้ว')).toBeVisible()
  const row = page.locator('form[data-form=allocation]')
  await expect(row).toHaveCount(1)
  await expect(row.locator('input[type=datetime-local]').nth(1)).toHaveValue('2027-03-31T23:59')

  // A due date before the opening is refused by the page
  await row.locator('input[type=datetime-local]').nth(0).fill('2027-04-02T08:00')
  await row.getByRole('button', { name: 'บันทึกวัน' }).click()
  await expect(page.getByRole('alert')).toContainText('กำหนดส่งต้องหลังวันเปิดรับงาน')
  // Fixing it saves
  await page.locator('form[data-form=allocation] input[type=datetime-local]').nth(0).fill('2027-03-01T08:00')
  await page.locator('form[data-form=allocation]').getByRole('button', { name: 'บันทึกวัน' }).click()
  await expect(page.getByText('บันทึกวันที่แล้ว')).toBeVisible()

  // Withdraw (nobody has started), then the task can go back to a draft
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'เลิกเปิด' }).click()
  await expect(page.getByText('เลิกเปิดให้รุ่นแล้ว')).toBeVisible()
  await expect(page.locator('form[data-form=allocation]')).toHaveCount(0)
  expect(csp).toEqual([])
})

test('a trainee has no access to task setup', async ({ page }) => {
  await signIn(page, 'teacher.a1@example.test')
  await page.goto(`/#/courses/${IDS.course}/tasks`)
  await expect(page.getByText('ไม่มีสิทธิ์จัดการภาระงาน')).toBeVisible()
})

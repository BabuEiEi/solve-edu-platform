import { test, expect } from './fixtures.js'
import { signIn, watchCsp, IDS, answerDialog } from './helpers.js'

test('trainer builds a rubric: two criteria, publish, then a new draft version; the quiz list stays separate', async ({
  page,
}) => {
  const csp = watchCsp(page)
  await signIn(page, 'trainer@example.test')
  await page.goto(`/#/courses/${IDS.course}/builder`)
  await page.getByRole('link', { name: 'Rubric', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Rubric ของหลักสูตร' })).toBeVisible()

  const create = page.locator('form[data-form=create-rubric]')
  await create.locator('[name=code]').fill('E2E-RUBRIC')
  await create.locator('[name=title]').fill('เกณฑ์ตรวจแผนการสอน (E2E)')
  await create.getByRole('button', { name: 'สร้าง Rubric' }).click()
  await expect(page.getByRole('heading', { name: 'เกณฑ์ตรวจแผนการสอน (E2E)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'เผยแพร่ฉบับนี้' })).toBeDisabled() // no criteria yet

  // Criterion 1: the four default levels, one renamed
  await page.getByRole('button', { name: '+ เพิ่มเกณฑ์' }).click()
  let form = page.locator('form[data-form=criterion]')
  await form.locator('[name=prompt]').fill('การกำหนดเป้าหมายการเรียนรู้')
  await form.locator('[name=level_label]').nth(3).fill('ยอดเยี่ยม')
  await form.locator('[name=level_description]').nth(3).fill('เป้าหมายชัด วัดได้ ครบทุกด้าน')
  await form.getByRole('button', { name: 'บันทึกเกณฑ์' }).click()
  await expect(page.getByText('บันทึกเกณฑ์แล้ว')).toBeVisible()
  await expect(page.locator('[data-criterion-id]')).toHaveCount(1)
  await expect(page.locator('[data-criterion-id]').first()).toContainText('4 ระดับ · เต็ม 4 คะแนน')

  // Criterion 2: two levels only (remove two of the four), scored 0 and 2
  await page.getByRole('button', { name: '+ เพิ่มเกณฑ์' }).click()
  form = page.locator('form[data-form=criterion]')
  await form.locator('[name=prompt]').fill('การใช้หลักฐาน')
  await form.getByRole('button', { name: 'ลบระดับ' }).last().click()
  await form.getByRole('button', { name: 'ลบระดับ' }).last().click()
  await form.locator('[name=level_label]').nth(0).fill('ไม่มี')
  await form.locator('[name=level_score]').nth(0).fill('0')
  await form.locator('[name=level_label]').nth(1).fill('มี')
  await form.locator('[name=level_score]').nth(1).fill('2')
  await form.getByRole('button', { name: 'บันทึกเกณฑ์' }).click()
  await expect(page.locator('[data-criterion-id]')).toHaveCount(2)
  await expect(page.getByText('พร้อมเผยแพร่ (2 เกณฑ์ · คะแนนเต็มรวม 6)')).toBeVisible()

  // A criterion with equal scores is refused by the page; the form stays open
  await page.locator('[data-criterion-id]').nth(1).getByRole('button', { name: 'แก้ไข' }).click()
  form = page.locator('form[data-form=criterion]')
  await form.locator('[name=level_score]').nth(0).fill('2')
  await form.getByRole('button', { name: 'บันทึกเกณฑ์' }).click()
  await expect(form.getByRole('alert')).toContainText('คะแนนไม่ซ้ำกัน')
  await form.getByRole('button', { name: 'ยกเลิก' }).click()

  // Reorder, then publish
  await page.locator('[data-criterion-id]').nth(1).getByRole('button', { name: 'เลื่อนขึ้น' }).click()
  await expect(page.locator('[data-criterion-id]').first()).toContainText('การใช้หลักฐาน')
  await page.getByRole('button', { name: 'เผยแพร่ฉบับนี้' }).click()
  await answerDialog(page)
  await expect(page.getByText('เผยแพร่แล้ว — นำไปใช้กับภาระงานได้')).toBeVisible()
  await expect(page.getByRole('button', { name: 'แก้ไข', exact: true })).toHaveCount(0) // published: read-only

  // New draft version carries the criteria over
  await page.getByRole('button', { name: 'สร้างฉบับใหม่จากฉบับนี้เพื่อแก้ไข' }).click()
  await expect(page.getByText('สร้างฉบับร่างใหม่แล้ว')).toBeVisible()
  await expect(page.locator('[data-criterion-id]')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'เผยแพร่ฉบับนี้' })).toBeEnabled()

  // The quiz list does not show the rubric, and the rubric list does not show quizzes
  await page.goto(`/#/courses/${IDS.course}/quizzes`)
  await expect(page.getByRole('heading', { name: 'แบบทดสอบของหลักสูตร' })).toBeVisible()
  await expect(page.getByText('เกณฑ์ตรวจแผนการสอน (E2E)')).toHaveCount(0)
  await page.goto(`/#/courses/${IDS.course}/rubrics`)
  await expect(page.getByText('เกณฑ์ตรวจแผนการสอน (E2E)')).toBeVisible()
  await expect(page.getByText('แบบทดสอบก่อนเรียน')).toHaveCount(0)
  expect(csp).toEqual([])
})

test('a rubric id opened as a quiz (and a quiz opened as a rubric) is not shown; a trainee gets no access', async ({
  page,
  browser,
}) => {
  await signIn(page, 'trainer@example.test')
  await page.goto(`/#/courses/${IDS.course}/rubrics/a1000000-0000-4000-a000-000000000001`) // the demo QUIZ id
  await expect(page.getByText('ไม่มีสิทธิ์จัดการ Rubric')).toBeVisible()

  const learner = await (await browser.newContext()).newPage()
  await signIn(learner, 'teacher.a1@example.test')
  await learner.goto(`/#/courses/${IDS.course}/rubrics`)
  await expect(learner.getByText('ไม่มีสิทธิ์จัดการ Rubric')).toBeVisible()
})

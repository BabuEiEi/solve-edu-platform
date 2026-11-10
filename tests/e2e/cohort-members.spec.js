import { test, expect } from './fixtures.js'
import { signIn, sqlAs, IDS, PEOPLE } from './helpers.js'

/**
 * Phase 4g step 3: the cohort members page. Its own cohort (set up through the
 * database as Staff) so the demo cohort the other specs read is untouched.
 */
const STAFF = '00000000-0000-4000-a000-000000000012'
const PROGRAM = '20000000-0000-4000-a000-000000000001'
const TEACHER_B1 = '00000000-0000-4000-a000-000000000010'

test('Staff accepts a request, adds a person by search, enrolls them in a course; the person can open it', async ({
  page,
  browser,
}) => {
  const cohortId = sqlAs(
    STAFF,
    `insert into public.cohorts (program_id, code, name, status, enrollment_mode)
     values ('${PROGRAM}', 'E2E-M', 'รุ่นทดสอบสมาชิก', 'open', 'approval') returning id;`
  )
    .split('\n')
    .find((l) => /^[0-9a-f-]{36}$/.test(l))
  sqlAs(PEOPLE.a2.id, `select public.request_cohort_join('${cohortId}');`) // ครู ก2 asks to join

  await signIn(page, 'staff@example.test')
  await page.goto(`/#/programs/${PROGRAM}/cohorts/${cohortId}`)
  await expect(page.getByRole('heading', { name: /รุ่นทดสอบสมาชิก/ })).toBeVisible()

  // the request
  const request = page.locator('[data-requests] li', { hasText: 'ครู ก2' })
  await expect(request).toBeVisible()
  await request.getByRole('button', { name: 'รับเข้ารุ่น' }).click()
  await expect(page.getByText('รับเข้ารุ่นแล้ว')).toBeVisible()
  await expect(page.locator('[data-role-group=trainee]')).toContainText('ครู ก2')

  // search and add (Staff searches e-mails too)
  await page.locator('form[data-form=people-search] [name=q]').fill('teacher.b1@')
  await page.locator('form[data-form=people-search]').getByRole('button', { name: 'ค้นหา' }).click()
  const found = page.locator('[data-search-results] li', { hasText: 'ครู ข1' })
  await expect(found).toContainText('teacher.b1@example.test')
  await found.getByRole('button', { name: 'เพิ่ม' }).click()
  await expect(page.getByText('เพิ่มเป็นผู้เข้าอบรมแล้ว')).toBeVisible()
  await expect(page.locator('[data-role-group=trainee] li')).toHaveCount(2)

  // enroll ครู ก2 in the course (one course, one person)
  const cell = page.locator(`[data-trainee="${PEOPLE.a2.id}"] [data-cell="${IDS.course}"]`)
  await cell.getByRole('button', { name: 'ลงทะเบียน' }).click()
  await expect(page.getByText('ลงทะเบียนแล้ว', { exact: true }).first()).toBeVisible()
  await expect(cell).toContainText('ลงทะเบียนแล้ว')
  const b1 = page.locator(`[data-trainee="${TEACHER_B1}"] [data-cell="${IDS.course}"]`)
  await expect(b1.getByRole('button', { name: 'ลงทะเบียน' })).toBeVisible() // ครู ข1 is not enrolled yet: still offered

  // ครู ก2 can open the course of this cohort
  const learner = await (await browser.newContext()).newPage()
  await signIn(learner, 'teacher.a2@example.test')
  await learner.goto(`/#/courses/${IDS.course}`)
  await expect(learner.getByRole('heading', { name: /การประเมินเพื่อพัฒนาการเรียนรู้/ })).toBeVisible()
})

test('a trainee of the demo cohort cannot manage its members', async ({ page }) => {
  await signIn(page, 'teacher.a1@example.test')
  await page.goto(`/#/programs/${PROGRAM}/cohorts/30000000-0000-4000-a000-000000000001`)
  await expect(page.locator('[data-add-people], [data-action=enroll], [data-action=remove]')).toHaveCount(0)
})

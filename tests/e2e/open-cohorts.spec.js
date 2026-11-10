import { test, expect } from './fixtures.js'
import { signIn, sqlAs, answerDialog, watchCsp, IDS } from './helpers.js'

/**
 * Phase 4g step 4: the learner's side. Staff opens two cohorts (through the
 * database); a learner joins the one that is open at once, chooses a course and
 * opens it, asks the other one and takes the request back; another learner
 * finds the first one full. Own cohorts, so the demo cohort is untouched.
 */
const STAFF = '00000000-0000-4000-a000-000000000012'
const PROGRAM = '20000000-0000-4000-a000-000000000001'
const OPEN_NAME = 'รุ่นเปิดทันที E2E'
const APPROVAL_NAME = 'รุ่นต้องอนุมัติ E2E'
const CLOSED_NAME = 'รุ่นปิดรับสมัคร ผู้จัดการเพิ่มคน E2E'
const LEARNER = '00000000-0000-4000-a000-000000000004' // school.admin.a (a teacher now, in no cohort)

const uuidOf = (out) => out.split('\n').find((l) => /^[0-9a-f-]{36}$/.test(l))

test('a learner joins an open cohort, chooses a course and opens it; asks another cohort and takes the request back', async ({
  page,
  browser,
}) => {
  const csp = watchCsp(page)
  const cohortId = uuidOf(
    sqlAs(
      STAFF,
      `insert into public.cohorts (program_id, code, name, status, enrollment_mode, seat_limit)
       values ('${PROGRAM}', 'E2E-OPEN', '${OPEN_NAME}', 'open', 'open', 1) returning id;`
    )
  )
  sqlAs(
    STAFF,
    `insert into public.cohorts (program_id, code, name, status, enrollment_mode)
     values ('${PROGRAM}', 'E2E-APPR', '${APPROVAL_NAME}', 'open', 'approval');`
  )

  await signIn(page, 'school.admin.a@example.test')
  await page.locator('a[href="#/join"]:visible').first().click()
  await expect(page.getByRole('heading', { name: 'รุ่นที่เปิดรับสมัคร', exact: true })).toBeVisible()
  const open = page.locator('[data-cohort]', { hasText: OPEN_NAME })
  await expect(open).toContainText('เหลือ 1 ที่นั่ง')
  await expect(open).toContainText('การประเมินเพื่อพัฒนาการเรียนรู้') // the courses are shown before joining
  await expect(open.locator('[data-action=enroll]')).toHaveCount(0) // … but not offered yet
  await expect(page.locator('a[href="#/assessments"]')).toHaveCount(0) // not a trainee yet: no tests menu

  // join at once (asks first)
  await open.getByRole('button', { name: 'สมัครเข้ารุ่นนี้' }).click()
  await answerDialog(page, 'confirm')
  const joined = page.locator('[data-my-cohorts] article[data-cohort]', { hasText: OPEN_NAME })
  await expect(joined).toBeVisible() // now under "รุ่นของฉัน"
  await expect(page.locator('[data-open-cohorts] article', { hasText: OPEN_NAME })).toHaveCount(0) // and not twice
  await expect(page.locator('a[href="#/assessments"]')).not.toHaveCount(0) // a trainee now: the menu followed

  // choose the course, then open it
  await joined
    .locator(`li[data-course="${IDS.course}"]`)
    .getByRole('button', { name: 'ลงทะเบียนหลักสูตรนี้' })
    .click()
  await expect(page.getByText('ลงทะเบียนหลักสูตรแล้ว')).toBeVisible()
  const link = joined.locator(`li[data-course="${IDS.course}"] a[data-action-link=open-course]`)
  await expect(link).toBeVisible()
  await link.click()
  await expect(page.getByRole('heading', { name: /การประเมินเพื่อพัฒนาการเรียนรู้/ }).first()).toBeVisible()

  // meanwhile Staff adds the learner to a cohort CLOSED to joining
  const closedId = uuidOf(
    sqlAs(
      STAFF,
      `insert into public.cohorts (program_id, code, name, status, enrollment_mode)
       values ('${PROGRAM}', 'E2E-CLOSED', '${CLOSED_NAME}', 'in_progress', 'closed') returning id;`
    )
  )
  sqlAs(
    STAFF,
    `insert into public.cohort_memberships (cohort_id, user_id, cohort_role, status) values ('${closedId}', '${LEARNER}', 'trainee', 'active');`
  )

  // the cohort closed to joining (added by Staff) is under "รุ่นของฉัน" too, and its course can be chosen
  await page.goto('/#/join')
  const closed = page.locator('[data-my-cohorts] article[data-cohort]', { hasText: CLOSED_NAME })
  await closed
    .locator(`li[data-course="${IDS.course}"]`)
    .getByRole('button', { name: 'ลงทะเบียนหลักสูตรนี้' })
    .click()
  await expect(closed.locator(`li[data-course="${IDS.course}"]`)).toContainText('ลงทะเบียนแล้ว')
  await expect(page.locator('[data-open-cohorts] article', { hasText: CLOSED_NAME })).toHaveCount(0) // never offered to others

  // the other cohort needs a manager's approval; take the request back, then ask again
  const approval = page.locator('[data-cohort]', { hasText: APPROVAL_NAME })
  await approval.getByRole('button', { name: 'ขอเข้ารุ่นนี้' }).click()
  await expect(approval.locator('[data-status=waiting]')).toContainText('รอผู้จัดการรุ่นอนุมัติ')
  await approval.getByRole('button', { name: 'ถอนคำขอ' }).click()
  await answerDialog(page, 'confirm')
  await expect(approval.locator('[data-status=again]')).toContainText('ต้องรอผู้จัดการรุ่นอนุมัติใหม่')
  await expect(approval.getByRole('button', { name: 'ขอเข้ารุ่นอีกครั้ง' })).toBeVisible()
  expect(csp).toEqual([])

  // someone else finds the first cohort full
  const other = await (await browser.newContext()).newPage()
  await signIn(other, 'teacher.a2@example.test')
  await other.goto('/#/join')
  const full = other.locator('[data-cohort]', { hasText: OPEN_NAME })
  await expect(full.locator('[data-status=full]')).toBeVisible()
  await expect(full.locator('[data-action=join]')).toHaveCount(0)
  expect(
    sqlAs(
      STAFF,
      `select count(*) from public.cohort_memberships where cohort_id = '${cohortId}' and cohort_role = 'trainee' and status = 'active';`
    )
      .split('\n')
      .find((l) => /^\d+$/.test(l))
  ).toBe('1') // the seat limit held
})

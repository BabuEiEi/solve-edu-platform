import { readFile } from 'node:fs/promises'
import { test, expect } from './fixtures.js'
import { signIn, watchCsp, sqlAs, submitAs, reviewInUi, resetTaskWork, DEMO, PEOPLE } from './helpers.js'

// psql also prints SET / COMMIT: the count is the one line that is only digits
const count = (userId, sql) =>
  Number(
    sqlAs(userId, sql)
      .split('\n')
      .find((l) => /^\d+$/.test(l))
  )

test('trainer reviews with the rubric: queue, draft hidden from the trainee, release, re-grade needs a reason, CSV', async ({
  page,
  browser,
}) => {
  const csp = watchCsp(page)
  resetTaskWork()
  submitAs(PEOPLE.a1.id, 'งานของ ก1')
  submitAs(PEOPLE.a2.id, 'งานของ ก2 <img src=x onerror=alert(1)>')
  await signIn(page, 'trainer@example.test')
  await page.locator('a[href="#/staff/tasks"]:visible').click()
  await expect(page.locator('[data-review-queue]')).toContainText('ส่งแผนการสอน AfL 1 คาบ')
  await expect(page.locator('[data-waiting]')).toContainText('รอตรวจ 2')

  // The people table: both waiting, a filter, then the first person's work
  await page.locator('[data-review-queue] a').first().click()
  await expect(page.locator('[data-people] tbody tr')).toHaveCount(3) // the demo cohort has 3 trainees: 2 submitted, 1 not yet
  await page.getByRole('button', { name: /^รอตรวจ/ }).click()
  await expect(page.locator('[data-people] tbody tr')).toHaveCount(2)
  await page.getByRole('button', { name: /^ทั้งหมด/ }).click()
  await page.locator('tr', { hasText: PEOPLE.a2.name }).locator('[data-review-link]').click()
  await expect(page.locator('[data-work]')).toContainText('งานของ ก2')
  await expect(page.locator('[data-work] img')).toHaveCount(0) // the work's text is shown as text

  // Release needs everything: one criterion unscored, no outcome → stopped on the page
  const form = page.locator('form[data-form=review]')
  await form.locator(`[data-criterion="${DEMO.c1}"]`).getByLabel(/ดีมาก/).check()
  await form.getByRole('button', { name: 'ส่งผลให้ผู้เรียน' }).click()
  await expect(form.getByRole('alert')).toContainText('ยังไม่ได้เลือกระดับของเกณฑ์')

  // Draft for A1: saved, kept after reload, and NOT visible to the trainee
  await reviewInUi(page, PEOPLE.a1.name, {
    levels: { [DEMO.c1]: 'พอใช้', [DEMO.c2]: 'ไม่มีหลักฐาน' },
    comments: { [DEMO.c1]: 'เป้าหมายกว้างไป' },
    feedback: 'ลองเพิ่มหลักฐาน',
    outcome: 'revise',
  })
  await page.reload()
  await expect(page.locator(`[data-criterion="${DEMO.c1}"] input:checked`)).toBeVisible()
  await expect(page.locator('[name=feedback]')).toHaveValue('ลองเพิ่มหลักฐาน')
  expect(count(PEOPLE.a1.id, `select count(*) from public.task_reviews;`)).toBe(0) // the trainee sees no draft

  // Release; the trainee now sees it
  await reviewInUi(page, PEOPLE.a1.name, {
    levels: { [DEMO.c1]: 'พอใช้', [DEMO.c2]: 'ไม่มีหลักฐาน' },
    outcome: 'revise',
    release: true,
  })
  expect(count(PEOPLE.a1.id, `select count(*) from public.task_reviews where released_at is not null;`)).toBe(
    1
  )
  await page.goto(`/#/staff/tasks/${DEMO.allocation}`)
  await expect(page.locator('tr', { hasText: PEOPLE.a1.name })).toContainText('ส่งกลับแก้ไข')
  await expect(page.locator('tr', { hasText: PEOPLE.a1.name })).toContainText('2 / 6')
  await expect(page.locator('[data-waiting]')).toHaveCount(0)

  // Re-grade: the reason is required; both reviews are listed afterwards
  await page.locator('tr', { hasText: PEOPLE.a1.name }).locator('[data-review-link]').click()
  await expect(page.locator('[data-released-reviews]')).toContainText('ผลที่ใช้อยู่')
  await page.locator(`[data-criterion="${DEMO.c1}"]`).getByLabel(/ดีมาก/).check()
  await page.locator('form[data-form=review]').getByRole('button', { name: 'ส่งผลให้ผู้เรียน' }).click()
  await expect(page.locator('form[data-form=review]').getByRole('alert')).toContainText(
    'ระบุเหตุผลที่ตรวจใหม่'
  )
  await page.locator('[name=reason]').fill('ทบทวนตามเกณฑ์แล้ว')
  page.once('dialog', (d) => d.accept())
  await page.locator('form[data-form=review]').getByRole('button', { name: 'ส่งผลให้ผู้เรียน' }).click()
  await expect(page.getByText('ส่งผลให้ผู้เรียนแล้ว')).toBeVisible()
  await expect(page.locator('[data-released]')).toHaveCount(2)
  await expect(page.locator('[data-released-reviews]')).toContainText('ผลก่อนหน้า')
  await expect(page.locator('[data-released-reviews]')).toContainText('เหตุผลที่ตรวจใหม่: ทบทวนตามเกณฑ์แล้ว')

  // CSV: names, status, scores — no work content
  await page.goto(`/#/staff/tasks/${DEMO.allocation}`)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'ดาวน์โหลดผล (CSV)' }).click()
  const csv = await readFile(await (await download).path(), 'utf8')
  expect(csv).toContain('ชื่อ,สถานะ,จำนวนรอบที่ส่ง')
  expect(csv).toContain(PEOPLE.a1.name)
  expect(csv).toContain('ยังไม่ส่ง') // trainees who have not submitted are listed too
  expect(csv).not.toContain('งานของ ก1')
  expect(csv).not.toContain('onerror')
  expect(csp).toEqual([])

  // A mentor sees only their mentee (A1): one person, and A2's work is closed to them
  const mentor = await (await browser.newContext()).newPage()
  await signIn(mentor, 'mentor@example.test')
  await mentor.goto(`/#/staff/tasks/${DEMO.allocation}`)
  await expect(mentor.locator('[data-people] tbody tr')).toHaveCount(1)
  await expect(mentor.locator('[data-people]')).toContainText(PEOPLE.a1.name)
  await expect(mentor.locator('[data-people]')).not.toContainText(PEOPLE.a2.name)
})

test('a trainee has no review pages (this runs after the first test, so work exists to be hidden)', async ({
  page,
}) => {
  await signIn(page, 'teacher.a1@example.test')
  await expect(page.locator('a[href="#/staff/tasks"]:visible')).toHaveCount(0)
  await page.goto(`/#/staff/tasks/${DEMO.allocation}`)
  await expect(page.locator('[data-people]')).toHaveCount(0) // RLS: a trainee sees no one else's work
})

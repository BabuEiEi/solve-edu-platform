import { test, expect } from './fixtures.js'
import { signIn, submitAs, reviewInUi, resetTaskWork, DEMO, PEOPLE } from './helpers.js'

// both menus (desktop sidebar, phone strip) carry the same badge; the first is enough
const badge = (page, path) => page.locator(`[data-nav-badge="${path}"]`).first()

test('menu badges: the reviewer sees what waits; the trainee sees a new result, then it clears once opened', async ({
  page,
  browser,
}) => {
  resetTaskWork()
  submitAs(PEOPLE.a1.id, 'งานของ ก1')
  submitAs(PEOPLE.a2.id, 'งานของ ก2')

  const trainer = await (await browser.newContext()).newPage()
  await signIn(trainer, 'trainer@example.test')
  await expect(badge(trainer, '/staff/tasks')).toHaveText('2')

  // The trainee has nothing yet
  await signIn(page, 'teacher.a1@example.test')
  await expect(badge(page, '/tasks')).toBeHidden()

  // The trainer returns A1's work for revision: the waiting count drops by one
  await reviewInUi(trainer, PEOPLE.a1.name, {
    levels: { [DEMO.c1]: 'พอใช้', [DEMO.c2]: 'ไม่มีหลักฐาน' },
    feedback: 'เพิ่มหลักฐาน',
    outcome: 'revise',
    release: true,
  })
  await trainer.reload()
  await expect(badge(trainer, '/staff/tasks')).toHaveText('1')

  // The trainee: a new result AND a task to revise → 2; the list marks the task
  await page.reload()
  await expect(badge(page, '/tasks')).toHaveText('2')
  await page.locator('a[href="#/tasks"]:visible').click()
  await expect(page.locator('[data-notice=unread]')).toBeVisible()
  await expect(page.locator('[data-notice=revise]')).toBeVisible()

  // Opening the task marks the result as seen: the badge drops to 1 (still to revise) at once
  await page.getByRole('link', { name: /ส่งแผนการสอน AfL 1 คาบ/ }).click()
  await expect(page.locator('[data-review]')).toContainText('ส่งกลับแก้ไข')
  await expect(badge(page, '/tasks')).toHaveText('1')
  await page.getByRole('link', { name: '← ภาระงานของฉัน' }).click()
  await expect(page.locator('[data-notice=unread]')).toHaveCount(0)
  await expect(page.locator('[data-notice=revise]')).toBeVisible()

  // Starting the next attempt clears the "revise" notice (a draft is open)
  await page.getByRole('link', { name: /ส่งแผนการสอน AfL 1 คาบ/ }).click()
  await page.getByRole('button', { name: 'แก้ไขและส่งรอบที่ 2' }).click()
  await page.reload()
  await expect(badge(page, '/tasks')).toBeHidden()
})

test('a trainer who is not a trainee has no trainee badge; a trainee has no reviewer badge', async ({
  page,
  browser,
}) => {
  resetTaskWork()
  submitAs(PEOPLE.a1.id, 'งานของ ก1')
  await signIn(page, 'trainer@example.test')
  await expect(page.locator('[data-nav-badge="/tasks"]')).toHaveCount(0)
  const trainee = await (await browser.newContext()).newPage()
  await signIn(trainee, 'teacher.a2@example.test')
  await expect(trainee.locator('[data-nav-badge="/staff/tasks"]')).toHaveCount(0)
})

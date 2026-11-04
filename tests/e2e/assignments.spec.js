import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { signIn, watchCsp, IDS } from './helpers.js'

const QUIZ = 'a1000000-0000-4000-a000-000000000001'
const TITLE = 'แบบทดสอบหลังเรียน (E2E)'

test('trainer assigns a posttest, follows the cohort results and exports them; a mentor sees only their mentee', async ({
  browser,
}) => {
  const trainer = await (await browser.newContext()).newPage()
  const csp = watchCsp(trainer)
  await signIn(trainer, 'trainer@example.test')
  await trainer.goto(`/#/courses/${IDS.course}/quizzes/${QUIZ}`)
  await expect(trainer.locator('[data-assignments]')).toContainText('แบบทดสอบก่อนเรียน AfL')
  await trainer.locator('a[data-action-link=assign]').click()

  const form = trainer.locator('form[data-form=assignment]')
  await form.locator('[name=purpose]').selectOption('posttest')
  await form.locator('[name=title]').fill(TITLE)
  await form.locator('[name=passing_percent]').fill('50')
  await form.locator('[name=close_at]').fill('2027-03-31T16:00')
  await expect(form.locator('[data-date-label=close_at]')).toHaveText('31 มี.ค. 2570 16:00 น.') // พ.ศ. echo
  await form.getByRole('button', { name: 'บันทึกและเผยแพร่' }).click()

  await expect(trainer.getByRole('heading', { name: TITLE })).toBeVisible()
  await expect(trainer.locator('[data-summary]')).toContainText('0 / 3')
  await expect(trainer.getByText('31 มี.ค. 2570 16:00 น.').first()).toBeVisible() // Bangkok time, BE year

  // A trainee of the cohort (and the mentor's mentee) takes it
  const learner = await (await browser.newContext()).newPage()
  await signIn(learner, 'teacher.a1@example.test')
  await learner.goto('/#/assessments')
  await learner.getByRole('link', { name: new RegExp(TITLE.replace(/[()]/g, '\\$&')) }).click()
  await learner.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  await learner.getByLabel('ถูก', { exact: true }).check()
  await learner.getByRole('button', { name: 'ส่งคำตอบ' }).click()
  await expect(learner.getByText(/ยังไม่ได้ตอบ 3 ข้อ/)).toBeVisible()
  await learner.getByRole('button', { name: 'ส่งคำตอบ' }).click()
  await expect(learner.getByRole('heading', { name: 'ผลการทดสอบ' })).toBeVisible()

  // Trainer: results updated; pass mark now frozen
  await trainer.reload() // same hash: goto() would not re-render
  await expect(trainer.locator('[data-summary]')).toContainText('1 / 3')
  const row = trainer.locator('[data-results] tbody tr', { hasText: 'ครู ก1' })
  await expect(row).toContainText('ส่งแล้ว')
  await expect(row).toContainText('ยังไม่ผ่านเกณฑ์')
  await expect(trainer.locator('[data-results] tbody tr')).toHaveCount(3)
  await expect(trainer.locator('form[data-form=assignment] [name=passing_percent]')).toBeDisabled()
  await expect(trainer.locator('[data-item-analysis]')).toContainText('ต้องมีผู้ส่งอย่างน้อย 5 คน') // 1 submitted

  const [download] = await Promise.all([
    trainer.waitForEvent('download'),
    trainer.getByRole('button', { name: 'ดาวน์โหลด CSV' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^results-C1-.+\.csv$/)
  const csv = await readFile(await download.path(), 'utf8')
  expect(csv).toContain('ครู ก1 (สมมติ)')
  expect(csv).toContain('ยังไม่เริ่ม')

  // Deadline stays editable after attempts
  await trainer.locator('form[data-form=assignment] [name=attempt_limit]').fill('2')
  await trainer.getByRole('button', { name: 'บันทึกการตั้งค่า' }).click()
  await expect(trainer.getByText('บันทึกการตั้งค่าแล้ว')).toBeVisible()
  expect(csp).toEqual([])

  // Mentor: nav entry, only the mentee, no settings
  const mentor = await (await browser.newContext()).newPage()
  await signIn(mentor, 'mentor@example.test')
  await mentor.getByRole('link', { name: 'ผลแบบทดสอบ' }).first().click()
  await mentor.getByRole('link', { name: new RegExp(TITLE.replace(/[()]/g, '\\$&')) }).click()
  await expect(mentor.locator('[data-results] tbody tr')).toHaveCount(1)
  await expect(mentor.locator('[data-results]')).toContainText('ครู ก1')
  await expect(mentor.locator('form[data-form=assignment]')).toHaveCount(0)
})

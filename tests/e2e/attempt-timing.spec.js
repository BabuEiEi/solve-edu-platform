import { test, expect } from '@playwright/test'
import { signIn, watchCsp, IDS } from './helpers.js'

const QUIZ = 'a1000000-0000-4000-a000-000000000001'
const TITLE = 'แบบฝึกจับเวลา (E2E)'
const titleLink = new RegExp(TITLE.replace(/[()]/g, '\\$&'))

test('timed test: countdown, answers saved on the server follow the trainee to another device, extra attempt', async ({
  browser,
}) => {
  // Trainer: assign with a 15-minute limit
  const trainer = await (await browser.newContext()).newPage()
  await signIn(trainer, 'trainer@example.test')
  await trainer.goto(`/#/courses/${IDS.course}/quizzes/${QUIZ}`)
  await trainer.locator('a[data-action-link=assign]').click()
  const form = trainer.locator('form[data-form=assignment]')
  await form.locator('[name=purpose]').selectOption('formative')
  await form.locator('[name=title]').fill(TITLE)
  await form.locator('[name=time_limit_minutes]').fill('15')
  await form.locator('[name=close_at]').fill('2027-03-31T16:00')
  await expect(form.locator('[name=grace_minutes]')).toHaveValue('5')
  await form.getByRole('button', { name: 'บันทึกและเผยแพร่' }).click()
  await expect(trainer.getByRole('heading', { name: TITLE })).toBeVisible()

  // Device A: start, answer one item, wait for the server save
  const deviceA = await (await browser.newContext()).newPage()
  const csp = watchCsp(deviceA)
  await signIn(deviceA, 'teacher.a1@example.test')
  await deviceA.goto('/#/assessments')
  await deviceA.getByRole('link', { name: titleLink }).click()
  await expect(deviceA.getByText('15 นาทีต่อครั้ง')).toBeVisible()
  await deviceA.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  await expect(deviceA.locator('[data-remaining]')).toHaveText(/^1[45]:\d\d$/)
  await deviceA.getByLabel('ถูก', { exact: true }).check()
  await expect(deviceA.locator('[data-save-status]')).toContainText('บันทึกคำตอบแล้ว')
  await expect(deviceA.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')
  expect(
    await deviceA.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('attempt')))
  ).toEqual([])

  // Device B (same person): the open attempt resumes with the saved answer
  const deviceB = await (await browser.newContext()).newPage()
  await signIn(deviceB, 'teacher.a1@example.test')
  await deviceB.goto('/#/assessments')
  await deviceB.getByRole('link', { name: titleLink }).click()
  await expect(deviceB.getByLabel('ถูก', { exact: true })).toBeChecked()
  await deviceB.getByRole('button', { name: 'ส่งคำตอบ' }).click()
  await deviceB.getByRole('button', { name: 'ส่งคำตอบ' }).click() // confirm unanswered items
  await expect(deviceB.getByRole('heading', { name: 'ผลการทดสอบ' })).toBeVisible()

  // Trainer: one extra attempt for this trainee
  await trainer.reload()
  const row = trainer.locator('[data-results] tbody tr', { hasText: 'ครู ก1' })
  await expect(row).toContainText('1 / 1')
  trainer.once('dialog', (d) => d.accept('สัญญาณขาด'))
  await row.locator('[data-action=grant-extra]').click()
  await expect(trainer.getByText('ให้สิทธิ์ทำเพิ่ม 1 ครั้งแก่ ครู ก1 (สมมติ) แล้ว')).toBeVisible()
  await expect(trainer.locator('[data-results] tbody tr', { hasText: 'ครู ก1' })).toContainText('(เพิ่ม 1)')
  await expect(trainer.locator('form[data-form=assignment] [name=time_limit_minutes]')).toBeDisabled()

  await deviceB.getByRole('link', { name: new RegExp(`← ${TITLE.replace(/[()]/g, '\\$&')}`) }).click()
  await expect(deviceB.getByText('2 ครั้ง (รวมสิทธิ์เพิ่ม 1)')).toBeVisible()
  await expect(deviceB.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' })).toBeVisible()
  expect(csp).toEqual([])
})

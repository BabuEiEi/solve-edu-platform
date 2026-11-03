import { test, expect } from '@playwright/test'
import { signIn, watchCsp, IDS } from './helpers.js'

const YOUTUBE = 'https://www.youtube.com/watch?v=gxyBiCWiQ_8'

test('trainee opens a lesson and marks it complete', async ({ page }) => {
  await signIn(page, 'teacher.a1@example.test')
  await page.getByRole('link', { name: 'หลักสูตร' }).first().click()
  await page.getByRole('link', { name: /Assessment for Learning/ }).click()
  await expect(page.getByRole('progressbar')).toBeVisible()
  await page.getByRole('link', { name: 'บทที่ 1.2 เกณฑ์ความสำเร็จ' }).click()
  await page.getByRole('button', { name: /ทำเครื่องหมายว่าเรียนจบ/ }).click()
  await expect(page.getByText('เรียนจบแล้ว เมื่อ')).toBeVisible()
})

test('trainee cannot reach the builder or the approvals page', async ({ page }) => {
  await signIn(page, 'teacher.a1@example.test')
  await page.goto(`/#/courses/${IDS.course}/builder`)
  await expect(page.getByText('ท่านไม่มีสิทธิ์แก้ไขหลักสูตรนี้')).toBeVisible()
  await page.goto('/#/admin/approvals')
  await expect(page.getByRole('heading', { name: /สวัสดี/ })).toBeVisible() // guard redirects home
})

test('trainer adds a YouTube block; learner sees the embed without CSP violations', async ({ browser }) => {
  const trainer = await (await browser.newContext()).newPage()
  await signIn(trainer, 'trainer@example.test')
  await trainer.goto(`/#/courses/${IDS.course}/builder/lessons/${IDS.lesson2}`)
  await trainer.locator('[data-action=new-block][data-type=video]').click()
  await trainer.locator('form[data-form=block] input[name=url]').fill(YOUTUBE)
  await trainer.locator('form[data-form=block] button[type=submit]').click()
  await expect(trainer.getByText('บันทึกเนื้อหาแล้ว')).toBeVisible()

  const learner = await (await browser.newContext()).newPage()
  const csp = watchCsp(learner)
  await signIn(learner, 'teacher.a1@example.test')
  await learner.goto(`/#/learn/${IDS.course}/${IDS.lesson2}`)
  const frame = learner.locator('iframe')
  await expect(frame).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/gxyBiCWiQ_8')
  await learner.waitForTimeout(1500)
  expect(csp).toEqual([])
})

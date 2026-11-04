import { test, expect } from '@playwright/test'
import { signIn, watchCsp } from './helpers.js'

const FORMATIVE = 'a4000000-0000-4000-a000-000000000002'

test('the same attempt opened on a second device: the first one stops and asks to reload', async ({
  browser,
}) => {
  const deviceA = await (await browser.newContext()).newPage()
  const csp = watchCsp(deviceA)
  await signIn(deviceA, 'teacher.a2@example.test')
  await deviceA.goto(`/#/assessments/${FORMATIVE}`)
  await deviceA.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  await deviceA.getByLabel('ถูก', { exact: true }).check()
  await expect(deviceA.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')

  // Device B resumes the attempt (with A's answer) and carries on
  const deviceB = await (await browser.newContext()).newPage()
  await signIn(deviceB, 'teacher.a2@example.test')
  await deviceB.goto(`/#/assessments/${FORMATIVE}`)
  await expect(deviceB.getByLabel('ถูก', { exact: true })).toBeChecked()
  await deviceB.getByLabel('คำตอบข้อ 4').fill('75')
  await deviceB.getByLabel('คำตอบข้อ 4').blur() // leaving the field saves at once
  await expect(deviceB.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')

  // Device A changes an answer: refused as stale; A stops and asks to reload
  await deviceA.getByLabel('ผิด', { exact: true }).check()
  await expect(deviceA.locator('[data-superseded]')).toContainText(
    'มีการทำต่อจากอีกเครื่องแล้ว กรุณาโหลดหน้าใหม่'
  )
  await expect(deviceA.getByRole('button', { name: 'ส่งคำตอบ' })).toBeDisabled()

  // Reloading A shows B's answers, not A's refused change
  await deviceA.getByRole('button', { name: 'โหลดหน้าใหม่' }).click()
  await expect(deviceA.getByLabel('ถูก', { exact: true })).toBeChecked()
  await expect(deviceA.getByLabel('คำตอบข้อ 4')).toHaveValue('75')
  expect(csp).toEqual([])
})

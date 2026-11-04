import { test, expect } from '@playwright/test'
import { signIn, watchCsp } from './helpers.js'

const TYPES = 'a4000000-0000-4000-a000-000000000003' // demo assignment with the new item types

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('phone: all seven new item types answered by tapping, saved, restored after reload, scored 7/7', async ({
  page,
}) => {
  const csp = watchCsp(page)
  await signIn(page, 'teacher.a2@example.test')
  await page.goto(`/#/assessments/${TYPES}`)
  await page.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  const form = page.locator('form[data-form=attempt]')
  await expect(form.locator('fieldset[data-item-type]')).toHaveCount(7)

  // Ordering arrives shuffled: move each step up into place with the ↑ buttons
  const ordering = form.locator('fieldset[data-item-type=ordering]')
  await expect(ordering.locator('[data-order-state]')).toContainText('ยังไม่ได้จัดลำดับ') // the shown order is not an answer
  for (const [target, id] of ['q2', 't4', 'k7', 'm9'].entries()) {
    for (;;) {
      const ids = await ordering
        .locator('[data-order-id]')
        .evaluateAll((rows) => rows.map((r) => r.dataset.orderId))
      if (ids.indexOf(id) <= target) break
      await ordering.locator(`[data-order-id="${id}"] [data-move="-1"]`).tap()
    }
  }
  await expect(ordering.locator('[data-order-id]').first()).toHaveAttribute('data-order-id', 'q2')
  await expect(ordering.locator('[data-order-state]')).toHaveText('จัดลำดับแล้ว')

  const matching = form.locator('fieldset[data-item-type=matching]')
  for (const [left, right] of [
    ['l1', 'j3'],
    ['l2', 'w6'],
    ['l3', 'x5'],
  ])
    await matching.locator(`select[name$=":${left}"]`).selectOption(right)

  const classification = form.locator('fieldset[data-item-type=classification]')
  for (const [item, cat] of [
    ['i1', 'c1'],
    ['i2', 'c1'],
    ['i3', 'c2'],
    ['i4', 'c2'],
  ])
    await classification.locator(`input[name$=":${item}"][value="${cat}"]`).check()

  const matrix = form.locator('fieldset[data-item-type=choice_matrix]')
  for (const [row, col] of [
    ['w1', 'f'],
    ['w2', 't'],
    ['w3', 't'],
  ])
    await matrix.locator(`input[name$=":${row}"][value="${col}"]`).check()

  const dropdown = form.locator('fieldset[data-item-type=dropdown]')
  await dropdown.getByLabel('ช่องที่ 1').selectOption('x')
  await dropdown.getByLabel('ช่องที่ 2').selectOption('p')

  const cloze = form.locator('fieldset[data-item-type=cloze]')
  await cloze.getByLabel('ช่องที่ 1').fill(' afl ')
  await cloze.getByLabel('ช่องที่ 2').fill('๗๕') // Thai digits
  await cloze.getByLabel('ช่องที่ 2').blur()

  const labelling = form.locator('fieldset[data-item-type=image_labelling]')
  await expect(labelling.locator('img')).toBeVisible() // the seeded image, from the private bucket
  await expect(labelling.locator('[data-marker]')).toHaveCount(3)
  for (const [k, label] of ['กำหนดเป้าหมาย', 'รวบรวมหลักฐาน', 'ให้ข้อมูลย้อนกลับ'].entries())
    await labelling.getByLabel(`คำตอบของ จุดที่ ${k + 1}`).selectOption({ label })
  await expect(page.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')

  // Fits the phone: no sideways scrolling
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // Reload: same order (stored on the attempt) and every answer restored from the server
  await page.reload()
  await expect(ordering.locator('[data-order-id]')).toHaveCount(4)
  expect(
    await ordering.locator('[data-order-id]').evaluateAll((rows) => rows.map((r) => r.dataset.orderId))
  ).toEqual(['q2', 't4', 'k7', 'm9'])
  await expect(ordering.locator('[data-action=confirm-order]')).toBeHidden()
  await expect(matching.locator('select[name$=":l2"]')).toHaveValue('w6')
  await expect(classification.locator('input[name$=":i3"][value="c2"]')).toBeChecked()
  await expect(cloze.getByLabel('ช่องที่ 1')).toHaveValue('afl')
  await expect(cloze.getByLabel('ช่องที่ 2')).toHaveValue('75')

  await page.getByRole('button', { name: 'ส่งคำตอบ' }).tap()
  await expect(page.getByRole('heading', { name: 'ผลการทดสอบ' })).toBeVisible()
  await expect(page.locator('[data-score]')).toHaveText(/7\s*\/\s*7/)
  expect(csp).toEqual([])
})

test('phone: an ordering item left as shown counts as unanswered until "ใช้ลำดับนี้" is tapped', async ({
  page,
}) => {
  await signIn(page, 'teacher.b1@example.test')
  await page.goto(`/#/assessments/${TYPES}`)
  await page.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  const form = page.locator('form[data-form=attempt]')
  const ordering = form.locator('fieldset[data-item-type=ordering]')
  await expect(ordering.locator('[data-order-id]')).toHaveCount(4)

  await page.getByRole('button', { name: 'ส่งคำตอบ' }).tap()
  await expect(page.getByText(/ยังไม่ได้ตอบ 7 ข้อ \(ข้อ 1,/)).toBeVisible() // ordering is item 1 and counted

  await ordering.getByRole('button', { name: 'ใช้ลำดับนี้' }).tap()
  await expect(ordering.locator('[data-order-state]')).toHaveText('จัดลำดับแล้ว')
  await expect(page.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')
  await page.reload()
  await expect(ordering.locator('[data-order-state]')).toHaveText('จัดลำดับแล้ว') // saved on the server
  await page.getByRole('button', { name: 'ส่งคำตอบ' }).tap()
  await expect(page.getByText(/ยังไม่ได้ตอบ 6 ข้อ \(ข้อ 2,/)).toBeVisible()
})

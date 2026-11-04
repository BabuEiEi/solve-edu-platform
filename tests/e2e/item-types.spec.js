import { test, expect } from '@playwright/test'
import { signIn, watchCsp } from './helpers.js'

const TYPES = 'a4000000-0000-4000-a000-000000000003' // demo assignment with the new item types

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('phone: all new item types answered by tapping, saved, restored after reload, scored 6/6', async ({
  page,
}) => {
  const csp = watchCsp(page)
  await signIn(page, 'teacher.a2@example.test')
  await page.goto(`/#/assessments/${TYPES}`)
  await page.getByRole('button', { name: 'เริ่มทำแบบทดสอบ' }).click()
  const form = page.locator('form[data-form=attempt]')
  await expect(form.locator('fieldset[data-item-type]')).toHaveCount(6)

  // Ordering arrives shuffled: move each step up into place with the ↑ buttons
  const ordering = form.locator('fieldset[data-item-type=ordering]')
  for (const [target, id] of ['a', 'b', 'c', 'd'].entries()) {
    for (;;) {
      const ids = await ordering
        .locator('[data-order-id]')
        .evaluateAll((rows) => rows.map((r) => r.dataset.orderId))
      if (ids.indexOf(id) <= target) break
      await ordering.locator(`[data-order-id="${id}"] [data-move="-1"]`).tap()
    }
  }
  await expect(ordering.locator('[data-order-id]').first()).toHaveAttribute('data-order-id', 'a')

  const matching = form.locator('fieldset[data-item-type=matching]')
  for (const [left, right] of [
    ['l1', 'r1'],
    ['l2', 'r2'],
    ['l3', 'r3'],
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
  await expect(page.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved')

  // Fits the phone: no sideways scrolling
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // Reload: same order (stored on the attempt) and every answer restored from the server
  await page.reload()
  await expect(ordering.locator('[data-order-id]')).toHaveCount(4)
  expect(
    await ordering.locator('[data-order-id]').evaluateAll((rows) => rows.map((r) => r.dataset.orderId))
  ).toEqual(['a', 'b', 'c', 'd'])
  await expect(matching.locator('select[name$=":l2"]')).toHaveValue('r2')
  await expect(classification.locator('input[name$=":i3"][value="c2"]')).toBeChecked()
  await expect(cloze.getByLabel('ช่องที่ 1')).toHaveValue('afl')
  await expect(cloze.getByLabel('ช่องที่ 2')).toHaveValue('75')

  await page.getByRole('button', { name: 'ส่งคำตอบ' }).tap()
  await expect(page.getByRole('heading', { name: 'ผลการทดสอบ' })).toBeVisible()
  await expect(page.locator('[data-score]')).toHaveText(/6\s*\/\s*6/)
  expect(csp).toEqual([])
})

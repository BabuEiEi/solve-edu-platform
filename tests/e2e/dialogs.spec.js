import { test, expect } from './fixtures.js'
import { signIn, answerDialog, IDS } from './helpers.js'

// What jsdom cannot show (no layout, no focus movement): the real dialog in a real browser.
// Runs on the desktop and on the iPhone project (see playwright.config.js).

const YOUTUBE = 'https://www.youtube.com/watch?v=gxyBiCWiQ_8'
const LESSON = `/#/courses/${IDS.course}/builder/lessons/${IDS.lesson2}`

async function addVideoBlock(page) {
  await page.locator('[data-action=new-block][data-type=video]').click()
  await page.locator('form[data-form=block] input[name=url]').fill(YOUTUBE)
  await page.locator('form[data-form=block] button[type=submit]').click()
  await expect(page.getByText('บันทึกเนื้อหาแล้ว')).toBeVisible()
}

test('a delete question: Cancel has the focus, the buttons are in order, and only the red button deletes', async ({
  page,
}) => {
  await signIn(page, 'trainer@example.test')
  await page.goto(LESSON)
  await addVideoBlock(page)
  const blocks = page.locator('[data-action=delete-block]')
  const before = await blocks.count()
  const popup = page.locator('.swal2-popup')
  const ask = async () => {
    await blocks.last().click() // the block this test added, so the lesson ends as it began
    await expect(popup).toBeVisible()
  }

  await ask()
  await expect(popup.locator('.swal2-title')).toHaveText('ลบเนื้อหานี้?')
  // our classes beat the library's stylesheet (it lives in a cascade layer; see styles/main.css)
  await expect(popup.locator('.swal2-title')).toHaveCSS('font-size', '18px')
  await expect(popup.locator('.swal2-title')).toHaveCSS('text-align', 'left')
  await expect(popup).toHaveCSS('border-radius', '16px')
  await expect(popup.locator('.swal2-cancel')).toBeFocused() // Enter must not delete by accident
  const cancel = await popup.locator('.swal2-cancel').boundingBox()
  const confirm = await popup.locator('.swal2-confirm').boundingBox()
  expect(cancel.x).toBeLessThan(confirm.x) // Cancel on the left, the action on the right
  await expect(popup.locator('.swal2-confirm')).toHaveText('ลบ')
  // the red really is applied: same computed colour as an element with Tailwind's bg-rose-600
  const rose = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'bg-rose-600'
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  expect(rose).not.toBe('rgba(0, 0, 0, 0)')
  await expect(popup.locator('.swal2-confirm')).toHaveCSS('background-color', rose)
  const box = await popup.boundingBox()
  const width = page.viewportSize().width
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width) // fits the screen, phone included
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/dialog-confirm-${test.info().project.name}.png` })
  }

  await page.keyboard.press('Enter') // = the focused Cancel button
  await expect(popup).toBeHidden()
  await expect(blocks).toHaveCount(before)

  await ask()
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  await expect(blocks).toHaveCount(before)

  await ask()
  await page.mouse.click(3, 3) // the dimmed area outside the box
  await expect(popup).toBeHidden()
  await expect(blocks).toHaveCount(before)

  await ask()
  await answerDialog(page, 'confirm')
  await expect(page.getByText('ลบเนื้อหาแล้ว')).toBeVisible()
  await expect(blocks).toHaveCount(before - 1)
})

test('a question about a user’s own text never becomes markup, and the page behind stays still', async ({
  page,
}) => {
  await signIn(page, 'trainer@example.test')
  await page.goto(`/#/courses/${IDS.course}/builder`)
  const first = page.locator('[data-action=delete-unit]').first()
  await expect(first).toBeVisible()
  await first.click()
  const popup = page.locator('.swal2-popup')
  await expect(popup.locator('.swal2-title')).toContainText('ลบหน่วย “')
  expect(await popup.locator('.swal2-title img, .swal2-title script').count()).toBe(0)
  await answerDialog(page, 'cancel')
  await expect(page.locator('[data-action=delete-unit]').first()).toBeVisible() // nothing was deleted
})

test('a typed answer: the link box starts with https://, refuses a wrong link in place, and Escape cancels', async ({
  page,
}) => {
  await signIn(page, 'trainer@example.test')
  await page.goto(LESSON)
  await page.locator('[data-action=new-block][data-type=rich_text]').click()
  const popup = page.locator('.swal2-popup')
  await expect(page.getByRole('textbox', { name: 'เนื้อหาบทเรียน' })).toBeVisible() // the editor is mounted
  await page.locator('[data-cmd=link]').click()
  await expect(popup).toBeVisible()
  await expect(popup.locator('.swal2-input')).toHaveValue('https://')
  await expect(popup.locator('.swal2-input')).toBeFocused() // typing can start at once
  await popup.locator('.swal2-input').fill('http://ไม่ปลอดภัย.example.test')
  await popup.locator('.swal2-confirm').click()
  await expect(popup.locator('.swal2-validation-message')).toContainText('ต้องขึ้นต้นด้วย https://')
  await expect(popup).toBeVisible() // stays open: the person can fix the link
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/dialog-prompt-${test.info().project.name}.png` })
  }
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
})

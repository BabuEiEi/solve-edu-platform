import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'
import { test, expect } from './fixtures.js'
import { signIn, resetTaskWork, watchCsp, DEMO, answerDialog } from './helpers.js'

/**
 * Phase 4e: the reviewer downloads everything a cohort submitted as ONE .zip.
 * A real trainee upload, then the trainer's click and the real download: the
 * file names, folders and contents are read back from the saved archive.
 * Desktop and iPhone projects both run it (playwright.config.js).
 */
const PDF = {
  name: 'แผนการสอน.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% fictitious test file for the zip\n'),
}

test('the trainer downloads the cohort’s work as one zip: folder per person and attempt, the typed answer, the file, and a summary', async ({
  page,
  browser,
}) => {
  resetTaskWork()
  await signIn(page, 'teacher.a1@example.test')
  await page.locator('a[href="#/tasks"]:visible').click()
  await page.getByRole('link', { name: /ส่งแผนการสอน AfL 1 คาบ/ }).click()
  await page.getByRole('button', { name: /เริ่มทำงาน/ }).click()
  const form = page.locator('form[data-form=draft]')
  await form.locator('[name=text]').fill('แผนการสอนเรื่องเศษส่วน')
  await form.locator('[name=link_url]').fill('https://docs.example.test/plan')
  await form.locator('[name=link_label]').fill('แผนฉบับเต็ม')
  await form.locator('input[name=task_file]').setInputFiles(PDF)
  await expect(page.locator('[data-file]')).toContainText('แผนการสอน.pdf')
  await form.getByRole('button', { name: 'ส่งงาน' }).click()
  await answerDialog(page)
  await expect(page.getByText('ส่งงานแล้ว — รอผู้ตรวจ')).toBeVisible()

  const trainer = await (await browser.newContext({ acceptDownloads: true })).newPage()
  const csp = watchCsp(trainer)
  await signIn(trainer, 'trainer@example.test')
  await trainer.goto(`/#/staff/tasks/${DEMO.allocation}`)
  const section = trainer.locator('[data-zip]')
  await expect(section).toBeVisible()
  const button = section.locator('button[data-action=zip-download]')
  await expect(button).toHaveText('ดาวน์โหลดงานทั้งหมด (.zip)')

  const [download] = await Promise.all([trainer.waitForEvent('download'), button.click()])
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  expect(download.suggestedFilename()).toContain('ส่งแผนการสอน AfL 1 คาบ')
  await expect(section.locator('[data-zip-status]')).toContainText('ดาวน์โหลดแล้ว: 1 รอบ 1 ไฟล์')
  await expect(button).toBeEnabled()

  const files = unzipSync(new Uint8Array(readFileSync(await download.path())))
  const names = Object.keys(files)
  const folder = names.find((n) => n.endsWith('/แผนการสอน.pdf'))
  expect(folder).toMatch(/^.+\/รอบที่ 1 \(ส่ง \d{4}-\d{2}-\d{2}\)\/แผนการสอน\.pdf$/)
  expect(folder).toContain('ครู ก1')
  expect(strFromU8(files[folder])).toContain('fictitious test file for the zip')
  const answer = strFromU8(files[folder.replace('แผนการสอน.pdf', 'คำตอบ.txt')])
  expect(answer).toContain('แผนการสอนเรื่องเศษส่วน')
  expect(answer).toContain('แผนฉบับเต็ม — https://docs.example.test/plan')
  expect(names).toContain('สรุป.xlsx')
  expect(names.every((n) => !n.includes('..') && !n.startsWith('/'))).toBe(true)
  expect(csp).toEqual([]) // the signed storage URLs are allowed by the page's CSP

  // a trainee of the cohort has no such section (and no way to read the others' work)
  await trainer.context().close()
  await page.goto(`/#/staff/tasks/${DEMO.allocation}`)
  await expect(page.locator('[data-zip]')).toHaveCount(0)
})

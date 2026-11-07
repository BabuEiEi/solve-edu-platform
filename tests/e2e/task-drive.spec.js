import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures.js'
import { signIn, resetTaskWork, DEMO } from './helpers.js'
import { createFakeGoogle } from '../fake-google.js'

/**
 * The "ส่งสำเนาไป Google Drive" button, end to end: a real trainee upload, the
 * real Edge Function (served by scripts/supabase-local/test-e2e.sh) and a
 * strict FAKE Google that this spec starts. No real Google account is used.
 */
const port = Number(process.env.FAKE_GOOGLE_PORT)
const PDF = {
  name: 'แผนการสอน.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% fictitious test file for the Drive copy\n'),
}

test('the trainer copies submitted files to the central Drive: failure first, then success, then again with no duplicate; others do not see the button', async ({
  page,
  browser,
}) => {
  test.skip(!port, 'needs the Edge Functions and the fake Google: run npm run test:e2e')
  const google = createFakeGoogle({
    publicKeyPem: readFileSync(process.env.FAKE_GOOGLE_PUBLIC_KEY_FILE, 'utf8'),
    clientEmail: process.env.FAKE_GOOGLE_EMAIL,
    baseUrl: `http://host.docker.internal:${port}`,
  })
  const server = await google.listen(port)
  try {
    resetTaskWork()

    // A trainee uploads a file and submits (through the page, as a person would)
    await signIn(page, 'teacher.a1@example.test')
    await page.locator('a[href="#/tasks"]:visible').click()
    await page.getByRole('link', { name: /ส่งแผนการสอน AfL 1 คาบ/ }).click()
    await page.getByRole('button', { name: /เริ่มทำงาน/ }).click()
    const form = page.locator('form[data-form=draft]')
    await form.locator('[name=text]').fill('แผนการสอนเรื่องเศษส่วน')
    await form.locator('input[name=task_file]').setInputFiles(PDF)
    await expect(page.locator('[data-file]')).toContainText('แผนการสอน.pdf')
    page.once('dialog', (d) => d.accept())
    await form.getByRole('button', { name: 'ส่งงาน' }).click()
    await expect(page.getByText('ส่งงานแล้ว — รอผู้ตรวจ')).toBeVisible()

    // The trainer opens the people page
    const trainer = await (await browser.newContext()).newPage()
    await signIn(trainer, 'trainer@example.test')
    await trainer.goto(`/#/staff/tasks/${DEMO.allocation}`)
    const section = trainer.locator('[data-drive]')
    const button = section.locator('button[data-action=drive-export]')
    await expect(button).toHaveText('ส่งสำเนาไป Google Drive')
    await expect(section.locator('[data-drive-history]')).toHaveCount(0)

    // Declining the question sends nothing
    let asked = ''
    trainer.once('dialog', (d) => {
      asked = d.message()
      return d.dismiss()
    })
    await button.click()
    await expect.poll(() => asked).toContain('ชื่อผู้เรียนจะปรากฏในชื่อโฟลเดอร์')
    expect(google.log).toEqual([])

    // Google refuses the sign-in: the page says nothing was sent, and records the try
    google.fail.token = 400
    trainer.once('dialog', (d) => d.accept())
    await button.click()
    await expect(section.locator('[data-drive-status]')).toContainText('ส่งสำเนาไม่สำเร็จ — ไม่มีไฟล์ถูกส่ง')
    await expect(button).toBeEnabled()
    await expect(section.locator('[data-drive-history] li')).toHaveCount(1)
    await expect(section.locator('[data-drive-history]')).toContainText('ไม่สำเร็จ')
    await expect(section.locator('[data-drive-history]')).toContainText('เข้าสู่ระบบ Google ไม่สำเร็จ') // a Thai reason, not just a code
    expect(google.uploaded()).toHaveLength(0)

    // Google works again: the next press is not blocked and copies the file
    google.fail.token = 0
    trainer.once('dialog', (d) => d.accept())
    await button.click()
    await expect(section.locator('[data-drive-status]')).toContainText('ส่งครบแล้ว: ส่งใหม่ 1 ไฟล์')
    const link = section.locator('[data-drive-link]')
    await expect(link).toHaveAttribute(
      'href',
      /^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+$/
    )
    await expect(link).toHaveAttribute('rel', /noopener/)
    await expect(section.locator('[data-drive-history] li')).toHaveCount(2)
    const [file] = google.uploaded()
    expect(google.uploaded()).toHaveLength(1)
    const path = google.pathOf(file.id)
    expect(path).toHaveLength(6)
    expect(path[2]).toBe('ส่งแผนการสอน AfL 1 คาบ (ทดลอง)')
    expect(path[3]).toContain('ครู ก1') // the trainee's full name
    expect(path[4]).toMatch(/^รอบที่ 1 \(ส่ง \d{4}-\d{2}-\d{2}\)$/)
    expect(path[5]).toBe('แผนการสอน.pdf')
    expect(Buffer.from(file.bytes).equals(PDF.buffer)).toBe(true) // the very file the trainee uploaded
    if (process.env.SHOT_DIR) {
      await trainer.screenshot({
        path: `${process.env.SHOT_DIR}/drive-${test.info().project.name}.png`,
        fullPage: true,
      })
    }

    // Again: nothing is sent twice
    trainer.once('dialog', (d) => d.accept())
    await button.click()
    await expect(section.locator('[data-drive-status]')).toContainText(
      'ส่งครบแล้ว: มีใน Drive อยู่แล้ว 1 ไฟล์'
    )
    await expect(section.locator('[data-drive-history] li')).toHaveCount(3)
    expect(google.uploaded()).toHaveLength(1)

    // A mentor reads the same people page but has no button; the trainee has no such page
    const mentor = await (await browser.newContext()).newPage()
    await signIn(mentor, 'mentor@example.test')
    await mentor.goto(`/#/staff/tasks/${DEMO.allocation}`)
    await expect(mentor.locator('[data-people]')).toBeVisible()
    await expect(mentor.locator('[data-drive]')).toHaveCount(0)
    await expect(mentor.locator('button[data-action=drive-export]')).toHaveCount(0)
  } finally {
    server.close()
  }
})

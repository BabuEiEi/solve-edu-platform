export const PASSWORD = 'DemoPass#2569' // LOCAL demo seed only
export const IDS = {
  course: '40000000-0000-4000-a000-000000000001',
  lesson2: '60000000-0000-4000-a000-000000000002',
}

export async function signIn(page, email) {
  await page.goto('/')
  await page.locator('input[name=email]').fill(email)
  await page.locator('input[name=password]').fill(PASSWORD)
  await page.locator('form[data-form=auth] button[type=submit]').click()
  await page.locator('#view').waitFor()
}

/** Collect Content-Security-Policy violations reported to the console. */
export function watchCsp(page) {
  const violations = []
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text())
  })
  return violations
}

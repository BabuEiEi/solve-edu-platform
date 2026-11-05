import { execFileSync } from 'node:child_process'
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

/**
 * Run SQL in the local database as a signed-in person (their JWT claims, role
 * `authenticated`), so a spec can do something whose page does not exist yet
 * or happens on another person's side. Local demo database only.
 */
export function sqlAs(userId, sql) {
  const script = `begin;
select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', true);
set local role authenticated;
${sql}
commit;`
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_solve-edu-platform',
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input: script, encoding: 'utf8' }
  )
}
export const USERS = { trainer: '00000000-0000-4000-a000-000000000006' }

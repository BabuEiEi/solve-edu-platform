import { execFileSync } from 'node:child_process'
import { expect } from '@playwright/test'
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

export const DEMO = {
  allocation: 'b2000000-0000-4000-a000-000000000001',
  c1: 'a3000000-0000-4000-a000-000000000021',
  c2: 'a3000000-0000-4000-a000-000000000022',
}
export const PEOPLE = {
  a1: { id: '00000000-0000-4000-a000-000000000008', name: 'ครู ก1' },
  a2: { id: '00000000-0000-4000-a000-000000000009', name: 'ครู ก2' },
  mentor: '00000000-0000-4000-a000-000000000007',
}

/** Submit a demo task as a trainee through SQL (their JWT): quick set-up for the reviewer's specs. */
export function submitAs(userId, text) {
  sqlAs(
    userId,
    `create temp table s on commit drop as select public.start_task_submission('${DEMO.allocation}') as id;
     update public.task_submissions set text_response = '${text}' where id = (select id from s);
     select public.submit_task_submission((select id from s));`
  )
}

/**
 * The reviewer's page, driven like a person: open the person's work, pick a
 * level per criterion (by its label), the outcome, feedback; save or release.
 *   fields: { levels: {[criterionId]: levelLabel}, comments?, feedback?, outcome?: 'passed'|'revise', reason?, attempt?, release?: true }
 */
export async function reviewInUi(page, personName, fields) {
  await page.goto(`/#/staff/tasks/${DEMO.allocation}`)
  await page.locator('tr', { hasText: personName }).locator('[data-review-link]').click()
  if (fields.attempt) {
    await page
      .locator('[data-attempts]')
      .getByRole('link', { name: new RegExp(`รอบที่ ${fields.attempt}`) })
      .click()
    // wait until the page shows THAT attempt: filling the old form while it is replaced loses the choices
    await expect(page.locator('[data-work]')).toContainText(`รอบที่ ${fields.attempt} ·`)
  }
  const form = page.locator('form[data-form=review]')
  await form.waitFor()
  for (const [criterion, levelLabel] of Object.entries(fields.levels ?? {})) {
    await form
      .locator(`[data-criterion="${criterion}"]`)
      .getByLabel(new RegExp(`^\\s*${levelLabel}\\s+\\d`))
      .check() // the label starts with its name then its score, so “ดี” is not “ดีมาก”
    if (fields.comments?.[criterion])
      await form.locator(`[name="comment:${criterion}"]`).fill(fields.comments[criterion])
  }
  if (fields.feedback !== undefined) await form.locator('[name=feedback]').fill(fields.feedback)
  if (fields.outcome) await form.locator(`input[name=outcome][value=${fields.outcome}]`).check()
  if (fields.reason) await form.locator('[name=reason]').fill(fields.reason)
  if (fields.release) {
    page.once('dialog', (d) => d.accept())
    await form.getByRole('button', { name: 'ส่งผลให้ผู้เรียน' }).click()
    await page.getByText('ส่งผลให้ผู้เรียนแล้ว').waitFor()
  } else {
    await form.getByRole('button', { name: 'บันทึกร่างการตรวจ' }).click()
    await page.getByText('บันทึกร่างการตรวจแล้ว').waitFor()
  }
}

/**
 * Specs that work on the demo task start from "nobody has submitted": clears
 * the submissions and reviews of the local demo database (TRUNCATE does not
 * run the immutability triggers, which is why this is only for local tests).
 */
export function resetTaskWork() {
  execFileSync(
    'docker',
    ['exec', '-i', 'supabase_db_solve-edu-platform', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
    {
      input:
        'truncate public.task_drive_copies, public.task_drive_exports, public.task_review_reads, public.task_review_scores, public.task_reviews, public.task_submission_files, public.task_submissions;',
      encoding: 'utf8',
    }
  )
}

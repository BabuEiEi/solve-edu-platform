import { execFileSync } from 'node:child_process'
import { test, expect } from './fixtures.js'
import { signIn } from './helpers.js'

/**
 * "จัดการบัญชี" end to end: search, set a personal code, scope of a school
 * admin, and deleting an account through the real Edge Function (served by
 * scripts/supabase-local/test-e2e.sh).
 */
const sql = (text) =>
  execFileSync(
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
    { input: text, encoding: 'utf8' }
  ).trim()

test('platform admin: find a teacher, give a code, find by code; delete a throwaway account with the typed e-mail', async ({
  page,
}) => {
  test.skip(!process.env.FAKE_GOOGLE_PORT, 'needs the Edge Functions: run npm run test:e2e')
  sql(`update public.profiles set user_code = null where user_code is not null;
       delete from auth.users where email = 'e2e.delete.me@example.test';
       insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at,
                               confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
                               phone_change, phone_change_token, reauthentication_token)
       values ('99999999-0000-4000-a000-0000000e2e01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
               'e2e.delete.me@example.test', now(), '{"full_name":"ครู ทดลองลบ (สมมติ)"}', '{"provider":"email","providers":["email"]}', now(), now(),
               null, '', '', '', '', '', '', '');`)
  // confirmation_token is NULL on purpose: Supabase Auth cannot read such a row, so the first
  // press fails after the database part — the page must say so and a second press must finish

  await signIn(page, 'platform.admin@example.test')
  await page.goto('/#/admin/accounts')
  await expect(page.getByRole('heading', { name: 'จัดการบัญชี' })).toBeVisible()

  // search by name, then set a personal code
  await page.locator('input[name=q]').fill('ครู ก2')
  await page.locator('form[data-form=account-search]').getByRole('button', { name: 'ค้นหา' }).click()
  const a2 = page.locator('tr[data-account-id]', { hasText: 'ครู ก2' })
  await expect(a2).toHaveCount(1)
  await expect(a2).toContainText('teacher.a2@example.test')
  await a2.getByRole('button', { name: 'แก้ไข' }).click()
  const edit = page.locator('form[data-form=account-edit]')
  await edit.locator('[name=user_code]').fill('T 0002')
  await edit.getByRole('button', { name: 'บันทึก' }).click()
  await expect(edit.getByRole('alert')).toContainText('ไม่เว้นวรรค')
  await edit.locator('[name=user_code]').fill('T-0002')
  await edit.getByRole('button', { name: 'บันทึก' }).click()
  await expect(page.getByText('บันทึกข้อมูลบัญชีแล้ว')).toBeVisible()

  // find by code, ignoring case
  await page.locator('input[name=q]').fill('t-0002')
  await page.locator('form[data-form=account-search]').getByRole('button', { name: 'ค้นหา' }).click()
  await expect(page.locator('tr[data-account-id]')).toHaveCount(1)
  await expect(page.locator('tr[data-account-id] [data-code]')).toHaveText('T-0002')

  // the same code cannot go to someone else
  await page.locator('input[name=q]').fill('ครู ก1')
  await page.locator('form[data-form=account-search]').getByRole('button', { name: 'ค้นหา' }).click()
  await page
    .locator('tr[data-account-id]', { hasText: 'ครู ก1' })
    .getByRole('button', { name: 'แก้ไข' })
    .click()
  await page.locator('form[data-form=account-edit] [name=user_code]').fill('t-0002')
  await page.locator('form[data-form=account-edit]').getByRole('button', { name: 'บันทึก' }).click()
  await expect(page.locator('form[data-form=account-edit]').getByRole('alert')).toContainText('มีผู้ใช้แล้ว')
  await page.locator('form[data-form=account-edit]').getByRole('button', { name: 'ยกเลิก' }).click()

  // delete the throwaway account
  await page.locator('input[name=q]').fill('e2e.delete.me')
  await page.locator('form[data-form=account-search]').getByRole('button', { name: 'ค้นหา' }).click()
  const target = page.locator('tr[data-account-id]', { hasText: 'e2e.delete.me@example.test' })
  await target.getByRole('button', { name: 'ลบบัญชี' }).click()
  const confirmBtn = page.locator('[data-confirm-delete]')
  await expect(confirmBtn).toBeDisabled()
  await page.locator('input[name=confirm_email]').fill('wrong@example.test')
  await expect(confirmBtn).toBeDisabled()
  await page.locator('input[name=confirm_email]').fill('E2E.delete.me@example.test')
  await expect(confirmBtn).toBeEnabled()
  await confirmBtn.click()
  await expect(page.locator('[data-delete-row]').getByRole('alert')).toContainText(
    'ปิดการเข้าสู่ระบบไม่สำเร็จ'
  )
  expect(sql(`select status from public.profiles where id = '99999999-0000-4000-a000-0000000e2e01';`)).toBe(
    'deleted'
  ) // personal data already gone
  sql(`update auth.users set confirmation_token = '' where id = '99999999-0000-4000-a000-0000000e2e01';`)
  await confirmBtn.click() // retry: the function repeats only the sign-in part
  await expect(page.getByText('ลบบัญชีแล้ว')).toBeVisible()
  expect(
    sql(`select p.full_name || '|' || p.status || '|' || (u.email = 'e2e.delete.me@example.test') || '|' || (u.deleted_at is not null)
           from public.profiles p join auth.users u on u.id = p.id where p.id = '99999999-0000-4000-a000-0000000e2e01';`)
  ).toBe('ผู้ใช้ที่ถูกลบ|deleted|false|true')

  // listed as deleted, without e-mail or actions
  await page.locator('select[name=status]').selectOption('deleted')
  await page.locator('input[name=q]').fill('')
  await page.locator('form[data-form=account-search]').getByRole('button', { name: 'ค้นหา' }).click()
  const gone = page.locator('tr[data-account-id="99999999-0000-4000-a000-0000000e2e01"]')
  await expect(gone).toContainText('บัญชีถูกลบ')
  await expect(gone.getByRole('button')).toHaveCount(0)

  if (process.env.SHOT_DIR) {
    await page.locator('select[name=status]').selectOption('')
    await page.locator('form[data-form=account-search]').getByRole('button', { name: 'ค้นหา' }).click()
    await page
      .locator('tr[data-account-id]', { hasText: 'ครู ก1' })
      .getByRole('button', { name: 'แก้ไข' })
      .click()
    await page.screenshot({
      path: `${process.env.SHOT_DIR}/accounts-${test.info().project.name}.png`,
      fullPage: true,
    })
  }
})

test('a school admin manages only their school and is never offered "ลบบัญชี"', async ({ page }) => {
  await signIn(page, 'school.admin.b@example.test')
  await page.goto('/#/admin/accounts')
  const rows = page.locator('tr[data-account-id]')
  await expect(rows.first()).toBeVisible()
  await expect(page.locator('tbody')).toContainText('ครู ข1')
  await expect(page.locator('tbody')).not.toContainText('ครู ก1')
  await expect(page.getByRole('button', { name: 'ลบบัญชี' })).toHaveCount(0)
  await expect(
    page.locator('tr[data-account-id]', { hasText: 'ครู ข1' }).getByRole('button', { name: 'แก้ไข' })
  ).toBeVisible()
})

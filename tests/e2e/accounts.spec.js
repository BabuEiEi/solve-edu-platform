import { execFileSync } from 'node:child_process'
import { test, expect } from './fixtures.js'
import { signIn, answerDialog } from './helpers.js'

/**
 * "จัดการบัญชี" end to end: search, set a personal code, Staff approval and
 * school change (4f), appointing Staff, and deleting an account through the real Edge Function (served by
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

test('4f: Staff approves a newcomer, who joins the school they asked for; Staff moves them, is never offered "ลบบัญชี", and a former school admin has no such page', async ({
  page,
}) => {
  await signIn(page, 'staff@example.test')
  await expect(page.locator('a[href="#/admin/accounts"]:visible')).toBeVisible()
  await expect(page.locator('a[href="#/admin/import"]')).toHaveCount(0) // roster import (e-mails) is not Staff's
  await page.goto('/#/admin/accounts')
  const newcomer = page.locator('tr[data-account-id]', { hasText: 'ผู้สมัครใหม่' })
  await expect(newcomer).toContainText('ขอสังกัด: โรงเรียนสาธิต ก')
  await expect(page.getByRole('button', { name: 'ลบบัญชี' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'แต่งตั้งเป็น Staff' })).toHaveCount(0)
  await expect(page.locator('tbody')).not.toContainText('ผู้ดูแลระบบ (สมมติ)') // a platform role holder

  await newcomer.getByRole('button', { name: 'อนุมัติ' }).first().click()
  await expect(page.getByText('เปิดใช้งานบัญชีแล้ว')).toBeVisible()
  const approved = page.locator('tr[data-account-id]', { hasText: 'ผู้สมัครใหม่' })
  await expect(approved).toContainText('ครู')
  await expect(approved).toContainText('โรงเรียนสาธิต ก (สมมติ)')
  await expect(approved).not.toContainText('ยังไม่มีสังกัด')

  // the school was wrong: move them to school B in the edit form
  await approved.getByRole('button', { name: 'แก้ไข' }).first().click()
  const select = page.locator('[data-school-select]')
  await expect(select).toHaveValue('10000000-0000-4000-a000-000000000002')
  await select.selectOption({ label: 'โรงเรียนสาธิต ข (สมมติ)' })
  await page.locator('form[data-form=account-edit]').getByRole('button', { name: 'บันทึก' }).click()
  await expect(page.getByText('บันทึกข้อมูลบัญชีแล้ว')).toBeVisible()
  await expect(page.locator('tr[data-account-id]', { hasText: 'ผู้สมัครใหม่' })).toContainText(
    'โรงเรียนสาธิต ข (สมมติ)'
  )
  await expect(page.locator('tr[data-account-id]', { hasText: 'ผู้สมัครใหม่' })).not.toContainText(
    'โรงเรียนสาธิต ก (สมมติ)'
  )
  expect(
    sql(`select count(*) from public.organization_memberships m join public.profiles p on p.id = m.user_id
          where p.full_name like 'ผู้สมัครใหม่%' and m.ended_at is not null`)
  ).toBe('1') // school A kept as history

  // a former school admin (a teacher now) has no admin pages at all
  const other = await (await page.context().browser().newContext()).newPage()
  await signIn(other, 'school.admin.b@example.test')
  await expect(other.locator('a[href="#/admin/accounts"]')).toHaveCount(0)
  await expect(other.locator('a[href="#/admin/approvals"]')).toHaveCount(0)
})

test('4f: the platform admin appoints Staff and removes them again', async ({ page }) => {
  await signIn(page, 'platform.admin@example.test')
  await page.goto('/#/admin/accounts')
  await page.locator('input[name=q]').fill('teacher.a2@')
  await page.getByRole('button', { name: 'ค้นหา' }).click()
  const row = page.locator('tr[data-account-id]', { hasText: 'ครู ก2' })
  await row.getByRole('button', { name: 'แต่งตั้งเป็น Staff' }).first().click()
  await answerDialog(page)
  await expect(page.getByText('แต่งตั้งเป็น Staff แล้ว')).toBeVisible()
  await expect(row).toContainText('ผู้ช่วยดูแลระบบ (Staff)')
  await row.getByRole('button', { name: 'ถอดจาก Staff' }).first().click()
  await answerDialog(page)
  await expect(page.getByText('ถอดจาก Staff แล้ว')).toBeVisible()
  await expect(row).not.toContainText('ผู้ช่วยดูแลระบบ (Staff)')
  expect(
    sql(
      `select count(*) from public.platform_role_assignments where user_id = '00000000-0000-4000-a000-000000000009' and revoked_at is not null`
    )
  ).toBe('1') // history kept
})

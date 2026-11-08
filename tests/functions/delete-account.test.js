// @vitest-environment node
/**
 * The real Edge Function delete-account against Supabase Local: a person
 * signs up through Auth, uploads an avatar, and is deleted by the platform
 * admin. Run through scripts/supabase-local/test-functions.sh.
 */
import { execFileSync } from 'node:child_process'
import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { jwtFor, U } from '../integration/helpers.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret && process.env.SOLVEEDU_CRON_SECRET ? describe : describe.skip
const EMAIL = `delete.me.${Date.now()}@example.test`
const PASSWORD = 'Fictitious#2569'
const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
  type: 'image/png',
})

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
const anon = () =>
  createClient(env.url, env.apiKey, { auth: { persistSession: false, autoRefreshToken: false } })
const signIn = async () =>
  (await anon().auth.signInWithPassword({ email: EMAIL, password: PASSWORD })).error?.message ?? 'ok'

function press(who, body) {
  const headers = { 'content-type': 'application/json', apikey: env.apiKey }
  if (who) headers.authorization = `Bearer ${jwtFor(env.secret, U[who])}`
  return fetch(`${env.url}/functions/v1/delete-account`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

run('Edge Function delete-account (Supabase Local)', () => {
  let id

  beforeAll(async () => {
    const up = await anon().auth.signUp({
      email: EMAIL,
      password: PASSWORD,
      options: { data: { full_name: 'ครูทดสอบลบ' } },
    })
    expect(up.error).toBeNull()
    id = up.data.user.id
    sql(`update auth.users set email_confirmed_at = now() where id = '${id}';`)
    const person = anon()
    expect((await person.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })).error).toBeNull()
    expect((await person.storage.from('avatars').upload(`${id}/me.png`, png)).error).toBeNull()
  })

  it('refuses: no session, a district admin, a bad body, a wrong e-mail — and nothing changes', async () => {
    expect((await press(null, { user_id: id, confirm_email: EMAIL })).status).toBe(401)
    expect((await press('district_admin', { user_id: id, confirm_email: EMAIL })).status).toBe(403)
    expect((await press('platform_admin', { user_id: 'nope', confirm_email: EMAIL })).status).toBe(400)
    const wrong = await press('platform_admin', { user_id: id, confirm_email: 'someone@example.test' })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'confirm_mismatch' })
    expect(await signIn()).toBe('ok')
  })

  it('the platform admin deletes: personal data gone, sign-in gone, avatar gone, results model intact', async () => {
    const res = await press('platform_admin', { user_id: id, confirm_email: EMAIL.toUpperCase() })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deleted: true,
      already_deleted: false,
      sign_in: 'removed',
      avatars_removed: 1,
    })
    expect(await signIn()).toMatch(/invalid login credentials/i)
    expect(sql(`select full_name || '|' || status from public.profiles where id = '${id}';`)).toBe(
      'ผู้ใช้ที่ถูกลบ|deleted'
    )
    expect(
      sql(`select (email is distinct from '${EMAIL}') || '|' || (deleted_at is not null) || '|' || raw_user_meta_data::text
                  from auth.users where id = '${id}';`)
    ).toBe('true|true|{}')
    expect(
      sql(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${id}/%';`)
    ).toBe('0')
  })

  it('pressing again is harmless; the same e-mail can start over as a new account', async () => {
    const again = await press('platform_admin', { user_id: id, confirm_email: 'anything' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ deleted: true, already_deleted: true })
    const fresh = await anon().auth.signUp({ email: EMAIL, password: PASSWORD })
    expect(fresh.error).toBeNull()
    expect(fresh.data.user.id).not.toBe(id)
    expect(sql(`select status from public.profiles where id = '${fresh.data.user.id}';`)).toBe('pending')
  })
})

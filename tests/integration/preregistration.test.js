// @vitest-environment node
/**
 * Integration: CSV pre-registration against the REAL stack — GoTrue (email
 * confirmation ON), Mailpit for the confirmation mail, PostgREST + RLS.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { JSDOM } from 'jsdom'
import { supabaseAs } from './helpers.js'

globalThis.window ??= new JSDOM('').window
const { createPreregistrationService, analyzeRoster } =
  await import('../../src/features/preregistration/service.js')

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const MAIL = process.env.SOLVEEDU_MAILPIT_URL
const run = env.url && env.apiKey && env.secret && MAIL ? describe : describe.skip
const SCHOOL_A = '10000000-0000-4000-a000-000000000002'
const COHORT = '30000000-0000-4000-a000-000000000001'
const PASSWORD = 'IntegrationPass#2569'

const anonClient = () =>
  createClient(env.url, env.apiKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function confirmationLink(email) {
  for (let i = 0; i < 30; i++) {
    const found = await (
      await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()
    const msg = found.messages?.[0]
    if (msg) {
      const detail = await (await fetch(`${MAIL}/api/v1/message/${msg.ID}`)).json()
      const m = /https?:\/\/[^\s"'<>)]*\/auth\/v1\/verify[^\s"'<>)]*/.exec(`${detail.Text}\n${detail.HTML}`)
      if (m) return m[0].replace(/&amp;/g, '&')
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no confirmation mail for ${email}`)
}

run('CSV pre-registration (GoTrue + Mailpit + RLS)', () => {
  beforeAll(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
  const admin = () => createPreregistrationService(supabaseAs(env, 'school_admin_a'))

  it('imports a roster; only the importing org can see it', async () => {
    const csv =
      'email,full_name\ne2e.teacher@example.test,ครู อีทูอี\ne2e.cohort@example.test,ครู รุ่น\nbad,x\n'
    const a = analyzeRoster(csv)
    expect(a.validCount).toBe(2)
    const ok = a.rows.filter((r) => !r.errors.length)
    await admin().importRows([ok[0]], { organizationId: SCHOOL_A, orgRole: 'teacher' })
    const pending = await admin().list('pending')
    expect(pending.map((p) => p.email)).toContain('e2e.teacher@example.test')
    expect(await createPreregistrationService(supabaseAs(env, 'school_admin_b')).list('pending')).toEqual([])
    expect(await createPreregistrationService(supabaseAs(env, 'teacher_a1')).list('pending')).toEqual([])
  })

  it('re-importing the same pending email is rejected atomically', async () => {
    const rows = [
      { email: 'fresh.row@example.test', full_name: '' },
      { email: 'e2e.teacher@example.test', full_name: '' },
    ]
    await expect(admin().importRows(rows, { organizationId: SCHOOL_A, orgRole: 'teacher' })).rejects.toThrow()
    const pending = await admin().list('pending')
    expect(pending.some((p) => p.email === 'fresh.row@example.test')).toBe(false)
  })

  it('school admin A cannot import into school B', async () => {
    await expect(
      admin().importRows([{ email: 'x.y@example.test', full_name: '' }], {
        organizationId: '10000000-0000-4000-a000-000000000003',
        orgRole: 'teacher',
      })
    ).rejects.toThrow('ไม่มีสิทธิ์')
  })

  it('unconfirmed sign-up cannot sign in or claim; after confirming, claim grants the roster rights', async () => {
    const email = 'e2e.teacher@example.test'
    const c = anonClient()
    const signup = await c.auth.signUp({
      email,
      password: PASSWORD,
      options: { data: { full_name: 'ครู อีทูอี' } },
    })
    expect(signup.error).toBeNull()
    expect(signup.data.session).toBeNull() // confirmations are ON

    const early = await c.auth.signInWithPassword({ email, password: PASSWORD })
    expect(early.error?.message).toMatch(/not confirmed/i)

    // confirm via the emailed link
    const res = await fetch(await confirmationLink(email), { redirect: 'manual' })
    expect([302, 303, 200]).toContain(res.status)

    const login = await c.auth.signInWithPassword({ email, password: PASSWORD })
    expect(login.error).toBeNull()
    const mine = createPreregistrationService(c)
    expect(await mine.claimMine()).toBe(1)
    expect(await mine.claimMine()).toBe(0)

    const uid = login.data.user.id
    const profile = await c.from('profiles').select('id, status').eq('id', uid).single()
    expect(profile.data.status).toBe('active')
    const m = await c
      .from('organization_memberships')
      .select('org_role, organization_id')
      .eq('user_id', uid)
      .is('ended_at', null)
    expect(m.data).toEqual([{ org_role: 'teacher', organization_id: SCHOOL_A }])
    expect((await admin().list('pending')).some((p) => p.email === email)).toBe(false)
  })

  it('a verified user whose email is NOT on the roster gets nothing, even with spoofed metadata', async () => {
    const email = 'e2e.outsider@example.test'
    const c = anonClient()
    await c.auth.signUp({
      email,
      password: PASSWORD,
      options: { data: { full_name: 'คนนอก', email: 'e2e.cohort@example.test', role: 'admin' } },
    })
    await fetch(await confirmationLink(email), { redirect: 'manual' })
    expect((await c.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull()
    expect(await createPreregistrationService(c).claimMine()).toBe(0)
    const p = await c.from('profiles').select('status').single()
    expect(p.data.status).toBe('pending')
  })

  it('roster row with a cohort also adds the cohort membership; cancelled rows never apply', async () => {
    const cohortEmail = 'e2e.cohort@example.test'
    await createPreregistrationService(supabaseAs(env, 'district_admin')).importRows(
      [{ email: cohortEmail, full_name: 'ครู รุ่น' }],
      { organizationId: SCHOOL_A, orgRole: 'teacher', cohortId: COHORT, cohortRole: 'trainee' }
    )
    const cancelEmail = 'e2e.cancelled@example.test'
    await admin().importRows([{ email: cancelEmail, full_name: '' }], {
      organizationId: SCHOOL_A,
      orgRole: 'teacher',
    })
    const row = (await admin().list('pending')).find((p) => p.email === cancelEmail)
    await admin().cancel(row.id)

    const out = []
    for (const email of [cohortEmail, cancelEmail]) {
      const c = anonClient()
      await c.auth.signUp({ email, password: PASSWORD })
      await fetch(await confirmationLink(email), { redirect: 'manual' })
      const login = await c.auth.signInWithPassword({ email, password: PASSWORD })
      out.push({ c, id: login.data.user.id, claimed: await createPreregistrationService(c).claimMine() })
    }
    expect(out.map((o) => o.claimed)).toEqual([1, 0])
    const cm = await out[0].c
      .from('cohort_memberships')
      .select('cohort_id, cohort_role, status')
      .eq('user_id', out[0].id)
    expect(cm.data).toEqual([{ cohort_id: COHORT, cohort_role: 'trainee', status: 'active' }])
  })
})

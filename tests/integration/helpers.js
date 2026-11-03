import { createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

/** Demo seed identities (supabase/seed.sql). */
export const U = {
  platform_admin: '00000000-0000-4000-a000-000000000001',
  district_admin: '00000000-0000-4000-a000-000000000002',
  supervisor: '00000000-0000-4000-a000-000000000003',
  school_admin_a: '00000000-0000-4000-a000-000000000004',
  school_admin_b: '00000000-0000-4000-a000-000000000005',
  trainer: '00000000-0000-4000-a000-000000000006',
  mentor: '00000000-0000-4000-a000-000000000007',
  teacher_a1: '00000000-0000-4000-a000-000000000008',
  teacher_a2: '00000000-0000-4000-a000-000000000009',
  teacher_b1: '00000000-0000-4000-a000-000000000010',
  newcomer: '00000000-0000-4000-a000-000000000011',
}

export const IDS = {
  course: '40000000-0000-4000-a000-000000000001',
  lesson1: '60000000-0000-4000-a000-000000000001',
  lesson2: '60000000-0000-4000-a000-000000000002',
  draft_lesson: '60000000-0000-4000-a000-000000000004',
  enr_a1: '70000000-0000-4000-a000-000000000001',
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** HS256 JWT signed with the LOCAL secret only (never a real project secret). */
export function jwtFor(secret, sub, role = 'authenticated') {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ sub, role, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/** Full supabase-js client acting as a demo user (Data API + Storage). */
export function supabaseAs({ url, apiKey, secret }, key) {
  return createClient(url, apiKey, {
    accessToken: async () => (key ? jwtFor(secret, U[key]) : apiKey),
  })
}

// @vitest-environment node
/**
 * Integration: Supabase Storage API → storage.objects policies (authz helpers).
 * Runs only against Supabase Local (scripts/supabase-local/test-integration.sh).
 */
import { describe, it, expect } from 'vitest'
import { supabaseAs, U, IDS } from './helpers.js'

const env = {
  url: process.env.SOLVEEDU_API_URL,
  apiKey: process.env.SOLVEEDU_API_KEY,
  secret: process.env.SOLVEEDU_JWT_SECRET,
}
const run = env.url && env.apiKey && env.secret ? describe : describe.skip
const png = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], {
  type: 'image/png',
})

run('Storage API + policies (Supabase Local)', () => {
  const as = (key) => supabaseAs(env, key).storage

  it('trainer uploads into a managed lesson; trainee cannot', async () => {
    const ok = await as('trainer').from('lesson-media').upload(`${IDS.lesson1}/it-figure.png`, png)
    expect(ok.error).toBeNull()
    const denied = await as('teacher_a1').from('lesson-media').upload(`${IDS.lesson1}/it-evil.png`, png)
    expect(denied.error).toBeTruthy()
  })

  it('enrolled trainee gets a signed URL for published lesson media and can download it', async () => {
    const { data, error } = await as('teacher_a1')
      .from('lesson-media')
      .createSignedUrl(`${IDS.lesson1}/it-figure.png`, 60)
    expect(error).toBeNull()
    const res = await fetch(data.signedUrl)
    expect(res.status).toBe(200)
  })

  it('draft lesson media cannot be signed for a trainee', async () => {
    await as('trainer').from('lesson-media').upload(`${IDS.draft_lesson}/it-draft.png`, png)
    const { error } = await as('teacher_a1')
      .from('lesson-media')
      .createSignedUrl(`${IDS.draft_lesson}/it-draft.png`, 60)
    expect(error).toBeTruthy()
  })

  it('anonymous and unrelated users cannot sign lesson media', async () => {
    const anon = await as(null).from('lesson-media').createSignedUrl(`${IDS.lesson1}/it-figure.png`, 60)
    expect(anon.error).toBeTruthy()
    const other = await as('school_admin_b')
      .from('lesson-media')
      .createSignedUrl(`${IDS.lesson1}/it-figure.png`, 60)
    expect(other.error).toBeTruthy()
  })

  it('buckets are private: public URLs do not serve the object', async () => {
    const { data } = as('teacher_a1').from('lesson-media').getPublicUrl(`${IDS.lesson1}/it-figure.png`)
    const res = await fetch(data.publicUrl)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('bucket rejects disallowed MIME types', async () => {
    const htmlFile = new Blob(['<script>alert(1)</script>'], { type: 'text/html' })
    const { error } = await as('trainer').from('lesson-media').upload(`${IDS.lesson1}/it.html`, htmlFile)
    expect(error).toBeTruthy()
  })

  it('avatars: own folder only; classmates cannot sign it', async () => {
    const own = await as('teacher_a1').from('avatars').upload(`${U.teacher_a1}/it-avatar.png`, png)
    expect(own.error).toBeNull()
    const foreign = await as('teacher_a1').from('avatars').upload(`${U.teacher_a2}/it-avatar.png`, png)
    expect(foreign.error).toBeTruthy()
    const classmate = await as('teacher_a2')
      .from('avatars')
      .createSignedUrl(`${U.teacher_a1}/it-avatar.png`, 60)
    expect(classmate.error).toBeTruthy()
    const trainer = await as('trainer').from('avatars').createSignedUrl(`${U.teacher_a1}/it-avatar.png`, 60)
    expect(trainer.error).toBeNull()
  })

  it('trainee cannot delete lesson media; trainer can', async () => {
    const path = `${IDS.lesson1}/it-figure.png`
    await as('teacher_a1').from('lesson-media').remove([path])
    const still = await as('teacher_a1').from('lesson-media').createSignedUrl(path, 60)
    expect(still.error).toBeNull()
    const { data, error } = await as('trainer').from('lesson-media').remove([path])
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })
})

// @vitest-environment node
/**
 * Edge Function building blocks (supabase/functions/_shared + the clean-up
 * logic), tested without Deno or a network: fakes stand in for supabase-js.
 */
import { describe, it, expect, vi } from 'vitest'
import { HttpError, handle, json, corsHeaders, readJson } from '../../supabase/functions/_shared/http.js'
import {
  requireCronSecret,
  requireEnv,
  requireUser,
  safeEqual,
} from '../../supabase/functions/_shared/auth.js'
import { runCleanup } from '../../supabase/functions/cleanup-task-files/cleanup.js'

const SECRET = 'x'.repeat(40)
const req = (headers = {}, init = {}) =>
  new Request('http://fn.example.test/f', { method: 'POST', headers, ...init })

describe('http', () => {
  it('HttpError becomes {error: code} with its status; anything else a bare 500', async () => {
    const log = vi.fn()
    const teapot = await handle(() => {
      throw new HttpError(418, 'teapot')
    })(req())
    expect(teapot.status).toBe(418)
    expect(await teapot.json()).toEqual({ error: 'teapot' })
    const boom = await handle(
      () => {
        throw new Error('relation private.audit_logs, key sb_secret_abc')
      },
      { log }
    )(req())
    expect(boom.status).toBe(500)
    const body = await boom.text()
    expect(body).toBe('{"error":"internal"}') // nothing about SQL or keys reaches the caller
    expect(log).toHaveBeenCalledOnce()
  })

  it('objects are sent as 200 JSON, not cached', async () => {
    const res = await handle(() => ({ ok: true }))(req())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true })
    expect((await json(201, { a: 1 }).json()).a).toBe(1)
  })

  it('CORS answers only listed origins', async () => {
    const allowed = 'https://app.example.test, http://localhost:5173'
    expect(
      corsHeaders(req({ origin: 'https://app.example.test' }), allowed)['access-control-allow-origin']
    ).toBe('https://app.example.test')
    expect(corsHeaders(req({ origin: 'https://evil.example.test' }), allowed)).toEqual({})
    expect(corsHeaders(req({}), allowed)).toEqual({})
    expect(corsHeaders(req({ origin: 'https://app.example.test' }), '')).toEqual({})
    const pre = await handle(() => ({}), { cors: allowed })(
      req({ origin: 'http://localhost:5173' }, { method: 'OPTIONS' })
    )
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    const err = await handle(
      () => {
        throw new HttpError(403, 'forbidden')
      },
      { cors: allowed }
    )(req({ origin: 'http://localhost:5173' }))
    expect(err.headers.get('access-control-allow-origin')).toBe('http://localhost:5173') // the page can read the reason
  })

  it('readJson: an empty, broken or non-object body is {}', async () => {
    expect(await readJson(req({}, { body: '{"dry_run":true}' }))).toEqual({ dry_run: true })
    expect(await readJson(req())).toEqual({})
    expect(await readJson(req({}, { body: 'not json' }))).toEqual({})
    expect(await readJson(req({}, { body: '[1,2]' }))).toEqual({})
  })
})

describe('auth', () => {
  it('safeEqual compares whole values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'a')).toBe(false)
    expect(safeEqual('ไทย', 'ไทย')).toBe(true)
  })

  it('cron secret: right header passes; wrong or missing is 401', () => {
    expect(() => requireCronSecret(req({ 'x-cron-secret': SECRET }), SECRET)).not.toThrow()
    for (const headers of [{}, { 'x-cron-secret': 'x'.repeat(39) }, { authorization: `Bearer ${SECRET}` }]) {
      expect(() => requireCronSecret(req(headers), SECRET)).toThrow(expect.objectContaining({ status: 401 }))
    }
  })

  it('cron secret: not configured or too short fails CLOSED (500), even with a matching header', () => {
    for (const configured of [undefined, '', 'short']) {
      expect(() => requireCronSecret(req({ 'x-cron-secret': configured ?? '' }), configured)).toThrow(
        expect.objectContaining({ status: 500, code: 'not_configured' })
      )
    }
  })

  it('requireEnv: missing → 500 not_configured, without echoing any value', () => {
    expect(requireEnv(() => 'v', 'A')).toBe('v')
    expect(() => requireEnv(() => undefined, 'A')).toThrow(
      expect.objectContaining({ code: 'not_configured' })
    )
  })

  it('requireUser: the token is checked by Supabase Auth; bad or missing tokens are 401', async () => {
    const make = (result) => vi.fn(() => ({ auth: { getUser: vi.fn(async () => result) } }))
    const ok = make({ data: { user: { id: 'u1' } }, error: null })
    const { user } = await requireUser(req({ authorization: 'Bearer abc.def.ghi' }), ok)
    expect(user.id).toBe('u1')
    expect(ok).toHaveBeenCalledWith('Bearer abc.def.ghi') // the client acts as the caller
    const rejected = make({ data: { user: null }, error: { message: 'invalid JWT' } })
    await expect(requireUser(req({ authorization: 'Bearer abc.def.ghi' }), rejected)).rejects.toMatchObject({
      status: 401,
    })
    for (const authorization of [undefined, 'abc', 'Bearer ', 'Basic abc', 'Bearer a b']) {
      const never = make({ data: { user: { id: 'u1' } }, error: null })
      const headers = authorization === undefined ? {} : { authorization }
      await expect(requireUser(req(headers), never)).rejects.toMatchObject({ status: 401 })
      expect(never).not.toHaveBeenCalled()
    }
  })
})

describe('cleanup logic', () => {
  function fakes({ orphans = [], stale = [], removeResult } = {}) {
    const calls = []
    const db = {
      rpc: vi.fn(async (name, args) => {
        calls.push([name, args])
        if (name === 'task_files_cleanup_orphans')
          return { data: orphans.map((p) => ({ object_path: p })), error: null }
        if (name === 'task_files_cleanup_stale_drafts')
          return { data: stale.map((p) => ({ object_path: p })), error: null }
        if (name === 'task_files_cleanup_record') return { data: args.p_paths.length, error: null }
        throw new Error(name)
      }),
    }
    const bucket = {
      remove: vi.fn(
        async (paths) => removeResult?.(paths) ?? { data: paths.map((name) => ({ name })), error: null }
      ),
    }
    return { db, bucket, calls }
  }

  it('dry run: lists, deletes nothing, logs nothing', async () => {
    const f = fakes({ orphans: ['s/a.pdf'], stale: ['d/b.pdf'] })
    const out = await runCleanup({ db: f.db, bucket: f.bucket, dryRun: true })
    expect(out).toEqual({ dry_run: true, orphans: ['s/a.pdf'], stale_draft_files: ['d/b.pdf'] })
    expect(f.bucket.remove).not.toHaveBeenCalled()
    expect(f.calls.find(([n]) => n === 'task_files_cleanup_stale_drafts')[1].p_dry_run).toBe(true)
    expect(f.calls.some(([n]) => n === 'task_files_cleanup_record')).toBe(false)
  })

  it('real run: removes both kinds, logs only the orphans that were removed', async () => {
    const f = fakes({
      orphans: ['s/a.pdf', 's/kept.pdf'],
      stale: ['d/b.pdf'],
      removeResult: (paths) => ({
        data: paths.filter((p) => p !== 's/kept.pdf').map((name) => ({ name })),
        error: null,
      }),
    })
    const out = await runCleanup({ db: f.db, bucket: f.bucket })
    expect(out).toEqual({
      dry_run: false,
      stale_draft_files_removed: 1,
      orphans_removed: 1,
      orphans_logged: 1,
      failed: ['s/kept.pdf'],
    })
    expect(f.calls.find(([n]) => n === 'task_files_cleanup_record')[1]).toEqual({ p_paths: ['s/a.pdf'] })
  })

  it('a storage error leaves the paths for the next run and does not stop the rest', async () => {
    const f = fakes({
      orphans: ['s/a.pdf'],
      stale: ['d/b.pdf'],
      removeResult: (paths) =>
        paths.includes('d/b.pdf') ? { data: null, error: { message: 'down' } } : undefined,
    })
    const out = await runCleanup({ db: f.db, bucket: f.bucket })
    expect(out).toMatchObject({ stale_draft_files_removed: 0, orphans_removed: 1, failed: ['d/b.pdf'] })
  })

  it('deletes in chunks of 100 and skips the log call when nothing was removed', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `d/${i}.pdf`)
    const f = fakes({ stale: many })
    const out = await runCleanup({ db: f.db, bucket: f.bucket })
    expect(f.bucket.remove.mock.calls.map(([p]) => p.length)).toEqual([100, 100, 50])
    expect(out.stale_draft_files_removed).toBe(250)
    expect(f.calls.some(([n]) => n === 'task_files_cleanup_record')).toBe(false)
  })

  it('a database error stops the run before anything is deleted', async () => {
    const f = fakes()
    f.db.rpc = vi.fn(async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }))
    await expect(runCleanup({ db: f.db, bucket: f.bucket })).rejects.toThrow(/orphans: 42501/)
    expect(f.bucket.remove).not.toHaveBeenCalled()
  })
})

/**
 * Shared HTTP helpers for Edge Functions (Deno). Plain JS with no Deno
 * globals, so Vitest can test them in Node too.
 *
 * Errors: throw `new HttpError(status, code)` anywhere in a handler;
 * `handle()` turns it into `{ error: code }`. Anything else becomes a bare
 * 500 `{ error: 'internal' }` — details go to the function log only, never
 * to the caller (no stack traces, keys or SQL in responses).
 */

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

/**
 * CORS for functions the browser calls. Only origins in the allow-list get
 * the header back; others get none (the browser then blocks the response).
 *   allowedOrigins: comma-separated env value, e.g. "https://app.example.test,http://localhost:5173"
 */
export function corsHeaders(req, allowedOrigins = '') {
  const origin = req.headers.get('origin') ?? ''
  const allowed = allowedOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (!origin || !allowed.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

/**
 * Wrap a handler: (req) => Response | object. Objects are sent as 200 JSON.
 *   options.cors: allowed origins (string) — answers OPTIONS and adds headers
 *   options.log:  where unexpected errors go (default console.error)
 */
export function handle(fn, { cors = null, log = console.error } = {}) {
  return async (req) => {
    const extra = cors === null ? {} : corsHeaders(req, cors)
    if (cors !== null && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra })
    try {
      const out = await fn(req)
      if (out instanceof Response) {
        for (const [k, v] of Object.entries(extra)) out.headers.set(k, v)
        return out
      }
      return json(200, out, extra)
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.code }, extra)
      log(`[edge] unexpected error: ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
      return json(500, { error: 'internal' }, extra)
    }
  }
}

/** Read a JSON body; an empty or invalid body is `{}` (callers validate fields). */
export async function readJson(req) {
  try {
    const body = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

/** supabase-js `{ data, error }` → data, or a 500 that hides the database message. */
export function unwrap({ data, error }, what = 'database') {
  if (error) throw new Error(`${what}: ${error.code ?? ''} ${error.message ?? error}`)
  return data
}

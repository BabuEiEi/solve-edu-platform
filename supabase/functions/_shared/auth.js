/**
 * Who may call an Edge Function.
 *
 *   requireEnv(getEnv, name)        a configured secret, or 500 not_configured
 *   requireCronSecret(req, secret)  scheduled jobs: header x-cron-secret
 *   requireUser(req, makeClient)    signed-in people: their own JWT, checked
 *                                   by Supabase Auth (not just decoded)
 *
 * The service-role key never leaves the function; the browser only ever
 * sends its own session token.
 */
import { HttpError } from './http.js'

export const MIN_SECRET_LENGTH = 32

export function requireEnv(getEnv, name) {
  const value = getEnv(name)
  if (!value) throw new HttpError(500, 'not_configured', `missing ${name}`)
  return value
}

/** Constant-time text comparison (does not stop at the first different byte). */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a))
  const y = new TextEncoder().encode(String(b))
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

/**
 * Scheduled callers prove themselves with a long shared secret. A missing
 * or short configured secret fails closed (500), never open.
 */
export function requireCronSecret(req, secret) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new HttpError(500, 'not_configured', 'CRON_SECRET')
  const given = req.headers.get('x-cron-secret') ?? ''
  if (!safeEqual(given, secret)) throw new HttpError(401, 'unauthorized')
}

/**
 * makeClient(authorizationHeader) → a supabase-js client acting as the caller
 * (publishable key + their token), so RLS and RPC checks apply to them.
 */
export async function requireUser(req, makeClient) {
  const header = req.headers.get('authorization') ?? ''
  if (!/^Bearer [A-Za-z0-9._~+/=-]+$/.test(header)) throw new HttpError(401, 'unauthorized')
  const client = makeClient(header)
  const { data, error } = await client.auth.getUser(header.slice('Bearer '.length))
  if (error || !data?.user?.id) throw new HttpError(401, 'unauthorized')
  return { user: data.user, client }
}

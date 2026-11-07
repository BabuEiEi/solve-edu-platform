/**
 * Google service-account access token (OAuth 2.0 JWT bearer grant), with
 * WebCrypto only (Deno and Node both have it). The private key stays in the
 * function's secret GOOGLE_SERVICE_ACCOUNT_JSON; only a short-lived access
 * token is sent to the Drive API.
 */
import { HttpError } from './http.js'

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

/** Parse the service-account JSON secret; anything missing → 500 not_configured. */
export function parseServiceAccount(raw) {
  let sa
  try {
    sa = JSON.parse(raw ?? '')
  } catch {
    throw new HttpError(500, 'not_configured', 'GOOGLE_SERVICE_ACCOUNT_JSON is not JSON')
  }
  if (
    typeof sa?.client_email !== 'string' ||
    typeof sa?.private_key !== 'string' ||
    !sa.private_key.includes('BEGIN PRIVATE KEY')
  ) {
    throw new HttpError(500, 'not_configured', 'GOOGLE_SERVICE_ACCOUNT_JSON lacks client_email/private_key')
  }
  return { clientEmail: sa.client_email, privateKey: sa.private_key }
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const b64urlText = (text) => b64url(new TextEncoder().encode(text))

async function importKey(pem) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'sign',
  ])
}

/** A signed JWT assertion for the token endpoint (valid 1 hour). */
export async function signAssertion({ clientEmail, privateKey, scope, audience, nowSeconds }) {
  const header = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64urlText(
    JSON.stringify({ iss: clientEmail, scope, aud: audience, iat: nowSeconds, exp: nowSeconds + 3600 })
  )
  const key = await importKey(privateKey)
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`)
  )
  return `${header}.${claims}.${b64url(sig)}`
}

/**
 * getToken() → access token, fetched once and reused until a minute before
 * it expires. Errors carry the HTTP status only (never the response body,
 * which may echo the assertion).
 */
export function createTokenSource({
  serviceAccount,
  scope = DRIVE_SCOPE,
  tokenUrl = GOOGLE_TOKEN_URL,
  fetch = globalThis.fetch,
  now = Date.now,
}) {
  let cached = null
  return async function getToken() {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token
    const assertion = await signAssertion({
      ...serviceAccount,
      scope,
      audience: tokenUrl,
      nowSeconds: Math.floor(now() / 1000),
    })
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    })
    if (!res.ok) throw new DriveError('google_auth_failed', res.status)
    const body = await res.json()
    if (typeof body?.access_token !== 'string') throw new DriveError('google_auth_failed', res.status)
    cached = { token: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 }
    return cached.token
  }
}

/** A Google/Drive failure with a short, safe code for logs and the run record. */
export class DriveError extends Error {
  constructor(code, status = 0) {
    super(status ? `${code} (HTTP ${status})` : code)
    this.code = code
    this.status = status
  }
}

/**
 * Overrides of Google URLs exist for tests with a fake Google only; they may
 * point at this machine (Docker host) and nowhere else.
 */
export function googleUrl(override, fallback) {
  if (!override) return fallback
  let u
  try {
    u = new URL(override)
  } catch {
    throw new HttpError(500, 'not_configured', 'bad Google URL override')
  }
  if (u.protocol !== 'http:' || !['host.docker.internal', '127.0.0.1', 'localhost'].includes(u.hostname)) {
    throw new HttpError(500, 'not_configured', 'Google URL overrides are for local tests only')
  }
  return override.replace(/\/$/, '')
}

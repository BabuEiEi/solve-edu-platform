/**
 * A fake Google (OAuth token endpoint + the Drive v3 calls we use), in
 * memory. Strict where real Google is strict, so mistakes show up in tests:
 *   - the token request must carry an RS256 assertion signed by the service
 *     account's key, for the Drive scope, addressed to this token URL
 *   - every Drive call needs that access token and supportsAllDrives=true
 *   - appProperties queries / resumable uploads behave like Drive's
 *
 *   handle(Request) → Response         (unit tests: pass as `fetch`)
 *   listen(port, host) → http.Server   (function tests: the Edge runtime calls it)
 */
import { createServer } from 'node:http'
import { createPublicKey, verify } from 'node:crypto'

const FOLDER = 'application/vnd.google-apps.folder'
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export function createFakeGoogle({ publicKeyPem, clientEmail, baseUrl }) {
  const publicKey = createPublicKey(publicKeyPem)
  const tokens = new Set()
  const files = new Map() // id → { id, name, mimeType, parents, appProperties, bytes, trashed }
  const sessions = new Map()
  const log = []
  const fail = { upload: 0, createFolder: 0, token: 0 } // set a status to make the next calls fail
  let n = 0
  const newId = (p) => `${p}${String(++n).padStart(6, '0')}x`

  function checkAssertion(assertion) {
    const [h, c, s] = String(assertion).split('.')
    if (!s) return 'malformed'
    const header = JSON.parse(Buffer.from(h, 'base64url').toString())
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString())
    if (header.alg !== 'RS256') return 'alg'
    if (!verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')))
      return 'signature'
    if (claims.iss !== clientEmail) return 'iss'
    if (claims.aud !== `${baseUrl}/token`) return 'aud'
    if (claims.scope !== 'https://www.googleapis.com/auth/drive') return 'scope'
    const now = Math.floor(Date.now() / 1000)
    if (!(claims.iat <= now + 60 && claims.exp > now && claims.exp - claims.iat <= 3600)) return 'time'
    return null
  }

  // the subset of Drive's query language our code sends
  function matches(f, q) {
    const parent = q.match(/^'([^']+)' in parents/)?.[1]
    if (parent && !f.parents.includes(parent)) return false
    if (/trashed = false/.test(q) && f.trashed) return false
    if (q.includes(`mimeType = '${FOLDER}'`) && f.mimeType !== FOLDER) return false
    if (q.includes(`mimeType != '${FOLDER}'`) && f.mimeType === FOLDER) return false
    const prop = q.match(/appProperties has \{ key='([^']+)' and value='((?:[^'\\]|\\.)*)' \}/)
    if (prop && f.appProperties?.[prop[1]] !== prop[2].replace(/\\(.)/g, '$1')) return false
    return true
  }

  async function handle(req) {
    const url = new URL(req.url)
    const path = url.pathname
    log.push(`${req.method} ${path}`)
    if (path === '/token' && req.method === 'POST') {
      if (fail.token) return json(fail.token, { error: 'invalid_grant' })
      const form = new URLSearchParams(await req.text())
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
        return json(400, { error: 'grant' })
      const why = checkAssertion(form.get('assertion'))
      if (why) return json(400, { error: 'invalid_grant', why })
      const token = `ya29.fake-${newId('t')}`
      tokens.add(token)
      return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' })
    }
    const auth = req.headers.get('authorization') ?? ''
    if (!tokens.has(auth.replace(/^Bearer /, ''))) return json(401, { error: 'unauthenticated' })
    if (url.searchParams.get('supportsAllDrives') !== 'true' && !path.startsWith('/session/'))
      return json(404, { error: 'File not found (supportsAllDrives missing)' })

    if (path === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const out = [...files.values()].filter((f) => matches(f, q))
      return json(200, { files: out.map(({ id, name, appProperties }) => ({ id, name, appProperties })) })
    }
    if (path === '/drive/v3/files' && req.method === 'POST') {
      if (fail.createFolder) return json(fail.createFolder, { error: 'denied' })
      const meta = await req.json()
      if (!meta.parents?.every((p) => files.has(p))) return json(404, { error: 'parent not found' })
      const id = newId('fo')
      files.set(id, { id, trashed: false, ...meta })
      return json(200, { id })
    }
    if (
      path === '/upload/drive/v3/files' &&
      req.method === 'POST' &&
      url.searchParams.get('uploadType') === 'resumable'
    ) {
      if (fail.upload) return json(fail.upload, { error: 'denied' })
      const meta = await req.json()
      if (!meta.parents?.every((p) => files.has(p))) return json(404, { error: 'parent not found' })
      const sid = newId('s')
      sessions.set(sid, {
        meta,
        type: req.headers.get('x-upload-content-type'),
        length: Number(req.headers.get('x-upload-content-length')),
      })
      return new Response(null, {
        status: 200,
        headers: {
          location: `${baseUrl}/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}&supportsAllDrives=true`,
        },
      })
    }
    if (path === '/upload/drive/v3/files' && req.method === 'PUT') {
      const s = sessions.get(url.searchParams.get('upload_id'))
      if (!s) return json(404, { error: 'no session' })
      const bytes = new Uint8Array(await req.arrayBuffer())
      if (bytes.byteLength !== s.length) return json(400, { error: 'length mismatch' })
      const id = newId('fi')
      files.set(id, { id, trashed: false, mimeType: s.type, bytes, ...s.meta })
      sessions.delete(url.searchParams.get('upload_id'))
      return json(200, { id })
    }
    return json(404, { error: `no fake for ${req.method} ${path}` })
  }

  const root = 'rootFolder0001'
  files.set(root, {
    id: root,
    name: 'SolveEdu (กลาง)',
    mimeType: FOLDER,
    parents: ['sharedDrive'],
    trashed: false,
  })

  /** path of names from the root, e.g. ['หลักสูตร', 'รุ่น', …, 'file.pdf'] */
  function pathOf(id) {
    const names = []
    for (let f = files.get(id); f && f.id !== root; f = files.get(f.parents[0])) names.unshift(f.name)
    return names
  }

  function listen(port, host = '127.0.0.1') {
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const r = await handle(
        new Request(`${baseUrl}${req.url}`, {
          method: req.method,
          headers: req.headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        })
      )
      res.writeHead(r.status, Object.fromEntries(r.headers))
      res.end(Buffer.from(await r.arrayBuffer()))
    })
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
  }

  return {
    handle,
    listen,
    files,
    log,
    fail,
    root,
    pathOf,
    uploaded: () => [...files.values()].filter((f) => f.bytes),
  }
}

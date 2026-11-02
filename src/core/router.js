/**
 * Minimal hash router: "#/courses/<id>" → { name, params }.
 * Each route may declare `allow(caps)`; a failed guard routes to `fallback`.
 */
export function compileRoutes(routes) {
  return routes.map((r) => {
    const keys = []
    const pattern = r.path.replace(/:([a-zA-Z_]+)/g, (_, k) => {
      keys.push(k)
      return '([^/]+)'
    })
    return { ...r, keys, regex: new RegExp(`^${pattern}/?$`) }
  })
}

export function matchRoute(compiled, hash) {
  const path = (hash || '').replace(/^#/, '') || '/'
  for (const r of compiled) {
    const m = path.match(r.regex)
    if (m) {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
      return { route: r, params }
    }
  }
  return null
}

export function resolveRoute(compiled, hash, caps, fallbackPath = '/') {
  const hit = matchRoute(compiled, hash)
  if (hit && (!hit.route.allow || hit.route.allow(caps))) return hit
  return matchRoute(compiled, `#${fallbackPath}`)
}

export function navigate(path) {
  if (window.location.hash !== `#${path}`) window.location.hash = path
}

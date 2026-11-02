/**
 * Safe HTML templating (SEC-07).
 *
 * Every interpolated value is HTML-escaped unless it is already a SafeHtml
 * produced by `html` or explicitly marked with `trusted()` (static markup only).
 * Never build markup with string concatenation of user/DB data.
 *
 *   render(el, html`<p class="x">${user.full_name}</p>`)
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }

export class SafeHtml {
  constructor(value) {
    this.value = value
  }
  toString() {
    return this.value
  }
}

export function escapeHtml(value) {
  if (value === null || value === undefined || value === false) return ''
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPES[ch])
}

function toHtml(value) {
  if (value instanceof SafeHtml) return value.value
  if (Array.isArray(value)) return value.map(toHtml).join('')
  return escapeHtml(value)
}

/** Tagged template: escapes all interpolations. */
export function html(strings, ...values) {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1]
  return new SafeHtml(out)
}

/** Mark a STATIC, developer-authored string as safe (never DB/user data). */
export function trusted(staticMarkup) {
  return new SafeHtml(String(staticMarkup))
}

/** Only allow http(s)/mailto/relative URLs in href/src attributes. */
export function safeUrl(url) {
  const s = String(url ?? '').trim()
  if (/^(https?:|mailto:)/i.test(s) || s.startsWith('/') || s.startsWith('#')) return s
  return '#'
}

export function render(el, safe) {
  if (!(safe instanceof SafeHtml)) throw new TypeError('render() requires SafeHtml from html``')
  el.innerHTML = safe.value
}

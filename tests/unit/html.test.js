import { describe, it, expect } from 'vitest'
import { html, escapeHtml, trusted, safeUrl, render, SafeHtml } from '../../src/shared/ui/html.js'

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&\``)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;&#96;'
    )
  })
  it('renders null/undefined/false as empty', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(false)).toBe('')
    expect(escapeHtml(0)).toBe('0')
  })
})

describe('html``', () => {
  it('escapes interpolated user data (XSS)', () => {
    const name = '<script>steal()</script>'
    expect(html`<p>${name}</p>`.value).toBe('<p>&lt;script&gt;steal()&lt;/script&gt;</p>')
  })
  it('cannot break out of a quoted attribute', () => {
    const v = '" onmouseover="x'
    expect(html`<a title="${v}">t</a>`.value).toBe('<a title="&quot; onmouseover=&quot;x">t</a>')
  })
  it('composes nested SafeHtml and arrays without double-escaping', () => {
    const items = ['a<b', 'c'].map((x) => html`<li>${x}</li>`)
    expect(html`<ul>${items}</ul>`.value).toBe('<ul><li>a&lt;b</li><li>c</li></ul>')
  })
  it('trusted() passes static markup through', () => {
    expect(html`<i>${trusted('<b>x</b>')}</i>`.value).toBe('<i><b>x</b></i>')
  })
})

describe('safeUrl', () => {
  it('blocks javascript: and data: URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#')
    expect(safeUrl(' JaVaScRiPt:alert(1)')).toBe('#')
    expect(safeUrl('data:text/html,x')).toBe('#')
  })
  it('allows https, mailto and relative', () => {
    expect(safeUrl('https://example.test')).toBe('https://example.test')
    expect(safeUrl('mailto:a@example.test')).toBe('mailto:a@example.test')
    expect(safeUrl('#/courses')).toBe('#/courses')
  })
})

describe('render', () => {
  it('refuses plain strings', () => {
    const el = document.createElement('div')
    expect(() => render(el, '<b>x</b>')).toThrow(TypeError)
  })
  it('writes SafeHtml and the DOM contains text, not elements, for user data', () => {
    const el = document.createElement('div')
    render(el, html`<p>${'<img src=x onerror=alert(1)>'}</p>`)
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(html`x` instanceof SafeHtml).toBe(true)
  })
})

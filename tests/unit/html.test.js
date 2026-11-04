import { describe, it, expect } from 'vitest'
import { html, escapeHtml, trusted, safeUrl, render, SafeHtml } from '../../src/shared/ui/html.js'
import { filePicker, bindFilePickers } from '../../src/shared/ui/components.js'

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

describe('filePicker (Thai text instead of the browser\'s "Choose File")', () => {
  it('hides the real input inside a Thai label and shows the chosen name, escaped', () => {
    const root = document.createElement('div')
    document.body.append(root)
    render(
      root,
      html`<form>${filePicker({ name: 'media_file', accept: 'image/png', button: 'เลือกรูป…', label: 'รูปประกอบโจทย์', required: true })}</form>`
    )
    const input = root.querySelector('input[type=file]')
    expect(input.name).toBe('media_file')
    expect(input.accept).toBe('image/png')
    expect(input.required).toBe(true)
    expect(input.getAttribute('aria-label')).toBe('รูปประกอบโจทย์')
    expect(input.classList.contains('sr-only')).toBe(true)
    expect(input.closest('label').textContent.trim()).toBe('เลือกรูป…')
    const shown = root.querySelector('[data-file-name]')
    expect(shown.textContent).toBe('ยังไม่ได้เลือกไฟล์')

    bindFilePickers(root)
    bindFilePickers(root) // binding twice adds no second listener
    Object.defineProperty(input, 'files', {
      value: [{ name: '<img src=x onerror=alert(1)>.png' }],
      configurable: true,
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(shown.textContent).toBe('<img src=x onerror=alert(1)>.png') // text, not markup
    expect(root.querySelector('img')).toBeNull()
    Object.defineProperty(input, 'files', { value: [], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(shown.textContent).toBe('ยังไม่ได้เลือกไฟล์')
    root.remove()
  })

  it('without a label the button text names the input; not required by default', () => {
    const root = document.createElement('div')
    render(root, filePicker({ name: 'file' }))
    const input = root.querySelector('input')
    expect(input.hasAttribute('aria-label')).toBe(false)
    expect(input.required).toBe(false)
    expect(root.textContent).toContain('เลือกไฟล์…')
  })
})

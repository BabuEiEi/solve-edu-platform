import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderAuthScreen } from '../../src/features/profiles/views.js'

describe('sign-in screen', () => {
  afterEach(() => document.body.replaceChildren())

  const open = () => {
    const root = document.createElement('div')
    document.body.append(root)
    renderAuthScreen(root, { auth: { signInWithGoogle: vi.fn() } })
    return root
  }

  it('links to the privacy policy in a new tab, safely, in sign-in and in sign-up mode', () => {
    const root = open()
    const link = root.querySelector('a[data-privacy-link]')
    expect(link.getAttribute('href')).toBe('/privacy.html')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    root.querySelector('button[data-action=toggle]').click() // switch to "สมัครใช้งาน"
    expect(root.querySelector('a[data-privacy-link]')).not.toBeNull()
    expect(root.textContent).toContain('นโยบายความเป็นส่วนตัว')
  })
})

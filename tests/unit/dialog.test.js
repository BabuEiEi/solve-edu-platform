import { describe, it, expect, afterEach } from 'vitest'
import Swal from 'sweetalert2/dist/sweetalert2.esm.min.js'
import { confirmDialog, promptDialog } from '../../src/shared/ui/dialog.js'

// jsdom has no layout, no innerText (SweetAlert2 sets the title with it) and does not move
// focus, so those are checked in a real browser (tests/e2e/dialogs.spec.js). Here: what
// does not depend on them — the answers, the plain-text rule and the classes.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get() {
    return this.textContent
  },
  set(v) {
    this.textContent = v
  },
})
const tick = () => new Promise((r) => setTimeout(r, 0))
const popup = () => Swal.getPopup()
const isOpen = () => Swal.getPopup() !== null
// SweetAlert2 keeps a hidden, empty <img class="swal2-image"> of its own; ours would have src="x"
const injected = () => popup().querySelector('img[src="x"], b')

afterEach(() => {
  Swal.close()
  document.body.replaceChildren()
})

describe('confirmDialog', () => {
  it('shows Thai default buttons, resolves true on confirm', async () => {
    const p = confirmDialog({ title: 'ลบข้อนี้?' })
    await tick()
    expect(isOpen()).toBe(true)
    expect(Swal.getTitle().textContent).toBe('ลบข้อนี้?')
    expect(Swal.getConfirmButton().textContent).toBe('ยืนยัน')
    expect(Swal.getCancelButton().textContent).toBe('ยกเลิก')
    Swal.clickConfirm()
    expect(await p).toBe(true)
    expect(isOpen()).toBe(false)
  })

  it('resolves false on cancel, on Escape and when closed from outside', async () => {
    let p = confirmDialog({ title: 'x' })
    await tick()
    Swal.clickCancel()
    expect(await p).toBe(false)

    p = confirmDialog({ title: 'x' })
    await tick()
    popup().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    Swal.close() // what a backdrop click ends up doing: dismissed, not confirmed
    expect(await p).toBe(false)
  })

  it('shows the explanation as plain text with line breaks kept', async () => {
    const p = confirmDialog({ title: 't', text: 'บรรทัด 1\nบรรทัด 2' })
    await tick()
    expect(Swal.getHtmlContainer().textContent).toBe('บรรทัด 1\nบรรทัด 2')
    expect(Swal.getHtmlContainer().className).toContain('whitespace-pre-line')
    Swal.clickCancel()
    await p
  })

  it('never turns text from users into HTML (title, text, button texts)', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><b>x</b>'
    const p = confirmDialog({ title: `ลบหน่วย “${evil}”?`, text: evil, confirmText: evil, cancelText: evil })
    await tick()
    expect(injected()).toBeNull()
    expect(Swal.getTitle().textContent).toContain(evil)
    expect(Swal.getHtmlContainer().textContent).toBe(evil)
    expect(Swal.getConfirmButton().textContent).toBe(evil)
    expect(Swal.getCancelButton().textContent).toBe(evil)
    expect(window.__pwned).toBeUndefined()
    Swal.clickCancel()
    await p
  })

  it('danger: red confirm button; a normal confirmation uses the brand colour', async () => {
    let p = confirmDialog({ title: 'ลบ?', danger: true, confirmText: 'ลบ' })
    await tick()
    expect(Swal.getConfirmButton().className).toContain('bg-rose-600')
    Swal.clickCancel()
    await p
    p = confirmDialog({ title: 'ส่งงาน?' })
    await tick()
    expect(Swal.getConfirmButton().className).toContain('bg-brand-600')
    Swal.clickCancel()
    await p
  })

  it('a second dialog replaces the first, which counts as not confirmed', async () => {
    const first = confirmDialog({ title: 'ก' })
    await tick()
    const second = confirmDialog({ title: 'ข' })
    await tick()
    expect(await first).toBe(false)
    expect(Swal.getTitle().textContent).toBe('ข')
    Swal.clickConfirm()
    expect(await second).toBe(true)
  })
})

describe('promptDialog', () => {
  const type = (value) => {
    const input = Swal.getInput()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('resolves what was typed, with the default value and limits set', async () => {
    const p = promptDialog({
      title: 'เหตุผล',
      label: 'ระบุเหตุผล',
      placeholder: 'เช่น สัญญาณขาด',
      defaultValue: 'https://',
      maxLength: 100,
    })
    await tick()
    const input = Swal.getInput()
    expect(input.value).toBe('https://')
    expect(input.placeholder).toBe('เช่น สัญญาณขาด')
    expect(input.getAttribute('maxlength')).toBe('100')
    expect(Swal.getPopup().textContent).toContain('ระบุเหตุผล')
    type('https://example.test/x')
    Swal.clickConfirm()
    expect(await p).toBe('https://example.test/x')
  })

  it('resolves null when cancelled, an empty string when confirmed empty', async () => {
    let p = promptDialog({ title: 'x' })
    await tick()
    Swal.clickCancel()
    expect(await p).toBeNull()

    p = promptDialog({ title: 'x' })
    await tick()
    Swal.clickConfirm()
    expect(await p).toBe('')
  })

  it('a validator can refuse the value and shows its message until it is fixed', async () => {
    const validate = (v) => (v.startsWith('https://') ? undefined : 'ลิงก์ต้องขึ้นต้นด้วย https://')
    const p = promptDialog({ title: 'ลิงก์', validate })
    await tick()
    type('http://x.test')
    Swal.clickConfirm()
    await tick()
    await tick()
    expect(isOpen()).toBe(true)
    expect(Swal.getValidationMessage().textContent).toBe('ลิงก์ต้องขึ้นต้นด้วย https://')
    type('https://x.test')
    Swal.clickConfirm()
    expect(await p).toBe('https://x.test')
  })

  it('shows the label exactly as given (no visible &lt;), and the same for the buttons', async () => {
    const p = promptDialog({ title: 'a', label: 'ชื่อ <ใหม่> & “เก่า”', confirmText: 'ตกลง & ปิด' })
    await tick()
    expect(popup().querySelector('label, .swal2-input-label').textContent).toBe('ชื่อ <ใหม่> & “เก่า”')
    expect(Swal.getConfirmButton().textContent).toBe('ตกลง & ปิด')
    Swal.clickCancel()
    await p
  })

  it('shows the label and the explanation as plain text', async () => {
    const evil = '<img src=x onerror="window.__pwned=2">'
    const p = promptDialog({ title: evil, text: evil, label: evil, placeholder: evil })
    await tick()
    expect(injected()).toBeNull()
    expect(window.__pwned).toBeUndefined()
    expect(Swal.getInput().placeholder).toBe(evil)
    Swal.clickCancel()
    await p
  })
})

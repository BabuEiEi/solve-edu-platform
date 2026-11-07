import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createAutosave, AUTOSAVE_DELAY_MS, LEAVE_PROMPT } from '../../src/shared/ui/autosave.js'
import { AppError } from '../../src/core/errors.js'
import { html, render } from '../../src/shared/ui/html.js'

function setup(over = {}) {
  render(
    document.body,
    html`<a href="#/x" id="out">ออก</a
      ><form>
        <input name="t" /><button id="in" type="button">ใน</button><span id="s"></span>
      </form>`
  )
  const form = document.querySelector('form')
  const status = document.querySelector('#s')
  const save = over.save ?? vi.fn(async () => {})
  const auto = createAutosave({ form, status, save, ...over })
  const type = () => form.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }))
  return { form, status, save, auto, type }
}

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('saves once, a second after typing stops; the status follows', async () => {
    const { status, save, type } = setup()
    type()
    expect(status.dataset.state).toBe('dirty')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    type() // typing again restarts the wait
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(save).toHaveBeenCalledTimes(1)
    expect(status.dataset.state).toBe('saved')
    expect(status.textContent).toContain('บันทึกอัตโนมัติแล้ว')
  })

  it('input during a save is saved right after, never two at once', async () => {
    let release
    let running = 0
    let most = 0
    const save = vi.fn(async () => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => (release = r))
      running--
    })
    const { type, status } = setup({ save })
    type()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(status.dataset.state).toBe('saving')
    type()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1) // still the first
    release()
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(most).toBe(1)
    expect(status.dataset.state).toBe('saved')
  })

  it('a failed save says so (with the reason), stays dirty and the next input tries again', async () => {
    const save = vi.fn().mockRejectedValueOnce(new AppError('ร่างนี้ถูกส่งแล้ว')).mockResolvedValue(undefined)
    const { type, status, auto } = setup({ save })
    type()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(status.dataset.state).toBe('error')
    expect(status.textContent).toContain('ร่างนี้ถูกส่งแล้ว')
    expect(auto.isDirty()).toBe(true)
    type()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(status.dataset.state).toBe('saved')
  })

  it('what cannot be saved yet (canSave false) is not sent and the status explains', async () => {
    const { type, status, save } = setup({ canSave: () => false })
    type()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(save).not.toHaveBeenCalled()
    expect(status.dataset.state).toBe('dirty')
    expect(status.textContent).toContain('ตรวจข้อมูลที่กรอกก่อน')
  })

  it('flush saves pending changes now', async () => {
    const { type, save, auto } = setup()
    type()
    await auto.flush()
    expect(save).toHaveBeenCalledTimes(1)
    expect(auto.isDirty()).toBe(false)
    await auto.flush() // nothing pending: no second save
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('leaving: the browser prompt while unsaved; our Thai prompt for in-app links; links inside the form are free', async () => {
    const { type, auto } = setup()
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    type()
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.querySelector('#out').dispatchEvent(click)
    expect(confirm).toHaveBeenCalledWith(LEAVE_PROMPT)
    expect(click.defaultPrevented).toBe(true)
    confirm.mockReturnValue(true)
    const allowed = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.querySelector('#out').dispatchEvent(allowed)
    expect(allowed.defaultPrevented).toBe(false)
    await auto.flush()
    confirm.mockClear()
    document.querySelector('#out').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(confirm).not.toHaveBeenCalled() // saved: no prompt
    confirm.mockRestore()
  })

  it('a form that left the page detaches itself and never prompts', () => {
    const { form, type } = setup()
    type()
    form.remove()
    const confirm = vi.spyOn(window, 'confirm')
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })
})

import { toUserMessage } from '../../core/errors.js'

export const AUTOSAVE_DELAY_MS = 1000
export const LEAVE_PROMPT = 'ยังบันทึกไม่เสร็จ ออกจากหน้านี้หรือไม่'

/**
 * Save what a person types a moment after they stop typing.
 *
 *   form     the <form> being edited (typing in it marks it dirty)
 *   status   an element that shows the state (data-state: saved | dirty | saving | error)
 *   save()   async; saves what is on screen. Throw to report a problem. It is
 *            never called twice at once: input that arrives during a save
 *            is saved right after.
 *   canSave() optional; false = what is typed cannot be saved yet (e.g. a half-typed
 *            link): the status says so and nothing is sent.
 *
 * Also warns before the person leaves with unsaved changes (closing the tab,
 * or clicking a link inside the app), and removes its own listeners once the
 * form is no longer on the page. Returns { flush, dispose, isDirty }.
 */
export function createAutosave({
  form,
  status,
  save,
  canSave = () => true,
  delay = AUTOSAVE_DELAY_MS,
  words = {},
}) {
  const text = {
    dirty: 'ยังไม่ได้บันทึก…',
    saving: 'กำลังบันทึก…',
    saved: 'บันทึกอัตโนมัติแล้ว',
    waiting: 'ยังบันทึกไม่ได้ — ตรวจข้อมูลที่กรอกก่อน',
    error: 'บันทึกไม่สำเร็จ — กรุณาลองใหม่หรือกดปุ่มบันทึก',
    ...words,
  }
  let timer = null
  let dirty = false
  let saving = false
  let again = false
  let disposed = false

  const show = (state, message = text[state]) => {
    if (!status) return
    status.dataset.state = state
    status.textContent = message
  }

  async function run() {
    clearTimeout(timer)
    timer = null
    if (disposed || !dirty) return
    if (saving) {
      again = true
      return
    }
    if (!canSave()) {
      show('dirty', text.waiting)
      return
    }
    saving = true
    dirty = false
    show('saving')
    try {
      await save()
      if (!dirty) show('saved')
    } catch (err) {
      dirty = true
      show('error', `${text.error} (${toUserMessage(err)})`)
    } finally {
      saving = false
      if (again && !disposed) {
        again = false
        run()
      }
    }
  }

  const onInput = () => {
    if (disposed) return
    dirty = true
    show('dirty')
    clearTimeout(timer)
    timer = setTimeout(run, delay)
  }

  const needed = () => {
    if (!form.isConnected) {
      dispose()
      return false
    }
    return dirty || saving
  }
  const onBeforeUnload = (e) => {
    if (!needed()) return
    e.preventDefault()
    e.returnValue = ''
  }
  const onLeaveClick = (e) => {
    const target = e.target.closest?.('a[href^="#"], [data-action="sign-out"]')
    if (!target || form.contains(target) || !needed()) return
    if (!window.confirm(LEAVE_PROMPT)) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }
  function dispose() {
    disposed = true
    clearTimeout(timer)
    form.removeEventListener('input', onInput)
    window.removeEventListener('beforeunload', onBeforeUnload)
    document.removeEventListener('click', onLeaveClick, true)
  }

  form.addEventListener('input', onInput)
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('click', onLeaveClick, true)
  show('saved', '')
  return {
    /** Save now if anything is unsaved (before submit / release); resolves when no save is running. */
    async flush() {
      if (dirty) await run()
      while (saving) await new Promise((r) => setTimeout(r, 10))
    },
    dispose,
    isDirty: () => dirty || saving,
  }
}

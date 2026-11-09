// Not 'sweetalert2' itself: that entry (the .all build) injects its stylesheet at run time, outside
// our cascade layer. This build has no CSS in it; main.css imports the stylesheet into a layer.
import Swal from 'sweetalert2/dist/sweetalert2.esm.min.js'

/**
 * The only place that knows about SweetAlert2. Every confirmation / question
 * in the app goes through here, replacing the browser's window.confirm and
 * window.prompt (which cannot be styled and are poor on phones).
 *
 *   await confirmDialog({ title, text, danger })    → true | false
 *   await promptDialog({ title, label, validate })  → string | null (null = cancelled)
 *
 * The library's stylesheet is imported in styles/main.css, inside a cascade layer
 * (see the note there), so that the Tailwind classes below can override it.
 *
 * Security: SweetAlert2 reads `title`, `html`, the button texts and the
 * validation message as HTML (the input label and the placeholder are text).
 * Text that may come from users (a unit title in "delete this unit?") must
 * never reach it as HTML, so this wrapper only ever passes plain-text options
 * (`titleText`, `text`, `inputLabel`) and HTML-escapes the strings that
 * SweetAlert2 insists on reading as HTML (the button texts, the validation
 * message).
 */

// A dialog belongs to the page that opened it. If the page changes underneath (the Back
// button, a link in another tab of the app), close it as "cancelled": answering it afterwards
// would act on a page that is no longer on screen (window.confirm blocked this by itself).
window.addEventListener('hashchange', () => {
  if (Swal.getPopup()) Swal.close() // getPopup, not isVisible: isVisible measures layout
})

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const BTN =
  'rounded-lg px-4 py-2 text-sm font-semibold shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40'

function look({ danger }) {
  return {
    buttonsStyling: false,
    reverseButtons: true, // cancel on the left, the action on the right
    animation: false, // no motion: faster, steadier on phones and in tests
    heightAuto: false, // do not touch <html>/<body> height (the app shell is full height)
    focusCancel: Boolean(danger), // Enter must not delete by accident
    customClass: {
      popup: 'rounded-2xl p-6 text-left',
      title: 'p-0 text-left text-lg font-semibold text-ink-900',
      htmlContainer: 'm-0 mt-2 whitespace-pre-line p-0 text-left text-sm text-ink-600',
      input: 'mx-0 mt-2 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900',
      inputLabel: 'm-0 mt-3 justify-start p-0 text-left text-sm font-medium text-ink-700',
      validationMessage: 'justify-start text-sm text-rose-700',
      actions: 'mt-5 w-full flex-wrap justify-end gap-2',
      confirmButton: `${BTN} ${danger ? 'bg-rose-600 text-white hover:bg-rose-700' : 'bg-brand-600 text-white hover:bg-brand-700'}`,
      cancelButton: `${BTN} border border-ink-200 bg-white text-ink-700 hover:bg-ink-50`,
    },
  }
}

/**
 * Ask the user to confirm. Resolves true only when they press the confirm
 * button; cancel, Escape and clicking outside all resolve false.
 *   danger  red confirm button, and the cancel button has the focus
 */
export async function confirmDialog({
  title,
  text = '',
  confirmText = 'ยืนยัน',
  cancelText = 'ยกเลิก',
  danger = false,
} = {}) {
  const result = await Swal.fire({
    ...look({ danger }),
    titleText: title,
    text,
    showCancelButton: true,
    confirmButtonText: escapeHtml(confirmText),
    cancelButtonText: escapeHtml(cancelText),
  })
  return result.isConfirmed === true
}

/**
 * Ask the user to type a line of text. Resolves the typed string, or null when
 * they cancel (Escape and clicking outside count as cancel).
 *   label / placeholder  plain text
 *   validate(value)      return a message (string) to refuse the value, or nothing to accept
 *   maxLength            limit on the input
 */
export async function promptDialog({
  title,
  text = '',
  label = '',
  placeholder = '',
  defaultValue = '',
  confirmText = 'ตกลง',
  cancelText = 'ยกเลิก',
  validate = null,
  maxLength = 500,
  danger = false,
} = {}) {
  const result = await Swal.fire({
    ...look({ danger }),
    titleText: title,
    text,
    input: 'text',
    inputLabel: label, // set as text by SweetAlert2 (innerText): escaping here would show &lt;
    inputPlaceholder: placeholder,
    inputValue: defaultValue,
    inputAttributes: { maxlength: String(maxLength), autocapitalize: 'off', autocomplete: 'off' },
    // SweetAlert2 shows the validator's message as HTML (setInnerHtml), so escape it: a message
    // may one day quote what the person typed.
    inputValidator: validate
      ? (value) => {
          const problem = validate(String(value ?? ''))
          return problem ? escapeHtml(problem) : undefined
        }
      : undefined,
    showCancelButton: true,
    confirmButtonText: escapeHtml(confirmText),
    cancelButtonText: escapeHtml(cancelText),
  })
  return result.isConfirmed ? String(result.value ?? '') : null
}

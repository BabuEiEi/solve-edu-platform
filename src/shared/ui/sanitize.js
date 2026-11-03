/**
 * Rich-text sanitisation (BLUEPRINT §5.3, SEC-07).
 *
 * Lesson HTML is authored by course managers, stored in lesson_blocks and
 * rendered to learners. It is sanitised on SAVE (service layer) and again on
 * RENDER (here), and the database rejects script-capable markup as a third
 * line of defence. `richText()` is the ONLY sanctioned way to turn stored
 * HTML into SafeHtml.
 */
import DOMPurify from 'dompurify'
import { SafeHtml } from './html.js'

export const RICH_TEXT_TAGS = [
  'p',
  'br',
  'h2',
  'h3',
  'h4',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'hr',
  'a',
]

const CONFIG = {
  ALLOWED_TAGS: RICH_TEXT_TAGS,
  ALLOWED_ATTR: ['href', 'target', 'rel'],
  ALLOWED_URI_REGEXP: /^(?:https:|mailto:)/i,
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
}

const purifier = DOMPurify(globalThis.window)
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    if (!node.getAttribute('href')) node.removeAttribute('target')
    else {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  }
})

/** Sanitised HTML string (for saving). */
export function sanitizeRichText(dirty) {
  return purifier.sanitize(String(dirty ?? ''), CONFIG).trim()
}

/** Sanitised HTML as SafeHtml (for rendering inside html``). */
export function richText(dirty) {
  return new SafeHtml(sanitizeRichText(dirty))
}

/** True when the sanitised HTML has no visible text (e.g. "<p></p>"). */
export function isBlankRichText(dirtyOrClean) {
  return (
    sanitizeRichText(dirtyOrClean)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim() === ''
  )
}

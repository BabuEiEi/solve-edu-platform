import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'

/**
 * Text of the first sheet of a downloaded .xlsx (cell texts, in order), read
 * straight from the zip — the spec runs in Node, which has no DOMParser, and
 * checking the file without our own reader keeps the check independent.
 */
export async function xlsxTexts(path) {
  const parts = unzipSync(new Uint8Array(await readFile(path)))
  const sheet = strFromU8(parts['xl/worksheets/sheet1.xml'])
  const decode = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
  return [...sheet.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decode(m[1]))
}

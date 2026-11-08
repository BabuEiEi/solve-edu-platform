import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import {
  toXlsx,
  readXlsxRows,
  columnName,
  safeSheetName,
  looksLikeXlsx,
  XLSX_LIMITS,
} from '../../src/shared/utils/xlsx.js'
import { readTableFile, TABLE_FILE_ACCEPT } from '../../src/shared/utils/tableFile.js'
import { AppError } from '../../src/core/errors.js'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NSR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** Build an .xlsx by hand, the way Excel lays it out (shared strings, styles, extra attributes). */
function handmade({ sheetData, shared = null, workbook = null, rels = null, extra = {} }) {
  const files = {
    '[Content_Types].xml': strToU8(
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`
    ),
    'xl/workbook.xml': strToU8(
      workbook ??
        `${HEAD}<workbook xmlns="${NS}" xmlns:r="${NSR}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      rels ??
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `${HEAD}<worksheet xmlns="${NS}" xmlns:r="${NSR}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1:C3"/><sheetData>${sheetData}</sheetData></worksheet>`
    ),
    ...extra,
  }
  if (shared !== null)
    files['xl/sharedStrings.xml'] = strToU8(`${HEAD}<sst xmlns="${NS}" count="9">${shared}</sst>`)
  return zipSync(files)
}

const messageOf = (fn) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    return e.message
  }
  return 'no error'
}

/** Overwrite the declared uncompressed size of one entry (local header + central directory). */
function patchDeclaredSize(zip, name, size) {
  const out = zip.slice()
  const view = new DataView(out.buffer)
  const nameBytes = strToU8(name)
  const nameAt = (at, len) => len === nameBytes.length && nameBytes.every((b, i) => out[at + i] === b)
  for (let i = 0; i < out.length - 4; i++) {
    const sig = view.getUint32(i, true)
    if (sig === 0x04034b50 && nameAt(i + 30, view.getUint16(i + 26, true))) view.setUint32(i + 22, size, true)
    if (sig === 0x02014b50 && nameAt(i + 46, view.getUint16(i + 28, true))) view.setUint32(i + 24, size, true)
  }
  return out
}

describe('xlsx helpers', () => {
  it('names columns like Excel', () => {
    expect([0, 25, 26, 51, 701, 702, 16383].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'ZZ',
      'AAA',
      'XFD',
    ])
  })
  it('makes sheet names Excel accepts', () => {
    expect(safeSheetName('ผล/สอบ: [รอบ 1]?')).toBe('ผล สอบ   รอบ 1')
    expect(safeSheetName("'quoted'")).toBe('quoted')
    expect(safeSheetName('')).toBe('Sheet1')
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31)
  })
})

describe('toXlsx', () => {
  const rows = [
    ['ชื่อ', 'คะแนน', 'ผ่าน', 'หมายเหตุ'],
    ['ครู ตัวอย่าง หนึ่ง', 12.5, true, '=HYPERLINK("http://evil.example.test","x")'],
    ['ครู "สอง" <b>&', 0, false, null],
    ['บรรทัด1\nบรรทัด2', Number.NaN, undefined, 'ctrl\u0001char'],
  ]
  const parts = unzipSync(toXlsx(rows, { sheetName: 'ผลสอบ', textColumns: [3] }))
  const sheet = strFromU8(parts['xl/worksheets/sheet1.xml'])

  it('is a complete package with one sheet', () => {
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
    expect(strFromU8(parts['xl/workbook.xml'])).toContain('<sheet name="ผลสอบ" sheetId="1" r:id="rId1"/>')
    for (const xml of Object.values(parts))
      expect(() => new DOMParser().parseFromString(strFromU8(xml), 'application/xml')).not.toThrow()
  })
  it('never writes a formula: text is stored as text, numbers as numbers', () => {
    expect(sheet).not.toContain('<f>')
    expect(sheet).toMatch(/<c r="D2" s="2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;/)
    expect(sheet).toContain('<c r="B2"><v>12.5</v></c>')
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>')
  })
  it('escapes XML, drops characters XML forbids, skips NaN and empty cells', () => {
    expect(sheet).toContain('ครู &quot;สอง&quot; &lt;b&gt;&amp;')
    expect(sheet).toContain('ctrlchar')
    expect(sheet).not.toContain('<c r="B4"')
    expect(sheet).not.toContain('<c r="C4"')
  })
  it('makes the header bold and frozen, and formats text columns as Text', () => {
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">')
    expect(sheet).toContain('<c r="D1" s="3" t="inlineStr">')
    expect(sheet).toContain('state="frozen"')
    expect(sheet).toMatch(/<col min="4" max="4" width="\d+" customWidth="1" style="2"\/>/)
    expect(strFromU8(parts['xl/styles.xml'])).toContain('numFmtId="49"')
  })
  it('round-trips through the reader as strings', () => {
    expect(readXlsxRows(toXlsx(rows))).toEqual([
      ['ชื่อ', 'คะแนน', 'ผ่าน', 'หมายเหตุ'],
      ['ครู ตัวอย่าง หนึ่ง', '12.5', 'TRUE', '=HYPERLINK("http://evil.example.test","x")'],
      ['ครู "สอง" <b>&', '0', 'FALSE'],
      ['บรรทัด1\nบรรทัด2', '', '', 'ctrlchar'],
    ])
  })
  it('writes an empty table as a valid file', () => {
    expect(readXlsxRows(toXlsx([]))).toEqual([])
  })
})

describe('readXlsxRows — files made elsewhere', () => {
  it('reads a file written by another program (openpyxl): first sheet only, rich text, blanks skipped', () => {
    // tests/fixtures/openpyxl-sample.xlsx: made by openpyxl 3.1.5 (fictitious data; second sheet "อื่น")
    const bytes = readFileSync(resolve(process.cwd(), 'tests/fixtures/openpyxl-sample.xlsx'))
    expect(readXlsxRows(bytes)).toEqual([
      ['email', 'full_name', 'user_code', 'score', 'ok'],
      ['teacher.one@example.test', 'ครู ตัวอย่าง หนึ่ง', '00123', '12.5', 'TRUE'],
      ['teacher.two@example.test', 'ครู ตัวหนา สอง', '', '', 'FALSE'],
      ['', '', '46024'],
    ])
  })
  it('reads Excel-style shared strings (plain, rich text, phonetic hints skipped)', () => {
    const file = handmade({
      shared:
        '<si><t>email</t></si><si><t xml:space="preserve"> ครู </t></si>' +
        '<si><r><rPr><b/></rPr><t>ตัว</t></r><r><t>หนา</t></r><rPh sb="0" eb="1"><t>IGNORED</t></rPh></si>',
      sheetData:
        '<row r="1" spans="1:3" x14ac:dyDescent="0.25"><c r="A1" s="1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3" t="str"><f>A1</f><v>email</v></c></row>',
    })
    expect(readXlsxRows(file)).toEqual([
      ['email', '', 'ตัวหนา'],
      ['', ' ครู ', 'email'],
    ])
  })
  it('accepts cells without a reference, prefixed namespaces and absolute sheet targets', () => {
    const file = zipSync({
      'xl/workbook.xml': strToU8(
        `<x:workbook xmlns:x="${NS}" xmlns:r="${NSR}"><x:sheets><x:sheet name="A" sheetId="2" r:id="rId9"/><x:sheet name="B" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Target="/xl/worksheets/./data.xml"/></Relationships>'
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>second</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`
      ),
      'xl/worksheets/data.xml': strToU8(
        `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>`
      ),
    })
    expect(readXlsxRows(file)).toEqual([['a', '2']])
  })
})

describe('readXlsxRows — untrusted files', () => {
  const NOT_XLSX = 'ไฟล์นี้ไม่ใช่ไฟล์ Excel (.xlsx) หรือไฟล์เสียหาย'

  it('rejects files that are not xlsx, with a Thai message', () => {
    expect(messageOf(() => readXlsxRows(strToU8('email,full_name\n')))).toBe(NOT_XLSX)
    expect(messageOf(() => readXlsxRows(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))).toBe(NOT_XLSX)
    expect(messageOf(() => readXlsxRows(zipSync({ 'a.txt': strToU8('x') })))).toBe(NOT_XLSX)
    expect(messageOf(() => readXlsxRows('not bytes'))).toBe(NOT_XLSX)
  })
  it('explains old .xls and password-protected files', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    expect(messageOf(() => readXlsxRows(ole))).toMatch(/\.xls .*รหัสผ่าน/)
  })
  it('refuses DOCTYPE / ENTITY (entity expansion, external entities)', () => {
    const bomb = handmade({ sheetData: '<row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row>' })
    const parts = unzipSync(bomb)
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']).replace(
      HEAD,
      `${HEAD}<!DOCTYPE worksheet [<!ENTITY x "lol"><!ENTITY y SYSTEM "file:///etc/passwd">]>`
    )
    parts['xl/worksheets/sheet1.xml'] = strToU8(sheet)
    expect(messageOf(() => readXlsxRows(zipSync(parts)))).toBe(NOT_XLSX)
  })
  it('rejects malformed XML and shared-string indexes out of range', () => {
    expect(messageOf(() => readXlsxRows(handmade({ sheetData: '<row><c>' })))).toBe(NOT_XLSX)
    expect(
      messageOf(() =>
        readXlsxRows(
          handmade({
            shared: '<si><t>a</t></si>',
            sheetData: '<row r="1"><c r="A1" t="s"><v>7</v></c></row>',
          })
        )
      )
    ).toBe(NOT_XLSX)
    expect(
      messageOf(() =>
        readXlsxRows(
          handmade({ sheetData: '<row r="1"><c r="1A" t="inlineStr"><is><t>a</t></is></c></row>' })
        )
      )
    ).toBe(NOT_XLSX)
  })
  it('caps the uploaded file size', () => {
    const file = toXlsx([['a']])
    expect(messageOf(() => readXlsxRows(file, { ...XLSX_LIMITS, fileBytes: 100 }))).toMatch(/ไฟล์ใหญ่เกิน/)
  })
  it('caps the unzipped size before inflating (zip bomb), per part and in total', () => {
    const big = toXlsx([['x'.repeat(5000)]])
    expect(messageOf(() => readXlsxRows(big, { ...XLSX_LIMITS, entryBytes: 1000 }))).toMatch(/ไฟล์ใหญ่เกิน/)
    expect(messageOf(() => readXlsxRows(big, { ...XLSX_LIMITS, totalBytes: 2000 }))).toMatch(/ไฟล์ใหญ่เกิน/)
  })
  it('a lying size header cannot make it inflate more than declared', () => {
    const file = toXlsx([['x'.repeat(50_000)]]) // compresses to a few hundred bytes
    // declared huge → refused before inflating
    expect(
      messageOf(() => readXlsxRows(patchDeclaredSize(file, 'xl/worksheets/sheet1.xml', 900_000_000)))
    ).toMatch(/ไฟล์ใหญ่เกิน/)
    // declared tiny → output is cut at the declared size and the XML is rejected
    expect(messageOf(() => readXlsxRows(patchDeclaredSize(file, 'xl/worksheets/sheet1.xml', 200)))).toBe(
      NOT_XLSX
    )
  })
  it('caps rows and columns', () => {
    const many = toXlsx(Array.from({ length: 30 }, (_, i) => [`r${i}`]))
    expect(messageOf(() => readXlsxRows(many, { ...XLSX_LIMITS, rows: 20 }))).toMatch(/เกิน 20 แถว/)
    const wide = handmade({ sheetData: '<row r="1"><c r="ZZ1" t="inlineStr"><is><t>far</t></is></c></row>' })
    expect(messageOf(() => readXlsxRows(wide))).toMatch(/เกิน 100 คอลัมน์/)
    // formatted-but-empty cells far away do not count
    const styledEmpty = handmade({
      sheetData:
        '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="XFD1" s="1"/></row><row r="1048576"><c r="A1048576" s="1"/></row>',
    })
    expect(readXlsxRows(styledEmpty)).toEqual([['a']])
  })
})

describe('readTableFile', () => {
  const fileOf = (bytes) => ({
    size: bytes.length,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })

  it('accepts Excel and CSV in pickers', () => {
    expect(TABLE_FILE_ACCEPT).toContain('.xlsx')
    expect(TABLE_FILE_ACCEPT).toContain('.csv')
  })
  it('reads xlsx by content (not by file name)', async () => {
    const bytes = toXlsx([['email'], ['a@example.test']])
    expect(looksLikeXlsx(bytes)).toBe(true)
    await expect(readTableFile(fileOf(bytes))).resolves.toEqual([['email'], ['a@example.test']])
  })
  it('reads UTF-8 CSV with or without BOM', async () => {
    await expect(readTableFile(fileOf(strToU8('﻿email,ชื่อ\r\na@example.test,ครู\r\n')))).resolves.toEqual([
      ['email', 'ชื่อ'],
      ['a@example.test', 'ครู'],
    ])
  })
  it('reads CSV saved in Thai Windows-874, the default of Thai Excel', async () => {
    const win874 = new Uint8Array([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x2c, 0xa4, 0xc3, 0xd9]) // "email,ครู"
    await expect(readTableFile(fileOf(win874))).resolves.toEqual([['email', 'ครู']])
  })
  it('refuses a missing or oversized file before reading it', async () => {
    await expect(readTableFile(null)).rejects.toThrow('ยังไม่ได้เลือกไฟล์')
    let read = false
    const huge = {
      size: XLSX_LIMITS.fileBytes + 1,
      arrayBuffer: async () => ((read = true), new ArrayBuffer(0)),
    }
    await expect(readTableFile(huge)).rejects.toThrow(/ไฟล์ใหญ่เกิน/)
    expect(read).toBe(false)
  })
})

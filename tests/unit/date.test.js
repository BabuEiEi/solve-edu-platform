import { describe, it, expect } from 'vitest'
import {
  formatThaiDate,
  formatThaiDateTime,
  toBuddhistYear,
  toGregorianYear,
} from '../../src/shared/utils/date.js'

describe('Thai date formatting', () => {
  it('converts between Gregorian and Buddhist Era', () => {
    expect(toBuddhistYear(2026)).toBe(2569)
    expect(toGregorianYear(2570)).toBe(2027)
  })
  it('shows the Buddhist year in Asia/Bangkok', () => {
    expect(formatThaiDate('2026-11-02T08:31:00Z')).toContain('2569')
    expect(formatThaiDate('2026-11-02T08:31:00Z')).toMatch(/^2 พ\.ย\. 2569$/)
  })
  it('crosses midnight using Bangkok time, not UTC', () => {
    // 2026-12-31 18:30 UTC = 2027-01-01 01:30 in Bangkok → พ.ศ. 2570
    expect(formatThaiDate('2026-12-31T18:30:00Z')).toMatch(/^1 ม\.ค\. 2570$/)
    expect(formatThaiDateTime('2026-12-31T18:30:00Z')).toBe('1 ม.ค. 2570 01:30 น.')
  })
  it('handles empty/invalid values', () => {
    expect(formatThaiDate(null)).toBe('—')
    expect(formatThaiDateTime('not-a-date')).toBe('—')
  })
})

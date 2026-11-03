import { describe, it, expect, vi } from 'vitest'
import { parseCsv } from '../../src/shared/utils/csv.js'
import {
  analyzeRoster,
  createPreregistrationService,
  rosterTemplateCsv,
  TEMPLATE_HEADER,
} from '../../src/features/preregistration/service.js'
import { renderImportView, grantableRoles, importableOrgs } from '../../src/features/preregistration/views.js'

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('parseCsv', () => {
  it('handles BOM, CRLF, quotes, embedded commas/newlines and blank lines', () => {
    const text =
      '﻿email,full_name\r\na@example.test,"นาย ก, ข"\r\n\r\n"b@example.test","line1\nline2 ""q"""\r\n'
    expect(parseCsv(text)).toEqual([
      ['email', 'full_name'],
      ['a@example.test', 'นาย ก, ข'],
      ['b@example.test', 'line1\nline2 "q"'],
    ])
  })
  it('keeps a last row without trailing newline and returns [] for empty input', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('')).toEqual([])
  })
})

describe('analyzeRoster', () => {
  const csv = [
    'Email,ชื่อ',
    'Good.One@Example.test, ครู หนึ่ง ',
    'bad-email,ครู สอง',
    ',ไม่มีอีเมล',
    'good.one@example.test,ซ้ำ',
    'already@example.test,มีแล้ว',
    'ok2@example.test,',
  ].join('\n')

  it('normalises emails and reports every problem with its line number', () => {
    const r = analyzeRoster(csv, { existing: ['Already@example.test'] })
    expect(r.validCount).toBe(2)
    expect(r.errorCount).toBe(4)
    expect(r.rows[0]).toMatchObject({
      line: 2,
      email: 'good.one@example.test',
      full_name: 'ครู หนึ่ง',
      errors: [],
    })
    expect(r.rows[1].errors).toContain('รูปแบบอีเมลไม่ถูกต้อง')
    expect(r.rows[2].errors).toContain('ไม่มีอีเมล')
    expect(r.rows[3].errors[0]).toContain('ซ้ำกับแถว 2')
    expect(r.rows[4].errors[0]).toContain('รอผูกบัญชี')
  })
  it('rejects files without an email column, without data, or too large', () => {
    expect(() => analyzeRoster('name\nx')).toThrow('email')
    expect(() => analyzeRoster('email')).toThrow('ไม่มีข้อมูล')
    expect(() => analyzeRoster('')).toThrow('ไฟล์ว่าง')
    const big = 'email\n' + Array.from({ length: 501 }, (_, i) => `u${i}@example.test`).join('\n')
    expect(() => analyzeRoster(big)).toThrow('ไม่เกิน 500')
  })
})

function fakeClient(result = { data: [], error: null }) {
  const calls = []
  const b = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => resolve(result)
        return (...a) => (calls.push([prop, ...a]), b)
      },
    }
  )
  return {
    calls,
    from: (t) => (calls.push(['from', t]), b),
    rpc: vi.fn(async () => ({ data: 2, error: null })),
  }
}

describe('preregistration service', () => {
  it('imports in ONE insert and sends no status/importer (server-stamped)', async () => {
    const c = fakeClient({ data: null, error: null })
    const out = await createPreregistrationService(c).importRows(
      [{ email: 'a@example.test', full_name: 'ก', status: 'claimed', imported_by: 'x' }],
      { organizationId: 'O', orgRole: 'teacher', cohortId: 'C', cohortRole: 'trainee' }
    )
    const inserts = c.calls.filter(([op]) => op === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toHaveLength(1)
    expect(Object.keys(inserts[0][1][0]).sort()).toEqual(
      ['batch_id', 'cohort_id', 'cohort_role', 'email', 'full_name', 'org_role', 'organization_id'].sort()
    )
    expect(out.count).toBe(1)
  })
  it('drops cohort_role when no cohort is chosen', async () => {
    const c = fakeClient({ data: null, error: null })
    await createPreregistrationService(c).importRows([{ email: 'a@example.test', full_name: '' }], {
      organizationId: 'O',
      orgRole: 'teacher',
      cohortId: null,
      cohortRole: 'trainee',
    })
    expect(c.calls.find(([op]) => op === 'insert')[1][0]).toMatchObject({
      cohort_id: null,
      cohort_role: null,
    })
  })
  it('claimMine calls the RPC with no arguments (identity comes from the JWT)', async () => {
    const c = fakeClient()
    expect(await createPreregistrationService(c).claimMine()).toBe(2)
    expect(c.rpc).toHaveBeenCalledWith('claim_my_preregistrations')
  })
  it('cancel on a row hidden by RLS is an error, not silent success', async () => {
    await expect(
      createPreregistrationService(fakeClient({ data: [], error: null })).cancel('x')
    ).rejects.toThrow('ไม่มีสิทธิ์')
  })
})

describe('import view helpers', () => {
  const orgs = [
    { id: 'D', parent_id: null },
    { id: 'A', parent_id: 'D' },
    { id: 'B', parent_id: 'D' },
  ]
  it('school admins see only their school and may offer only teacher', () => {
    const context = { orgMemberships: [{ organization_id: 'A', org_role: 'school_admin' }] }
    expect(importableOrgs(orgs, context, { isPlatformAdmin: false }).map((o) => o.id)).toEqual(['A'])
    expect(grantableRoles({ isPlatformAdmin: false, orgRoles: ['school_admin'] })).toEqual(['teacher'])
  })
  it('district admins see the district and its schools', () => {
    const context = { orgMemberships: [{ organization_id: 'D', org_role: 'district_admin' }] }
    expect(importableOrgs(orgs, context, { isPlatformAdmin: false }).map((o) => o.id)).toEqual([
      'D',
      'A',
      'B',
    ])
    expect(grantableRoles({ isPlatformAdmin: false, orgRoles: ['district_admin'] })).not.toContain(
      'district_admin'
    )
  })
})

describe('import view', () => {
  it('previews errors, imports only valid rows, then lists pending', async () => {
    const el = document.createElement('div')
    const importRows = vi.fn(async (rows) => ({ count: rows.length }))
    const services = {
      organizations: {
        listActiveOrganizations: async () => [{ id: 'A', name: 'โรงเรียน ก', parent_id: null }],
      },
      programs: {
        listVisiblePrograms: async () => [{ name: 'โครงการ', cohorts: [{ id: 'C', name: 'รุ่น 1' }] }],
      },
      preregistration: {
        list: async () => [],
        pendingEmails: async () => [],
        importRows,
        cancel: async () => {},
      },
    }
    const context = { orgMemberships: [{ organization_id: 'A', org_role: 'school_admin' }] }
    await renderImportView(el, {
      services,
      context,
      caps: { isPlatformAdmin: false, orgRoles: ['school_admin'] },
    })

    const file = new File(['email,full_name\nok@example.test,ครู\nbroken,x\n'], 'r.csv', { type: 'text/csv' })
    const form = el.querySelector('form[data-form=roster]')
    const fd = new FormData(form)
    fd.set('file', file)
    // jsdom cannot assign input.files; stand in for the browser's FormData
    const real = globalThis.FormData
    globalThis.FormData = class extends real {
      constructor() {
        super(form)
        this.set('file', file)
      }
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    globalThis.FormData = real

    expect(el.textContent).toContain('ถูกต้อง 1')
    expect(el.textContent).toContain('มีข้อผิดพลาด 1')
    expect(el.textContent).toContain('รูปแบบอีเมลไม่ถูกต้อง')
    el.querySelector('[data-action=confirm-import]').click()
    await flush()
    expect(importRows).toHaveBeenCalledTimes(1)
    expect(importRows.mock.calls[0][0].map((r) => r.email)).toEqual(['ok@example.test'])
    expect(el.textContent).toContain('นำเข้าแล้ว 1 รายการ')
  })
})

describe('roster template', () => {
  it('has the exact headers the importer requires and every example row passes validation', () => {
    const csv = rosterTemplateCsv()
    expect(csv.startsWith('﻿')).toBe(true) // Excel opens Thai as UTF-8
    expect(parseCsv(csv)[0]).toEqual(TEMPLATE_HEADER)
    const result = analyzeRoster(csv)
    expect(result.errorCount).toBe(0)
    expect(result.validCount).toBe(2)
    expect(result.rows.every((r) => r.email.endsWith('@example.test'))).toBe(true)
  })
})

describe('import view template download', () => {
  it('downloads roster-template.csv from a blob URL', async () => {
    const el = document.createElement('div')
    const services = {
      organizations: { listActiveOrganizations: async () => [{ id: 'A', name: 'ก', parent_id: null }] },
      programs: { listVisiblePrograms: async () => [] },
      preregistration: { list: async () => [] },
    }
    const context = { orgMemberships: [{ organization_id: 'A', org_role: 'school_admin' }] }
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
    let downloaded = null
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloaded = { name: this.download, href: this.href }
    })
    await renderImportView(el, {
      services,
      context,
      caps: { isPlatformAdmin: false, orgRoles: ['school_admin'] },
    })
    el.querySelector('[data-action=download-template]').click()
    expect(downloaded).toEqual({ name: 'roster-template.csv', href: 'blob:test' })
    expect(URL.createObjectURL.mock.calls[0][0].type).toContain('text/csv')
    click.mockRestore()
  })
})

/**
 * "ส่งสำเนาไป Google Drive" on the reviewer's task page: Thai texts, the
 * service's mapping of the function's error codes, and the page itself.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDriveService } from '../../src/features/drive/service.js'
import { explainError, historyLine, resultMessage, resultTone } from '../../src/features/drive/logic.js'
import { renderTaskPeopleView } from '../../src/features/reviews/views.js'
vi.mock('../../src/shared/ui/dialog.js', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }))
import { confirmDialog } from '../../src/shared/ui/dialog.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('texts', () => {
  it('a complete run says what was sent and what was already there', () => {
    expect(resultMessage({ status: 'done', copied: 3, skipped: 2, failed: 0, remaining: 0 })).toBe(
      'ส่งครบแล้ว: ส่งใหม่ 3 ไฟล์ · มีใน Drive อยู่แล้ว 2 ไฟล์'
    )
    expect(resultMessage({ status: 'done', copied: 0, skipped: 0 })).toContain('ไม่มีไฟล์แนบ')
    expect(resultTone({ status: 'done' })).toBe('success')
  })

  it('an unfinished run says how to go on; a failed one says nothing was sent', () => {
    const partial = resultMessage({ status: 'partial', copied: 2, skipped: 0, failed: 1, remaining: 4 })
    expect(partial).toContain('ส่งยังไม่ครบ')
    expect(partial).toContain('เหลืออีก 4 ไฟล์')
    expect(partial).toContain('ส่งไม่สำเร็จ 1 ไฟล์')
    expect(partial).toContain('กดอีกครั้ง')
    expect(resultTone({ status: 'partial' })).toBe('warning')
    expect(resultMessage({ status: 'failed' })).toContain('ไม่มีไฟล์ถูกส่ง')
  })

  it('history lines: label, counts, the recorded reason', () => {
    expect(historyLine({ status: 'done', files_copied: 3, files_skipped: 1, files_failed: 0 })).toEqual({
      label: 'ส่งครบ',
      detail: 'ส่งใหม่ 3 · มีแล้ว 1',
      error: null,
    })
    expect(
      historyLine({
        status: 'partial',
        files_copied: 0,
        files_skipped: 2,
        files_failed: 1,
        error: 'drive_forbidden',
      })
    ).toMatchObject({
      label: 'ส่งบางส่วน',
      detail: 'ส่งใหม่ 0 · มีแล้ว 2 · ไม่สำเร็จ/เหลือ 1',
      error: { reason: expect.stringContaining('Shared Drive'), code: 'drive_forbidden' },
    })
    expect(historyLine({ status: 'running' })).toMatchObject({ label: 'กำลังส่ง', detail: '' })
  })

  it('recorded error codes are explained in Thai, the code kept as detail; unknown ones do not leak English', () => {
    expect(explainError(null)).toBeNull()
    expect(explainError('google_auth_failed (HTTP 400)')).toEqual({
      reason: 'เข้าสู่ระบบ Google ไม่สำเร็จ (ตรวจกุญแจของ service account)',
      code: 'google_auth_failed (HTTP 400)',
    })
    const two = explainError(
      'drive_forbidden: upload (HTTP 403); download_failed; drive_forbidden: upload (HTTP 403)'
    )
    expect(two.reason).toBe(
      'Google Drive ไม่อนุญาต (ตรวจว่า service account เป็นสมาชิกของ Shared Drive) · อ่านไฟล์งานจากระบบไม่ได้'
    )
    expect(explainError('something odd').reason).toBe('เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ')
    expect(explainError('did not finish within 15 minutes').reason).toContain('15 นาที')
  })
})

describe('service', () => {
  const httpError = (status, body) => ({
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(JSON.stringify(body), { status }),
  })

  it('sends only the allocation id and returns the function’s answer', async () => {
    const invoke = vi.fn(async () => ({ data: { status: 'done', copied: 1 }, error: null }))
    const out = await createDriveService({ functions: { invoke } }).exportTask('A1')
    expect(out).toEqual({ status: 'done', copied: 1 })
    expect(invoke).toHaveBeenCalledWith('drive-export-task', { body: { allocation_id: 'A1' } })
  })

  it('the function’s error codes become Thai messages', async () => {
    const cases = {
      forbidden: 'เฉพาะผู้ตรวจของรุ่นนี้',
      already_running: 'กำลังส่งสำเนา',
      not_configured: 'ยังไม่ได้ตั้งค่า Google Drive',
      unauthorized: 'เซสชันหมดอายุ',
    }
    for (const [code, text] of Object.entries(cases)) {
      const service = createDriveService({
        functions: { invoke: async () => ({ data: null, error: httpError(409, { error: code }) }) },
      })
      await expect(service.exportTask('A1')).rejects.toMatchObject({
        message: expect.stringContaining(text),
        code,
      })
    }
  })

  it('a network failure or an unknown body gets the fallback (no raw English)', async () => {
    for (const error of [
      { message: 'Failed to send a request to the Edge Function' },
      httpError(502, { x: 1 }),
      httpError(500, 'not json {'),
    ]) {
      const service = createDriveService({ functions: { invoke: async () => ({ data: null, error }) } })
      const err = await service.exportTask('A1').catch((e) => e)
      expect(err.message).toContain('ตรวจ "ประวัติการส่งสำเนา"')
      expect(err.message).not.toMatch(/Edge Function|non-2xx/)
    }
  })

  it('history asks for explicit columns, newest first, and never throws', async () => {
    const calls = []
    const chain = (result) => {
      const q = {
        select: (c) => (calls.push(['select', c]), q),
        eq: (k, v) => (calls.push(['eq', k, v]), q),
        order: (k, o) => (calls.push(['order', k, o]), q),
        limit: (n) => (calls.push(['limit', n]), Promise.resolve(result)),
      }
      return q
    }
    const ok = createDriveService({ from: () => chain({ data: [{ id: 'r1' }], error: null }) })
    expect(await ok.history('A1')).toEqual([{ id: 'r1' }])
    expect(calls.find(([k]) => k === 'select')[1]).not.toContain('*')
    expect(calls).toContainEqual(['eq', 'allocation_id', 'A1'])
    expect(calls).toContainEqual(['order', 'started_at', { ascending: false }])
    expect(
      await createDriveService({ from: () => chain({ data: null, error: { code: '42501' } }) }).history('A1')
    ).toEqual([])
    expect(
      await createDriveService({
        from: () => {
          throw new Error('offline')
        },
      }).history('A1')
    ).toEqual([])
  })
})

describe('page', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })
  const allocation = {
    id: 'A1',
    cohort_id: 'C',
    due_at: null,
    cohorts: { id: 'C', code: 'R1', name: 'รุ่น 1' },
    tasks: { id: 'T', title: XSS, max_attempts: 3, status: 'published', courses: { title: 'หลักสูตร' } },
  }
  const run = (o = {}) => ({
    id: 'r1',
    started_at: '2026-11-05T01:00:00Z',
    status: 'done',
    files_copied: 3,
    files_skipped: 0,
    files_failed: 0,
    error: null,
    profiles: { full_name: XSS, display_name: null },
    ...o,
  })
  const setup = ({ caps = { canManagePrograms: true }, drive = {} } = {}) => {
    const services = {
      reviews: {
        getAllocation: async () => allocation,
        submissionsOf: async () => ({ submissions: [], reviews: [] }),
        roster: async () => [],
      },
      drive: {
        history: vi.fn(async () => [run()]),
        exportTask: vi.fn(async () => ({
          run_id: 'r2',
          status: 'done',
          copied: 2,
          skipped: 1,
          failed: 0,
          remaining: 0,
          folder_url: 'https://drive.google.com/drive/folders/abc123',
        })),
        ...drive,
      },
    }
    const el = document.createElement('div')
    document.body.append(el)
    return {
      services,
      el,
      open: () =>
        renderTaskPeopleView(
          el,
          { services, caps, context: { cohortMemberships: [] } },
          { allocationId: 'A1' }
        ),
    }
  }

  it('an assessor sees the section with the history; names and reasons are text', async () => {
    const { el, open } = setup()
    await open()
    const section = el.querySelector('[data-drive]')
    expect(section.querySelector('[data-action=drive-export]').textContent).toContain(
      'ส่งสำเนาไป Google Drive'
    )
    expect(section.textContent).toContain('ส่งครบ')
    expect(section.textContent).toContain('ส่งใหม่ 3')
    expect(el.querySelector('img')).toBeNull()
    expect(section.querySelector('[data-drive-history]').textContent).toContain(XSS)
    const { el: el2, open: open2 } = setup({
      drive: {
        history: vi.fn(async () => [run({ status: 'failed', error: 'google_auth_failed (HTTP 400)' })]),
      },
    })
    await open2()
    const failed = el2.querySelector('[data-drive-history]').textContent
    expect(failed).toContain('เข้าสู่ระบบ Google ไม่สำเร็จ')
    expect(failed).toContain('(google_auth_failed (HTTP 400))')
  })

  it('someone who does not assess the cohort sees no section and nothing is asked of the server', async () => {
    const { el, services, open } = setup({ caps: {} })
    await open()
    expect(el.querySelector('[data-drive]')).toBeNull()
    expect(services.drive.history).not.toHaveBeenCalled()
  })

  it('pressing asks first; declining sends nothing', async () => {
    const { el, services, open } = setup()
    await open()
    confirmDialog.mockResolvedValue(false)
    el.querySelector('[data-action=drive-export]').click()
    await settle()
    expect(confirmDialog.mock.calls[0][0].text).toContain('ชื่อผู้เรียนจะปรากฏในชื่อโฟลเดอร์')
    expect(services.drive.exportTask).not.toHaveBeenCalled()
  })

  it('confirmed: the button is disabled while sending, then the result, the folder link and a fresh history', async () => {
    let finish
    const { el, services, open } = setup({
      drive: { exportTask: vi.fn(() => new Promise((r) => (finish = r))) },
    })
    await open()
    confirmDialog.mockResolvedValue(true)
    el.querySelector('[data-action=drive-export]').click()
    await settle()
    const busy = el.querySelector('[data-action=drive-export]')
    expect(busy.disabled).toBe(true)
    expect(busy.textContent).toContain('กำลังส่งสำเนา')
    expect(el.querySelector('[data-drive-status]').textContent).toContain('อย่าปิดหน้านี้')
    busy.click() // a disabled button sends no click at all …
    el.onclick({ target: busy }) // … and even a click that reaches the handler is ignored while busy
    expect(services.drive.exportTask).toHaveBeenCalledTimes(1)
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    services.drive.history.mockResolvedValue([run({ id: 'r2', files_copied: 2, files_skipped: 1 }), run()])
    finish({
      run_id: 'r2',
      status: 'done',
      copied: 2,
      skipped: 1,
      failed: 0,
      remaining: 0,
      folder_url: 'https://drive.google.com/drive/folders/abc123',
    })
    await settle()
    expect(el.querySelector('[data-action=drive-export]').disabled).toBe(false)
    expect(el.querySelector('[data-drive-status]').textContent).toContain(
      'ส่งใหม่ 2 ไฟล์ · มีใน Drive อยู่แล้ว 1 ไฟล์'
    )
    const link = el.querySelector('[data-drive-link]')
    expect(link.getAttribute('href')).toBe('https://drive.google.com/drive/folders/abc123')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(el.querySelectorAll('[data-drive-history] li')).toHaveLength(2)
    expect(services.drive.exportTask).toHaveBeenCalledWith('A1')
  })

  it('a refusal shows its Thai reason, re-enables the button and still refreshes the history', async () => {
    const { AppError } = await import('../../src/core/errors.js')
    const { el, services, open } = setup({
      drive: {
        exportTask: vi.fn(async () => {
          throw new AppError('ยังไม่ได้ตั้งค่า Google Drive ของระบบ กรุณาแจ้งผู้ดูแลระบบ')
        }),
      },
    })
    await open()
    confirmDialog.mockResolvedValue(true)
    el.querySelector('[data-action=drive-export]').click()
    await settle()
    expect(el.querySelector('[data-drive-status] [role=alert]').textContent).toContain(
      'ยังไม่ได้ตั้งค่า Google Drive'
    )
    expect(el.querySelector('[data-action=drive-export]').disabled).toBe(false)
    expect(el.querySelector('[data-drive-link]')).toBeNull()
    expect(services.drive.history).toHaveBeenCalledTimes(2)
  })

  it('an unfinished run is shown as a warning that says to press again; a non-Drive link is not made clickable', async () => {
    const { el, open } = setup({
      drive: {
        exportTask: vi.fn(async () => ({
          status: 'partial',
          copied: 1,
          skipped: 0,
          failed: 0,
          remaining: 3,
          folder_url: 'javascript:alert(1)',
        })),
      },
    })
    await open()
    confirmDialog.mockResolvedValue(true)
    el.querySelector('[data-action=drive-export]').click()
    await settle()
    expect(el.querySelector('[data-drive-status]').textContent).toContain('เหลืออีก 3 ไฟล์')
    expect(el.querySelector('[data-drive-link]').getAttribute('href')).toBe('#')
  })
})

/**
 * "ลบ / เก็บถาวร": reasons in Thai, the service's error mapping, and the
 * self-mounting zone (unused → typed confirmation; used → reasons + archive).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { reasonLines, confirmMatches } from '../../src/features/deletion/logic.js'
import { createDeletionService } from '../../src/features/deletion/service.js'
import { watchDeleteZones } from '../../src/features/deletion/zone.js'
import { html, render } from '../../src/shared/ui/html.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('texts', () => {
  it('reasons: only what is present, in a fixed order, as sentences', () => {
    expect(reasonLines({ attempts: 2, enrollments: 3, reviews: 0 })).toEqual([
      'มีผู้ลงทะเบียนเรียน 3 คน',
      'มีผู้ทำแบบทดสอบแล้ว 2 ครั้ง',
    ])
    expect(reasonLines({ rubric_tasks_elsewhere: 1 })[0]).toContain('หลักสูตรอื่น')
    expect(reasonLines({ nonsense: 5 })).toEqual([])
    expect(reasonLines(null)).toEqual([])
  })

  it('the confirmation is exact (case and spaces count), as the database checks it', () => {
    expect(confirmMatches('AFL-101', 'AFL-101')).toBe(true)
    expect(confirmMatches('afl-101', 'AFL-101')).toBe(false)
    expect(confirmMatches('AFL-101 ', 'AFL-101')).toBe(false)
    expect(confirmMatches('', '')).toBe(false)
    expect(confirmMatches('x', undefined)).toBe(false)
  })
})

describe('service', () => {
  it('usage asks the database; remove sends the id and the typed text under the right argument name', async () => {
    const rpc = vi.fn(async () => ({ data: { can_delete: true, reasons: {} }, error: null }))
    const s = createDeletionService({ rpc })
    expect(await s.usage('course', 'C1')).toEqual({ can_delete: true, reasons: {} })
    expect(rpc).toHaveBeenLastCalledWith('deletion_usage', { p_kind: 'course', p_id: 'C1' })
    await s.remove('course', 'C1', 'AFL-101')
    expect(rpc).toHaveBeenLastCalledWith('delete_course', { p_course: 'C1', p_confirm: 'AFL-101' })
    await s.remove('instrument', 'I1', 'Q')
    expect(rpc).toHaveBeenLastCalledWith('delete_instrument', { p_instrument: 'I1', p_confirm: 'Q' })
    await s.remove('task', 'T1', 'ชื่องาน')
    expect(rpc).toHaveBeenLastCalledWith('delete_task', { p_task: 'T1', p_confirm: 'ชื่องาน' })
    await expect(s.remove('lesson', 'x', 'y')).rejects.toThrow('ชนิดรายการ')
  })

  it('database refusals become Thai messages', async () => {
    const fail = (code) =>
      createDeletionService({ rpc: async () => ({ data: null, error: { code, message: 'x' } }) })
    await expect(fail('SE009').remove('course', 'C', 'x')).rejects.toThrow('เก็บถาวรแทน')
    await expect(fail('22023').remove('course', 'C', 'x')).rejects.toThrow('ไม่ตรง')
    await expect(fail('42501').remove('course', 'C', 'x')).rejects.toThrow('ไม่มีสิทธิ์')
    await expect(fail('23503').remove('course', 'C', 'x')).rejects.toThrow('ระหว่างที่ลบ')
    await expect(fail('XX000').remove('course', 'C', 'x')).rejects.toThrow('ลบไม่สำเร็จ')
    await expect(fail('42501').usage('task', 'T')).rejects.toThrow('ไม่มีสิทธิ์')
  })
})

describe('zone', () => {
  afterEach(() => document.body.replaceChildren())

  const setup = ({ usage = { can_delete: true, reasons: {} }, cfg = {}, remove } = {}) => {
    const services = {
      deletion: {
        usage: vi.fn(async () => usage),
        remove: remove ?? vi.fn(async () => ({ deleted: true })),
      },
    }
    const root = document.createElement('div')
    document.body.append(root)
    const onDeleted = vi.fn()
    const config = vi.fn(() => ({ confirmWord: 'AFL-101', onDeleted, ...cfg }))
    watchDeleteZones(root, { services, config })
    const draw = (extra = '') =>
      render(
        root,
        html`<h1>หน้า ${extra}</h1><section data-delete-zone data-kind="course" data-id="C1"></section>`
      )
    draw()
    return { root, services, onDeleted, config, draw }
  }
  const zoneText = (root) => root.querySelector('[data-delete-zone]').textContent

  it('an unused item: delete is offered, the button stays off until the exact text is typed, then it deletes', async () => {
    const { root, services, onDeleted } = setup()
    await settle()
    expect(services.deletion.usage).toHaveBeenCalledWith('course', 'C1')
    expect(zoneText(root)).toContain('ยังไม่มีผู้ใช้หลักสูตรนี้ ลบได้ถาวร')
    root.querySelector('[data-zone-action=open]').click()
    const confirmBtn = () => root.querySelector('[data-zone-confirm]')
    const typed = root.querySelector('input[name=confirm]')
    expect(zoneText(root)).toContain('ย้อนคืนไม่ได้')
    expect(confirmBtn().disabled).toBe(true)
    typed.value = 'afl-101'
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    expect(confirmBtn().disabled).toBe(true)
    root
      .querySelector('[data-zone-form]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(services.deletion.remove).not.toHaveBeenCalled() // a forced submit with the wrong text does nothing
    typed.value = 'AFL-101'
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    expect(confirmBtn().disabled).toBe(false)
    root
      .querySelector('[data-zone-form]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(services.deletion.remove).toHaveBeenCalledWith('course', 'C1', 'AFL-101')
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('a used item: the reasons are listed and there is no delete button; archive is offered when the page has it', async () => {
    const run = vi.fn(async () => {})
    const { root, services } = setup({
      usage: { can_delete: false, reasons: { enrollments: 3, attempts: 1 } },
      cfg: { archive: { label: 'เก็บถาวรหลักสูตร', run } },
    })
    await settle()
    const text = zoneText(root)
    expect(text).toContain('ลบหลักสูตรนี้ไม่ได้')
    expect(root.querySelector('[data-reasons]').textContent).toContain('มีผู้ลงทะเบียนเรียน 3 คน')
    expect(root.querySelector('[data-zone-action=open]')).toBeNull()
    root.querySelector('[data-zone-action=archive]').click()
    await settle()
    expect(run).toHaveBeenCalledOnce()
    expect(services.deletion.remove).not.toHaveBeenCalled()
  })

  it('a used item whose page has no archive: reasons only', async () => {
    const { root } = setup({ usage: { can_delete: false, reasons: { submissions: 2 } } })
    await settle()
    expect(root.querySelector('[data-zone-action=archive]')).toBeNull()
    expect(zoneText(root)).toContain('มีงานที่ผู้เรียนเริ่มหรือส่งแล้ว 2 รอบ')
  })

  it('a failed archive and a failed delete keep the panel with the reason', async () => {
    const a = setup({
      usage: { can_delete: false, reasons: { enrollments: 1 } },
      cfg: { archive: { label: 'เก็บถาวร', run: async () => Promise.reject(new Error('x')) } },
    })
    await settle()
    a.root.querySelector('[data-zone-action=archive]').click()
    await settle()
    expect(a.root.querySelector('[data-delete-zone] [role=alert]')).not.toBeNull()
    document.body.replaceChildren()
    const d = setup({ remove: vi.fn(async () => Promise.reject(new Error('x'))) })
    await settle()
    d.root.querySelector('[data-zone-action=open]').click()
    const typed = d.root.querySelector('input[name=confirm]')
    typed.value = 'AFL-101'
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    d.root
      .querySelector('[data-zone-form]')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(d.root.querySelector('[data-zone-form] [role=alert]')).not.toBeNull()
    expect(d.onDeleted).not.toHaveBeenCalled()
  })

  it('a usage check that fails says so instead of offering a delete', async () => {
    const services = {
      deletion: { usage: vi.fn(async () => Promise.reject(new Error('x'))), remove: vi.fn() },
    }
    const root = document.createElement('div')
    document.body.append(root)
    watchDeleteZones(root, { services, config: () => ({ confirmWord: 'X' }) })
    render(root, html`<section data-delete-zone data-kind="task" data-id="T1"></section>`)
    await settle()
    expect(root.querySelector('[data-delete-zone] [role=alert]')).not.toBeNull()
    expect(root.querySelector('[data-zone-action=open]')).toBeNull()
  })

  it('when the page redraws, the new zone is filled in again; texts are escaped', async () => {
    const { root, services, draw } = setup({ cfg: { confirmWord: XSS } })
    await settle()
    expect(services.deletion.usage).toHaveBeenCalledTimes(1)
    draw('ใหม่') // the page re-rendered everything, wiping the zone
    await settle()
    expect(services.deletion.usage).toHaveBeenCalledTimes(2)
    expect(zoneText(root)).toContain('ลบได้ถาวร')
    root.querySelector('[data-zone-action=open]').click()
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('[data-confirm-word]').textContent).toBe(XSS)
  })

  it('an unknown kind or a missing id is ignored', async () => {
    const services = { deletion: { usage: vi.fn(), remove: vi.fn() } }
    const root = document.createElement('div')
    document.body.append(root)
    watchDeleteZones(root, { services, config: () => ({}) })
    render(
      root,
      html`<section data-delete-zone data-kind="lesson" data-id="L1"></section><section data-delete-zone data-kind="task"></section>`
    )
    await settle()
    expect(services.deletion.usage).not.toHaveBeenCalled()
  })
})

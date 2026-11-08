import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildAllocationPayload,
  buildTaskPayload,
  cohortsLeft,
  rubricOptions,
} from '../../src/features/tasks/logic.js'
import { createTaskService } from '../../src/features/tasks/service.js'
import { renderCourseTasksView, renderTaskDetailView } from '../../src/features/tasks/views.js'
import { toUserMessage, AppError } from '../../src/core/errors.js'
vi.mock('../../src/shared/ui/dialog.js', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }))
import { confirmDialog } from '../../src/shared/ui/dialog.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('task logic', () => {
  it('payload: trims, defaults 3 attempts, empty instructions/rubric become null', () => {
    expect(
      buildTaskPayload({ title: ' ส่งแผน ', instructions: ' ', rubric_version_id: '', max_attempts: '' })
    ).toEqual({
      title: 'ส่งแผน',
      instructions: null,
      rubric_version_id: null,
      max_attempts: 3,
    })
    expect(
      buildTaskPayload({ title: 'x', instructions: 'แนบแผน', rubric_version_id: 'V1', max_attempts: '5' })
    ).toMatchObject({
      instructions: 'แนบแผน',
      rubric_version_id: 'V1',
      max_attempts: 5,
    })
  })

  it.each([
    [{ title: '  ' }, 'ชื่อภาระงาน'],
    [{ title: 'x'.repeat(301) }, 'ยาวเกิน 300'],
    [{ title: 'x', instructions: 'x'.repeat(10001) }, 'ยาวเกิน 10,000'],
    [{ title: 'x', max_attempts: '0' }, 'เลข 1–10'],
    [{ title: 'x', max_attempts: '11' }, 'เลข 1–10'],
    [{ title: 'x', max_attempts: '2.5' }, 'เลข 1–10'],
  ])('%j → %s', (f, msg) => {
    expect(() => buildTaskPayload(f)).toThrow(AppError)
    expect(() => buildTaskPayload(f)).toThrow(msg)
  })

  it('allocation dates: Bangkok time to +07:00, blank = none, due must follow the opening', () => {
    expect(buildAllocationPayload({ available_at: '2026-12-01T08:00', due_at: '2026-12-15T23:59' })).toEqual({
      available_at: '2026-12-01T08:00:00+07:00',
      due_at: '2026-12-15T23:59:00+07:00',
    })
    expect(buildAllocationPayload({ available_at: '', due_at: '' })).toEqual({
      available_at: null,
      due_at: null,
    })
    expect(() =>
      buildAllocationPayload({ available_at: '2026-12-15T08:00', due_at: '2026-12-01T08:00' })
    ).toThrow('หลังวันเปิดรับงาน')
    expect(() => buildAllocationPayload({ due_at: 'พรุ่งนี้' })).toThrow('กำหนดส่ง')
  })

  it('only published rubric versions are offered, newest first; cohorts already opened are left out', () => {
    const rubrics = [
      {
        title: 'เกณฑ์ A',
        instrument_versions: [
          { id: 'a1', version_no: 1, status: 'published' },
          { id: 'a2', version_no: 2, status: 'published' },
          { id: 'a3', version_no: 3, status: 'draft' },
        ],
      },
      { title: 'เกณฑ์ B', instrument_versions: [{ id: 'b1', version_no: 1, status: 'draft' }] },
    ]
    expect(rubricOptions(rubrics)).toEqual([
      { id: 'a2', label: 'เกณฑ์ A · ฉบับที่ 2' },
      { id: 'a1', label: 'เกณฑ์ A · ฉบับที่ 1' },
    ])
    expect(cohortsLeft([{ id: 'c1' }, { id: 'c2' }], [{ cohort_id: 'c1' }]).map((c) => c.id)).toEqual(['c2'])
  })

  it('new error codes have Thai messages', () => {
    expect(toUserMessage({ code: 'SE006' })).toContain('เปลี่ยน Rubric')
    expect(toUserMessage({ code: 'SE007' })).toContain('ส่งรอบใหม่ไม่ได้')
    expect(toUserMessage({ code: 'SE008' })).toContain('กำลังส่งสำเนาไป Google Drive')
  })
})

describe('task service', () => {
  const client = (result = { data: [{ id: 'T1' }], error: null }) => {
    const calls = []
    const b = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve(result)
          return (...args) => (calls.push([prop, ...args]), b)
        },
      }
    )
    return { calls, from: (t) => (calls.push(['from', t]), b) }
  }

  it('create sends the course and payload; allocations go to their table', async () => {
    const c = client({ data: { id: 'T1' }, error: null })
    const svc = createTaskService(c)
    await svc.create('K', { title: 'x', max_attempts: 3 })
    expect(c.calls).toContainEqual(['insert', { course_id: 'K', title: 'x', max_attempts: 3 }])
    await svc.addAllocation('T1', 'C1', { available_at: null, due_at: '2026-12-15T23:59:00+07:00' })
    expect(c.calls).toContainEqual(['from', 'task_allocations'])
    expect(c.calls).toContainEqual([
      'insert',
      { task_id: 'T1', cohort_id: 'C1', available_at: null, due_at: '2026-12-15T23:59:00+07:00' },
    ])
  })

  it('selects explicit columns only', async () => {
    const c = client()
    await createTaskService(c).listForCourse('K')
    for (const [op, cols] of c.calls.filter(([op]) => op === 'select')) expect([op, cols]).not.toContain('*')
  })

  it('an update that matches no row says so (no rights, or gone)', async () => {
    await expect(
      createTaskService(client({ data: [], error: null })).update('T1', { title: 'x' })
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('task pages', () => {
  afterEach(() => document.body.replaceChildren())
  const course = { id: 'K', title: 'หลักสูตรทดสอบ', course_units: [] }
  const cohorts = [
    { id: 'C1', code: 'R1', name: 'รุ่น 1', program_name: 'โปรแกรม' },
    { id: 'C2', code: 'R2', name: 'รุ่น 2', program_name: 'โปรแกรม' },
  ]
  const rubrics = [
    {
      id: 'R',
      title: 'เกณฑ์ตรวจ',
      instrument_versions: [
        { id: 'RV1', version_no: 1, status: 'published' },
        { id: 'RV2', version_no: 2, status: 'draft' },
      ],
    },
  ]
  const task = (o = {}) => ({
    id: 'T1',
    course_id: 'K',
    title: XSS,
    instructions: 'แนบแผน',
    rubric_version_id: 'RV1',
    max_attempts: 3,
    status: 'draft',
    created_at: '2026-11-05T01:00:00Z',
    instrument_versions: { id: 'RV1', version_no: 1, instruments: { id: 'R', title: 'เกณฑ์ตรวจ' } },
    task_allocations: [],
    ...o,
  })
  const makeServices = (t = task()) => ({
    courses: { getAccess: async () => 'manage' },
    builder: { getCourseTree: async () => course },
    quizzes: { listForCourse: vi.fn(async () => rubrics) },
    assignments: { listCohortsForCourse: vi.fn(async () => cohorts) },
    deletion: {
      usage: vi.fn(async () => ({ can_delete: true, reasons: {} })),
      remove: vi.fn(async () => ({ deleted: true })),
    },
    tasks: {
      listForCourse: vi.fn(async () => [t]),
      get: vi.fn(async () => t),
      create: vi.fn(async () => ({ id: 'NEW' })),
      update: vi.fn(async (id, patch) => Object.assign(t, patch)),
      remove: vi.fn(async () => {}),
      addAllocation: vi.fn(async (_id, cohortId, dates) => {
        t.task_allocations.push({
          id: 'A' + cohortId,
          task_id: 'T1',
          cohort_id: cohortId,
          ...dates,
          cohorts: cohorts.find((c) => c.id === cohortId),
        })
      }),
      updateAllocation: vi.fn(async () => {}),
      removeAllocation: vi.fn(async () => {}),
    },
  })
  const ctx = (services) => ({
    services,
    caps: { canManagePrograms: true },
    context: { cohortMemberships: [] },
  })
  const open = async (services) => {
    const el = document.createElement('div')
    document.body.append(el)
    await renderTaskDetailView(el, ctx(services), { id: 'K', taskId: 'T1' })
    await settle() // the delete zone asks the database whether anyone has used the task
    return el
  }

  it('list: tasks escaped, with rubric and the number of cohorts; create goes to the detail page', async () => {
    const services = makeServices()
    const el = document.createElement('div')
    document.body.append(el)
    await renderCourseTasksView(el, ctx(services), { id: 'K' })
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-tasks] a').getAttribute('href')).toBe('#/courses/K/tasks/T1')
    expect(el.querySelector('[data-tasks]').textContent.replace(/\s+/g, ' ')).toContain(
      'เกณฑ์ตรวจ · ฉบับที่ 1 · เปิดให้ 0 รุ่น'
    )
    const options = [...el.querySelectorAll('select[name=rubric_version_id] option')].map((o) =>
      o.textContent.trim()
    )
    expect(options.some((o) => o === 'เกณฑ์ตรวจ · ฉบับที่ 1')).toBe(true)
    expect(options.some((o) => o.includes('ฉบับที่ 2'))).toBe(false) // a draft rubric version is not offered
    el.querySelector('input[name=title]').value = 'ภาระงานใหม่'
    el.querySelector('select[name=rubric_version_id]').value = 'RV1'
    el.querySelector('form[data-form=create-task]').requestSubmit()
    await settle()
    expect(services.tasks.create).toHaveBeenCalledWith(
      'K',
      expect.objectContaining({ title: 'ภาระงานใหม่', rubric_version_id: 'RV1', max_attempts: 3 })
    )
  })

  it('create: a bad value stays on the form with a Thai message and the typed text', async () => {
    const services = makeServices()
    const el = document.createElement('div')
    document.body.append(el)
    await renderCourseTasksView(el, ctx(services), { id: 'K' })
    el.querySelector('input[name=title]').value = 'พิมพ์ไว้'
    el.querySelector('input[name=max_attempts]').value = '99'
    const form = el.querySelector('form[data-form=create-task]')
    form.noValidate = true // the browser's own max=10 check would stop it first; this tests the page's check
    form.requestSubmit()
    await settle()
    expect(services.tasks.create).not.toHaveBeenCalled()
    expect(el.textContent).toContain('เลข 1–10')
    expect(el.querySelector('input[name=title]').value).toBe('พิมพ์ไว้')
  })

  it('draft: publish button, no cohort opening yet, delete offered; settings save', async () => {
    const services = makeServices()
    const el = await open(services)
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-allocations]').textContent).toContain('เผยแพร่ภาระงานก่อน')
    expect(el.querySelector('[data-action=delete-task]')).toBeNull() // replaced by the shared delete zone
    expect(
      el.querySelector('[data-delete-zone][data-kind=task][data-id=T1] [data-zone-action=open]')
    ).not.toBeNull()
    el.querySelector('input[name=max_attempts]').value = '2'
    el.querySelector('form[data-form=task]').requestSubmit()
    await settle()
    expect(services.tasks.update).toHaveBeenCalledWith(
      'T1',
      expect.objectContaining({ max_attempts: 2, rubric_version_id: 'RV1' })
    )
    expect(el.textContent).toContain('บันทึกการตั้งค่าแล้ว')
    el.querySelector('[data-action=set-status][data-status=published]').click()
    await settle()
    expect(services.tasks.update).toHaveBeenLastCalledWith('T1', { status: 'published' })
  })

  it('delete zone: typing the exact title deletes an unused task and goes back to the list', async () => {
    const services = makeServices()
    const el = await open(services)
    el.querySelector('[data-zone-action=open]').click()
    const typed = el.querySelector('input[name=confirm]')
    typed.value = 'ส่งแผนการสอน'
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    expect(el.querySelector('[data-zone-confirm]').disabled).toBe(true) // not the whole title
    const { title } = await services.tasks.get()
    typed.value = title
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    el.querySelector('[data-zone-form]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await settle()
    expect(services.deletion.remove).toHaveBeenCalledWith('task', 'T1', title)
    expect(window.location.hash).toBe('#/courses/K/tasks')
  })

  it('delete zone: a task somebody started shows why it cannot go, and offers archive', async () => {
    const t = task({ status: 'published' })
    const services = makeServices(t)
    services.deletion.usage.mockResolvedValue({ can_delete: false, reasons: { submissions: 2 } })
    const el = await open(services)
    const zone = el.querySelector('[data-delete-zone]')
    expect(zone.textContent).toContain('มีงานที่ผู้เรียนเริ่มหรือส่งแล้ว 2 รอบ')
    expect(zone.querySelector('[data-zone-action=open]')).toBeNull()
    zone.querySelector('[data-zone-action=archive]').click()
    await settle()
    expect(services.tasks.update).toHaveBeenLastCalledWith('T1', { status: 'archived' })
  })

  it('published: open to a cohort with dates (Bangkok time), change the dates, withdraw', async () => {
    const t = task({ status: 'published' })
    const services = makeServices(t)
    confirmDialog.mockResolvedValue(true)
    const el = await open(services)
    const form = el.querySelector('form[data-form=new-allocation]')
    expect(form.querySelectorAll('select[name=cohort_id] option')).toHaveLength(2)
    form.querySelector('select[name=cohort_id]').value = 'C1'
    form.querySelector('input[name=due_at]').value = '2026-12-15T23:59'
    form.requestSubmit()
    await settle()
    expect(services.tasks.addAllocation).toHaveBeenCalledWith('T1', 'C1', {
      available_at: null,
      due_at: '2026-12-15T23:59:00+07:00',
    })
    expect(el.textContent).toContain('เปิดภาระงานให้รุ่นแล้ว')
    expect(el.querySelectorAll('form[data-form=allocation]')).toHaveLength(1)
    expect(el.querySelectorAll('form[data-form=new-allocation] select[name=cohort_id] option')).toHaveLength(
      1
    ) // C2 left
    const row = el.querySelector('form[data-form=allocation]')
    row.querySelector('input[name=due_at_AC1]').value = '2026-12-31T12:00'
    row.requestSubmit()
    await settle()
    expect(services.tasks.updateAllocation).toHaveBeenCalledWith('AC1', {
      available_at: null,
      due_at: '2026-12-31T12:00:00+07:00',
    })
    el.querySelector('[data-action=remove-allocation]').click()
    await settle()
    expect(services.tasks.removeAllocation).toHaveBeenCalledWith('AC1')
    confirmDialog.mockReset()
  })

  it('a refusal from the server is shown in Thai (rubric frozen after submissions)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const services = makeServices()
    services.tasks.update = vi.fn(async () => {
      throw new AppError(toUserMessage({ code: 'SE006' }), { code: 'SE006' })
    })
    const el = await open(services)
    el.querySelector('form[data-form=task]').requestSubmit()
    await settle()
    expect(el.textContent).toContain('มีผู้ส่งงานแล้ว จึงเปลี่ยน Rubric')
  })

  it('another course, or no right to manage, shows no task', async () => {
    const other = makeServices(task({ course_id: 'OTHER' }))
    expect((await open(other)).textContent).toContain('ไม่มีสิทธิ์')
    const noRights = makeServices()
    noRights.courses.getAccess = async () => 'view'
    expect((await open(noRights)).textContent).toContain('ไม่มีสิทธิ์')
  })
})

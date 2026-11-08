/**
 * Phase 4a step 5: the delete / archive zone on the course, quiz, rubric and
 * task pages, archived badges in the lists, and the rubric picker.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderCourseBuilderView } from '../../src/features/builder/views.js'
import { renderQuizEditorView, renderCourseQuizzesView } from '../../src/features/quizzes/views.js'
import { renderRubricEditorView, renderCourseRubricsView } from '../../src/features/rubrics/views.js'
import { createQuizBuilderService } from '../../src/features/quizzes/service.js'
import { rubricOptions } from '../../src/features/tasks/logic.js'

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0))
}
const mount = () => {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}
const deletion = (usage = { can_delete: true, reasons: {} }) => ({
  usage: vi.fn(async () => usage),
  remove: vi.fn(async () => ({ deleted: true })),
})
const type = (el, text) => {
  const input = el.querySelector('input[name=confirm]')
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const submitZone = async (el) => {
  el.querySelector('[data-zone-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}

describe('delete zone on the pages', () => {
  afterEach(() => {
    document.body.replaceChildren()
    window.location.hash = ''
  })

  it('course page: unused → typing the course code deletes it and goes to the course list', async () => {
    const course = {
      id: 'K',
      code: 'AFL-101',
      title: 'หลักสูตร',
      status: 'draft',
      owner_org_id: 'O',
      course_units: [],
    }
    const services = {
      courses: { getAccess: async () => 'manage' },
      builder: { getCourseTree: vi.fn(async () => course), updateCourse: vi.fn(async () => {}) },
      deletion: deletion(),
    }
    const el = mount()
    await renderCourseBuilderView(el, { services }, { id: 'K' })
    await settle()
    expect(services.deletion.usage).toHaveBeenCalledWith('course', 'K')
    el.querySelector('[data-zone-action=open]').click()
    type(el, 'afl-101')
    expect(el.querySelector('[data-zone-confirm]').disabled).toBe(true)
    type(el, 'AFL-101')
    await submitZone(el)
    expect(services.deletion.remove).toHaveBeenCalledWith('course', 'K', 'AFL-101')
    expect(window.location.hash).toBe('#/courses')
  })

  it('course page: used → reasons, and "เก็บถาวรหลักสูตร" sets the status; an archived course is not offered it again', async () => {
    const course = {
      id: 'K',
      code: 'AFL-101',
      title: 'หลักสูตร',
      status: 'published',
      owner_org_id: 'O',
      course_units: [],
    }
    const services = {
      courses: { getAccess: async () => 'manage' },
      builder: {
        getCourseTree: vi.fn(async () => course),
        updateCourse: vi.fn(async (_id, patch) => Object.assign(course, patch)),
      },
      deletion: deletion({ can_delete: false, reasons: { enrollments: 3 } }),
    }
    const el = mount()
    await renderCourseBuilderView(el, { services }, { id: 'K' })
    await settle()
    expect(el.querySelector('[data-reasons]').textContent).toContain('มีผู้ลงทะเบียนเรียน 3 คน')
    el.querySelector('[data-zone-action=archive]').click()
    await settle()
    expect(services.builder.updateCourse).toHaveBeenCalledWith('K', { status: 'archived' })
    await settle()
    expect(el.querySelector('[data-zone-action=archive]')).toBeNull() // redrawn: already archived
    expect(el.querySelector('[data-reasons]')).not.toBeNull()
  })

  const quizServices = (state) => ({
    courses: { getAccess: async () => 'manage' },
    builder: {
      getCourseTree: async () => ({ id: 'K', title: 'หลักสูตร', owner_org_id: 'O', course_units: [] }),
    },
    quizzes: {
      getInstrument: vi.fn(async () => ({
        id: 'I1',
        course_id: 'K',
        code: state.code,
        title: 'ชื่อ',
        status: state.status,
        instrument_type: state.kind,
        instrument_versions: [{ id: 'V1', version_no: 1, status: 'draft' }],
      })),
      getItems: async () => [],
      keyStatus: async () => ({}),
      setInstrumentStatus: vi.fn(async (_id, status) => {
        state.status = status
      }),
    },
    assessmentMedia: { signedUrls: async () => ({}) },
    assignments: { listForVersions: async () => [] },
    deletion: deletion(state.usage),
  })

  it('quiz page: delete with the typed code, back to the quiz list', async () => {
    const state = { code: 'AFL-POST', status: 'active', kind: 'quiz' }
    const services = quizServices(state)
    const el = mount()
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    await settle()
    expect(services.deletion.usage).toHaveBeenCalledWith('instrument', 'I1')
    expect(el.querySelector('[data-delete-zone]').textContent).toContain('ลบแบบทดสอบ')
    el.querySelector('[data-zone-action=open]').click()
    type(el, 'AFL-POST')
    await submitZone(el)
    expect(services.deletion.remove).toHaveBeenCalledWith('instrument', 'I1', 'AFL-POST')
    expect(window.location.hash).toBe('#/courses/K/quizzes')
  })

  it('quiz page: a used quiz is archived (hidden) and can be brought back', async () => {
    const state = {
      code: 'Q',
      status: 'active',
      kind: 'quiz',
      usage: { can_delete: false, reasons: { attempts: 12 } },
    }
    const services = quizServices(state)
    const el = mount()
    await renderQuizEditorView(el, { services }, { id: 'K', quizId: 'I1' })
    await settle()
    expect(el.querySelector('[data-reasons]').textContent).toContain('มีผู้ทำแบบทดสอบแล้ว 12 ครั้ง')
    expect(el.querySelector('[data-archived]')).toBeNull()
    el.querySelector('[data-zone-action=archive]').click()
    await settle()
    expect(services.quizzes.setInstrumentStatus).toHaveBeenLastCalledWith('I1', 'archived')
    expect(el.querySelector('[data-archived]').textContent).toContain('เก็บถาวรแล้ว')
    expect(el.querySelector('[data-zone-action=archive]')).toBeNull()
    el.querySelector('[data-archived] [data-action=unarchive]').click()
    await settle()
    expect(services.quizzes.setInstrumentStatus).toHaveBeenLastCalledWith('I1', 'active')
    expect(el.querySelector('[data-archived]')).toBeNull()
  })

  it('rubric page: wording says Rubric, deletes with the typed code, goes back to the rubric list', async () => {
    const state = { code: 'RUB-PLAN', status: 'active', kind: 'rubric' }
    const services = quizServices(state)
    const el = mount()
    await renderRubricEditorView(el, { services }, { id: 'K', rubricId: 'I1' })
    await settle()
    const zone = el.querySelector('[data-delete-zone]')
    expect(zone.textContent).toContain('ลบRubric')
    expect(zone.textContent).not.toContain('แบบทดสอบ')
    zone.querySelector('[data-zone-action=open]').click()
    expect(zone.textContent).toContain('ทุกฉบับและทุกเกณฑ์ของ Rubric นี้')
    type(el, 'RUB-PLAN')
    await submitZone(el)
    expect(services.deletion.remove).toHaveBeenCalledWith('instrument', 'I1', 'RUB-PLAN')
    expect(window.location.hash).toBe('#/courses/K/rubrics')
  })

  it('rubric page: a rubric chosen by a task is archived; the page says so and can restore it', async () => {
    const state = {
      code: 'R',
      status: 'active',
      kind: 'rubric',
      usage: { can_delete: false, reasons: { rubric_tasks: 1 } },
    }
    const services = quizServices(state)
    const el = mount()
    await renderRubricEditorView(el, { services }, { id: 'K', rubricId: 'I1' })
    await settle()
    expect(el.querySelector('[data-reasons]').textContent).toContain('มีภาระงาน 1 รายการใช้ Rubric นี้')
    el.querySelector('[data-zone-action=archive]').click()
    await settle()
    expect(services.quizzes.setInstrumentStatus).toHaveBeenLastCalledWith('I1', 'archived')
    expect(el.querySelector('[data-archived]').textContent).toContain('ไม่ถูกเสนอเมื่อสร้างภาระงานใหม่')
    el.querySelector('[data-archived] [data-action=unarchive]').click()
    await settle()
    expect(services.quizzes.setInstrumentStatus).toHaveBeenLastCalledWith('I1', 'active')
  })

  it('lists: archived quizzes and rubrics are marked and sorted after the active ones', async () => {
    const rows = [
      { id: 'A', code: 'OLD', title: 'เก่า', status: 'archived', instrument_versions: [] },
      { id: 'B', code: 'NEW', title: 'ใหม่', status: 'active', instrument_versions: [] },
    ]
    const services = {
      courses: { getAccess: async () => 'manage' },
      builder: { getCourseTree: async () => ({ id: 'K', title: 'ห', owner_org_id: 'O', course_units: [] }) },
      quizzes: { listForCourse: vi.fn(async () => rows) },
    }
    for (const [render, selector] of [
      [renderCourseQuizzesView, 'ul li'],
      [renderCourseRubricsView, '[data-rubrics] li'],
    ]) {
      const el = mount()
      await render(el, { services }, { id: 'K' })
      const items = [...el.querySelectorAll(selector)].filter((li) =>
        li.querySelector('a[href*="/courses/K/"]')
      )
      expect(items.map((li) => li.querySelector('span.text-xs').textContent)).toEqual(['NEW', 'OLD'])
      expect(items[1].querySelector('[data-archived-badge]').textContent).toBe('เก็บถาวร')
      expect(items[0].querySelector('[data-archived-badge]')).toBeNull()
    }
  })
})

describe('rubric picker and service', () => {
  const v = (id, status = 'published', no = 1) => ({ id, status, version_no: no })
  it('archived rubrics are not offered for new tasks; the one a task already uses stays visible, marked', () => {
    const rubrics = [
      {
        id: 'R1',
        title: 'ใช้อยู่',
        status: 'active',
        instrument_versions: [v('V1'), v('V2', 'published', 2)],
      },
      {
        id: 'R2',
        title: 'เก็บแล้ว',
        status: 'archived',
        instrument_versions: [v('V3'), v('V4', 'published', 2)],
      },
    ]
    expect(rubricOptions(rubrics).map((o) => o.id)).toEqual(['V2', 'V1'])
    expect(rubricOptions(rubrics, 'V3')).toEqual([
      { id: 'V2', label: 'ใช้อยู่ · ฉบับที่ 2' },
      { id: 'V1', label: 'ใช้อยู่ · ฉบับที่ 1' },
      { id: 'V3', label: 'เก็บแล้ว · ฉบับที่ 1 (เก็บถาวร)' },
    ])
  })

  it('setInstrumentStatus only takes active / archived and updates one row', async () => {
    const calls = []
    const q = {
      update: (patch) => (calls.push(['update', patch]), q),
      eq: (k, val) => (calls.push(['eq', k, val]), q),
      select: () => q,
      single: async () => ({ data: { id: 'I1', status: 'archived' }, error: null }),
    }
    const service = createQuizBuilderService({ from: () => q })
    await expect(service.setInstrumentStatus('I1', 'gone')).rejects.toThrow('สถานะไม่ถูกต้อง')
    expect(await service.setInstrumentStatus('I1', 'archived')).toEqual({ id: 'I1', status: 'archived' })
    expect(calls).toEqual([
      ['update', { status: 'archived' }],
      ['eq', 'id', 'I1'],
    ])
  })
})

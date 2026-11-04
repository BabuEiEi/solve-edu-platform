import { describe, it, expect, vi } from 'vitest'
import {
  toBangkokInput,
  fromBangkokInput,
  bangkokInputLabel,
  buildAssignmentPayload,
  canAssessHint,
  traineeOnlyCohorts,
  summarizeResults,
  resultsCsvRows,
} from '../../src/features/assignments/logic.js'
import { createAssignmentService } from '../../src/features/assignments/service.js'
import {
  renderStaffAssessmentsView,
  renderNewAssignmentView,
  renderAssignmentDetailView,
} from '../../src/features/assignments/views.js'
import { toCsv, parseCsv } from '../../src/shared/utils/csv.js'
import { AppError, toUserMessage } from '../../src/core/errors.js'

const XSS = '<img src=x onerror=alert(1)>'
const flush = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush()
}

const attempt = (over) => ({
  id: 't',
  user_id: 'u1',
  attempt_no: 1,
  status: 'submitted',
  started_at: '2026-11-20T01:00:00Z',
  submitted_at: '2026-11-20T01:30:00Z',
  score: 3,
  max_score: 5,
  passed: true,
  ...over,
})

describe('assignment logic', () => {
  it('datetime-local values are Bangkok time, independent of the device zone', () => {
    expect(fromBangkokInput('2026-11-20T08:30', 'x')).toBe('2026-11-20T08:30:00+07:00')
    expect(toBangkokInput('2026-11-20T01:30:00Z')).toBe('2026-11-20T08:30')
    expect(toBangkokInput(fromBangkokInput('2027-01-01T00:05', 'x'))).toBe('2027-01-01T00:05')
    expect(toBangkokInput('2026-11-20T08:30')).toBe('2026-11-20T08:30') // raw input is re-shown as typed
    expect(toBangkokInput(null)).toBe('')
    expect(fromBangkokInput('', 'x')).toBeNull()
    expect(() => fromBangkokInput('20/11/2569', 'เวลาเปิด')).toThrow(/เวลาเปิด/)
  })

  it('date inputs are echoed in พ.ศ. (the native picker shows ค.ศ.)', () => {
    expect(bangkokInputLabel('2027-03-31T16:00')).toBe('31 มี.ค. 2570 16:00 น.')
    expect(bangkokInputLabel('')).toBe('')
    expect(bangkokInputLabel('31/03/2027')).toBe('')
  })

  it('payload: validates title, limit, pass mark and window', () => {
    const base = { title: ' หลังเรียน ', purpose: 'posttest', attempt_limit: '2', passing_percent: '' }
    expect(buildAssignmentPayload(base)).toEqual({
      title: 'หลังเรียน',
      instructions: null,
      open_at: null,
      close_at: null,
      attempt_limit: 2,
      purpose: 'posttest',
      passing_percent: null,
    })
    expect(buildAssignmentPayload({ ...base, passing_percent: '60.5' }).passing_percent).toBe(60.5)
    expect(() => buildAssignmentPayload({ ...base, title: ' ' })).toThrow(AppError)
    expect(() => buildAssignmentPayload({ ...base, attempt_limit: '0' })).toThrow(/1–20/)
    expect(() => buildAssignmentPayload({ ...base, attempt_limit: '1.5' })).toThrow(/1–20/)
    expect(() => buildAssignmentPayload({ ...base, passing_percent: '101' })).toThrow(/0–100/)
    expect(() => buildAssignmentPayload({ ...base, purpose: 'final' })).toThrow(/ประเภท/)
    expect(() =>
      buildAssignmentPayload({ ...base, open_at: '2026-11-20T09:00', close_at: '2026-11-20T09:00' })
    ).toThrow(/หลังเวลาเปิด/)
  })

  it('locked payload leaves out the settings the server freezes', () => {
    const p = buildAssignmentPayload(
      { title: 'x', attempt_limit: '3', close_at: '2026-12-01T16:00' },
      { locked: true }
    )
    expect(p).toEqual({
      title: 'x',
      instructions: null,
      open_at: null,
      close_at: '2026-12-01T16:00:00+07:00',
      attempt_limit: 3,
    })
    expect(p).not.toHaveProperty('passing_percent')
    expect(p).not.toHaveProperty('purpose')
  })

  it('assessor hint mirrors authz.is_cohort_assessor; trainee-only cohorts are hidden from staff lists', () => {
    const context = {
      cohortMemberships: [
        { cohort_id: 'C1', cohort_role: 'trainer' },
        { cohort_id: 'C2', cohort_role: 'trainee' },
        { cohort_id: 'C3', cohort_role: 'mentor' },
        { cohort_id: 'C3', cohort_role: 'trainee' },
      ],
    }
    expect(canAssessHint({}, context, 'C1')).toBe(true)
    expect(canAssessHint({}, context, 'C3')).toBe(false)
    expect(canAssessHint({ canManagePrograms: true }, context, 'C9')).toBe(true)
    expect([...traineeOnlyCohorts(context)]).toEqual(['C2'])
  })

  it('summary: best attempt per person, not-started people counted, off-roster attempts kept', () => {
    const roster = [
      { user_id: 'u1', name: 'ข' },
      { user_id: 'u2', name: 'ก' },
      { user_id: 'u3', name: 'ค' },
    ]
    const attempts = [
      attempt({ id: 'a1', score: 2, passed: false }),
      attempt({ id: 'a2', attempt_no: 2, score: 4, submitted_at: '2026-11-21T01:00:00Z' }),
      attempt({
        id: 'b1',
        user_id: 'u2',
        status: 'in_progress',
        submitted_at: null,
        score: null,
        passed: null,
      }),
      attempt({ id: 'x1', user_id: 'gone', score: 5, profiles: { full_name: 'ออกจากรุ่นแล้ว' } }),
    ]
    const { rows, summary } = summarizeResults(roster, attempts, { passing_percent: 60 })
    const u1 = rows.find((r) => r.user_id === 'u1')
    expect(u1).toMatchObject({ used: 2, status: 'submitted', lastSubmittedAt: '2026-11-21T01:00:00Z' })
    expect(u1.first.id).toBe('a1')
    expect(u1.best.id).toBe('a2')
    expect(rows.find((r) => r.user_id === 'u2')).toMatchObject({ status: 'in_progress', best: null })
    expect(rows.find((r) => r.user_id === 'u3')).toMatchObject({ status: 'not_started', used: 0 })
    expect(rows.find((r) => r.user_id === 'gone')).toMatchObject({ offRoster: true, name: 'ออกจากรุ่นแล้ว' })
    expect(rows.map((r) => r.name)).toEqual(['ก', 'ข', 'ค', 'ออกจากรุ่นแล้ว'])
    expect(summary).toEqual({ total: 4, started: 3, submitted: 2, average: 90, passed: 2 })
    expect(summarizeResults(roster, [], { passing_percent: null }).summary).toMatchObject({
      average: null,
      passed: null,
    })
  })

  it('CSV: header + one row per person; formula-like names are neutralised', () => {
    const { rows } = summarizeResults([{ user_id: 'u1', name: '=HYPERLINK("x")' }], [attempt()], {
      passing_percent: 50,
    })
    const text = toCsv(resultsCsvRows(rows))
    expect(text.startsWith('﻿')).toBe(true)
    const parsed = parseCsv(text)
    expect(parsed[0][0]).toBe('ชื่อ')
    expect(parsed[1]).toEqual([
      `'=HYPERLINK("x")`,
      'ส่งแล้ว',
      '1',
      '60',
      '60',
      '3',
      '5',
      'ผ่าน',
      '2026-11-20T01:30:00Z',
    ])
    expect(toCsv([['-1', -1, '@x', 'a,b']])).toBe('﻿\'-1,-1,\'@x,"a,b"\r\n')
  })

  it('SE004 has a Thai message', () => {
    expect(toUserMessage({ code: 'SE004', message: 'x' })).toMatch(/มีผู้เริ่มทำแล้ว/)
  })
})

describe('assignment service', () => {
  function fakeClient(results) {
    const calls = []
    const client = {
      calls,
      from(table) {
        const q = { table, ops: [] }
        calls.push(q)
        const chain = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === 'then') {
                const r = typeof results === 'function' ? results(q) : results
                return (resolve) => resolve(r)
              }
              return (...args) => {
                q.ops.push([prop, ...args])
                return chain
              }
            },
          }
        )
        return chain
      },
    }
    return client
  }

  it('create sends no score/timestamp columns; version, cohort and course come from the caller', async () => {
    const c = fakeClient({ data: { id: 'A1' }, error: null })
    await createAssignmentService(c).create({
      versionId: 'V',
      cohortId: 'C',
      courseId: 'K',
      status: 'published',
      title: 't',
      attempt_limit: 1,
    })
    const insert = c.calls[0].ops.find(([op]) => op === 'insert')[1]
    expect(insert).toEqual({
      title: 't',
      attempt_limit: 1,
      instrument_version_id: 'V',
      cohort_id: 'C',
      course_id: 'K',
      status: 'published',
    })
  })

  it('update that RLS filters to zero rows is an error, not a silent success', async () => {
    const c = fakeClient({ data: [], error: null })
    await expect(createAssignmentService(c).update('A1', { title: 'x' })).rejects.toThrow(/ไม่มีสิทธิ์/)
  })

  it('roster = cohort trainees ∪ own mentees, de-duplicated; attempts select no per-item data', async () => {
    const c = fakeClient((q) =>
      q.table === 'cohort_memberships'
        ? { data: [{ user_id: 'u1', profiles: { full_name: 'หนึ่ง' } }], error: null }
        : q.table === 'mentor_assignments'
          ? {
              data: [
                { trainee_id: 'u1', profiles: { full_name: 'หนึ่ง' } },
                { trainee_id: 'u2', profiles: { display_name: 'สอง' } },
              ],
              error: null,
            }
          : { data: [], error: null }
    )
    const svc = createAssignmentService(c)
    expect(await svc.listRoster('C', 'me')).toEqual([
      { user_id: 'u1', name: 'หนึ่ง' },
      { user_id: 'u2', name: 'สอง' },
    ])
    expect(c.calls[1].ops).toContainEqual(['eq', 'mentor_id', 'me'])
    await svc.listAttempts('A1')
    const select = c.calls.at(-1).ops.find(([op]) => op === 'select')[1]
    expect(select).not.toMatch(/awarded_score|response|answer/)
  })
})

describe('assignment views', () => {
  const assignment = {
    id: 'A1-0000-0000',
    title: XSS,
    purpose: 'posttest',
    status: 'published',
    cohort_id: 'C1',
    course_id: 'K',
    attempt_limit: 2,
    passing_percent: 60,
    open_at: null,
    close_at: null,
    instructions: null,
    cohorts: { id: 'C1', code: 'C1', name: 'รุ่น 1' },
    courses: { id: 'K', title: 'AfL' },
    instrument_versions: {
      id: 'V1',
      version_no: 1,
      instruments: { id: 'I1', title: 'Quiz', course_id: 'K' },
    },
  }
  const trainer = { cohortMemberships: [{ cohort_id: 'C1', cohort_role: 'trainer' }] }
  const mentor = { cohortMemberships: [{ cohort_id: 'C1', cohort_role: 'mentor' }] }
  const makeServices = (overrides = {}) => ({
    assignments: {
      get: vi.fn(async () => assignment),
      listAttempts: vi.fn(async () => [attempt({ user_id: 'u1' })]),
      listRoster: vi.fn(async () => [
        { user_id: 'u1', name: XSS },
        { user_id: 'u2', name: 'ครู ข' },
      ]),
      update: vi.fn(async () => ({ id: 'A1' })),
      listVisible: vi.fn(async () => [assignment, { ...assignment, id: 'A2', cohort_id: 'C2' }]),
      getVersion: vi.fn(async () => ({
        id: 'V1',
        version_no: 1,
        status: 'published',
        instruments: assignment.instrument_versions.instruments,
      })),
      listCohortsForCourse: vi.fn(async () => [
        { id: 'C1', code: 'C1', name: 'รุ่น 1', program_name: 'P' },
        { id: 'C2', code: 'C2', name: 'รุ่นที่เรียน', program_name: 'P' },
      ]),
      create: vi.fn(async () => ({ id: 'NEW' })),
      ...overrides,
    },
  })
  const ctx = (services, context) => ({ services, context, caps: {}, session: { user: { id: 'me' } } })

  it('detail (trainer): summary, escaped names, settings locked once attempts exist', async () => {
    const el = document.createElement('div')
    const services = makeServices()
    await renderAssignmentDetailView(el, ctx(services, trainer), { id: 'A1' })
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-summary]').textContent).toContain('1 / 2')
    expect(el.querySelectorAll('[data-results] tbody tr')).toHaveLength(2)
    expect(el.textContent).toContain('ยังไม่เริ่ม')
    expect(el.querySelector('[data-date-label=close_at]').textContent).toBe('')
    const close = el.querySelector('input[name=close_at]')
    close.value = '2027-01-15T09:30'
    close.dispatchEvent(new Event('input', { bubbles: true }))
    expect(el.querySelector('[data-date-label=close_at]').textContent).toBe('15 ม.ค. 2570 09:30 น.')
    expect(el.querySelector('select[name=purpose]').disabled).toBe(true)
    expect(el.querySelector('input[name=passing_percent]').disabled).toBe(true)
    expect(el.querySelector('[data-action=delete]')).toBeNull()

    el.querySelector('input[name=attempt_limit]').value = '3'
    el.querySelector('form[data-form=assignment]').requestSubmit()
    await settle()
    const [, patch] = services.assignments.update.mock.calls[0]
    expect(patch.attempt_limit).toBe(3)
    expect(patch).not.toHaveProperty('passing_percent')
    expect(el.textContent).toContain('บันทึกการตั้งค่าแล้ว')
  })

  it('detail (mentor): results only, no settings form', async () => {
    const el = document.createElement('div')
    await renderAssignmentDetailView(el, ctx(makeServices(), mentor), { id: 'A1' })
    expect(el.querySelector('form[data-form=assignment]')).toBeNull()
    expect(el.textContent).toContain('แสดงเฉพาะผู้เรียนที่ท่านมีสิทธิ์ดูผล')
  })

  it('detail: SE004 from the server is shown in Thai', async () => {
    const el = document.createElement('div')
    const services = makeServices({
      listAttempts: vi.fn(async () => []),
      update: vi.fn(async () => {
        throw Object.assign(new Error('x'), { code: 'SE004' })
      }),
    })
    await renderAssignmentDetailView(el, ctx(services, trainer), { id: 'A1' })
    el.querySelector('form[data-form=assignment]').requestSubmit()
    await settle()
    expect(el.textContent).toContain('มีผู้เริ่มทำแล้ว')
  })

  it('staff list hides cohorts where the caller is only a trainee', async () => {
    const el = document.createElement('div')
    const context = {
      cohortMemberships: [...trainer.cohortMemberships, { cohort_id: 'C2', cohort_role: 'trainee' }],
    }
    await renderStaffAssessmentsView(el, ctx(makeServices(), context))
    expect([...el.querySelectorAll('[data-assignment-id]')].map((a) => a.dataset.assignmentId)).toEqual([
      'A1-0000-0000',
    ])
    expect(el.querySelector('img')).toBeNull()
  })

  it('new: offers only cohorts the caller assesses; publish button sends status published', async () => {
    const el = document.createElement('div')
    const services = makeServices()
    await renderNewAssignmentView(el, ctx(services, trainer), { versionId: 'V1' })
    expect([...el.querySelectorAll('select[name=cohort_id] option')].map((o) => o.value)).toEqual(['C1'])
    el.querySelector('input[name=passing_percent]').value = '70'
    const form = el.querySelector('form[data-form=assignment]')
    form.requestSubmit(form.querySelector('button[value=published]'))
    await settle()
    expect(services.assignments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'V1',
        cohortId: 'C1',
        courseId: 'K',
        status: 'published',
        passing_percent: 70,
        purpose: 'pretest',
      })
    )
  })

  it('new: a draft version cannot be assigned', async () => {
    const el = document.createElement('div')
    const services = makeServices({
      getVersion: vi.fn(async () => ({ id: 'V2', status: 'draft', instruments: {} })),
    })
    await renderNewAssignmentView(el, ctx(services, trainer), { versionId: 'V2' })
    expect(el.textContent).toContain('มอบหมายได้เฉพาะฉบับที่เผยแพร่แล้ว')
    expect(el.querySelector('form')).toBeNull()
  })
})

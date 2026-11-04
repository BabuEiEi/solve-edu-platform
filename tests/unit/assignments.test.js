import { describe, it, expect, vi } from 'vitest'
import {
  toBangkokInput,
  fromBangkokInput,
  bangkokInputLabel,
  buildAssignmentPayload,
  canAssessHint,
  traineeOnlyCohorts,
  summarizeResults,
  difficultyLabel,
  discriminationLabel,
  reliabilityLabel,
  choicesText,
  partName,
  percentText,
  partLines,
  itemStatsCsvRows,
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

// A row of assignment_results (one per person)
const person = (over) => ({
  user_id: 'u1',
  name: 'ครู ก',
  on_roster: true,
  used: 1,
  extra: 0,
  in_progress: false,
  submitted: 1,
  auto_submitted: 0,
  first_score: 3,
  first_max: 5,
  best_score: 3,
  best_max: 5,
  best_passed: true,
  last_submitted_at: '2026-11-20T01:30:00Z',
  ...over,
})
const nobody = {
  used: 0,
  submitted: 0,
  first_score: null,
  first_max: null,
  best_score: null,
  best_max: null,
  best_passed: null,
  last_submitted_at: null,
}

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
    const base = {
      title: ' หลังเรียน ',
      purpose: 'posttest',
      attempt_limit: '2',
      passing_percent: '',
      close_at: '2027-03-31T16:00',
    }
    expect(buildAssignmentPayload(base)).toEqual({
      title: 'หลังเรียน',
      instructions: null,
      open_at: null,
      close_at: '2027-03-31T16:00:00+07:00',
      attempt_limit: 2,
      grace_minutes: 5,
      shuffle_items: false,
      shuffle_choices: false,
      purpose: 'posttest',
      passing_percent: null,
      time_limit_minutes: null,
    })
    expect(buildAssignmentPayload({ ...base, time_limit_minutes: '30', grace_minutes: '0' })).toMatchObject({
      time_limit_minutes: 30,
      grace_minutes: 0,
    })
    expect(() => buildAssignmentPayload({ ...base, time_limit_minutes: '0' })).toThrow(/1–600/)
    expect(() => buildAssignmentPayload({ ...base, time_limit_minutes: '15.5' })).toThrow(/1–600/)
    expect(() => buildAssignmentPayload({ ...base, grace_minutes: '61' })).toThrow(/0–60/)
    expect(buildAssignmentPayload({ ...base, passing_percent: '60.5' }).passing_percent).toBe(60.5)
    expect(buildAssignmentPayload({ ...base, shuffle_choices: 'on' })).toMatchObject({
      shuffle_items: false,
      shuffle_choices: true,
    }) // checkboxes
    expect(() => buildAssignmentPayload({ ...base, title: ' ' })).toThrow(AppError)
    expect(() => buildAssignmentPayload({ ...base, close_at: '' })).toThrow(/วันเวลาปิดรับ/) // every assignment closes
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
      grace_minutes: 5,
      shuffle_items: false,
      shuffle_choices: false,
    })
    expect(p).not.toHaveProperty('passing_percent')
    expect(p).not.toHaveProperty('time_limit_minutes')
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

  it('summary from server rows: best attempt per person, not started counted, off-roster kept', () => {
    const results = [
      person({
        user_id: 'u1',
        name: 'ข',
        used: 2,
        submitted: 2,
        first_score: 2,
        best_score: 4,
        last_submitted_at: '2026-11-21T01:00:00Z',
      }),
      person({ user_id: 'u2', name: 'ก', ...nobody, used: 1, in_progress: true }),
      person({ user_id: 'u3', name: 'ค', ...nobody }),
      person({ user_id: 'gone', name: 'ออกจากรุ่นแล้ว', on_roster: false, first_score: 5, best_score: 5 }),
    ]
    const { rows, summary } = summarizeResults(results, { passing_percent: 60, attempt_limit: 2 })
    const u1 = rows.find((r) => r.user_id === 'u1')
    expect(u1).toMatchObject({
      used: 2,
      limit: 2,
      status: 'submitted',
      lastSubmittedAt: '2026-11-21T01:00:00Z',
    })
    expect(u1.first).toEqual({ score: 2, max_score: 5 })
    expect(u1.best).toEqual({ score: 4, max_score: 5, passed: true })
    expect(rows.find((r) => r.user_id === 'u2')).toMatchObject({
      status: 'in_progress',
      inProgress: true,
      best: null,
    })
    expect(rows.find((r) => r.user_id === 'u3')).toMatchObject({ status: 'not_started', used: 0 })
    expect(rows.find((r) => r.user_id === 'gone')).toMatchObject({ offRoster: true })
    expect(rows.map((r) => r.name)).toEqual(['ก', 'ข', 'ค', 'ออกจากรุ่นแล้ว'])
    expect(summary).toEqual({ total: 4, started: 3, submitted: 2, average: 90, passed: 2 })
    expect(summarizeResults([person({ ...nobody })], { passing_percent: null }).summary).toMatchObject({
      average: null,
      passed: null,
    })
  })

  it("extra attempts raise the person's limit; auto-submitted attempts are counted", () => {
    const { rows } = summarizeResults([person({ used: 2, submitted: 2, extra: 1, auto_submitted: 1 })], {
      attempt_limit: 1,
    })
    expect(rows[0]).toMatchObject({ used: 2, extra: 1, limit: 2, autoSubmitted: 1 })
  })

  it('item analysis labels follow the usual guides (p .20–.80, D ≥ .20, reliability ≥ .70)', () => {
    expect([0.1, 0.5, 0.9].map(difficultyLabel)).toEqual(['ยากมาก', 'พอเหมาะ', 'ง่ายมาก'])
    expect([-0.1, 0.1, 0.3, 0.5].map(discriminationLabel)).toEqual([
      'ติดลบ — ตรวจโจทย์/เฉลย',
      'ต่ำ — ควรปรับปรุง',
      'พอใช้',
      'ดี',
    ])
    expect([0.95, 0.75, 0.559, 0.3, null].map(reliabilityLabel)).toEqual([
      'สูงมาก',
      'ยอมรับได้',
      'ค่อนข้างต่ำ',
      'ต่ำ',
      'คำนวณไม่ได้',
    ])
    expect(choicesText({ b: 4, a: 1 })).toBe('a 1 · b 4')
    expect(choicesText({ true: 3, false: 2 })).toBe('ผิด 2 · ถูก 3')
    const rows = itemStatsCsvRows({
      items: [
        {
          item_type: 'mcq_single',
          prompt: '=cmd',
          max_score: 1,
          p: 0.667,
          d: 0.5,
          r_it: 0.403,
          choices: { b: 4 },
          blank: 1,
        },
      ],
    })
    expect(rows[1]).toEqual([1, 'mcq_single', '=cmd', 1, 0.667, 0.5, 0.403, 'b 4', 1, ''])
    expect(parseCsv(toCsv(rows))[1][2]).toBe("'=cmd") // formula-like prompt neutralised
  })

  it('item analysis per part: names as the trainee met them, rates only', () => {
    expect(partName('cloze', { no: 2, label: null })).toBe('ช่องที่ 2')
    expect(partName('ordering', { no: 1 })).toBe('ลำดับที่ 1')
    expect(partName('image_labelling', { no: 3, label: '' })).toBe('จุดที่ 3')
    expect(partName('matching', { no: 1, label: '  ตั้งเป้าหมาย ' })).toBe('รายการที่ 1 (ตั้งเป้าหมาย)')
    expect(partName('choice_matrix', { no: 2, label: 'ก'.repeat(40) })).toBe(`แถวที่ 2 (${'ก'.repeat(29)}…)`)
    expect([0.6, 0, 1, 0.333, null].map(percentText)).toEqual(['60%', '0%', '100%', '33%', '—'])
    const item = {
      item_type: 'dropdown',
      prompt: '=x',
      max_score: 2,
      p: 0.5,
      d: 0.2,
      r_it: null,
      choices: {},
      blank: 1,
      slots: [
        { slot_id: 'b1', no: 1, label: null, correct_rate: 0.6, answered: 4 },
        { slot_id: 'b2', no: 2, label: null, correct_rate: 0.4, answered: 4 },
      ],
    }
    expect(partLines(item)).toEqual(['ช่องที่ 1 ถูก 60% (ตอบ 4)', 'ช่องที่ 2 ถูก 40% (ตอบ 4)'])
    expect(partLines({ item_type: 'mcq_single' })).toEqual([])
    expect(itemStatsCsvRows({ items: [item] })[1].at(-1)).toBe(
      'ช่องที่ 1 ถูก 60% (ตอบ 4) · ช่องที่ 2 ถูก 40% (ตอบ 4)'
    )
  })

  it('CSV: header + one row per person; formula-like names are neutralised', () => {
    const { rows } = summarizeResults([person({ name: '=HYPERLINK("x")' })], { passing_percent: 50 })
    const text = toCsv(resultsCsvRows(rows))
    expect(text.startsWith('﻿')).toBe(true)
    const parsed = parseCsv(text)
    expect(parsed[0][0]).toBe('ชื่อ')
    expect(parsed[1]).toEqual([
      `'=HYPERLINK("x")`,
      'ส่งแล้ว',
      '1',
      '0',
      '0',
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

  it('results and item analysis are RPCs; attempts select no per-item data', async () => {
    const c = fakeClient({ data: [], error: null })
    c.rpc = vi.fn(async () => ({ data: [], error: null }))
    const svc = createAssignmentService(c)
    await svc.results('A1')
    await svc.itemStatistics('A1')
    expect(c.rpc.mock.calls).toEqual([
      ['assignment_results', { p_assignment: 'A1' }],
      ['item_statistics', { p_assignment: 'A1' }],
    ])
    await svc.listAttempts('A1')
    const select = c.calls.at(-1).ops.find(([op]) => op === 'select')[1]
    expect(select).not.toMatch(/awarded_score|response|answer|draft/)
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
    close_at: '2027-03-31T16:59:00Z',
    instructions: null,
    cohorts: { id: 'C1', code: 'C1', name: 'รุ่น 1' },
    courses: { id: 'K', title: 'AfL' },
    instrument_versions: {
      id: 'V1',
      version_no: 1,
      instruments: { id: 'I1', title: 'Quiz', course_id: 'K' },
    },
  }
  const STATS = {
    n: 6,
    min_n: 5,
    suppressed: false,
    basis: 'first_attempt',
    group_size: 2,
    k: 2,
    max_score: 5,
    mean_score: 2.5,
    sd_score: 1.71,
    reliability: 0.559,
    reliability_kind: 'kr20',
    items: [
      {
        item_id: 'i1',
        display_order: 1,
        item_type: 'mcq_single',
        prompt: XSS,
        max_score: 1,
        p: 0.667,
        d: 0.5,
        r_it: 0.403,
        blank: 1,
        choices: { a: 1, b: 4 },
      },
      {
        item_id: 'i2',
        display_order: 2,
        item_type: 'true_false',
        prompt: 'ข้อสอง',
        max_score: 1,
        p: 0.95,
        d: -0.1,
        r_it: null,
        blank: 0,
        choices: { true: 5, false: 1 },
      },
      {
        item_id: 'i3',
        display_order: 3,
        item_type: 'matching',
        prompt: 'จับคู่',
        max_score: 1,
        p: 0.5,
        d: 0.25,
        r_it: 0.1,
        blank: 0,
        choices: {},
        slots: [
          { slot_id: 'l1', no: 1, label: XSS, correct_rate: 0.6, answered: 6 },
          { slot_id: 'l2', no: 2, label: 'ขั้นสอง', correct_rate: 0.4, answered: 5 },
        ],
      },
    ],
  }
  const trainer = { cohortMemberships: [{ cohort_id: 'C1', cohort_role: 'trainer' }] }
  const mentor = { cohortMemberships: [{ cohort_id: 'C1', cohort_role: 'mentor' }] }
  const makeServices = (overrides = {}) => ({
    assignments: {
      get: vi.fn(async () => assignment),
      results: vi.fn(async () => [
        person({ user_id: 'u1', name: XSS }),
        person({ user_id: 'u2', name: 'ครู ข', ...nobody }),
      ]),
      itemStatistics: vi.fn(async () => STATS),
      update: vi.fn(async () => ({ id: 'A1' })),
      grantExtraAttempt: vi.fn(async () => {}),
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
    expect(el.querySelector('[data-date-label=close_at]').textContent).toBe('31 มี.ค. 2570 23:59 น.')
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

  it('detail (trainer): +1 attempt asks for a reason and grants it to that person', async () => {
    const el = document.createElement('div')
    const services = makeServices()
    await renderAssignmentDetailView(el, ctx(services, trainer), { id: 'A1' })
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValueOnce('สัญญาณขาด')
    const button = el.querySelector('tr[data-user-id=u2] [data-action=grant-extra]')
    button.click() // cancelled
    expect(services.assignments.grantExtraAttempt).not.toHaveBeenCalled()
    el.querySelector('tr[data-user-id=u2] [data-action=grant-extra]').click()
    await settle()
    expect(services.assignments.grantExtraAttempt).toHaveBeenCalledWith('A1', 'u2', 'สัญญาณขาด')
    expect(el.textContent).toContain('ให้สิทธิ์ทำเพิ่ม 1 ครั้งแก่ ครู ข แล้ว')
    expect(el.querySelector('input[name=time_limit_minutes]').disabled).toBe(true) // frozen with attempts
    prompt.mockRestore()
  })

  it('detail (trainer): item analysis with labels, escaped prompts, no key', async () => {
    const el = document.createElement('div')
    await renderAssignmentDetailView(el, ctx(makeServices(), trainer), { id: 'A1' })
    const section = el.querySelector('[data-item-analysis]')
    expect(section.querySelector('img')).toBeNull()
    expect(section.querySelector('[data-reliability]').textContent).toBe('0.559')
    expect(section.textContent).toContain('KR-20')
    expect(section.textContent).toContain('ค่อนข้างต่ำ')
    const row1 = section.querySelector('[data-item-row="1"]').textContent
    expect(row1).toContain('0.67')
    expect(row1).toContain('พอเหมาะ')
    expect(row1).toContain('a 1 · b 4')
    const row2 = section.querySelector('[data-item-row="2"]').textContent
    expect(row2).toContain('ง่ายมาก')
    expect(row2).toContain('ติดลบ — ตรวจโจทย์/เฉลย')
    expect(row2).toContain('ผิด 1 · ถูก 5')
    const parts = [...section.querySelectorAll('[data-item-row="3"] [data-parts] li')].map(
      (li) => li.textContent
    )
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^รายการที่ 1 \(.*\) ถูก 60% \(ตอบ 6\)$/) // label escaped (no <img> above)
    expect(parts[1]).toBe('รายการที่ 2 (ขั้นสอง) ถูก 40% (ตอบ 5)')
    expect(section.querySelector('[data-item-row="1"] [data-parts]')).toBeNull()
    // phones: one card per item instead of the wide table (same numbers, no sideways scrolling)
    const cards = section.querySelectorAll('[data-item-card]')
    expect(cards).toHaveLength(3)
    expect(section.querySelector('[data-item-cards]').classList.contains('md:hidden')).toBe(true)
    expect(section.querySelector('[data-items]').parentElement.classList.contains('md:block')).toBe(true)
    expect(cards[0].textContent).toContain('0.67')
    expect(cards[0].textContent).toContain('a 1 · b 4')
    expect(cards[2].querySelectorAll('[data-parts] li')).toHaveLength(2)
    expect(cards[2].textContent).toContain('ถูกรายส่วน')
    expect(section.textContent).toContain('ระบบไม่ระบุว่าตัวเลือกใดเป็นคำตอบที่ถูก')
  })

  it('item analysis: too few people, or an error, does not hide the results', async () => {
    const el = document.createElement('div')
    await renderAssignmentDetailView(
      el,
      ctx(
        makeServices({ itemStatistics: vi.fn(async () => ({ n: 3, min_n: 5, suppressed: true })) }),
        trainer
      ),
      { id: 'A1' }
    )
    expect(el.querySelector('[data-item-analysis]').textContent).toContain('ต้องมีผู้ส่งอย่างน้อย 5 คน')
    const el2 = document.createElement('div')
    await renderAssignmentDetailView(
      el2,
      ctx(
        makeServices({
          itemStatistics: vi.fn(async () => {
            throw Object.assign(new Error('x'), { code: '42501' })
          }),
        }),
        trainer
      ),
      { id: 'A1' }
    )
    expect(el2.querySelectorAll('[data-results] tbody tr')).toHaveLength(2)
    expect(el2.querySelector('[data-item-analysis]').textContent).toContain('วิเคราะห์ข้อสอบไม่สำเร็จ')
  })

  it('detail (mentor): results only, no settings form', async () => {
    const el = document.createElement('div')
    const services = makeServices()
    await renderAssignmentDetailView(el, ctx(services, mentor), { id: 'A1' })
    expect(services.assignments.itemStatistics).not.toHaveBeenCalled()
    expect(el.querySelector('[data-item-analysis]')).toBeNull()
    expect(el.querySelector('form[data-form=assignment]')).toBeNull()
    expect(el.querySelector('[data-action=grant-extra]')).toBeNull()
    expect(el.textContent).toContain('แสดงเฉพาะผู้เรียนที่ท่านมีสิทธิ์ดูผล')
  })

  it('a draft without a closing time cannot be published', async () => {
    const el = document.createElement('div')
    const services = makeServices({
      get: vi.fn(async () => ({ ...assignment, status: 'draft', close_at: null })),
      results: vi.fn(async () => [person({ ...nobody })]),
    })
    await renderAssignmentDetailView(el, ctx(services, trainer), { id: 'A1' })
    expect(el.querySelector('input[name=close_at]').required).toBe(true)
    el.querySelector('[data-action=publish]').click()
    await settle()
    expect(services.assignments.update).not.toHaveBeenCalled()
    expect(el.textContent).toContain('กรุณากำหนดวันเวลาปิดรับ')
  })

  it('detail: SE004 from the server is shown in Thai', async () => {
    const el = document.createElement('div')
    const services = makeServices({
      results: vi.fn(async () => [person({ ...nobody })]),
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
    el.querySelector('input[name=close_at]').value = '2027-03-31T16:00'
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

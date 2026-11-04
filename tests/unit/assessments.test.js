import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  assignmentState,
  parseNumericAnswer,
  buildResponses,
  itemMediaPaths,
  answersFromResponses,
  clockOffset,
  remainingMs,
  formatRemaining,
} from '../../src/features/assessments/logic.js'
import {
  createAssessmentService,
  ITEM_COLUMNS,
  ATTEMPT_COLUMNS,
} from '../../src/features/assessments/service.js'
import {
  renderMyAssessmentsView,
  renderAssessmentView,
  renderAttemptResultView,
} from '../../src/features/assessments/views.js'
import { renderBlock } from '../../src/features/lessons/render.js'
import { render } from '../../src/shared/ui/html.js'
import { toUserMessage, AppError } from '../../src/core/errors.js'

const XSS = '<img src=x onerror=alert(1)>'
const flush = () => new Promise((r) => setTimeout(r, 0))

const ITEMS = [
  {
    id: 'i1',
    item_type: 'mcq_single',
    prompt: 'ข้อแรก',
    max_score: 1,
    options_json: {
      options: [
        { id: 'a', text: 'ก' },
        { id: 'b', text: XSS },
      ],
    },
  },
  {
    id: 'i2',
    item_type: 'mcq_multiple',
    prompt: 'ข้อสอง',
    max_score: 2,
    options_json: {
      options: [
        { id: 'a', text: 'ก' },
        { id: 'b', image_path: 'inst/b.png' },
      ],
    },
  },
  { id: 'i3', item_type: 'true_false', prompt: 'ข้อสาม', max_score: 1, options_json: {} },
  {
    id: 'i4',
    item_type: 'numeric',
    prompt: 'ข้อสี่',
    max_score: 1,
    media_path: 'inst/q4.png',
    options_json: { unit: '%' },
  },
]

describe('assignmentState', () => {
  const base = { attempt_limit: 2, open_at: null, close_at: null }
  const now = new Date('2026-11-20T00:00:00Z')

  it('counts started attempts toward the limit', () => {
    const s = assignmentState(base, [{ attempt_no: 1, status: 'in_progress' }], now)
    expect(s).toMatchObject({ window: 'open', used: 1, remaining: 1, canStart: true })
    expect(s.inProgress.attempt_no).toBe(1)
  })
  it('limit reached → cannot start; latest submitted attempt is reported', () => {
    const s = assignmentState(
      base,
      [
        { attempt_no: 1, status: 'submitted', score: 1 },
        { attempt_no: 2, status: 'submitted', score: 4 },
      ],
      now
    )
    expect(s).toMatchObject({ remaining: 0, canStart: false })
    expect(s.latest.score).toBe(4)
  })
  it('respects the open window, even with an attempt in progress', () => {
    expect(assignmentState({ ...base, open_at: '2026-12-01T00:00:00Z' }, [], now).window).toBe('upcoming')
    const closed = assignmentState(
      { ...base, close_at: '2026-11-19T00:00:00Z' },
      [{ attempt_no: 1, status: 'in_progress' }],
      now
    )
    expect(closed).toMatchObject({ window: 'closed', canStart: false })
  })
  it('extra attempts granted to the caller raise the limit', () => {
    const s = assignmentState(
      { ...base, assessment_extra_attempts: [{ id: 'x1' }] },
      [
        { attempt_no: 1, status: 'submitted' },
        { attempt_no: 2, status: 'submitted' },
      ],
      now
    )
    expect(s).toMatchObject({ limit: 3, remaining: 1, canStart: true })
  })
})

describe('answers → submit payload', () => {
  it('parses numbers including Thai digits and separators', () => {
    expect(parseNumericAnswer('75')).toBe(75)
    expect(parseNumericAnswer('๗๕')).toBe(75)
    expect(parseNumericAnswer(' 1,234.5 ')).toBe(1234.5)
    expect(parseNumericAnswer('-3')).toBe(-3)
    expect(parseNumericAnswer('')).toBeNull()
    expect(parseNumericAnswer('abc')).toBeNaN()
    expect(parseNumericAnswer('7.5.1')).toBeNaN()
  })

  it('builds the exact shapes the RPC validates; numbers unanswered items', () => {
    const { responses, unanswered } = buildResponses(ITEMS, {
      i1: 'b',
      i2: ['b', 'a', 'b'],
      i3: '',
      i4: '๗๕',
    })
    expect(responses).toEqual({ i1: { choice: 'b' }, i2: { choices: ['b', 'a'] }, i4: { value: 75 } })
    expect(unanswered).toEqual([3])
  })

  it('rejects a non-numeric entry with the item number', () => {
    expect(() => buildResponses(ITEMS, { i4: 'เจ็ดสิบห้า' })).toThrow(AppError)
    expect(() => buildResponses(ITEMS, { i4: 'เจ็ดสิบห้า' })).toThrow('ข้อ 4')
  })

  it('collects question and choice images for signing', () => {
    expect(itemMediaPaths(ITEMS)).toEqual(['inst/b.png', 'inst/q4.png'])
  })
})

describe('server draft and countdown helpers', () => {
  it('lenient build (autosave, time up) leaves out a half-typed number instead of failing', () => {
    expect(buildResponses(ITEMS, { i1: 'a', i4: '7x' }, { lenient: true }).responses).toEqual({
      i1: { choice: 'a' },
    })
  })

  it('saved responses restore the form answers they came from', () => {
    const responses = {
      i1: { choice: 'b' },
      i2: { choices: ['a', 'b'] },
      i3: { value: false },
      i4: { value: 75 },
    }
    const answers = answersFromResponses(ITEMS, responses)
    expect(answers).toEqual({ i1: 'b', i2: ['a', 'b'], i3: 'false', i4: '75' })
    expect(buildResponses(ITEMS, answers).responses).toEqual(responses)
    expect(answersFromResponses(ITEMS, null)).toEqual({})
  })

  it('countdown uses the server clock, not the device clock', () => {
    const server = '2026-11-20T01:00:00Z'
    const deviceTwoMinutesFast = new Date('2026-11-20T01:02:00Z').getTime()
    const offset = clockOffset(server, deviceTwoMinutesFast)
    expect(offset).toBe(-120_000)
    expect(remainingMs('2026-11-20T01:30:00Z', offset, deviceTwoMinutesFast)).toBe(30 * 60_000)
    expect(formatRemaining(754_000)).toBe('12:34')
    expect(formatRemaining(3_723_000)).toBe('1:02:03')
    expect(formatRemaining(400)).toBe('0:01') // rounds up: never shows 0:00 while time remains
    expect(formatRemaining(-5000)).toBe('0:00')
  })
})

describe('assessment service', () => {
  function fakeClient(result = { data: [], error: null }) {
    const calls = []
    const builder = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve(result)
          return (...args) => {
            calls.push([prop, ...args])
            return builder
          }
        },
      }
    )
    return {
      calls,
      from: (t) => (calls.push(['from', t]), builder),
      rpc: vi.fn(async (fn, args) => (calls.push(['rpc', fn, args]), result)),
    }
  }

  it('selects explicit columns; item columns carry no key material', async () => {
    const c = fakeClient()
    const svc = createAssessmentService(c)
    await svc.listMyAssignments('u1', ['c1'])
    await svc.getItems('v1')
    await svc.getAttempt('t1')
    const selects = c.calls.filter(([op]) => op === 'select').map(([, cols]) => cols)
    expect(selects).toHaveLength(3)
    for (const s of selects) expect(s).not.toMatch(/\*/)
    expect(ITEM_COLUMNS).not.toMatch(/answer|correct|key|scoring/)
    expect(ATTEMPT_COLUMNS).toContain('correct_count')
    // only the caller's own attempts are embedded
    expect(c.calls).toContainEqual(['eq', 'assessment_attempts.user_id', 'u1'])
  })

  it('submit sends only the attempt id and answers (no score, no timestamps)', async () => {
    const c = fakeClient({ data: [{ score: 1 }], error: null })
    const out = await createAssessmentService(c).submit('t1', { i1: { choice: 'b' } })
    expect(c.rpc).toHaveBeenCalledWith('submit_attempt', {
      p_attempt: 't1',
      p_responses: { i1: { choice: 'b' } },
    })
    expect(out).toEqual({ score: 1 })
  })

  it('no cohorts → no query', async () => {
    const c = fakeClient()
    expect(await createAssessmentService(c).listMyAssignments('u1', [])).toEqual([])
    expect(c.calls).toEqual([])
  })

  it('assessment error codes have Thai messages', () => {
    expect(toUserMessage({ code: 'SE001' })).toMatch(/ยังไม่เปิดหรือปิดรับ/)
    expect(toUserMessage({ code: 'SE002' })).toMatch(/ครบจำนวนครั้ง/)
    expect(toUserMessage({ code: 'SE003' })).toMatch(/ส่งคำตอบ/)
  })

  it('saveDraft sends only the attempt id and answers', async () => {
    const c = fakeClient({ data: [{ saved_at: 'x', finalized: false }], error: null })
    expect(await createAssessmentService(c).saveDraft('t1', { i1: { choice: 'a' } })).toEqual({
      saved_at: 'x',
      finalized: false,
    })
    expect(c.rpc).toHaveBeenCalledWith('save_attempt_draft', {
      p_attempt: 't1',
      p_responses: { i1: { choice: 'a' } },
    })
  })
})

describe('assessment views', () => {
  const assignment = {
    id: 'a1',
    title: XSS,
    purpose: 'pretest',
    instructions: 'ทำได้ 1 ครั้ง',
    open_at: null,
    close_at: null,
    attempt_limit: 1,
    passing_percent: 60,
    status: 'published',
    instrument_version_id: 'v1',
    courses: { id: 'k', title: 'AfL' },
    assessment_attempts: [],
  }
  const ctx = (assessments) => ({
    session: { user: { id: 'u1' } },
    context: { cohortMemberships: [{ cohort_role: 'trainee', cohort_id: 'c1' }] },
    services: {
      assessments,
      assessmentMedia: { signedUrls: async () => ({ 'inst/q4.png': 'https://x.example.test/q4.png' }) },
    },
  })

  it('list escapes titles and shows remaining attempts', async () => {
    const el = document.createElement('div')
    const listMyAssignments = vi.fn(async () => [assignment])
    await renderMyAssessmentsView(el, ctx({ listMyAssignments }))
    expect(listMyAssignments).toHaveBeenCalledWith('u1', ['c1'])
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('ทำได้อีก 1 จาก 1 ครั้ง')
    expect(el.querySelector('a[href="#/assessments/a1"]')).not.toBeNull()
  })

  it('start → exam → unanswered confirmation → submit sends built responses', async () => {
    const el = document.createElement('div')
    document.body.append(el)
    const svc = {
      getAssignment: vi.fn(async () => assignment),
      start: vi.fn(async () => ({
        attempt_id: 't1',
        attempt_no: 1,
        started_at: '2026-11-20T01:00:00Z',
        resumed: false,
      })),
      getItems: vi.fn(async () => ITEMS),
      submit: vi.fn(async () => ({ score: 1 })),
    }
    await renderAssessmentView(el, ctx(svc), { id: 'a1' })
    expect(el.textContent).toContain('ระบบจะนับเป็น 1 ครั้ง')
    expect(svc.start).not.toHaveBeenCalled() // nothing counts until the trainee clicks

    el.querySelector('[data-action=start-attempt]').click()
    await flush()
    await flush()
    const form = el.querySelector('form[data-form=attempt]')
    expect(form).not.toBeNull()
    expect(form.querySelectorAll('fieldset')).toHaveLength(4)
    expect(form.querySelectorAll('input[type=radio][name="q:i1"]')).toHaveLength(2)
    expect(form.querySelectorAll('input[type=checkbox][name="q:i2"]')).toHaveLength(2)
    expect(form.querySelector('fieldset[data-item-id=i1] img')).toBeNull() // XSS choice text escaped
    expect(form.querySelector('img[src="https://x.example.test/q4.png"]')).not.toBeNull()

    form.querySelector('input[name="q:i1"][value=b]').checked = true
    form.querySelector('input[name="q:i4"]').value = '๗๕'
    form.requestSubmit()
    await flush()
    expect(svc.submit).not.toHaveBeenCalled()
    expect(el.textContent).toContain('ยังไม่ได้ตอบ 2 ข้อ (ข้อ 2, 3)')

    form.requestSubmit()
    await flush()
    expect(svc.submit).toHaveBeenCalledWith('t1', { i1: { choice: 'b' }, i4: { value: 75 } })
    expect(window.location.hash).toBe('#/assessments/attempts/t1')
    el.remove()
  })

  it('an open attempt resumes straight into the exam', async () => {
    const el = document.createElement('div')
    const svc = {
      getAssignment: async () => ({
        ...assignment,
        assessment_attempts: [{ attempt_no: 1, status: 'in_progress' }],
      }),
      start: vi.fn(async () => ({ attempt_id: 't9', attempt_no: 1, started_at: null, resumed: true })),
      getItems: async () => ITEMS,
    }
    await renderAssessmentView(el, ctx(svc), { id: 'a1' })
    expect(svc.start).toHaveBeenCalledTimes(1)
    expect(el.querySelector('form[data-form=attempt]')).not.toBeNull()
  })

  it('limit reached → no start button', async () => {
    const el = document.createElement('div')
    const svc = {
      getAssignment: async () => ({
        ...assignment,
        assessment_attempts: [
          { id: 't1', attempt_no: 1, status: 'submitted', score: 3, max_score: 5, passed: true },
        ],
      }),
    }
    await renderAssessmentView(el, ctx(svc), { id: 'a1' })
    expect(el.querySelector('[data-action=start-attempt]')).toBeNull()
    expect(el.textContent).toContain('ทำครบจำนวนครั้งแล้ว')
    expect(el.querySelector('a[href="#/assessments/attempts/t1"]')).not.toBeNull()
  })

  it('result page shows totals and pass state only', async () => {
    const el = document.createElement('div')
    const svc = {
      getAttempt: async () => ({
        id: 't1',
        assignment_id: 'a1',
        attempt_no: 1,
        status: 'submitted',
        submitted_at: '2026-11-20T02:00:00Z',
        score: 4,
        max_score: 5,
        passed: true,
        correct_count: 3,
        item_count: 4,
        assessment_assignments: { title: XSS, purpose: 'pretest', passing_percent: 60 },
      }),
    }
    await renderAttemptResultView(el, ctx(svc), { attemptId: 't1' })
    expect(el.querySelector('[data-score]').textContent).toMatch(/4\s*\/\s*5/)
    expect(el.textContent).toContain('80%')
    expect(el.textContent).toContain('3 / 4 ข้อ')
    expect(el.textContent).toContain('ผ่านเกณฑ์')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-auto-submitted]')).toBeNull()
  })

  it('result page says when the server submitted on time-out', async () => {
    const el = document.createElement('div')
    const svc = {
      getAttempt: async () => ({
        id: 't1',
        assignment_id: 'a1',
        attempt_no: 1,
        status: 'submitted',
        submitted_at: '2026-11-20T02:00:00Z',
        score: 1,
        max_score: 5,
        passed: false,
        correct_count: 1,
        item_count: 4,
        auto_submitted: true,
        assessment_assignments: { title: 't', purpose: 'pretest', passing_percent: 60 },
      }),
    }
    await renderAttemptResultView(el, ctx(svc), { attemptId: 't1' })
    expect(el.querySelector('[data-auto-submitted]').textContent).toContain(
      'ส่งคำตอบที่บันทึกไว้ล่าสุดให้อัตโนมัติ'
    )
  })
})

describe('exam: server autosave and countdown', () => {
  const T0 = new Date('2026-11-20T01:00:00Z')
  const timed = {
    id: 'a1',
    title: 'หลังเรียน',
    purpose: 'posttest',
    open_at: null,
    close_at: null,
    attempt_limit: 1,
    time_limit_minutes: 10,
    grace_minutes: 5,
    passing_percent: 60,
    status: 'published',
    instrument_version_id: 'v1',
    assessment_attempts: [{ id: 't1', attempt_no: 1, status: 'in_progress' }],
  }
  const started = (over = {}) => ({
    attempt_id: 't1',
    attempt_no: 1,
    started_at: T0.toISOString(),
    resumed: true,
    deadline_at: new Date(T0.getTime() + 10 * 60_000).toISOString(),
    server_now: T0.toISOString(),
    draft: { i1: { choice: 'a' } },
    timed_out: false,
    ...over,
  })
  const ctx = (assessments) => ({
    session: { user: { id: 'u1' } },
    context: { cohortMemberships: [] },
    services: { assessments, assessmentMedia: { signedUrls: async () => ({}) } },
  })
  const mount = async (svc) => {
    const el = document.createElement('div')
    document.body.append(el)
    await renderAssessmentView(el, ctx(svc), { id: 'a1' })
    await vi.advanceTimersByTimeAsync(0)
    return el
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    window.location.hash = ''
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('resume restores saved answers; typing saves to the server after a pause', async () => {
    const svc = {
      getAssignment: async () => timed,
      start: vi.fn(async () => started()),
      getItems: async () => ITEMS,
      saveDraft: vi.fn(async () => ({ saved_at: T0.toISOString(), finalized: false })),
    }
    const el = await mount(svc)
    const form = el.querySelector('form[data-form=attempt]')
    expect(form.querySelector('input[name="q:i1"][value=a]').checked).toBe(true) // restored from the server
    expect(el.querySelector('[data-remaining]').textContent).toBe('10:00')

    const status = el.querySelector('[data-save-status]')
    const tf = form.querySelector('input[name="q:i3"][value=true]')
    tf.checked = true
    tf.dispatchEvent(new Event('input', { bubbles: true }))
    expect(status.dataset.state).toBe('dirty')
    await vi.advanceTimersByTimeAsync(0) // a choice is saved at once
    expect(svc.saveDraft).toHaveBeenLastCalledWith('t1', { i1: { choice: 'a' }, i3: { value: true } })
    expect(status.textContent).toContain('บันทึกคำตอบแล้ว')
    expect(status.dataset.state).toBe('saved')

    const num = form.querySelector('input[name="q:i4"]')
    num.value = '7'
    num.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(svc.saveDraft).toHaveBeenCalledTimes(1) // typing waits for a pause
    await vi.advanceTimersByTimeAsync(600)
    expect(svc.saveDraft).toHaveBeenCalledTimes(2)
    expect(svc.saveDraft).toHaveBeenLastCalledWith('t1', {
      i1: { choice: 'a' },
      i3: { value: true },
      i4: { value: 7 },
    })
  })

  it('a change made while a save is in flight is saved right after it (not dropped)', async () => {
    let release
    const svc = {
      getAssignment: async () => timed,
      start: async () => started(),
      getItems: async () => ITEMS,
      saveDraft: vi
        .fn()
        .mockImplementationOnce(() => new Promise((r) => (release = r)))
        .mockResolvedValue({ saved_at: T0.toISOString(), finalized: false }),
    }
    const el = await mount(svc)
    const status = el.querySelector('[data-save-status]')
    const pick = (sel) => {
      const i = el.querySelector(sel)
      i.checked = true
      i.dispatchEvent(new Event('input', { bubbles: true }))
    }
    pick('input[name="q:i1"][value=b]')
    await vi.advanceTimersByTimeAsync(0)
    pick('input[name="q:i3"][value=false]') // arrives while the first save is pending
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.saveDraft).toHaveBeenCalledTimes(1)
    expect(status.dataset.state).not.toBe('saved')
    release({ saved_at: T0.toISOString(), finalized: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.saveDraft).toHaveBeenCalledTimes(2)
    expect(svc.saveDraft).toHaveBeenLastCalledWith('t1', { i1: { choice: 'b' }, i3: { value: false } })
    expect(status.dataset.state).toBe('saved')
  })

  it('time up → submits what is on screen without the unanswered prompt', async () => {
    const svc = {
      getAssignment: async () => timed,
      start: async () => started(),
      getItems: async () => ITEMS,
      saveDraft: vi.fn(),
      submit: vi.fn(async () => ({ score: 0 })),
    }
    const el = await mount(svc)
    el.querySelector('input[name="q:i4"]').value = '7x' // half-typed: left out, not an error
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000)
    expect(el.querySelector('[data-time-alert]').textContent).toBe('เหลือเวลา 5 นาที')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(svc.submit).toHaveBeenCalledTimes(1)
    expect(svc.submit).toHaveBeenCalledWith('t1', { i1: { choice: 'a' } })
    expect(window.location.hash).toBe('#/assessments/attempts/t1')
  })

  it('the server says time was up while saving → go to the result', async () => {
    const svc = {
      getAssignment: async () => timed,
      start: async () => started(),
      getItems: async () => ITEMS,
      saveDraft: vi.fn(async () => ({ saved_at: null, finalized: true })),
    }
    const el = await mount(svc)
    const b = el.querySelector('input[name="q:i1"][value=b]')
    b.checked = true
    b.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(window.location.hash).toBe('#/assessments/attempts/t1')
  })

  it('reopening an expired attempt shows its result instead of the exam', async () => {
    const svc = {
      getAssignment: async () => timed,
      start: vi.fn(async () => started({ timed_out: true, resumed: false, draft: null })),
      getItems: vi.fn(),
    }
    const el = await mount(svc)
    expect(svc.getItems).not.toHaveBeenCalled()
    expect(el.querySelector('form[data-form=attempt]')).toBeNull()
    expect(window.location.hash).toBe('#/assessments/attempts/t1')
  })

  it('overview tells the trainee the time limit before they start', async () => {
    const svc = { getAssignment: async () => ({ ...timed, assessment_attempts: [] }) }
    const el = await mount(svc)
    expect(el.textContent).toContain('10 นาทีต่อครั้ง')
    expect(el.textContent).toContain('ระบบจะส่งคำตอบที่บันทึกไว้ให้อัตโนมัติ')
  })
})

describe('quiz_reference lesson block', () => {
  it('links to the assessment page with an encoded id', () => {
    const el = document.createElement('div')
    render(
      el,
      renderBlock({
        block_type: 'quiz_reference',
        content_json: { assessment_assignment_id: 'a1"><x', title: XSS },
      })
    )
    const a = el.querySelector('a[data-quiz-link]')
    expect(a.getAttribute('href')).toBe('#/assessments/a1%22%3E%3Cx')
    expect(el.querySelector('img')).toBeNull()
  })
})

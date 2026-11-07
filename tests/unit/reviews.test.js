import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildReviewPayload,
  countWaiting,
  filterRows,
  groupByPerson,
  reviewCsvRows,
} from '../../src/features/reviews/logic.js'
import { createReviewService } from '../../src/features/reviews/service.js'
import {
  renderReviewQueueView,
  renderTaskPeopleView,
  renderReviewView,
} from '../../src/features/reviews/views.js'
import { AppError } from '../../src/core/errors.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
const prof = (name) => ({ id: name, full_name: name, display_name: null })
const sub = (id, user, n, o = {}) => ({
  id,
  allocation_id: 'A1',
  user_id: user,
  attempt_no: n,
  status: 'submitted',
  submitted_at: `2026-11-0${n}T01:00:00Z`,
  is_late: false,
  text_response: 't',
  links: [],
  profiles: prof(user),
  ...o,
})
const rev = (id, submission, outcome, o = {}) => ({
  id,
  submission_id: submission,
  outcome,
  score: '3.00',
  max_score: '4.00',
  released_at: '2026-11-05T01:00:00Z',
  ...o,
})

describe('who is waiting', () => {
  const submissions = [
    sub('s1', 'ก', 1),
    sub('s2', 'ข', 1),
    sub('s3', 'ข', 2, { is_late: true }),
    sub('s4', 'ค', 1),
  ]
  const reviews = [rev('r1', 's1', 'passed'), rev('r2', 's2', 'revise'), rev('r4', 's4', 'revise')]
  const roster = [
    { user_id: 'ง', profiles: prof('ง') },
    { user_id: 'ก', profiles: prof('ก') },
  ]

  it('one row per person on their latest attempt; waiting first, then revise, passed, not submitted', () => {
    const rows = groupByPerson(submissions, reviews, roster)
    expect(rows.map((r) => [r.name, r.state, r.attempts])).toEqual([
      ['ข', 'waiting', 2], // attempt 2 has no review yet (attempt 1 was returned)
      ['ค', 'revise', 1],
      ['ก', 'passed', 1],
      ['ง', 'none', 0],
    ])
    expect(rows[0].is_late).toBe(true)
    expect(rows[0].latest.id).toBe('s3')
    expect(countWaiting(rows)).toBe(1)
    expect(filterRows(rows, 'passed').map((r) => r.name)).toEqual(['ก'])
    expect(filterRows(rows, 'all')).toHaveLength(4)
  })

  it('the newest release is the review in force; without a roster only people who submitted are listed', () => {
    const rows = groupByPerson(
      [sub('s1', 'ก', 1)],
      [
        rev('a', 's1', 'passed', { released_at: '2026-11-01T00:00:00Z' }),
        rev('b', 's1', 'revise', { released_at: '2026-11-09T00:00:00Z' }),
      ]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('revise')
    expect(groupByPerson([], [], [])).toEqual([])
    expect(groupByPerson([sub('s9', 'ซ', 1, { profiles: null })])[0].name).toBe('ไม่ทราบชื่อ')
  })
})

describe('the review form', () => {
  const criteria = [
    { id: 'c1', prompt: 'เป้าหมาย' },
    { id: 'c2', prompt: 'หลักฐาน' },
  ]
  const form = (o = {}) => ({
    levels: { c1: 'a', c2: 'x' },
    comments: { c1: ' ดี ', c2: '' },
    feedback: ' ผ่านครับ ',
    outcome: 'passed',
    reason: '',
    ...o,
  })

  it('sends levels and comments only (never a score); empty text becomes null', () => {
    expect(buildReviewPayload(form(), criteria)).toEqual({
      scores: { c1: { level: 'a', comment: 'ดี' }, c2: { level: 'x' } },
      feedback: 'ผ่านครับ',
      outcome: 'passed',
      reason: null,
    })
    expect(buildReviewPayload({ levels: {}, feedback: '  ', outcome: 'maybe' }, criteria)).toEqual({
      scores: {},
      feedback: null,
      outcome: null,
      reason: null,
    })
  })

  it('a draft may be partial; a release needs every criterion, an outcome, and a reason when re-grading', () => {
    expect(() => buildReviewPayload(form({ levels: { c1: 'a' } }), criteria)).not.toThrow()
    expect(() => buildReviewPayload(form({ levels: { c1: 'a' } }), criteria, { release: true })).toThrow(
      'ยังไม่ได้เลือกระดับของเกณฑ์: “หลักฐาน”'
    )
    expect(() => buildReviewPayload(form({ outcome: '' }), criteria, { release: true })).toThrow(
      'เลือกผลการตรวจ'
    )
    expect(() => buildReviewPayload(form(), criteria, { release: true, regrade: true })).toThrow(
      'ระบุเหตุผลที่ตรวจใหม่'
    )
    expect(
      buildReviewPayload(form({ reason: 'ทบทวน' }), criteria, { release: true, regrade: true }).reason
    ).toBe('ทบทวน')
    expect(buildReviewPayload({ levels: {}, outcome: 'revise' }, [], { release: true }).outcome).toBe(
      'revise'
    ) // no rubric
  })

  it('length limits', () => {
    expect(() => buildReviewPayload(form({ feedback: 'x'.repeat(10001) }), criteria)).toThrow(
      'ยาวเกิน 10,000'
    )
    expect(() => buildReviewPayload(form({ comments: { c1: 'x'.repeat(2001) } }), criteria)).toThrow(AppError)
    expect(() => buildReviewPayload(form({ reason: 'x'.repeat(1001) }), criteria)).toThrow('ยาวเกิน 1,000')
  })

  it('CSV: names, status, scores; no content of the work; people who have not submitted are listed', () => {
    const rows = groupByPerson(
      [sub('s1', 'ก', 1, { text_response: 'ความลับของงาน' })],
      [rev('r1', 's1', 'passed')],
      [{ user_id: 'ข', profiles: prof('ข') }]
    )
    const csv = reviewCsvRows(rows, { rubric_version_id: 'RV' })
    expect(csv[0]).toEqual([
      'ชื่อ',
      'สถานะ',
      'จำนวนรอบที่ส่ง',
      'ส่งล่าสุด (ISO)',
      'ส่งช้า',
      'คะแนน',
      'คะแนนเต็ม',
      'ผลการตรวจล่าสุด',
    ])
    expect(csv[1]).toEqual(['ก', 'ผ่าน', 1, '2026-11-01T01:00:00Z', 'ไม่', '3.00', '4.00', 'ผ่าน'])
    expect(csv[2]).toEqual(['ข', 'ยังไม่ส่ง', 0, '', '', '', '', ''])
    expect(JSON.stringify(csv)).not.toContain('ความลับ')
    expect(reviewCsvRows(rows, { rubric_version_id: null })[0]).not.toContain('คะแนน')
  })
})

describe('service', () => {
  const make = (result = { data: [], error: null }) => {
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
    return {
      calls,
      client: {
        from: (t) => (calls.push(['from', t]), b),
        rpc: vi.fn(async () => ({ data: 'R1', error: null })),
        storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
      },
    }
  }

  it('roster names the foreign key (two lead to profiles); only submitted attempts are listed', async () => {
    const m = make()
    const svc = createReviewService(m.client)
    await svc.roster('C1')
    expect(m.calls.find(([op]) => op === 'select')[1]).toContain('profiles!cohort_memberships_user_id_fkey')
    const n = make({ data: [{ id: 's1' }], error: null })
    await createReviewService(n.client).submissionsOf(['A1'])
    expect(n.calls).toContainEqual(['eq', 'status', 'submitted'])
    expect(n.calls).toContainEqual(['eq', 'status', 'released'])
    for (const [op, cols] of [...m.calls, ...n.calls].filter(([op]) => op === 'select'))
      expect([op, cols]).not.toContain('*')
  })

  it("saveReview and release call the RPCs with the page's arguments", async () => {
    const m = make()
    const svc = createReviewService(m.client)
    await svc.saveReview('S1', {
      scores: { c1: { level: 'a' } },
      feedback: 'ดี',
      outcome: 'passed',
      reason: null,
    })
    expect(m.client.rpc).toHaveBeenCalledWith('save_task_review', {
      p_submission: 'S1',
      p_scores: { c1: { level: 'a' } },
      p_feedback: 'ดี',
      p_outcome: 'passed',
      p_reason: null,
    })
    await svc.release('R1')
    expect(m.client.rpc).toHaveBeenCalledWith('release_task_review', { p_review: 'R1' })
    expect((await svc.submissionsOf([])).submissions).toEqual([])
  })
})

describe('pages', () => {
  afterEach(() => document.body.replaceChildren())
  const task = {
    id: 'T',
    title: XSS,
    rubric_version_id: 'RV',
    max_attempts: 3,
    status: 'published',
    courses: { title: 'หลักสูตร' },
  }
  const allocation = {
    id: 'A1',
    cohort_id: 'C',
    due_at: null,
    cohorts: { id: 'C', code: 'R1', name: 'รุ่น 1' },
    tasks: task,
  }
  const criteria = [
    {
      id: 'c1',
      prompt: XSS,
      max_score: 4,
      options_json: {
        levels: [
          { id: 'a', label: 'ต่ำ', score: 1 },
          { id: 'b', label: 'สูง', score: 4, description: 'ดีมาก' },
        ],
      },
    },
    {
      id: 'c2',
      prompt: 'หลักฐาน',
      max_score: 2,
      options_json: {
        levels: [
          { id: 'x', label: 'ไม่มี', score: 0 },
          { id: 'y', label: 'มี', score: 2 },
        ],
      },
    },
  ]
  const ctx = (services, me = 'me') => ({
    services,
    caps: { canManagePrograms: true },
    context: { cohortMemberships: [] },
    session: { user: { id: me } },
  })
  const baseServices = (over = {}) => ({
    reviews: {
      listAllocations: vi.fn(async () => [allocation]),
      getAllocation: vi.fn(async () => allocation),
      submissionsOf: vi.fn(async () => ({
        submissions: [sub('s1', 'ก', 1), sub('s2', 'ข', 1)],
        reviews: [rev('r1', 's2', 'passed')],
      })),
      roster: vi.fn(async () => [{ user_id: 'ง', profiles: prof('ง') }]),
      ...over,
    },
  })

  it('queue: tasks with how many wait; the title is text', async () => {
    const el = document.createElement('div')
    await renderReviewQueueView(el, ctx(baseServices()))
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-waiting]').textContent).toContain('รอตรวจ 1')
    expect(el.querySelector('[data-review-queue] a').getAttribute('href')).toBe('#/staff/tasks/A1')
    const empty = document.createElement('div')
    await renderReviewQueueView(empty, ctx(baseServices({ listAllocations: async () => [] })))
    expect(empty.textContent).toContain('ยังไม่มีภาระงาน')
  })

  it('people: filter, link to the work, CSV; an assessor sees the roster, a mentor does not', async () => {
    const created = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => (created.push(b), 'blob:x'))
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const services = baseServices()
    const el = document.createElement('div')
    await renderTaskPeopleView(el, ctx(services), { allocationId: 'A1' })
    expect(el.querySelectorAll('[data-people] tbody tr')).toHaveLength(3)
    expect(el.querySelector('tr[data-user-id=ก] [data-review-link]').getAttribute('href')).toBe(
      '#/staff/tasks/review/s1'
    )
    el.querySelector('[data-filter=waiting]').click()
    expect(el.querySelectorAll('[data-people] tbody tr')).toHaveLength(1)
    el.querySelector('[data-action=export-csv]').click()
    expect(await created[0].text()).toContain('ชื่อ,สถานะ')
    const mentor = document.createElement('div')
    const mentorCtx = {
      ...ctx(baseServices()),
      caps: {},
      context: { cohortMemberships: [{ cohort_id: 'C', cohort_role: 'mentor' }] },
    }
    await renderTaskPeopleView(mentor, mentorCtx, { allocationId: 'A1' })
    expect(mentorCtx.services.reviews.roster).not.toHaveBeenCalled()
    expect(mentor.querySelectorAll('[data-people] tbody tr')).toHaveLength(2)
    URL.createObjectURL.mockRestore()
  })

  const detail = (o = {}) => ({
    submission: sub('s1', 'ก', 1, {
      text_response: XSS,
      links: [{ url: 'https://x.example.test', label: 'ลิงก์' }],
    }),
    allocation,
    attempts: [{ id: 's1', attempt_no: 1, is_late: false }],
    files: [],
    reviews: [],
    scores: [],
    criteria,
    ...o,
  })
  const openReview = async (d, over = {}, me = 'me') => {
    const services = baseServices({
      getSubmission: vi.fn(async () => d),
      signedUrls: vi.fn(async () => ({})),
      saveReview: vi.fn(async () => 'R9'),
      release: vi.fn(async () => ({})),
      discard: vi.fn(async () => {}),
      ...over,
    })
    const el = document.createElement('div')
    document.body.append(el)
    await renderReviewView(el, ctx(services, me), { submissionId: 's1' })
    return { el, services }
  }
  const pick = (el, criterion, level) =>
    (el.querySelector(`input[name="level:${criterion}"][value=${level}]`).checked = true)

  it('shows the work as text; a release with a criterion unscored stops on the page, nothing is sent', async () => {
    const { el, services } = await openReview(detail())
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-work]').textContent).toContain(XSS)
    pick(el, 'c1', 'b')
    el.querySelector('input[name=outcome][value=passed]').checked = true
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    el.querySelector('button[data-intent=release]').click()
    await settle()
    expect(el.querySelector('[data-form-error]').textContent).toContain('ยังไม่ได้เลือกระดับของเกณฑ์')
    expect(services.reviews.saveReview).not.toHaveBeenCalled()
    window.confirm.mockRestore()
  })

  it('save stores a draft (no release); release saves first, then releases that review', async () => {
    const { el, services } = await openReview(detail())
    pick(el, 'c1', 'b')
    el.querySelector('textarea[name=feedback]').value = 'ดีมาก'
    el.querySelector('button[data-intent=save]').click()
    await settle()
    expect(services.reviews.saveReview).toHaveBeenCalledWith('s1', {
      scores: { c1: { level: 'b' } },
      feedback: 'ดีมาก',
      outcome: null,
      reason: null,
    })
    expect(services.reviews.release).not.toHaveBeenCalled()
    expect(el.textContent).toContain('ผู้เรียนยังไม่เห็น')
    pick(el, 'c1', 'b')
    pick(el, 'c2', 'y')
    el.querySelector('input[name=outcome][value=revise]').checked = true
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    el.querySelector('button[data-intent=release]').click()
    await settle()
    expect(services.reviews.release).toHaveBeenCalledWith('R9')
    expect(services.reviews.saveReview.mock.invocationCallOrder.at(-1)).toBeLessThan(
      services.reviews.release.mock.invocationCallOrder[0]
    )
    expect(el.textContent).toContain('ส่งผลให้ผู้เรียนแล้ว')
    window.confirm.mockRestore()
  })

  it('my draft is shown again and can be discarded', async () => {
    const d = detail({
      reviews: [
        {
          id: 'd1',
          submission_id: 's1',
          reviewer_id: 'me',
          status: 'draft',
          outcome: 'revise',
          feedback: 'ร่างเดิม',
          regrade_reason: null,
        },
      ],
      scores: [
        { review_id: 'd1', criterion_id: 'c1', level_id: 'b', score: '4.00', comment: 'ความเห็นเดิม' },
      ],
    })
    const { el, services } = await openReview(d)
    expect(el.querySelector('input[name="level:c1"][value=b]').checked).toBe(true)
    expect(el.querySelector('input[name="comment:c1"]').value).toBe('ความเห็นเดิม')
    expect(el.querySelector('textarea[name=feedback]').value).toBe('ร่างเดิม')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    el.querySelector('[data-action=discard]').click()
    await settle()
    expect(services.reviews.discard).toHaveBeenCalledWith('d1')
    window.confirm.mockRestore()
  })

  it('a released review: listed with its earlier one, the form starts from it and a re-grade needs the reason', async () => {
    const d = detail({
      reviews: [
        {
          id: 'r2',
          submission_id: 's1',
          status: 'released',
          outcome: 'revise',
          feedback: XSS,
          score: '1.00',
          max_score: '6.00',
          released_at: '2026-11-06T00:00:00Z',
          regrade_reason: 'ทบทวน',
        },
        {
          id: 'r1',
          submission_id: 's1',
          status: 'released',
          outcome: 'passed',
          feedback: 'เดิม',
          score: '6.00',
          max_score: '6.00',
          released_at: '2026-11-05T00:00:00Z',
        },
      ],
      scores: [{ review_id: 'r2', criterion_id: 'c1', level_id: 'a', score: '1.00', comment: null }],
    })
    const { el, services } = await openReview(d)
    expect(el.querySelectorAll('[data-released]')).toHaveLength(2)
    expect(el.querySelector('[data-released-reviews]').textContent).toContain('เหตุผลที่ตรวจใหม่: ทบทวน')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('input[name="level:c1"][value=a]').checked).toBe(true) // starts from the review in force
    expect(el.querySelector('textarea[name=reason]')).not.toBeNull()
    pick(el, 'c2', 'x')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    el.querySelector('button[data-intent=release]').click()
    await settle()
    expect(el.querySelector('[data-form-error]').textContent).toContain('ระบุเหตุผลที่ตรวจใหม่')
    expect(services.reviews.saveReview).not.toHaveBeenCalled()
    window.confirm.mockRestore()
  })

  it('your own work cannot be reviewed; a work that is not visible shows a Thai page; server refusals keep the form', async () => {
    const own = await openReview(detail(), {}, 'ก')
    expect(own.el.querySelector('form[data-form=review]')).toBeNull()
    expect(own.el.textContent).toContain('ตรวจงานของตนเองไม่ได้')
    const missing = await openReview(null)
    expect(missing.el.textContent).toContain('ไม่พบงานนี้')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refused = await openReview(detail(), {
      saveReview: vi.fn(async () => {
        throw new AppError('คุณไม่มีสิทธิ์ดำเนินการนี้')
      }),
    })
    pick(refused.el, 'c1', 'a')
    refused.el.querySelector('button[data-intent=save]').click()
    await settle()
    expect(refused.el.querySelector('[data-form-error]').textContent).toContain('ไม่มีสิทธิ์')
    expect(refused.el.querySelector('input[name="level:c1"][value=a]').checked).toBe(true)
  })

  it('autosave: choosing a level keeps a private draft; the discard button appears once there is one', async () => {
    vi.useFakeTimers()
    const { el, services } = await openReview(detail())
    const discard = el.querySelector('[data-action=discard]')
    expect(discard.hidden).toBe(true)
    pick(el, 'c1', 'b')
    el.querySelector('input[name="level:c1"][value=b]').dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(1100)
    expect(services.reviews.saveReview).toHaveBeenCalledWith('s1', {
      scores: { c1: { level: 'b' } },
      feedback: null,
      outcome: null,
      reason: null,
    })
    expect(services.reviews.release).not.toHaveBeenCalled() // a draft only
    expect(discard.hidden).toBe(false)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    discard.click()
    await vi.advanceTimersByTimeAsync(10)
    expect(services.reviews.discard).toHaveBeenCalledWith('R9') // the draft autosave created
    window.confirm.mockRestore()
    vi.useRealTimers()
  })
})

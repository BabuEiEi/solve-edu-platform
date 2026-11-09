import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  allocationNotice,
  attemptState,
  buildDraft,
  buildLinks,
  hasContent,
  isOverdue,
  nextAction,
  reviewsOf,
  scoreText,
  taskFilePath,
  validateTaskFile,
} from '../../src/features/submissions/logic.js'
import { createSubmissionService } from '../../src/features/submissions/service.js'
import { renderMyTasksView, renderTaskPageView } from '../../src/features/submissions/views.js'
import { AppError } from '../../src/core/errors.js'
vi.mock('../../src/shared/ui/dialog.js', () => ({ confirmDialog: vi.fn(), promptDialog: vi.fn() }))
import { confirmDialog } from '../../src/shared/ui/dialog.js'

const XSS = '<img src=x onerror=alert(1)>'
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}
const file = (type, size = 1000, name = 'f') => ({ type, size, name })

describe('files', () => {
  it('accepts PDF/Office/images up to 20 MB and 5 files; refuses video and others, in Thai', () => {
    expect(validateTaskFile(file('application/pdf'))).toBe('pdf')
    expect(
      validateTaskFile(file('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
    ).toBe('docx')
    expect(validateTaskFile(file('image/png', 20 * 1024 * 1024))).toBe('png')
    expect(() => validateTaskFile(file('video/mp4'))).toThrow('วิดีโอให้ส่งเป็นลิงก์')
    expect(() => validateTaskFile(file('application/x-msdownload'))).toThrow('ชนิดไฟล์ไม่รองรับ')
    expect(() => validateTaskFile(file('application/pdf', 20 * 1024 * 1024 + 1))).toThrow('เกิน 20 MB')
    expect(() => validateTaskFile(file('application/pdf'), 5)).toThrow('ไม่เกิน 5 ไฟล์')
    expect(() => validateTaskFile(null)).toThrow(AppError)
  })

  it('the path is <attempt>/<random>.<ext>; the client file name is never in it', () => {
    expect(taskFilePath('S1', 'pdf', 'U')).toBe('S1/U.pdf')
    expect(taskFilePath('S1', 'png')).toMatch(/^S1\/[0-9a-f-]{36}\.png$/)
  })
})

describe('links and the draft', () => {
  it('blank rows are dropped; https only; labels optional; at most 5', () => {
    expect(
      buildLinks([
        { url: ' https://a.example.test/x ', label: ' แผน ' },
        { url: '', label: '' },
        { url: 'https://b.example.test' },
      ])
    ).toEqual([{ url: 'https://a.example.test/x', label: 'แผน' }, { url: 'https://b.example.test' }])
    expect(() => buildLinks([{ url: 'http://a.example.test' }])).toThrow(
      'ลิงก์ที่ 1: ต้องขึ้นต้นด้วย https://'
    )
    expect(() => buildLinks([{ url: 'javascript:alert(1)' }])).toThrow('https://')
    expect(() => buildLinks([{ url: '', label: 'มีแต่ชื่อ' }])).toThrow('กรุณาใส่ที่อยู่ลิงก์')
    expect(() =>
      buildLinks(Array.from({ length: 6 }, (_, i) => ({ url: `https://x.example.test/${i}` })))
    ).toThrow('ไม่เกิน 5')
  })

  it('draft: trimmed text or null; content check counts text, links and files', () => {
    const d = buildDraft({ text: '  ข้อความ  ', linkRows: [] })
    expect(d).toEqual({ text_response: 'ข้อความ', links: [] })
    expect(buildDraft({ text: '   ', linkRows: [] }).text_response).toBeNull()
    expect(() => buildDraft({ text: 'x'.repeat(20001), linkRows: [] })).toThrow('ยาวเกิน 20,000')
    expect(hasContent({ text_response: null, links: [] }, 0)).toBe(false)
    expect(hasContent({ text_response: null, links: [] }, 1)).toBe(true)
    expect(hasContent({ text_response: null, links: [{ url: 'https://a.example.test' }] }, 0)).toBe(true)
  })
})

describe('what the trainee can do next', () => {
  const task = { max_attempts: 3 }
  const sub = (n, status = 'submitted') => ({ id: 's' + n, attempt_no: n, status })
  const act = (submissions, reviews = {}, allocation = {}, now = Date.parse('2026-12-01T00:00:00Z')) =>
    nextAction({ allocation, task, submissions, currentOf: (id) => reviews[id] ?? null, now })

  it('start, open draft, waiting, again, passed, used up, not open yet', () => {
    expect(act([])).toBe('start')
    expect(act([sub(1, 'draft')])).toBe('open')
    expect(act([sub(1)])).toBe('waiting')
    expect(act([sub(1)], { s1: { outcome: 'revise' } })).toBe('again')
    expect(act([sub(1)], { s1: { outcome: 'passed' } })).toBe('passed')
    expect(act([sub(3), sub(2), sub(1)], { s3: { outcome: 'revise' } })).toBe('used_up')
    expect(act([], {}, { available_at: '2026-12-02T00:00:00Z' })).toBe('not_open')
    expect(act([sub(1, 'draft')], {}, { available_at: '2026-12-02T00:00:00Z' })).toBe('open') // a draft already exists
  })

  it('the review in force is the newest release; state and score text', () => {
    const { current, earlier } = reviewsOf([
      { id: 'a', released_at: '2026-11-01T00:00:00Z', outcome: 'revise' },
      { id: 'b', released_at: '2026-11-03T00:00:00Z', outcome: 'passed' },
    ])
    expect(current.id).toBe('b')
    expect(earlier.map((r) => r.id)).toEqual(['a'])
    expect(reviewsOf([]).current).toBeNull()
    expect(attemptState({ status: 'draft' }, null)).toBe('draft')
    expect(attemptState({ status: 'submitted' }, null)).toBe('waiting')
    expect(attemptState({ status: 'submitted' }, { outcome: 'revise' })).toBe('revise')
    expect(scoreText({ score: '3.00', max_score: '5.00' })).toBe('3 / 5')
    expect(scoreText({ score: null, max_score: null })).toBe('')
    expect(isOverdue({ due_at: '2026-11-01T00:00:00Z' }, Date.parse('2026-11-02T00:00:00Z'))).toBe(true)
    expect(isOverdue({ due_at: null })).toBe(false)
  })
})

describe('service', () => {
  const make = ({ listed = [], removed = [] } = {}) => {
    const calls = []
    const bucket = {
      upload: vi.fn(async () => ({ data: {}, error: null })),
      remove: vi.fn(async (paths) => (removed.push(...paths), { data: [], error: null })),
      list: vi.fn(async () => ({ data: listed, error: null })),
      createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
    }
    const insertResult = { data: { id: 'F1' }, error: null }
    const b = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve(insertResult)
          if (prop === 'single') return async () => insertResult
          return (...args) => (calls.push([prop, ...args]), b)
        },
      }
    )
    return {
      calls,
      bucket,
      insertResult,
      client: {
        from: (t) => (calls.push(['from', t]), b),
        rpc: vi.fn(async () => ({ data: 'S1', error: null })),
        storage: { from: () => bucket },
      },
    }
  }

  it('addFile uploads under the attempt folder, then records it', async () => {
    const m = make()
    const row = await createSubmissionService(m.client).addFile(
      'S1',
      file('application/pdf', 10, 'แผน.pdf'),
      0
    )
    expect(row).toEqual({ id: 'F1' })
    const [path] = m.bucket.upload.mock.calls[0]
    expect(path).toMatch(/^S1\/[0-9a-f-]{36}\.pdf$/)
    expect(m.calls).toContainEqual([
      'insert',
      { submission_id: 'S1', object_path: path, file_name: 'แผน.pdf' },
    ])
  })

  it('a refused file never reaches storage; a failed record removes the uploaded object', async () => {
    const m = make()
    await expect(createSubmissionService(m.client).addFile('S1', file('video/mp4'), 0)).rejects.toThrow(
      'ชนิดไฟล์'
    )
    expect(m.bucket.upload).not.toHaveBeenCalled()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = make()
    bad.insertResult.data = null
    bad.insertResult.error = { code: '23514', message: 'x' }
    await expect(
      createSubmissionService(bad.client).addFile('S1', file('application/pdf'), 0)
    ).rejects.toThrow()
    expect(bad.bucket.remove).toHaveBeenCalledTimes(1)
    console.error.mockRestore?.()
  })

  it('cleanOrphans removes only unrecorded objects older than the grace period', async () => {
    const now = Date.parse('2026-11-05T12:00:00Z')
    const m = make({
      listed: [
        { name: 'kept.pdf', created_at: '2026-11-05T00:00:00Z' },
        { name: 'orphan.pdf', created_at: '2026-11-05T00:00:00Z' },
        { name: 'just-now.pdf', created_at: '2026-11-05T11:58:00Z' },
      ],
    })
    const removed = await createSubmissionService(m.client).cleanOrphans(
      'S1',
      [{ object_path: 'S1/kept.pdf' }],
      { now }
    )
    expect(removed).toEqual(['S1/orphan.pdf'])
    expect(m.bucket.remove).toHaveBeenCalledWith(['S1/orphan.pdf'])
  })

  it('saveDraft says so when no row was updated (already submitted)', async () => {
    const m = make()
    m.insertResult.data = []
    await expect(
      createSubmissionService(m.client).saveDraft('S1', { text_response: 'x', links: [] })
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('selects explicit columns only', async () => {
    const m = make()
    m.insertResult.data = []
    await createSubmissionService(m.client).listMine('U')
    for (const [op, cols] of m.calls.filter(([op]) => op === 'select')) expect([op, cols]).not.toContain('*')
  })
})

describe('pages', () => {
  afterEach(() => document.body.replaceChildren())
  const task = {
    id: 'T',
    course_id: 'K',
    title: XSS,
    instructions: XSS,
    rubric_version_id: 'RV',
    max_attempts: 3,
    status: 'published',
    courses: { id: 'K', title: 'หลักสูตร' },
  }
  const allocation = {
    id: 'A1',
    task_id: 'T',
    cohort_id: 'C',
    available_at: null,
    due_at: '2027-03-31T16:59:00Z',
    cohorts: { id: 'C', code: 'R1', name: 'รุ่น 1' },
    tasks: task,
  }
  const criteria = [
    {
      id: 'c1',
      prompt: 'เป้าหมาย',
      max_score: 4,
      options_json: {
        levels: [
          { id: 'a', label: 'ต่ำ', score: 1 },
          { id: 'b', label: 'สูง', score: 4 },
        ],
      },
    },
  ]
  const base = (o = {}) => ({
    allocation,
    submissions: [],
    files: [],
    reviews: [],
    scores: [],
    criteria,
    ...o,
  })
  const sub = (n, o = {}) => ({
    id: 's' + n,
    allocation_id: 'A1',
    user_id: 'u1',
    attempt_no: n,
    status: 'submitted',
    text_response: 'งานรอบ ' + n,
    links: [],
    submitted_at: '2026-11-05T01:00:00Z',
    is_late: false,
    ...o,
  })
  const makeServices = (detail) => ({
    submissions: {
      listMine: vi.fn(async () => ({ allocations: [allocation], submissions: detail.submissions })),
      getDetail: vi.fn(async () => detail),
      signedUrls: vi.fn(async () => ({ 'S/f.pdf': 'https://files.example.test/f.pdf?token=1' })),
      cleanOrphans: vi.fn(async () => []),
      markSeen: vi.fn(async () => 1),
      start: vi.fn(async () => 's1'),
      saveDraft: vi.fn(async () => {}),
      submit: vi.fn(async () => ({})),
      addFile: vi.fn(async () => ({})),
      removeFile: vi.fn(async () => {}),
    },
  })
  const open = async (detail) => {
    const services = makeServices(detail)
    const el = document.createElement('div')
    document.body.append(el)
    await renderTaskPageView(el, { services, session: { user: { id: 'u1' } } }, { allocationId: 'A1' })
    return { el, services }
  }

  it('list: tasks with due date and attempts used; text escaped', async () => {
    const services = makeServices(base({ submissions: [sub(1)] }))
    const el = document.createElement('div')
    await renderMyTasksView(el, { services, session: { user: { id: 'u1' } } })
    expect(services.submissions.listMine).toHaveBeenCalledWith('u1')
    expect(el.querySelector('[data-my-tasks] a').getAttribute('href')).toBe('#/tasks/A1')
    expect(el.textContent.replace(/\s+/g, ' ')).toContain('ส่งแล้ว 1/3 รอบ')
    expect(el.querySelector('img')).toBeNull()
    const empty = document.createElement('div')
    await renderMyTasksView(empty, {
      services: { submissions: { listMine: async () => ({ allocations: [], submissions: [] }) } },
      session: { user: { id: 'u1' } },
    })
    expect(empty.textContent).toContain('ยังไม่มีภาระงาน')
  })

  it('no attempt yet: instructions escaped, rubric shown, a start button; starting opens a draft', async () => {
    const { el, services } = await open(base())
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-rubric]').textContent).toContain('เป้าหมาย')
    el.querySelector('[data-action=start]').click()
    await settle()
    expect(services.submissions.start).toHaveBeenCalledWith('A1')
  })

  it('a draft: nothing to submit is stopped on the page; a bad link keeps the form; save and submit go in order', async () => {
    const draft = sub(1, { status: 'draft', submitted_at: null, is_late: null, text_response: null })
    const { el, services } = await open(base({ submissions: [draft] }))
    const form = el.querySelector('form[data-form=draft]')
    form.querySelector('button[data-intent=submit]').click()
    await settle()
    expect(form.querySelector('[data-form-error]').textContent).toContain('อย่างน้อยหนึ่งอย่าง')
    expect(services.submissions.saveDraft).not.toHaveBeenCalled()
    form.querySelector('[name=text]').value = 'งานของฉัน'
    form.querySelector('[name=link_url]').value = 'http://nope.example.test'
    form.querySelector('button[data-intent=save]').click()
    await settle()
    expect(form.querySelector('[data-form-error]').textContent).toContain('https://')
    expect(el.querySelector('[name=text]').value).toBe('งานของฉัน')
    form.querySelector('[name=link_url]').value = 'https://ok.example.test'
    confirmDialog.mockResolvedValue(true)
    form.querySelector('button[data-intent=submit]').click()
    await settle()
    expect(services.submissions.saveDraft).toHaveBeenCalledWith('s1', {
      text_response: 'งานของฉัน',
      links: [{ url: 'https://ok.example.test' }],
    })
    expect(services.submissions.submit).toHaveBeenCalledWith('s1')
    expect(services.submissions.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(
      services.submissions.submit.mock.invocationCallOrder[0]
    )
    expect(el.textContent).toContain('ส่งงานแล้ว')
    confirmDialog.mockReset()
  })

  it('a refused submit keeps the form with the server message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const draft = sub(1, { status: 'draft', submitted_at: null, is_late: null, text_response: 'x' })
    const { el, services } = await open(base({ submissions: [draft] }))
    services.submissions.submit = vi.fn(async () => {
      throw new AppError('ส่งงานรอบนี้ไปแล้ว')
    })
    confirmDialog.mockResolvedValue(true)
    el.querySelector('button[data-intent=submit]').click()
    await settle()
    expect(el.querySelector('form[data-form=draft] [data-form-error]').textContent).toContain(
      'ส่งงานรอบนี้ไปแล้ว'
    )
    confirmDialog.mockReset()
  })

  it('files: attached list with remove, the picker uploads, five files fill it, orphans are cleaned on open', async () => {
    const draft = sub(1, { status: 'draft', submitted_at: null, is_late: null })
    const files = [
      { id: 'f1', submission_id: 's1', object_path: 'S/f.pdf', file_name: 'แผน.pdf', size_bytes: 2048 },
    ]
    const { el, services } = await open(base({ submissions: [draft], files }))
    expect(services.submissions.cleanOrphans).toHaveBeenCalledWith('s1', files)
    expect(el.querySelector('[data-file=f1]').textContent).toContain('แผน.pdf')
    el.querySelector('[data-action=remove-file]').click()
    await settle()
    expect(services.submissions.removeFile).toHaveBeenCalledWith(files[0])
    const input = el.querySelector('input[name=task_file]')
    const pdf = new File(['%PDF'], 'ใหม่.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { value: [pdf], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(services.submissions.addFile).toHaveBeenCalledWith('s1', pdf, 1)
    const five = Array.from({ length: 5 }, (_, i) => ({
      id: 'g' + i,
      submission_id: 's1',
      object_path: 'p' + i,
      file_name: 'f' + i,
      size_bytes: 10,
    }))
    const full = await open(base({ submissions: [draft], files: five }))
    expect(full.el.querySelector('input[name=task_file]')).toBeNull()
    expect(full.el.textContent).toContain('แนบครบ 5 ไฟล์แล้ว')
  })

  it('links can be added up to five and removed; the last row is cleared, not removed', async () => {
    const draft = sub(1, { status: 'draft', submitted_at: null, is_late: null })
    const { el } = await open(base({ submissions: [draft] }))
    const form = el.querySelector('form[data-form=draft]')
    for (let i = 0; i < 6; i++) form.querySelector('[data-action=add-link]').click()
    expect(form.querySelectorAll('[data-link-row]')).toHaveLength(5)
    expect(form.querySelector('[data-form-error]').textContent).toContain('ไม่เกิน 5')
    while (form.querySelectorAll('[data-link-row]').length > 1)
      form.querySelector('[data-action=remove-link]').click()
    form.querySelector('[name=link_url]').value = 'https://x.example.test'
    form.querySelector('[data-action=remove-link]').click()
    expect(form.querySelectorAll('[data-link-row]')).toHaveLength(1)
    expect(form.querySelector('[name=link_url]').value).toBe('')
  })

  it('history: attempts with late badge, links safe, files signed, the review with scores, earlier reviews folded', async () => {
    const s1 = sub(1, { is_late: true, links: [{ url: 'https://docs.example.test/p', label: XSS }] })
    const detail = base({
      submissions: [sub(2), s1],
      files: [
        { id: 'f1', submission_id: 's1', object_path: 'S/f.pdf', file_name: 'แผน.pdf', size_bytes: 3000 },
      ],
      reviews: [
        {
          id: 'r1',
          submission_id: 's1',
          outcome: 'revise',
          feedback: XSS,
          score: '1.00',
          max_score: '4.00',
          released_at: '2026-11-06T00:00:00Z',
          regrade_reason: 'ตรวจใหม่',
        },
        {
          id: 'r0',
          submission_id: 's1',
          outcome: 'passed',
          feedback: 'เดิม',
          score: '4.00',
          max_score: '4.00',
          released_at: '2026-11-05T05:00:00Z',
          regrade_reason: null,
        },
      ],
      scores: [{ review_id: 'r1', criterion_id: 'c1', level_id: 'a', score: '1.00', comment: 'ปรับ' }],
    })
    const { el } = await open(detail)
    expect(el.querySelector('img')).toBeNull() // feedback, link label: text only
    expect(el.querySelector('[data-attempt="1"]').textContent).toContain('ส่งช้า')
    expect(el.querySelector('[data-attempt="1"] [data-review]').textContent).toContain('คะแนน 1 / 4')
    expect(el.querySelector('[data-attempt="1"] [data-review-scores]').textContent).toContain('ต่ำ (1/4)')
    expect(el.querySelector('[data-attempt="1"] [data-earlier-reviews]').textContent).toContain('4 / 4')
    expect(
      el.querySelector('[data-attempt="1"] a[href="https://files.example.test/f.pdf?token=1"]')
    ).not.toBeNull()
    expect(el.querySelector('[data-attempt="1"] a[href="https://docs.example.test/p"]').rel).toContain(
      'noopener'
    )
    expect(el.querySelector('[data-attempt="2"] [data-review]')).toBeNull() // waiting
    expect(el.querySelector('[data-actions]').textContent).toContain('รอผู้ตรวจ')
  })

  it('a task that is not visible shows a Thai not-found page', async () => {
    const services = makeServices(null)
    const el = document.createElement('div')
    await renderTaskPageView(el, { services, session: { user: { id: 'u1' } } }, { allocationId: 'X' })
    expect(el.textContent).toContain('ไม่พบภาระงาน')
  })

  it('autosave: typing saves the draft a moment later (no button), a half-typed bad link waits, leaving is guarded', async () => {
    vi.useFakeTimers()
    const draft = sub(1, { status: 'draft', submitted_at: null, is_late: null, text_response: null })
    const { el, services } = await open(base({ submissions: [draft] }))
    const form = el.querySelector('form[data-form=draft]')
    const status = form.querySelector('[data-save-status]')
    const type = (name, value) => {
      form.querySelector(`[name=${name}]`).value = value
      form.querySelector(`[name=${name}]`).dispatchEvent(new Event('input', { bubbles: true }))
    }
    type('text', 'ร่างที่พิมพ์ค้างไว้')
    expect(status.dataset.state).toBe('dirty')
    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true) // unsaved: the browser asks
    await vi.advanceTimersByTimeAsync(1100)
    expect(services.submissions.saveDraft).toHaveBeenCalledWith('s1', {
      text_response: 'ร่างที่พิมพ์ค้างไว้',
      links: [],
    })
    expect(status.dataset.state).toBe('saved')
    type('link_url', 'http://half-typed')
    await vi.advanceTimersByTimeAsync(1100)
    expect(services.submissions.saveDraft).toHaveBeenCalledTimes(1) // an invalid link is not sent
    expect(status.textContent).toContain('ตรวจข้อมูลที่กรอกก่อน')
    type('link_url', 'https://ok.example.test')
    await vi.advanceTimersByTimeAsync(1100)
    expect(services.submissions.saveDraft).toHaveBeenLastCalledWith('s1', {
      text_response: 'ร่างที่พิมพ์ค้างไว้',
      links: [{ url: 'https://ok.example.test' }],
    })
    vi.useRealTimers()
  })

  it('opening a task with released results marks them seen and refreshes the menu badge; none to mark otherwise', async () => {
    const refreshNotices = vi.fn()
    const detail = base({
      submissions: [sub(1)],
      reviews: [
        {
          id: 'r1',
          submission_id: 's1',
          outcome: 'revise',
          score: '1',
          max_score: '4',
          released_at: '2026-11-06T00:00:00Z',
        },
      ],
    })
    const services = makeServices(detail)
    const el = document.createElement('div')
    document.body.append(el)
    await renderTaskPageView(
      el,
      { services, session: { user: { id: 'u1' } }, refreshNotices },
      { allocationId: 'A1' }
    )
    await settle()
    expect(services.submissions.markSeen).toHaveBeenCalledWith('A1')
    expect(refreshNotices).toHaveBeenCalledTimes(1)
    const none = await open(base())
    expect(none.services.submissions.markSeen).not.toHaveBeenCalled()
  })

  it('the list shows "มีผลตรวจใหม่" for unopened results and "ต้องแก้ไข" for returned work, and clears them once seen', async () => {
    const reviews = [
      { id: 'r1', submission_id: 's1', outcome: 'revise', released_at: '2026-11-06T00:00:00Z' },
    ]
    const render = async (readIds) => {
      const services = makeServices(base({ submissions: [sub(1)] }))
      services.submissions.listMine = vi.fn(async () => ({
        allocations: [allocation],
        submissions: [sub(1)],
        reviews,
        readIds,
      }))
      const el = document.createElement('div')
      await renderMyTasksView(el, { services, session: { user: { id: 'u1' } } })
      return el
    }
    const fresh = await render(new Set())
    expect(fresh.querySelector('[data-notice=unread]')).not.toBeNull()
    expect(fresh.querySelector('[data-notice=revise]')).not.toBeNull()
    const seen = await render(new Set(['r1']))
    expect(seen.querySelector('[data-notice=unread]')).toBeNull()
    expect(seen.querySelector('[data-notice=revise]')).not.toBeNull() // still needs revising
  })

  it('allocationNotice: unread count; revise only with attempts left and no draft open', () => {
    const task = { max_attempts: 2 }
    const r = (id, submission, outcome, at = '2026-11-05T00:00:00Z') => ({
      id,
      submission_id: submission,
      outcome,
      released_at: at,
    })
    expect(
      allocationNotice({ submissions: [sub(1)], reviews: [r('a', 's1', 'revise')], readIds: new Set(), task })
    ).toEqual({ unread: 1, revise: true })
    expect(
      allocationNotice({
        submissions: [sub(1)],
        reviews: [r('a', 's1', 'revise')],
        readIds: new Set(['a']),
        task,
      })
    ).toEqual({ unread: 0, revise: true })
    expect(
      allocationNotice({
        submissions: [sub(2), sub(1)],
        reviews: [r('a', 's1', 'revise')],
        readIds: new Set(['a']),
        task,
      }).revise
    ).toBe(false) // attempt 2 waits for review
    expect(
      allocationNotice({
        submissions: [sub(2), sub(1)],
        reviews: [r('a', 's2', 'revise')],
        readIds: new Set(['a']),
        task,
      }).revise
    ).toBe(false) // both attempts used
    expect(
      allocationNotice({
        submissions: [sub(2, { status: 'draft' }), sub(1)],
        reviews: [r('a', 's1', 'revise')],
        readIds: new Set(),
        task,
      }).revise
    ).toBe(false) // a draft is open
    expect(
      allocationNotice({ submissions: [sub(1)], reviews: [r('a', 's1', 'passed')], readIds: new Set(), task })
        .revise
    ).toBe(false)
    expect(allocationNotice({ submissions: [], reviews: [], readIds: new Set(), task })).toEqual({
      unread: 0,
      revise: false,
    })
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  createBuilderService,
  moveId,
  nextOrder,
  learnerVisibility,
} from '../../src/features/builder/service.js'
import { renderCourseBuilderView, renderLessonEditorView } from '../../src/features/builder/views.js'
import {
  renderCoursesView,
  renderCourseOutlineView,
  learnerOutline,
} from '../../src/features/courses/views.js'
import { mountRichTextEditor, richTextEditorMarkup } from '../../src/shared/ui/richTextEditor.js'
import { render } from '../../src/shared/ui/html.js'

const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('builder helpers', () => {
  it('moveId moves within bounds only', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveId(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
  })
  it('nextOrder = max + 1', () => {
    expect(nextOrder([{ display_order: 3 }, { display_order: 7 }])).toBe(8)
    expect(nextOrder([])).toBe(1)
  })
  it('learnerVisibility explains what hides a lesson', () => {
    const pub = { status: 'published' }
    expect(learnerVisibility(pub, pub, pub)).toEqual({ visible: true, hiddenBy: [] })
    expect(learnerVisibility({ status: 'draft' }, pub, { status: 'draft' }).hiddenBy).toEqual([
      'หลักสูตร',
      'บทเรียน',
    ])
  })
  it('learnerOutline keeps only published units and lessons', () => {
    const c = learnerOutline({
      course_units: [
        { status: 'published', lessons: [{ status: 'published' }, { status: 'draft' }] },
        { status: 'draft', lessons: [{ status: 'published' }] },
      ],
    })
    expect(c.course_units).toHaveLength(1)
    expect(c.course_units[0].lessons).toHaveLength(1)
  })
})

/** Fake PostgREST builder: records calls, resolves queued results. */
function fakeClient(results = []) {
  const calls = []
  const queue = [...results]
  const builder = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then')
          return (resolve) => resolve(queue.shift() ?? { data: [{ id: 'x' }], error: null })
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
    rpc: vi.fn(async () => queue.shift() ?? { data: null, error: null }),
  }
}

describe('builder service', () => {
  it('updateCourse sends only whitelisted fields (owner_org_id is immutable)', async () => {
    const c = fakeClient()
    await createBuilderService(c).updateCourse('K', {
      title: ' AfL ',
      owner_org_id: 'evil',
      status: 'published',
      x: 1,
    })
    expect(c.calls.find(([op]) => op === 'update')[1]).toEqual({ title: 'AfL', status: 'published' })
  })
  it('rejects unknown statuses and empty titles before calling the server', async () => {
    const c = fakeClient()
    const s = createBuilderService(c)
    await expect(s.updateUnit('U', { status: 'live' })).rejects.toThrow('สถานะ')
    await expect(s.addLesson('U', '   ', 1)).rejects.toThrow('ชื่อ')
    expect(c.calls.some(([op]) => op === 'update' || op === 'insert')).toBe(false)
  })
  it('createCourse always starts as draft', async () => {
    const c = fakeClient([{ data: { id: 'K' }, error: null }])
    await createBuilderService(c).createCourse({
      owner_org_id: 'O',
      code: 'C1',
      title: 'T',
      status: 'published',
    })
    expect(c.calls.find(([op]) => op === 'insert')[1]).toMatchObject({ status: 'draft', owner_org_id: 'O' })
  })
  it('an update filtered out by RLS (0 rows) is reported, not silent', async () => {
    const c = fakeClient([{ data: [], error: null }])
    await expect(createBuilderService(c).updateLesson('L', { title: 'x' })).rejects.toThrow('ไม่มีสิทธิ์')
  })
  it('deleting a lesson with learner progress gives an actionable message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = fakeClient([{ data: null, error: { code: '23503', message: 'fk' } }])
    await expect(createBuilderService(c).deleteLesson('L')).rejects.toThrow('เก็บถาวร')
    spy.mockRestore()
  })
  it('reorder calls the atomic RPC', async () => {
    const c = fakeClient()
    await createBuilderService(c).reorder('unit', 'K', ['b', 'a'])
    expect(c.rpc).toHaveBeenCalledWith('reorder_course_items', {
      p_kind: 'unit',
      p_parent: 'K',
      p_ids: ['b', 'a'],
    })
  })
})

const tree = () => ({
  id: 'K',
  code: 'AFL',
  title: 'AfL',
  status: 'draft',
  course_units: [
    {
      id: 'U1',
      title: 'หน่วย 1',
      status: 'published',
      display_order: 1,
      lessons: [
        { id: 'L1', title: 'บท 1', status: 'published', display_order: 1 },
        { id: 'L2', title: '<img src=x onerror=alert(1)>', status: 'draft', display_order: 2 },
      ],
    },
    { id: 'U2', title: 'หน่วย 2', status: 'draft', display_order: 2, lessons: [] },
  ],
})

function builderServices(overrides = {}) {
  return {
    courses: { getAccess: async () => 'manage' },
    builder: {
      getCourseTree: vi.fn(async () => tree()),
      reorder: vi.fn(async () => {}),
      updateLesson: vi.fn(async () => ({ id: 'L' })),
      updateCourse: vi.fn(async () => ({ id: 'K' })),
      addUnit: vi.fn(async () => ({ id: 'U3' })),
      addBlock: vi.fn(async () => ({ id: 'B' })),
      updateBlock: vi.fn(async () => ({ id: 'B' })),
      deleteBlock: vi.fn(async () => ({ id: 'B' })),
    },
    lessons: {
      getLesson: vi.fn(async () => ({
        id: 'L1',
        unit_id: 'U1',
        title: 'บท 1',
        status: 'published',
        course_units: { id: 'U1', course_id: 'K', status: 'published' },
        lesson_blocks: [
          {
            id: 'B1',
            block_type: 'image',
            display_order: 1,
            content_json: { object_path: 'L1/a.png', alt: 'ภาพ' },
          },
          { id: 'B2', block_type: 'link', display_order: 2, content_json: { url: 'https://x.example.test' } },
        ],
      })),
    },
    media: {
      signedUrls: async () => ({ 'L1/a.png': 'https://signed.example.test/a' }),
      upload: vi.fn(async (lessonId) => `${lessonId}/new.png`),
      remove: vi.fn(async () => {}),
    },
    editor: {
      mount: vi.fn(async () => ({ getHTML: () => '<p>ใหม่</p>', focus() {}, destroy() {} })),
    },
    ...overrides,
  }
}

describe('course builder view', () => {
  it('denies users without manage access', async () => {
    const el = document.createElement('div')
    await renderCourseBuilderView(
      el,
      { services: builderServices({ courses: { getAccess: async () => 'view' } }) },
      { id: 'K' }
    )
    expect(el.textContent).toContain('ไม่มีสิทธิ์แก้ไข')
  })

  it('renders units/lessons safely and reorders, publishes, adds through services', async () => {
    const el = document.createElement('div')
    const services = builderServices()
    await renderCourseBuilderView(el, { services }, { id: 'K' })
    expect(el.querySelectorAll('[data-action=move-unit]')).toHaveLength(4)
    expect(el.querySelector('img')).toBeNull() // lesson title is escaped
    expect(el.querySelector('[data-action=move-unit][data-id=U1][data-delta="-1"]').disabled).toBe(true)

    el.querySelector('[data-action=move-unit][data-id=U1][data-delta="1"]').click()
    await flush()
    expect(services.builder.reorder).toHaveBeenCalledWith('unit', 'K', ['U2', 'U1'])

    el.querySelector('[data-action=toggle-lesson][data-id=L2]').click()
    await flush()
    expect(services.builder.updateLesson).toHaveBeenCalledWith('L2', { status: 'published' })

    const form = el.querySelector('form[data-form=add-unit]')
    form.querySelector('input[name=title]').value = 'หน่วย 3'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(services.builder.addUnit).toHaveBeenCalledWith('K', 'หน่วย 3', 3)
    expect(el.textContent).toContain('เพิ่มหน่วยแล้ว')
  })
})

describe('lesson editor view', () => {
  const open = async (services) => {
    const el = document.createElement('div')
    await renderLessonEditorView(el, { services }, { id: 'K', lessonId: 'L1' })
    return el
  }

  it('warns when learners cannot see the lesson and links to the learner preview', async () => {
    const el = await open(builderServices())
    expect(el.textContent).toContain('ผู้เรียนยังมองไม่เห็นบทเรียนนี้')
    expect(el.textContent).toContain('หลักสูตร')
    expect(el.querySelector('a[href="#/learn/K/L1"]')).not.toBeNull()
  })

  it('adds a rich-text block through the editor (sanitised on save)', async () => {
    const services = builderServices()
    const el = await open(services)
    el.querySelector('[data-action=new-block][data-type=rich_text]').click()
    await flush()
    expect(services.editor.mount).toHaveBeenCalled()
    el.querySelector('form[data-form=block]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await flush()
    expect(services.builder.addBlock).toHaveBeenCalledWith('L1', 'rich_text', { html: '<p>ใหม่</p>' }, 3)
  })

  it('keeps the form open and shows the error when validation fails', async () => {
    const services = builderServices()
    const el = await open(services)
    el.querySelector('[data-action=new-block][data-type=link]').click()
    const form = el.querySelector('form[data-form=block]')
    form.querySelector('input[name=url]').value = 'http://insecure.example.test'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(services.builder.addBlock).not.toHaveBeenCalled()
    expect(el.querySelector('form[data-form=block] [data-form-error]').textContent).toContain('https://')
    expect(el.querySelector('form[data-form=block] input[name=url]').value).toBe(
      'http://insecure.example.test'
    )
  })

  it('deleting a media block also removes its file', async () => {
    const services = builderServices()
    const el = await open(services)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    el.querySelector('[data-action=delete-block][data-id=B1]').click()
    await flush()
    expect(services.builder.deleteBlock).toHaveBeenCalledWith('B1')
    expect(services.media.remove).toHaveBeenCalledWith(['L1/a.png'])
  })

  it('reorders blocks via the RPC', async () => {
    const services = builderServices()
    const el = await open(services)
    el.querySelector('[data-action=move-block][data-id=B2][data-delta="-1"]').click()
    await flush()
    expect(services.builder.reorder).toHaveBeenCalledWith('block', 'L1', ['B2', 'B1'])
  })
})

describe('course list / preview', () => {
  it('course creators get a create form scoped to their organisations', async () => {
    const el = document.createElement('div')
    const createCourse = vi.fn(async () => ({ id: 'NEW' }))
    const services = { courses: { listVisibleCourses: async () => [] }, builder: { createCourse } }
    const context = {
      orgMemberships: [
        { org_role: 'supervisor', organizations: { id: 'D', name: 'เขต' } },
        { org_role: 'teacher', organizations: { id: 'S', name: 'โรงเรียน' } },
      ],
    }
    await renderCoursesView(el, {
      services,
      caps: { canCreateCourses: true, isPlatformAdmin: false },
      context,
    })
    el.querySelector('[data-action=create-course]').click()
    await flush()
    const options = [...el.querySelectorAll('select[name=owner_org_id] option')].map((o) => o.value)
    expect(options).toEqual(['D'])
    const form = el.querySelector('form[data-form=create-course]')
    form.querySelector('[name=code]').value = 'C-1'
    form.querySelector('[name=title]').value = 'หลักสูตรใหม่'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(createCourse).toHaveBeenCalledWith(expect.objectContaining({ owner_org_id: 'D', code: 'C-1' }))
    expect(window.location.hash).toBe('#/courses/NEW/builder')
  })

  it('learners do not see the create button', async () => {
    const el = document.createElement('div')
    await renderCoursesView(el, {
      services: { courses: { listVisibleCourses: async () => [] } },
      caps: { canCreateCourses: false },
      context: {},
    })
    expect(el.querySelector('[data-action=create-course]')).toBeNull()
  })

  it('preview shows only learner-visible content with a banner', async () => {
    const el = document.createElement('div')
    const services = {
      courses: {
        getCourseOutline: async () => tree(),
        listMyEnrollments: async () => [],
        getAccess: async () => 'manage',
      },
    }
    await renderCourseOutlineView(
      el,
      { services, session: { user: { id: 'u' } } },
      { id: 'K', preview: true }
    )
    expect(el.textContent).toContain('โหมดตัวอย่าง')
    expect(el.querySelector('a[href="#/learn/K/L1"]')).not.toBeNull()
    expect(el.querySelector('a[href="#/learn/K/L2"]')).toBeNull()
    expect(el.textContent).not.toContain('หน่วย 2')
  })
})

describe('rich text editor (Tiptap)', () => {
  it('mounts, applies toolbar commands and returns sanitised HTML', async () => {
    // jsdom has no layout engine; ProseMirror asks for rects when scrolling into view.
    const rects = () => Object.assign([], { length: 0 })
    Element.prototype.getClientRects ??= rects
    Range.prototype.getClientRects ??= rects
    Range.prototype.getBoundingClientRect ??= () => ({
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
    })
    const host = document.createElement('div')
    document.body.append(host)
    render(host, richTextEditorMarkup())
    const editor = await mountRichTextEditor(host.firstElementChild, '<p>ข้อความ<script>x</script></p>')
    expect(editor.getHTML()).toBe('<p>ข้อความ</p>')
    host.querySelector('[data-cmd=h2]').click()
    expect(editor.getHTML()).toBe('<h2>ข้อความ</h2>')
    editor.destroy()
    host.remove()
  })
})

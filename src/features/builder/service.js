import { unwrap, AppError } from '../../core/errors.js'
import { BLOCK_COLUMNS } from '../lessons/service.js'

const byOrder = (a, b) => a.display_order - b.display_order
export const CONTENT_STATUSES = ['draft', 'published', 'archived']

/** Keep only whitelisted keys that are present; trim strings; '' → null for optional text. */
function pick(patch, spec) {
  const out = {}
  for (const [key, kind] of Object.entries(spec)) {
    if (patch?.[key] === undefined) continue
    const v = patch[key]
    if (kind === 'text') out[key] = String(v ?? '').trim()
    else if (kind === 'optionalText') out[key] = String(v ?? '').trim() || null
    else if (kind === 'int') out[key] = v === '' || v === null ? null : Math.max(0, Math.round(Number(v)))
    else if (kind === 'bool') out[key] = Boolean(v)
    else if (kind === 'status') {
      if (!CONTENT_STATUSES.includes(v)) throw new AppError('สถานะไม่ถูกต้อง')
      out[key] = v
    }
  }
  if ('title' in out && !out.title) throw new AppError('กรุณาระบุชื่อ')
  if ('code' in out && !out.code) throw new AppError('กรุณาระบุรหัสหลักสูตร')
  return out
}

const COURSE_SPEC = {
  code: 'text',
  title: 'text',
  summary: 'optionalText',
  description: 'optionalText',
  duration_minutes: 'int',
  status: 'status',
}
const UNIT_SPEC = { title: 'text', description: 'optionalText', status: 'status' }
const LESSON_SPEC = { title: 'text', learning_objectives: 'optionalText', required: 'bool', status: 'status' }

/** 23503 on delete = rows still reference it (e.g. learners' lesson_progress). */
function friendlyDelete(err) {
  if (err?.code === '23503')
    return new AppError(
      'ลบไม่ได้ เพราะมีผู้เรียนบันทึกความก้าวหน้าแล้ว — ให้เปลี่ยนสถานะเป็น "เก็บถาวร" แทน',
      {
        code: err.code,
        cause: err,
      }
    )
  return err
}

export function createBuilderService(client) {
  /** UPDATE/DELETE filtered by RLS affect 0 rows silently; make that an error. */
  const one = async (query, context) => {
    const rows = unwrap(await query, context)
    if (!rows || rows.length === 0)
      throw new AppError('ไม่พบข้อมูล หรือท่านไม่มีสิทธิ์แก้ไข', { code: '42501' })
    return rows[0]
  }
  const remove = async (table, id) => {
    try {
      return await one(client.from(table).delete().eq('id', id).select('id'), `${table}.delete`)
    } catch (err) {
      throw friendlyDelete(err)
    }
  }

  return {
    /** Full tree including drafts (managers only see drafts through RLS). */
    async getCourseTree(courseId) {
      const course = unwrap(
        await client
          .from('courses')
          .select(
            'id, code, title, summary, description, duration_minutes, status, owner_org_id, course_units ( id, title, description, display_order, status, lessons ( id, title, display_order, status, required ) )'
          )
          .eq('id', courseId)
          .maybeSingle(),
        'builder.tree'
      )
      if (!course) return null
      course.course_units = (course.course_units ?? []).sort(byOrder)
      for (const u of course.course_units) u.lessons = (u.lessons ?? []).sort(byOrder)
      return course
    },

    async createCourse(fields) {
      const row = pick(fields, COURSE_SPEC)
      if (!fields?.owner_org_id) throw new AppError('กรุณาเลือกหน่วยงานเจ้าของหลักสูตร')
      if (!row.code || !row.title) throw new AppError('กรุณาระบุรหัสและชื่อหลักสูตร')
      return unwrap(
        await client
          .from('courses')
          .insert({ ...row, status: 'draft', owner_org_id: fields.owner_org_id })
          .select('id')
          .single(),
        'courses.create'
      )
    },

    async updateCourse(id, patch) {
      return one(
        client.from('courses').update(pick(patch, COURSE_SPEC)).eq('id', id).select('id, status'),
        'courses.update'
      )
    },

    async addUnit(courseId, title, displayOrder) {
      const row = pick({ title }, UNIT_SPEC)
      return unwrap(
        await client
          .from('course_units')
          .insert({ course_id: courseId, title: row.title, display_order: displayOrder, status: 'draft' })
          .select('id')
          .single(),
        'units.create'
      )
    },
    async updateUnit(id, patch) {
      return one(
        client.from('course_units').update(pick(patch, UNIT_SPEC)).eq('id', id).select('id'),
        'units.update'
      )
    },
    deleteUnit: (id) => remove('course_units', id),

    async addLesson(unitId, title, displayOrder) {
      const row = pick({ title }, LESSON_SPEC)
      return unwrap(
        await client
          .from('lessons')
          .insert({ unit_id: unitId, title: row.title, display_order: displayOrder, status: 'draft' })
          .select('id')
          .single(),
        'lessons.create'
      )
    },
    async updateLesson(id, patch) {
      return one(
        client.from('lessons').update(pick(patch, LESSON_SPEC)).eq('id', id).select('id'),
        'lessons.update'
      )
    },
    deleteLesson: (id) => remove('lessons', id),

    async addBlock(lessonId, blockType, content, displayOrder) {
      return unwrap(
        await client
          .from('lesson_blocks')
          .insert({
            lesson_id: lessonId,
            block_type: blockType,
            content_json: content,
            display_order: displayOrder,
          })
          .select(BLOCK_COLUMNS)
          .single(),
        'blocks.create'
      )
    },
    async updateBlock(id, content) {
      return one(
        client.from('lesson_blocks').update({ content_json: content }).eq('id', id).select(BLOCK_COLUMNS),
        'blocks.update'
      )
    },
    deleteBlock: (id) => remove('lesson_blocks', id),

    /** Atomic server-side reorder (SECURITY INVOKER RPC). */
    async reorder(kind, parentId, ids) {
      unwrap(
        await client.rpc('reorder_course_items', { p_kind: kind, p_parent: parentId, p_ids: ids }),
        'rpc.reorder_course_items'
      )
    },
  }
}

/** Move `id` by `delta` positions; returns a new array (unchanged at the ends). */
export function moveId(ids, id, delta) {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return ids
  const next = [...ids]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

/** Next free display_order (max + 1). */
export function nextOrder(items = []) {
  return items.reduce((m, i) => Math.max(m, i.display_order ?? 0), 0) + 1
}

/** Learners see a lesson only when course, unit and lesson are all published. */
export function learnerVisibility(course, unit, lesson) {
  const hidden = [
    course?.status !== 'published' && 'หลักสูตร',
    unit?.status !== 'published' && 'หน่วย',
    lesson && lesson.status !== 'published' && 'บทเรียน',
  ].filter(Boolean)
  return { visible: hidden.length === 0, hiddenBy: hidden }
}

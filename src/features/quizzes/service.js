import { unwrap, AppError } from '../../core/errors.js'
import { ITEM_COLUMNS } from '../assessments/service.js'
import { itemMediaPaths } from '../assessments/logic.js'

export const INSTRUMENT_COLUMNS =
  'id, owner_org_id, course_id, code, title, description, status, instrument_type, created_at'
export const VERSION_COLUMNS = 'id, instrument_id, version_no, status, published_at, content_hash, created_at'

const byVersion = (a, b) => a.version_no - b.version_no

/**
 * Quiz authoring. Keys are WRITE-ONLY: set_item_key() stores them and
 * item_key_status() reports has_key / key_valid; nothing here can read a key.
 */
export function createQuizBuilderService(client) {
  /** UPDATE/DELETE filtered by RLS affect 0 rows silently; make that an error. */
  const one = async (query, context) => {
    const rows = unwrap(await query, context)
    if (!rows || rows.length === 0)
      throw new AppError('ไม่พบข้อมูล หรือท่านไม่มีสิทธิ์แก้ไข', { code: '42501' })
    return rows[0]
  }
  const withVersions = `${INSTRUMENT_COLUMNS}, instrument_versions ( ${VERSION_COLUMNS} )`
  const sortVersions = (i) =>
    i ? { ...i, instrument_versions: [...(i.instrument_versions ?? [])].sort(byVersion) } : i

  return {
    /** Quizzes by default; pass 'rubric' for the course's rubrics. */
    async listForCourse(courseId, type = 'quiz') {
      const rows = unwrap(
        await client
          .from('instruments')
          .select(withVersions)
          .eq('course_id', courseId)
          .eq('instrument_type', type)
          .order('created_at', { ascending: true }),
        'quizzes.list'
      )
      return (rows ?? []).map(sortVersions)
    },

    async getInstrument(instrumentId) {
      return sortVersions(
        unwrap(
          await client.from('instruments').select(withVersions).eq('id', instrumentId).maybeSingle(),
          'quizzes.get'
        )
      )
    },

    /** New instrument under the course's owner org + its first (draft) version. */
    async createInstrument(course, { code, title, description }, type = 'quiz') {
      const noun = type === 'rubric' ? ' Rubric' : 'แบบทดสอบ'
      const row = {
        owner_org_id: course.owner_org_id,
        course_id: course.id,
        code: String(code ?? '').trim(),
        title: String(title ?? '').trim(),
        description: String(description ?? '').trim() || null,
        ...(type === 'quiz' ? {} : { instrument_type: type }),
      }
      if (!row.code) throw new AppError(`กรุณาระบุรหัส${noun}`)
      if (!row.title) throw new AppError(`กรุณาระบุชื่อ${noun}`)
      const instrument = unwrap(
        await client.from('instruments').insert(row).select(INSTRUMENT_COLUMNS).single(),
        'quizzes.create'
      )
      unwrap(
        await client
          .from('instrument_versions')
          .insert({ instrument_id: instrument.id })
          .select('id')
          .single(),
        'quizzes.first_version'
      )
      return instrument
    },

    async getItems(versionId) {
      return (
        unwrap(
          await client
            .from('instrument_items')
            .select(ITEM_COLUMNS)
            .eq('instrument_version_id', versionId)
            .order('display_order', { ascending: true }),
          'quizzes.items'
        ) ?? []
      )
    },

    /** { [item_id]: { has_key, key_valid } } — never key content. */
    async keyStatus(versionId) {
      const rows =
        unwrap(await client.rpc('item_key_status', { p_version: versionId }), 'quizzes.key_status') ?? []
      return Object.fromEntries(rows.map((r) => [r.item_id, { has_key: r.has_key, key_valid: r.key_valid }]))
    },

    async addItem(versionId, item, displayOrder) {
      return unwrap(
        await client
          .from('instrument_items')
          .insert({ ...item, instrument_version_id: versionId, display_order: displayOrder })
          .select(ITEM_COLUMNS)
          .single(),
        'quizzes.add_item'
      )
    },

    async updateItem(itemId, item) {
      return one(
        client.from('instrument_items').update(item).eq('id', itemId).select(ITEM_COLUMNS),
        'quizzes.update_item'
      )
    },

    async deleteItem(itemId) {
      return one(
        client.from('instrument_items').delete().eq('id', itemId).select('id'),
        'quizzes.delete_item'
      )
    },

    /**
     * Import rows (importFile.analyzeQuizImport → items) into a draft: all or
     * none. The server names a failing row as DETAIL "แถวที่ n" (n-th item of
     * the batch); the message adds the spreadsheet row (header = row 1).
     */
    async importItems(versionId, items) {
      const res = await client.rpc('import_instrument_items', { p_version: versionId, p_items: items })
      const n = /^แถวที่ (\d+)$/.exec(res.error?.details ?? '')?.[1]
      try {
        return unwrap(res, 'quizzes.import')
      } catch (err) {
        if (!n) throw err
        throw new AppError(
          `ระบบไม่รับข้อที่ ${n} ในไฟล์ (แถว ${Number(n) + 1}) — ${err.message} · ยังไม่มีข้อใดถูกนำเข้า`,
          {
            code: err.code,
            cause: err.cause,
          }
        )
      }
    },

    async reorderItems(versionId, ids) {
      unwrap(
        await client.rpc('reorder_course_items', { p_kind: 'item', p_parent: versionId, p_ids: ids }),
        'quizzes.reorder'
      )
    },

    /** Every image path any item of any version of the quiz refers to. */
    async usedMediaPaths(instrumentId) {
      const rows =
        unwrap(
          await client
            .from('instrument_items')
            .select('media_path, options_json, instrument_versions!inner ( instrument_id )')
            .eq('instrument_versions.instrument_id', instrumentId),
          'quizzes.used_media'
        ) ?? []
      return itemMediaPaths(rows)
    },

    /** Write-only answer key. The scoring mode is an item column (scoring_mode), not part of the key. */
    async setKey(itemId, { answer }) {
      unwrap(await client.rpc('set_item_key', { p_item: itemId, p_answer: answer }), 'quizzes.set_key')
    },

    async publish(versionId) {
      return unwrap(
        await client.rpc('publish_instrument_version', { p_version: versionId }),
        'quizzes.publish'
      )
    },

    async clone(versionId) {
      return unwrap(await client.rpc('clone_instrument_version', { p_version: versionId }), 'quizzes.clone')
    },

    /** Assignments linked to a course (for the quiz_reference lesson block). */
    async listCourseAssignments(courseId) {
      return (
        unwrap(
          await client
            .from('assessment_assignments')
            .select('id, title, purpose, status, cohort_id, cohorts ( code, name )')
            .eq('course_id', courseId)
            .order('created_at', { ascending: true }),
          'quizzes.course_assignments'
        ) ?? []
      )
    },
  }
}

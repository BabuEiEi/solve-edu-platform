import { unwrap, AppError } from '../../core/errors.js'

export const TASK_COLUMNS =
  'id, course_id, unit_id, title, instructions, rubric_version_id, max_attempts, status, created_at'
const ALLOCATION_COLUMNS = 'id, task_id, cohort_id, available_at, due_at, cohorts ( id, code, name )'
const WITH_ALLOCATIONS = `${TASK_COLUMNS}, instrument_versions ( id, version_no, instruments ( id, title ) ), task_allocations ( ${ALLOCATION_COLUMNS} )`

/**
 * Staff side of tasks (ภาระงาน): create and publish a task, open it to
 * cohorts. RLS decides every row (course managers; cohort assessors for
 * allocations); the server validates rubric, course and cohort again.
 */
export function createTaskService(client) {
  const one = async (query, context) => {
    const rows = unwrap(await query, context)
    if (!rows || rows.length === 0)
      throw new AppError('ไม่พบข้อมูล หรือท่านไม่มีสิทธิ์แก้ไข', { code: '42501' })
    return rows[0]
  }

  return {
    async listForCourse(courseId) {
      return (
        unwrap(
          await client
            .from('tasks')
            .select(WITH_ALLOCATIONS)
            .eq('course_id', courseId)
            .order('created_at', { ascending: true }),
          'tasks.list'
        ) ?? []
      )
    },

    async get(taskId) {
      return unwrap(
        await client.from('tasks').select(WITH_ALLOCATIONS).eq('id', taskId).maybeSingle(),
        'tasks.get'
      )
    },

    async create(courseId, payload) {
      return unwrap(
        await client
          .from('tasks')
          .insert({ course_id: courseId, ...payload })
          .select(TASK_COLUMNS)
          .single(),
        'tasks.create'
      )
    },

    async update(taskId, patch) {
      return one(client.from('tasks').update(patch).eq('id', taskId).select(TASK_COLUMNS), 'tasks.update')
    },

    async remove(taskId) {
      return one(client.from('tasks').delete().eq('id', taskId).select('id'), 'tasks.delete')
    },

    async addAllocation(taskId, cohortId, dates) {
      return unwrap(
        await client
          .from('task_allocations')
          .insert({ task_id: taskId, cohort_id: cohortId, ...dates })
          .select(ALLOCATION_COLUMNS)
          .single(),
        'tasks.allocate'
      )
    },

    async updateAllocation(allocationId, dates) {
      return one(
        client.from('task_allocations').update(dates).eq('id', allocationId).select(ALLOCATION_COLUMNS),
        'tasks.allocation_update'
      )
    },

    async removeAllocation(allocationId) {
      return one(
        client.from('task_allocations').delete().eq('id', allocationId).select('id'),
        'tasks.allocation_delete'
      )
    },
  }
}

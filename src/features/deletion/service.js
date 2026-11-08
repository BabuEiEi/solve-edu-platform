import { AppError } from '../../core/errors.js'

const CALL = { course: 'delete_course', instrument: 'delete_instrument', task: 'delete_task' }
const ARG = { course: 'p_course', instrument: 'p_instrument', task: 'p_task' }

/**
 * Delete what nobody has used (database functions: rights, typed
 * confirmation, re-check, audit). SE009 = it was used in the meantime.
 */
export function createDeletionService(client) {
  return {
    /** → { can_delete, reasons: {enrollments?, attempts?, …} } */
    async usage(kind, id) {
      const { data, error } = await client.rpc('deletion_usage', { p_kind: kind, p_id: id })
      if (error)
        throw new AppError(
          error.code === '42501' ? 'ท่านไม่มีสิทธิ์จัดการรายการนี้' : 'ตรวจการใช้งานไม่สำเร็จ',
          { code: error.code, cause: error }
        )
      return data
    },

    async remove(kind, id, confirm) {
      if (!CALL[kind]) throw new AppError('ชนิดรายการไม่ถูกต้อง')
      const { data, error } = await client.rpc(CALL[kind], { [ARG[kind]]: id, p_confirm: confirm })
      if (error) {
        const message =
          error.code === 'SE009'
            ? 'มีผู้เริ่มใช้รายการนี้แล้ว จึงลบไม่ได้ — ใช้การเก็บถาวรแทน (โหลดหน้าใหม่เพื่อดูเหตุผล)'
            : error.code === '22023'
              ? 'ข้อความที่พิมพ์ยืนยันไม่ตรง'
              : error.code === '42501'
                ? 'ท่านไม่มีสิทธิ์ลบรายการนี้'
                : error.code === '23503'
                  ? 'มีผู้เริ่มใช้รายการนี้ระหว่างที่ลบ จึงลบไม่ได้ — โหลดหน้าใหม่'
                  : 'ลบไม่สำเร็จ กรุณาลองใหม่'
        throw new AppError(message, { code: error.code, cause: error })
      }
      return data
    },
  }
}

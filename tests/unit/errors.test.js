import { describe, it, expect, vi } from 'vitest'
import { unwrap, toUserMessage, AppError } from '../../src/core/errors.js'

describe('errors', () => {
  it('maps RLS / permission errors to Thai', () => {
    expect(toUserMessage({ code: '42501', message: 'new row violates row-level security policy' })).toBe(
      'คุณไม่มีสิทธิ์ดำเนินการนี้'
    )
  })
  it('never leaks raw database messages', () => {
    expect(toUserMessage({ message: 'relation "private.audit_logs" does not exist' })).toBe(
      'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'
    )
  })
  it('says what to do when an archived quiz or rubric is used again (SE010)', () => {
    expect(toUserMessage({ code: 'SE010', message: 'this quiz is archived' })).toBe(
      'แบบทดสอบหรือ Rubric นี้ถูกเก็บถาวรแล้ว กรุณากด “นำกลับมาใช้” ที่หน้าของมันก่อน'
    )
  })
  it('cohort joining and enrollment codes have Thai messages (4g)', () => {
    expect(toUserMessage({ code: 'SE011' })).toContain('เต็มจำนวน')
    expect(toUserMessage({ code: 'SE012' })).toContain('ไม่ได้เปิดรับสมัคร')
    expect(toUserMessage({ code: 'SE013' })).toContain('เฉพาะผู้เข้าอบรมของรุ่นนี้')
    expect(toUserMessage({ code: 'SE014' })).toContain('รุ่นนี้ปิดแล้ว')
  })
  it('unwrap throws AppError when Supabase returns an error (SEC-05)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unwrap({ data: null, error: { code: '23505', message: 'dup' } })).toThrow(AppError)
    expect(unwrap({ data: [1], error: null })).toEqual([1])
    spy.mockRestore()
  })
})

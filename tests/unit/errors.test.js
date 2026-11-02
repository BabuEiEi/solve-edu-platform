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
  it('unwrap throws AppError when Supabase returns an error (SEC-05)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => unwrap({ data: null, error: { code: '23505', message: 'dup' } })).toThrow(AppError)
    expect(unwrap({ data: [1], error: null })).toEqual([1])
    spy.mockRestore()
  })
})

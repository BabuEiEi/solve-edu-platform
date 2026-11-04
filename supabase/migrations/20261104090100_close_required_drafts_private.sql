-- =====================================================================
-- Phase 2B.1 / step 2 follow-up (owner decisions 2026-11-04)
--
-- 1. Every published assignment closes at a set date and time, so every
--    attempt has a deadline and an abandoned one is always finalised.
-- 2. In-progress answers (draft_json) are private to the trainee until they
--    are submitted: no client role may read the column. The trainee gets
--    their own draft back only through start_attempt (SECURITY DEFINER).
--    Staff see answers once submitted, in assessment_responses.
-- =====================================================================

alter table public.assessment_assignments
  add constraint assessment_assignments_published_close
    check (status <> 'published' or close_at is not null);

comment on column public.assessment_assignments.close_at is 'เวลาปิดรับ — บังคับเมื่อเผยแพร่ (ทุกครั้งที่ทำจึงมีเส้นตาย และถูกปิดอัตโนมัติเสมอ)';

revoke select on public.assessment_attempts from authenticated;
grant select (id, assignment_id, user_id, attempt_no, status, started_at, submitted_at, score, max_score,
              passed, correct_count, item_count, draft_saved_at, auto_submitted)
  on public.assessment_attempts to authenticated;

comment on column public.assessment_attempts.draft_json is 'คำตอบที่บันทึกระหว่างทำ — ไม่ GRANT ให้ client (ผู้เรียนรับคืนผ่าน start_attempt เท่านั้น); ใช้ให้คะแนนเมื่อหมดเวลา; ล้างเมื่อส่งแล้ว';

# API Contracts — Phase 1 + 2A + 2B + 2B.1

Frontend คุยกับ Supabase Data API (PostgREST) ด้วย supabase-js; สิทธิ์ทั้งหมดบังคับในฐานข้อมูล

## 1. RPC

### `admin_set_profile_status(p_target uuid, p_status text, p_reason text = null) → void`

| | |
|---|---|
| เรียกโดย | `authenticated` (ไม่มีสิทธิ์สำหรับ `anon`) |
| `p_status` | `pending` \| `active` \| `suspended` |
| สำเร็จ | อัปเดต `profiles.status` + เขียน `private.audit_logs` (`action = 'SET_STATUS'`, before/after, reason) |
| `42501` | ไม่ได้ล็อกอิน · แก้ตนเอง · อยู่นอกขอบเขต · เป้าหมายเป็นผู้ถือบทบาทสูงกว่าที่ผู้เรียกจัดการได้ |
| `22023` | status ไม่ถูกต้อง |
| `P0002` | ไม่พบโปรไฟล์ |

```js
await supabase.rpc('admin_set_profile_status', { p_target: id, p_status: 'active', p_reason: 'ยืนยันตัวตนแล้ว' })
```

Client wrapper (`features/admin/service.js`) บังคับเหตุผลเมื่อ `suspended` ก่อนเรียก server

### `get_profile_contact(p_target uuid) → text`

ตนเอง หรือผู้ที่ `authz.can_admin_user(p_target)` · อื่น ๆ → `42501`

## 2. Table access patterns ที่ UI ใช้

| Use case | Query | หมายเหตุ |
|---|---|---|
| บริบทผู้ใช้ | `profiles.select(PROFILE_COLUMNS).eq('id', uid)` + `platform_role_assignments` + `organization_memberships(…, organizations(…))` + `cohort_memberships(…, cohorts(…))` | `PROFILE_COLUMNS` ไม่มี `contact_email` |
| แก้โปรไฟล์ | `profiles.update({ full_name, display_name }).eq('id', uid)` | คอลัมน์อื่นได้ 42501 |
| ขอสังกัด (pending) | `profiles.update({ requested_org_id })` | หลัง active → 42501 |
| คิวอนุมัติ | `profiles.select('…, organizations!profiles_requested_org_fk(name)').eq('status', s)` | ต้องระบุชื่อ FK เพราะมี 2 เส้นทาง |
| รายชื่อสถานศึกษา | `organizations.select('id, code, name, org_type, parent_id').eq('active', true)` | |
| โครงการ | `programs.select('…, organizations(name), cohorts(…)')` | |
| หลักสูตร | `courses.select(…)`; outline: `courses.select('…, course_units(…, lessons(…))')` | draft ถูกซ่อนโดย RLS |
| ความก้าวหน้าของฉัน | `course_enrollments.select('…, lesson_progress(…)').eq('user_id', uid)` | |
| บันทึกความก้าวหน้า (Phase 2 UI) | `lesson_progress.insert({ enrollment_id, lesson_id, status, progress_percent })` / `update({ status, progress_percent })` | เวลา server ประทับ; ห้ามส่ง `started_at/completed_at` |

## 2.1 Phase 2A

| Use case | การเรียก | หมายเหตุ |
|---|---|---|
| สิทธิ์ต่อหลักสูตร | `rpc('course_access', { p_course })` → `manage\|view\|none` | ใช้แสดงเครื่องมือเท่านั้น |
| เรียงลำดับ | `rpc('reorder_course_items', { p_kind: 'unit'\|'lesson'\|'block', p_parent, p_ids })` | atomic; ต้องส่งครบทุกรายการ |
| บทเรียน + บล็อก | `lessons.select('…, course_units(…), lesson_blocks(id, block_type, content_json, display_order)')` | draft ซ่อนจากผู้เรียนโดย RLS |
| เริ่มเรียน | `lesson_progress.upsert({enrollment_id, lesson_id, status:'in_progress'}, {onConflict:'enrollment_id,lesson_id', ignoreDuplicates:true})` | ไม่ลดสถานะที่ completed แล้ว |
| เรียนจบ | `lesson_progress.update({ status:'completed' })` (ถ้า 0 แถวค่อย `insert`) | **ส่งแค่ status** — `completed_at`/`progress_percent` ประทับโดย trigger |
| ไฟล์สื่อ | `storage.from('lesson-media').upload('<lesson_id>/<uuid>.<ext>', file)` · `createSignedUrls(paths, 3600)` | ไม่ใช้ `getPublicUrl` (bucket private) |
| นำเข้ารายชื่อ | `preregistrations.insert([...])` ครั้งเดียว = transaction เดียว | ไม่ส่ง `status/imported_by/claimed_*` |
| ผูกบัญชีหลังล็อกอิน | `rpc('claim_my_preregistrations')` → integer | เรียกก่อนโหลด context; ล้มเหลวแล้วไม่บล็อกการล็อกอิน |

## 2.2 Phase 2B — Assessment

**ไม่มีเฉลยในเส้นทางใดไปถึง browser**: คอลัมน์ข้อสอบที่เลือกคือ `ITEM_COLUMNS = 'id, item_type, prompt, media_path, options_json, max_score, display_order'` (`options_json` มีได้เพียง `id/text/image_path` ต่อตัวเลือก — DB ตรวจ)

| Use case | การเรียก | หมายเหตุ |
|---|---|---|
| สร้างแบบทดสอบ | `instruments.insert({owner_org_id, course_id, code, title, description})` แล้ว `instrument_versions.insert({instrument_id})` | เลขฉบับ/สถานะโดย server |
| เพิ่ม/แก้/ลบข้อ | `instrument_items.insert/update/delete` (ฉบับ draft) · เรียงด้วย `rpc('reorder_course_items', { p_kind: 'item', p_parent: version, p_ids })` | UPDATE ที่ RLS กรอง → service โยน 42501 |
| ตั้งเฉลย | `rpc('set_item_key', { p_item, p_answer, p_scoring })` | `p_answer`: `{correct:[ids]}` · `{correct:true\|false}` · `{value, tolerance}`; `p_scoring`: `{mode:'all_or_nothing'\|'partial'}` (mcq_multiple) |
| สถานะเฉลย | `rpc('item_key_status', { p_version })` → `[{item_id, has_key, key_valid}]` | |
| เผยแพร่ / สร้างฉบับใหม่ | `rpc('publish_instrument_version', { p_version })` → hash · `rpc('clone_instrument_version', { p_version })` → uuid | |
| รูปข้อสอบ | `storage.from('assessment-media').upload('<instrument_id>/<uuid>.<ext>')` · `createSignedUrls` | |
| ล้างรูปที่ไม่ได้ใช้ (2B.1) | `storage.from('assessment-media').list('<instrument_id>')` + `instrument_items.select('media_path, options_json, instrument_versions!inner(instrument_id)')` → `remove(paths)` คืนเฉพาะไฟล์ที่ลบได้จริง | หน้าจอเลือกเฉพาะไฟล์ที่ไม่มีข้อใดใช้และเก่ากว่า 24 ชม. · DB ปฏิเสธไฟล์ที่ยังใช้อยู่เสมอ |
| มอบหมายให้รุ่น | `assessment_assignments.insert({instrument_version_id, cohort_id, course_id, purpose, title, instructions, open_at, close_at, attempt_limit, passing_percent, time_limit_minutes, grace_minutes, status})` | `open_at/close_at` ส่งเป็น ISO `+07:00` จากช่องเวลาไทย · **`close_at` บังคับ** (UI ทุกกรณี; DB เมื่อ `published`) |
| แก้การตั้งค่า / เผยแพร่ / ปิดรับ / เก็บถาวร | `assessment_assignments.update({...}).eq('id').select('id')` | ปิดรับทันที = `close_at = now`; หลังมีผู้เริ่มทำ ห้ามส่ง `passing_percent/purpose/course_id` ที่เปลี่ยนค่า (SE004) |
| รุ่นที่มอบหมายได้ | `program_courses.select('programs(id, name, cohorts(id, code, name, status))').eq('course_id')` | UI กรองเฉพาะรุ่นที่ผู้ใช้เป็น trainer/coordinator/ผู้จัดการ; server ตัดสินจริง |
| แบบทดสอบของฉัน | `assessment_assignments.select('…, assessment_attempts(…)').eq('status','published').in('cohort_id', mine).eq('assessment_attempts.user_id', uid)` | |
| เริ่ม/ทำต่อ · ส่ง | `rpc('start_attempt', { p_assignment })` → `{attempt_id, attempt_no, started_at, resumed, deadline_at, server_now, draft, timed_out}` · `rpc('submit_attempt', { p_attempt, p_responses })` → คะแนนรวม + `auto_submitted` | `p_responses` = `{ [item_id]: {choice} \| {choices} \| {value} }`; ข้อที่ไม่ตอบไม่ต้องส่ง · `timed_out` = หมดเวลาแล้ว ระบบส่งให้ → ไปหน้าผล |
| บันทึกคำตอบระหว่างทำ (2B.1) | `rpc('save_attempt_draft', { p_attempt, p_responses, p_seq })` → `{saved_at, finalized, stale}` | ตัวเลือก: บันทึกทันที · ช่องตัวเลข: รอหยุดพิมพ์ 0.8 วินาที หรือบันทึกทันทีเมื่อออกจากช่อง · `p_seq` = `draft_seq` จาก `start_attempt` + ลำดับ · `finalized` = หมดเวลาแล้ว → ไปหน้าผล · `stale` = มีหน้าใหม่กว่า → แถบ "มีการทำต่อจากอีกเครื่องแล้ว กรุณาโหลดหน้าใหม่" และหยุดบันทึก · ไม่ใช้ localStorage |
| บันทึกครั้งสุดท้ายตอนออกจากหน้า (2B.1) | `fetch(POST /rest/v1/rpc/save_attempt_draft, { keepalive: true })` พร้อม `apikey` + `Authorization: Bearer <token ล่าสุด>` | เมื่อหน้าถูกซ่อน (สลับแอป/พับจอ), `pagehide` (ปิดแท็บ), ออกด้วยลิงก์ในระบบ · fire-and-forget · token จาก `onAuthStateChange` (หน้าที่กำลังปิดรอ supabase-js ไม่ได้) |
| เตือนก่อนออก (2B.1) | ยังบันทึกไม่เสร็จ: ลิงก์/ออกจากระบบในแอป → `confirm('ยังบันทึกไม่เสร็จ ออกจากหน้านี้หรือไม่')` · ปิดแท็บ/รีเฟรช → `beforeunload` (เบราว์เซอร์แสดงข้อความมาตรฐานของตัวเอง กำหนดข้อความเองไม่ได้) | |
| ตัวจับเวลา (2B.1) | นับถึง `deadline_at` โดยชดเชยนาฬิกาเครื่องด้วย `server_now` | หมดเวลา → ส่งสิ่งที่อยู่บนจอ (ข้อมูลตัวเลขที่พิมพ์ไม่ครบถูกข้าม); server รับถึงเส้นตาย+ผ่อนผัน |
| ให้สิทธิ์ทำเพิ่ม (2B.1) | `assessment_extra_attempts.insert({assignment_id, user_id, reason})` · อ่าน `select('id, user_id, reason, created_at')` | ห้ามส่ง `granted_by` |
| ผลของรุ่น (staff) | `rpc('assignment_results', { p_assignment })` → `[{user_id, name, on_roster, used, extra, in_progress, submitted, auto_submitted, first_score, first_max, best_score, best_max, best_passed, last_submitted_at}]` (2B.1) | หนึ่งแถวต่อคน คำนวณบน server; RLS ของผู้เรียกกำหนดแถว |
| วิเคราะห์ข้อสอบ (2B.1) | `rpc('item_statistics', { p_assignment })` → `{n, min_n, suppressed, basis:'first_attempt', group_size, k, max_score, mean_score, sd_score, reliability, reliability_kind:'kr20'\|'alpha', items:[{item_id, display_order, item_type, prompt, max_score, p, d, r_it, blank, choices}]}` | assessor เท่านั้น · `suppressed` เมื่อน้อยกว่า 5 คน (คืนแค่ `n`) |
| รายชื่อที่ควรทำ | `cohort_memberships.select('user_id, profiles!cohort_memberships_user_id_fkey(…)')` ∪ `mentor_assignments.select('trainee_id, profiles!mentor_assignments_trainee_id_fkey(…)').eq('mentor_id', uid)` | ต้องระบุชื่อ FK (มี 2 เส้นทางไป profiles) |

## 2.3 Phase 2C — ข้อสอบแบบใหม่ (กลุ่ม ก)

| item_type | `options_json` (ไม่มีเฉลย) | เฉลย (`set_item_key`) | คำตอบ (`p_responses[item_id]`) |
|---|---|---|---|
| `ordering` | `{options:[3–10 entries]}` | `{order:[ทุก id ครั้งเดียว]}` | `{order:[ทุก id ครั้งเดียว]}` |
| `matching` | `{left:[2–10], right:[≥ left, ≤ 15]}` | `{slots:{left id: right id}}` ครบทุกข้อ ไม่ซ้ำ | `{slots:{…}}` เว้นบางช่องได้ |
| `classification` | `{categories:[2–6], items:[2–15]}` | `{slots:{item id: category id}}` ครบ | `{slots:{…}}` |
| `choice_matrix` | `{rows:[1–15], columns:[2–6]}` | `{slots:{row id: column id}}` ครบ | `{slots:{…}}` |

entry = `{id: [a-z0-9]{1,8}, text?, image_path?}` · `scoring_json` = `{mode: 'partial' | 'all_or_nothing'}` ค่าเริ่มต้น **partial** (ตำแหน่ง/ช่องที่ถูก ÷ ทั้งหมด)

`start_attempt` คืน `presentation` = `{items:[item ids ตามลำดับที่เห็น], lists:{item id:{list:[ids]}}}` — ข้อเรียงลำดับสลับเสมอ (ไม่เริ่มในลำดับที่ถูก) · ฝั่งขวาของข้อจับคู่สลับเสมอ · อื่น ๆ ตาม `assessment_assignments.shuffle_items / shuffle_choices` (ค่าเริ่มต้นปิด) · เก็บไว้ที่ `assessment_attempts.presentation_json`

## 3. Error mapping (`src/core/errors.js`)

| code | ข้อความผู้ใช้ |
|---|---|
| `42501` | คุณไม่มีสิทธิ์ดำเนินการนี้ |
| `23505` | ข้อมูลนี้มีอยู่แล้วในระบบ |
| `23503` | ข้อมูลอ้างอิงไม่ถูกต้องหรือถูกใช้งานอยู่ |
| `23514` | ข้อมูลไม่ผ่านเงื่อนไขของระบบ |
| `22023` | ค่าที่ส่งมาไม่ถูกต้อง |
| `SE001` | แบบทดสอบนี้ยังไม่เปิดหรือปิดรับแล้ว |
| `SE002` | ท่านทำแบบทดสอบนี้ครบจำนวนครั้งที่กำหนดแล้ว |
| `SE003` | ส่งคำตอบของครั้งนี้ไปแล้ว (UI พาไปหน้าผลแทน) |
| `SE004` | มีผู้เริ่มทำแล้ว จึงแก้ประเภท เกณฑ์ผ่าน หรือหลักสูตร หรือย้อนเป็นฉบับร่างไม่ได้ (2B.1: รวมเวลาทำต่อครั้ง) |
| `SE005` | มีการทำต่อจากอีกเครื่องแล้ว กรุณาโหลดหน้าใหม่ (ส่งจากหน้าที่ถูกแทนที่) |
| `PGRST116` | ไม่พบข้อมูลที่ต้องการ |
| อื่น ๆ | ข้อความทั่วไป (ไม่เปิดเผยข้อความจากฐานข้อมูล) |

**หมายเหตุสำคัญ:** UPDATE/DELETE ที่ RLS กรองแถวออกจะ **ไม่ error** แต่ได้ 0 แถว — service ที่ต้องการยืนยันผลให้ต่อ `.select().single()` (จะได้ `PGRST116` เมื่อไม่มีสิทธิ์)

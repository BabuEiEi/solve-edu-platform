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
| ตั้งเฉลย | `rpc('set_item_key', { p_item, p_answer })` | `p_answer`: `{correct:[ids]}` · `{correct:true\|false}` · `{value, tolerance}` · `p_scoring` ต้องเป็น `{}` (ส่งโหมดมา → 23514) — **วิธีให้คะแนนอยู่ที่ `instrument_items.scoring_mode`** (2C.1): `'all_or_nothing'\|'partial'\|null` (null = ค่าเริ่มต้นของประเภท) ส่งพร้อม insert/update ข้อ และอ่านกลับได้ (ไม่ใช่ความลับ) |
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
| วิเคราะห์ข้อสอบ (2B.1) | `rpc('item_statistics', { p_assignment })` → `{n, min_n, suppressed, basis:'first_attempt', group_size, k, max_score, mean_score, sd_score, reliability, reliability_kind:'kr20'\|'alpha', items:[{item_id, display_order, item_type, prompt, max_score, p, d, r_it, blank, choices, slots}]}` · `slots` (2C) = `[{slot_id, no, label, correct_rate, answered}]` | assessor เท่านั้น · `suppressed` เมื่อน้อยกว่า 5 คน (คืนแค่ `n`) |
| รายชื่อที่ควรทำ | `cohort_memberships.select('user_id, profiles!cohort_memberships_user_id_fkey(…)')` ∪ `mentor_assignments.select('trainee_id, profiles!mentor_assignments_trainee_id_fkey(…)').eq('mentor_id', uid)` | ต้องระบุชื่อ FK (มี 2 เส้นทางไป profiles) |

## 2.3 Phase 2C — ข้อสอบแบบใหม่

| item_type | `options_json` (ไม่มีเฉลย) | เฉลย (`set_item_key`) | คำตอบ (`p_responses[item_id]`) |
|---|---|---|---|
| `ordering` | `{options:[3–10 entries]}` | `{order:[ทุก id ครั้งเดียว]}` | `{order:[ทุก id ครั้งเดียว]}` |
| `matching` | `{left:[2–10], right:[≥ left, ≤ 15]}` | `{slots:{left id: right id}}` ครบทุกข้อ ไม่ซ้ำ | `{slots:{…}}` เว้นบางช่องได้ |
| `classification` | `{categories:[2–6], items:[2–15]}` | `{slots:{item id: category id}}` ครบ | `{slots:{…}}` |
| `choice_matrix` | `{rows:[1–15], columns:[2–6]}` | `{slots:{row id: column id}}` ครบ | `{slots:{…}}` |

| `dropdown` | `{text:"…{{b1}}…", blanks:[{id, options:[2–10 entries ข้อความเท่านั้น]}] 1–20}` | `{slots:{blank id: option id}}` ครบ | `{slots:{…}}` |
| `cloze` | `{text:"…{{b1}}…", blanks:[{id, kind?: 'text'\|'number'}] 1–20}` | `{blanks:{b1:{accept:[1–10 คำ]}, b2:{value, tolerance?}}}` ครบ | `{blanks:{b1:"ข้อความ ≤ 200", b2: number}}` เว้นบางช่องได้ |
| `image_labelling` | `media_path` = รูป (บังคับ) · `{markers:[{id, x, y} % ของรูป] 1–15, labels:[2–20 entries ข้อความเท่านั้น]}` | `{slots:{marker id: label id}}` ครบ (ป้ายซ้ำได้) | `{slots:{…}}` |

หน้าทำข้อสอบ: เรียงลำดับ = ปุ่ม ↑ ↓ — ลำดับที่แสดงตอนเริ่ม**ไม่ใช่คำตอบ** จนกว่าจะย้ายรายการหรือกด "ใช้ลำดับนี้" (2C.1; ฟอร์มมีช่อง `q:<item>:set`, ไม่ส่ง `order` ถ้ายังไม่ตั้ง → นับเป็นไม่ตอบ ได้ 0) · ช่องที่ตัวเลือกเป็นข้อความล้วน = เมนูเลือก, มีรูป = แกลเลอรี (ข้อจับคู่) หรือการ์ด · ถ้าตัวเลือกของข้อจับคู่มีรูป (2C.1) = แกลเลอรีมีหมายเลขแสดงครั้งเดียว แล้วแต่ละแถวเลือก "รูปที่ N" จากเมนู (ชื่อ field และรูปแบบคำตอบเหมือนเดิม) · จัดกลุ่ม/ตารางตัวเลือก = ปุ่มตัวเลือกแบบชิป · ดรอปดาวน์/เติมคำ = ในประโยค · ติดป้าย = หมายเลขบนรูป + เมนูเลือกใต้รูป · ส่งแล้วเตือนทั้งข้อที่ยังไม่ตอบและข้อที่ตอบไม่ครบทุกช่อง · การมอบหมายมี `shuffle_items` / `shuffle_choices` ในฟอร์มตั้งค่า

ข้อความในเติมคำเทียบหลัง `private.normalize_answer`: NFKC (ำ = ํา), ลำดับการพิมพ์สระบน/ล่าง วรรณยุกต์ ํ ์ (2C.1: เรียงเป็นลำดับเดียว ตัดตัวที่พิมพ์ซ้ำ, "นำ้" = "น้ำ"), เลขไทย → 0–9, ตัดอักขระที่มองไม่เห็น, ยุบช่องว่าง, ไม่สนตัวพิมพ์เล็กใหญ่ — ไม่ตรวจคำสะกดใกล้เคียง · presentation ของดรอปดาวน์ใช้ชื่อรายการ `blank:<id>`

**ลำดับที่เก็บต้องไม่บอกเฉลย:** ผู้เรียนอ่าน `options_json` ได้หลังเริ่มทำ จึงห้ามเก็บข้อเรียงลำดับในลำดับที่ถูก และห้ามเก็บฝั่งขวาของข้อจับคู่ให้ทุกคู่อยู่ตำแหน่งเดียวกับฝั่งซ้าย (`set_item_key` ปฏิเสธ, `item_key_status.key_valid = false`) — หน้าสร้างข้อสอบใช้รหัสสุ่มและเก็บแบบสลับให้อัตโนมัติ

entry = `{id: [a-z0-9]{1,8}, text?, image_path?}` · `instrument_items.scoring_mode` = `'partial' | 'all_or_nothing'` ค่าเริ่มต้น (null) **partial** (ตำแหน่ง/ช่องที่ถูก ÷ ทั้งหมด) · mcq_multiple ค่าเริ่มต้น all_or_nothing · ข้อเลือกตอบเดียว/ถูกผิด/ตัวเลขไม่มีโหมด

**วิเคราะห์ข้อสอบรายส่วน (ขั้น 6):** `item_statistics` คืน `slots` ของข้อแบบใหม่ — หนึ่งแถวต่อส่วน (ตำแหน่งของข้อเรียงลำดับ · รายการฝั่งซ้าย/รายการที่จัดกลุ่ม/แถว · ช่องของดรอปดาวน์และเติมคำ เรียงตามที่ปรากฏในข้อความ · จุดบนรูป) มี `no` (ลำดับที่ผู้เรียนเห็น), `label` (ข้อความของส่วนนั้นถ้ามี), `correct_rate` (สัดส่วนคนที่ตอบส่วนนั้นถูก จากครั้งแรก), `answered` (จำนวนคนที่ตอบส่วนนั้น) · **ไม่มีจำนวนที่เลือกแต่ละตัวเลือกรายส่วน** เพื่อไม่ให้อนุมานเฉลยได้ · ข้อแบบเดิมได้ `slots: []` · ถูก/ผิดรายส่วนตัดสินด้วย `private.slot_hits` ตัวเดียวกับที่ให้คะแนน

`start_attempt` คืน `presentation` = `{items:[item ids ตามลำดับที่เห็น], lists:{item id:{list:[ids]}}}` — ข้อเรียงลำดับสลับเสมอ (ไม่เริ่มในลำดับที่ถูก) · ฝั่งขวาของข้อจับคู่สลับเสมอ · อื่น ๆ ตาม `assessment_assignments.shuffle_items / shuffle_choices` (ค่าเริ่มต้นปิด) · เก็บไว้ที่ `assessment_attempts.presentation_json`

## 2.4 Phase 2D — นำเข้าข้อสอบจากไฟล์

| เรื่อง | Call | หมายเหตุ |
|---|---|---|
| นำเข้าข้อพร้อมเฉลย | `rpc('import_instrument_items', { p_version, p_items })` → จำนวนข้อ | `p_items` = `[{item_type, prompt, max_score?, options_json, scoring_mode?, answer}]` · ประเภท `mcq_single`/`mcq_multiple`/`true_false`/`numeric` · ทุกแถวต้องมี `answer` (รูปแบบเดียวกับ `set_item_key`) · ไม่มีรูป · ≤ 200 แถว · ต่อท้ายฉบับร่าง · **ทั้งหมดหรือไม่เลย** · แถวผิด → error มี `details: 'แถวที่ n'` (n นับจาก 1 ตามลำดับใน array) · ฉบับที่ไม่ใช่ draft → 23514 · ไม่ใช่ผู้สร้างข้อสอบ → 42501 |

**ไฟล์นำเข้า (CSV)** — `src/features/quizzes/importFile.js` ตรวจในเบราว์เซอร์ก่อนส่ง (server ตรวจซ้ำ):

| คอลัมน์ | ความหมาย |
|---|---|
| `ประเภท` | เลือกตอบ · เลือกหลายคำตอบ · ถูกผิด · ตัวเลข |
| `โจทย์` · `คะแนน` | คะแนนว่าง = 1 |
| `ตัวเลือก1`–`ตัวเลือก6` | ข้อเลือกตอบ ≥ 2 ช่อง ใส่ต่อกันจากช่องแรก (ถูกผิด/ตัวเลขเว้นว่าง) |
| `คำตอบ` | เลือกตอบ/หลายคำตอบ = เลขลำดับตัวเลือก (`2`, `1,3`) · ถูกผิด = ถูก/ผิด · ตัวเลข = ค่า |
| `คลาดเคลื่อน` · `หน่วย` | เฉพาะข้อตัวเลข |
| `วิธีให้คะแนน` | เฉพาะเลือกหลายคำตอบ: บางส่วน / ทั้งหมด (ว่าง = ทั้งหมด) |

ลำดับคอลัมน์สลับได้ ใช้ชื่อเรียกอื่นได้บางชื่อ (เช่น `เฉลย`, `คำถาม`) คอลัมน์เกินถูกข้าม · รับเลขไทย · อ่านรหัส UTF-8 และ Windows-874 อัตโนมัติ · ≤ 200 ข้อ · error บอกเลขแถวตามที่เห็นในสเปรดชีต (หัวตาราง = แถว 1)

## 2.5 Phase 3 — Rubric

| เรื่อง | Call | หมายเหตุ |
|---|---|---|
| สร้าง Rubric | `from('instruments').insert({..., instrument_type: 'rubric'})` + ฉบับร่างแรก (เหมือนแบบทดสอบ) | `instrument_type` ตั้งได้ตอนสร้างเท่านั้น |
| เพิ่ม/แก้เกณฑ์ | `from('instrument_items')` `item_type: 'rubric_criterion'`, `prompt` = ชื่อเกณฑ์, `options_json` = `{description?, levels:[{id, label, score, description?}]}` | 2–6 ระดับ, id `[a-z0-9]{1,8}` ไม่ซ้ำ, คะแนน 0–1000 ไม่ซ้ำ (สูงสุด > 0) · `max_score` ที่ส่งมาถูกแทนด้วยคะแนนระดับสูงสุด · ไม่มีรูป ไม่มีโหมด ไม่มีเฉลย |
| เผยแพร่ / ฉบับใหม่ | `publish_instrument_version` / `clone_instrument_version` | Rubric เผยแพร่ได้โดยไม่ต้องมีเฉลย · มอบหมายเป็นแบบทดสอบไม่ได้ (23514) — ภาระงานใช้ Rubric (ขั้น 2–3) |

## 2.6 Phase 3 — ภาระงานและการส่งงาน

| เรื่อง | Call | หมายเหตุ |
|---|---|---|
| สร้าง/แก้ภาระงาน | `from('tasks')` insert `{course_id, unit_id?, title, instructions?, rubric_version_id?, max_attempts?, status}` · update (ยกเว้น `course_id`) | ผู้จัดการหลักสูตร · Rubric ต้องเป็นฉบับเผยแพร่ที่ตนจัดการได้ · มีผู้ส่งงานแล้วเปลี่ยน Rubric ไม่ได้ (**SE006**) · ลบได้เฉพาะร่าง |
| เปิดให้รุ่น | `from('task_allocations')` insert `{task_id, cohort_id, available_at?, due_at?}` · update วันที่ | ผู้ดูแลรุ่น · ภาระงานต้องเผยแพร่แล้ว และหลักสูตรอยู่ในโปรแกรมของรุ่น · รุ่นละครั้ง |
| เริ่ม/เปิดร่าง | `rpc('start_task_submission', { p_allocation })` → submission id | ผู้เรียนของรุ่น · คืนร่างเดิมถ้ามี · **SE001** ยังไม่ถึงวันเปิด · **SE002** ครบรอบ · **SE007** รอบล่าสุดรอตรวจหรือผ่านแล้ว |
| แก้ร่าง | `from('task_submissions').update({ text_response, links })` | เจ้าของ + ร่างเท่านั้น · ข้อความ ≤ 20,000 · ลิงก์ ≤ 5 `{url: https://…, label?}` |
| แนบไฟล์ | `storage.from('task-files').upload('<submission_id>/<ชื่อสุ่ม>', file)` แล้ว `from('task_submission_files').insert({ submission_id, object_path, file_name })` | ร่างของตนเท่านั้น · ≤ 5 ไฟล์ · ≤ 20 MB · PDF/Word/Excel/PowerPoint/รูป · ขนาดและชนิดระบบอ่านจาก storage · ลบได้ขณะเป็นร่าง |
| ส่ง | `rpc('submit_task_submission', { p_submission })` → แถวที่ส่ง | ต้องมีข้อความ ลิงก์ หรือไฟล์ · `submitted_at`, `is_late` จาก server · ส่งแล้วแก้ไม่ได้ (**SE003** ถ้าส่งซ้ำ) |
| ดูงาน | `from('task_submissions')`, `task_submission_files`, `storage.createSignedUrl` | เจ้าของเห็นทุกรอบรวมร่าง · ผู้ดูแลรุ่นเห็นงานที่**ส่งแล้ว**ทั้งรุ่น · ครูพี่เลี้ยงเห็นเฉพาะครูที่ดูแล · คนอื่นไม่เห็น |

**การตรวจงาน (ขั้น 3)**

| เรื่อง | Call | หมายเหตุ |
|---|---|---|
| บันทึกร่างการตรวจ | `rpc('save_task_review', { p_submission, p_scores, p_feedback, p_outcome, p_reason? })` → review id | ผู้ดูแลรุ่น หรือครูพี่เลี้ยงของครูคนนั้น — ไม่ใช่เจ้าของงาน · `p_scores` = `{criterion id: {level, comment?}}` (บางเกณฑ์ได้ขณะร่าง; `{}` ถ้าไม่มี Rubric) · `p_outcome` = `passed` / `revise` / null · ส่งคะแนนเองไม่ได้ (ระบบอ่านจากระดับ) · ร่างเห็นเฉพาะผู้ตรวจคนนั้น |
| ส่งผล | `rpc('release_task_review', { p_review })` → แถวผลการตรวจ | ต้องมีผลและครบทุกเกณฑ์ · รอบที่มีผลแล้ว = ตรวจใหม่ ต้องมี `p_reason` · `released_at` จาก server · ส่งแล้วแก้/ลบไม่ได้ · audit `RELEASE_TASK_REVIEW` / `REGRADE_TASK_REVIEW` (คะแนน/ผลเดิม/ใหม่/เหตุผล ไม่เก็บข้อเสนอแนะ) |
| ทิ้งร่าง | `from('task_reviews').delete().eq('id', …)` | ร่างของตนเท่านั้น |
| ดูผล | `from('task_reviews')`, `task_review_scores` | เจ้าของงานและผู้ตรวจที่เห็นงานนั้นเห็นผลที่ส่งแล้วทั้งหมด (ประวัติ) · ผลปัจจุบัน = `released_at` ล่าสุดของรอบนั้น |
| ส่งรอบใหม่ | `rpc('start_task_submission')` | ได้เมื่อผลปัจจุบันของรอบล่าสุดเป็น `revise` และยังไม่ครบรอบ |

**ฝั่งผู้เรียน (ขั้น 6)** — `createSubmissionService` ใช้ call ข้างบนทั้งหมด และอ่าน: `task_allocations` (ฝัง `tasks`, `cohorts`) · `task_submissions` (`user_id` = ตนเอง) · `task_submission_files` · `task_reviews` / `task_review_scores` (เฉพาะที่ส่งผลแล้ว) · `instrument_items` ของ Rubric ที่ภาระงานใช้ · ไฟล์ผ่าน `storage.from('task-files').createSignedUrls` · ไฟล์ที่อัปโหลดแต่ไม่ได้บันทึกแถว (ปิดหน้าไประหว่างทาง) ถูกลบเมื่อเปิดร่างอีกครั้ง หากเก่ากว่า 10 นาที

**ฝั่งผู้ตรวจ (ขั้น 7)** — `createReviewService`: อ่าน `task_allocations`, `task_submissions` (เฉพาะ `status = 'submitted'` ที่ RLS อนุญาต พร้อม `profiles ( id, full_name, display_name )`), `task_reviews` (`released` ทั้งหมด + ร่างของตน), `task_review_scores`, `instrument_items` ของ Rubric, `cohort_memberships` (รายชื่อ — เฉพาะผู้ดูแลรุ่น) · เขียนผ่าน `save_task_review` / `release_task_review` / ลบร่างของตน (ไม่มีทางเขียนตารางตรงๆ) · CSV (`ชื่อ, สถานะ, จำนวนรอบที่ส่ง, ส่งล่าสุด (ISO), ส่งช้า, [คะแนน, คะแนนเต็ม], ผลการตรวจล่าสุด`) สร้างในเบราว์เซอร์จากข้อมูลที่ RLS ให้ผู้ใช้เห็น จึงไม่รั่วข้ามขอบเขต

**แจ้งเตือนในระบบ (3b)**

| เรื่อง | Call | หมายเหตุ |
|---|---|---|
| ตัวเลขป้ายเมนู | `rpc('task_notice_counts')` → `{unread_results, revise, waiting}` | `unread_results` = ผลตรวจที่ส่งแล้วบนงานของตนที่ยังไม่เปิดดู · `revise` = ภาระงานที่ผลล่าสุดของรอบล่าสุดเป็น "ส่งกลับแก้ไข" ยังเหลือรอบ และไม่มีร่างเปิดอยู่ · `waiting` = จำนวนคน (ในงานที่ตนมีสิทธิ์ตรวจ ไม่นับตนเอง) ที่รอบล่าสุดยังไม่มีผลตรวจ |
| ทำเครื่องหมายว่าเปิดดูผลแล้ว | `rpc('mark_task_results_seen', { p_allocation })` → จำนวนที่เพิ่งทำเครื่องหมาย | ผลตรวจของงานตนเองเท่านั้น · ซ้ำได้ (ครั้งต่อไปได้ 0) · ลบ/แก้แถวไม่ได้ |

## 2.7 Phase 3b — Edge Functions

| งาน | เรียก | หมายเหตุ |
|---|---|---|
| ล้างไฟล์ค้าง (ตัวตั้งเวลา) | `POST /functions/v1/cleanup-task-files` + header `x-cron-secret` · body `{}` หรือ `{"dry_run": true}` | 200 `{dry_run:false, stale_draft_files_removed, orphans_removed, orphans_logged, failed[]}` / `{dry_run:true, orphans[], stale_draft_files[]}` · 401 `unauthorized` · 405 `method_not_allowed` · 500 `not_configured` (ไม่มี/สั้นเกิน CRON_SECRET) หรือ `internal` · เบราว์เซอร์ไม่เรียก — รายละเอียด `docs/EDGE_FUNCTIONS.md` |
| RPC ที่ function ใช้ (service role เท่านั้น) | `task_files_cleanup_orphans(p_older_than, p_limit)` · `task_files_cleanup_stale_drafts(p_idle, p_limit, p_dry_run)` · `task_files_cleanup_record(p_paths)` | คืน `{object_path}[]` / จำนวนแถว audit · ค่าต่ำกว่าขั้นต่ำ = 22023 · ผู้ใช้อื่น = 42501 |

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

# API Contracts — Phase 1 + 2A

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

## 3. Error mapping (`src/core/errors.js`)

| code | ข้อความผู้ใช้ |
|---|---|
| `42501` | คุณไม่มีสิทธิ์ดำเนินการนี้ |
| `23505` | ข้อมูลนี้มีอยู่แล้วในระบบ |
| `23503` | ข้อมูลอ้างอิงไม่ถูกต้องหรือถูกใช้งานอยู่ |
| `23514` | ข้อมูลไม่ผ่านเงื่อนไขของระบบ |
| `PGRST116` | ไม่พบข้อมูลที่ต้องการ |
| อื่น ๆ | ข้อความทั่วไป (ไม่เปิดเผยข้อความจากฐานข้อมูล) |

**หมายเหตุสำคัญ:** UPDATE/DELETE ที่ RLS กรองแถวออกจะ **ไม่ error** แต่ได้ 0 แถว — service ที่ต้องการยืนยันผลให้ต่อ `.select().single()` (จะได้ `PGRST116` เมื่อไม่มีสิทธิ์)

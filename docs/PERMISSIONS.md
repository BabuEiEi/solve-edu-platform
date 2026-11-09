# Permissions Model — SolveEdu Platform (Phase 1 + 2A + 2B + 2B.1)

> หลักการ: **GRANT กำหนดว่าแตะ "คอลัมน์" ใดได้ · RLS กำหนดว่าเห็น/แก้ "แถว" ใดได้ · Trigger รักษา invariant ที่ RLS ทำไม่ได้**
> การซ่อนเมนูใน UI (`src/core/permissions.js`) เป็นเพียงความสะดวก ไม่ใช่การรักษาความปลอดภัย

## 1. ระดับของบทบาท

```
platform_role_assignments   platform_admin, platform_support        (ดูแลระบบ — ไม่ใช่ผู้ดูแลข้อมูลเขต)
organization_memberships     district_admin > supervisor, school_admin > teacher
                             สิทธิ์บน org ใดครอบคลุมหน่วยงานลูกทั้งหมด (district → schools)
cohort_memberships           coordinator, trainer, mentor, trainee  (ต่อรุ่น; หนึ่งคนมีหลายบทบาทได้)
mentor_assignments           mentor → trainee รายคน ภายในรุ่น
```

**ทุกสิทธิ์ต้องมี `profiles.status = 'active'`** — ผู้ใช้ pending/suspended อ่านได้เฉพาะโปรไฟล์ตนเองและรายชื่อสถานศึกษา

## 2. Helper functions (`authz` schema)

`SECURITY DEFINER`, `search_path = ''`, คืนค่า boolean เกี่ยวกับ **ผู้เรียกเท่านั้น** (`auth.uid()`), ไม่อยู่ใน `[api].schemas` จึงเรียกผ่าน REST ไม่ได้ (ทดสอบแล้ว)

| ฟังก์ชัน | ความหมาย |
|---|---|
| `is_active_user()` | โปรไฟล์ผู้เรียก status = active |
| `is_platform_admin()` | active + มี platform_admin ที่ยังไม่ถูกเพิกถอน |
| `has_org_role(org, roles[])` | มีบทบาทใน org นั้น **หรือ org บรรพบุรุษ** |
| `can_grant_org_role(org, role)` | platform admin → ทุกบทบาท; district_admin → supervisor/school_admin/teacher; school_admin → teacher |
| `can_manage_org(org)` | platform admin หรือ district_admin เหนือ org |
| `is_cohort_member(cohort, roles[])` | มีบทบาท active ในรุ่น |
| `can_manage_program(program)` | platform admin หรือ district_admin/supervisor ของ owner org |
| `can_view_program(program)` | ผู้จัดการ หรือสมาชิกรุ่นใดของโครงการ |
| `can_manage_cohort(cohort)` | ผู้จัดการโครงการ หรือ coordinator ของรุ่น |
| `can_grant_cohort_role(cohort, role)` | ผู้จัดการโครงการ → ทุกบทบาท; coordinator → trainee/trainer/mentor (ห้ามตั้ง coordinator) |
| `is_mentor_of(trainee, cohort)` | มี mentor_assignment ที่ยัง active |
| `can_admin_user(target)` | platform admin หรือ district/school admin เหนือ org ที่ target สังกัด **หรือ requested_org_id** |
| `can_view_profile(target)` | ตนเอง · ผู้ดูแลตาม scope · supervisor ตาม scope · staff ของรุ่นเห็นสมาชิก · สมาชิกเห็น staff · mentor เห็นครูที่ดูแล · ผู้จัดการโครงการเห็นผู้เข้าร่วม — **trainee ไม่เห็น trainee คนอื่น** |
| `can_manage_course(course)` | platform admin · district_admin/supervisor ของ owner org · trainer ของรุ่นที่ใช้หลักสูตรนั้น |
| `can_view_course(course)` | ผู้จัดการ · หรือ (course **published** และ (ลงทะเบียนอยู่ หรือเป็น trainer/mentor/coordinator ของรุ่นที่ใช้)) |
| `can_view_unit / can_view_lesson` | ผู้จัดการเห็นทั้งหมด · ผู้เรียนเห็นเฉพาะ unit+lesson ที่ published |
| `owns_active_enrollment(e)` | enrollment ของตนเองที่ status = active |
| `can_view_enrollment(e)` | เจ้าของ · ผู้จัดการรุ่น · trainer ของรุ่น · mentor ของผู้เรียนคนนั้น |
| `can_manage_instrument_row(org, course)` / `can_manage_instrument(i)` / `can_manage_version(v)` (2B) | ผู้สร้างข้อสอบ: `can_create_course_in_org(owner org)` หรือ `can_manage_course(course)` |
| `is_cohort_assessor(cohort)` (2B) | `can_manage_cohort` (ผู้จัดการโครงการ, coordinator) หรือ trainer ของรุ่น — มอบหมายแบบทดสอบและเห็นผลทั้งรุ่น |
| `can_view_version(v)` / `can_view_instrument(i)` (2B) | ผู้สร้าง · assessor/mentor ของรุ่นที่ได้รับมอบหมาย · ผู้เรียน **หลังเริ่มทำแล้วเท่านั้น** (ดูข้อสอบล่วงหน้าไม่ได้) |
| `can_view_attempt(assignment, user)` / `can_view_attempt_id(t)` (2B) | ตนเอง · assessor ของรุ่น · mentor ของผู้เรียนคนนั้น |
| `can_assess_assignment(a)` (2B.1) | `is_cohort_assessor` ของรุ่นที่การมอบหมายนั้นอยู่ |

## 3. Matrix ต่อตาราง

| ตาราง | SELECT | INSERT | UPDATE (คอลัมน์ที่ GRANT) | DELETE |
|---|---|---|---|---|
| `profiles` | `can_view_profile(id)` — **ไม่มี** `contact_email` | ❌ (trigger จาก `auth.users`) | ตนเอง: `full_name, display_name, avatar_path, contact_email, requested_org_id` (*requested_org_id เฉพาะ pending*) | ❌ |
| `organizations` | active ทั้งหมด หรือผู้ดูแล | platform admin; district_admin สร้าง school/other ใต้ตน | `code, name, parent_id, active` ตามสิทธิ์เดียวกัน | ❌ |
| `organization_memberships` | ตนเอง · platform admin · admin/supervisor เหนือ org | `can_grant_org_role` และห้ามมอบให้ตนเอง (ยกเว้น platform admin) | `ended_at` เท่านั้น (ทางเดียว ไม่ย้อน ไม่อนาคต) | ❌ |
| `platform_role_assignments` | ตนเอง · platform admin | platform admin, ห้ามมอบให้ตนเอง | `revoked_at` (platform admin) | ❌ |
| `programs` | `can_view_program` | district_admin/supervisor ของ owner org | ไม่รวม `owner_org_id` | ❌ |
| `cohorts` | `can_view_cohort` | `can_manage_program` | ไม่รวม `program_id` | ❌ |
| `cohort_memberships` | ตนเอง · ผู้จัดการรุ่น · trainer | `can_grant_cohort_role` | `status` | ❌ |
| `mentor_assignments` | mentor/trainee ที่เกี่ยวข้อง · ผู้จัดการรุ่น | ผู้จัดการรุ่น + trigger ตรวจบทบาท | `ended_at` | ❌ |
| `courses` | `can_view_course` | district_admin/supervisor | ไม่รวม `owner_org_id` | ❌ |
| `program_courses` | `can_view_program` | ผู้จัดการโครงการ | `display_order` | ผู้จัดการโครงการ |
| `course_units` / `lessons` / `lesson_blocks` | `can_view_unit/lesson` | `can_manage_course` | ไม่รวม FK แม่ (ย้ายข้ามหลักสูตรไม่ได้) | `can_manage_course` |
| `course_enrollments` | `can_view_enrollment` | `can_manage_cohort` + trigger: ต้องเป็น trainee active และหลักสูตรอยู่ในโครงการ | `status` | ❌ |
| `lesson_progress` | `can_view_enrollment` | เจ้าของ enrollment active + trigger: บทเรียน published | `status, progress_percent` (เวลาประทับโดย server) | ❌ |
| `instruments` (2B) | ผู้สร้าง หรือ `can_view_instrument` | ผู้สร้าง (`owner_org_id, course_id, code, title, description, instrument_type`) | `code, title, description, status` | ❌ |
| `instrument_versions` (2B) | ผู้สร้าง หรือ `can_view_version` | `instrument_id` เท่านั้น (เลขฉบับ/สถานะโดย server; ร่างได้ทีละ 1) | ❌ — publish/clone ผ่าน RPC | ❌ |
| `instrument_items` (2B) | `can_view_version` | ผู้สร้าง + trigger: เฉพาะฉบับ draft · `options_json` ห้ามมีเฉลย | ไม่รวม `instrument_version_id` (draft เท่านั้น) | ผู้สร้าง (draft เท่านั้น) |
| `private.instrument_answer_keys` (2B) | ❌ ทุก role ของ client — **ตั้งได้แต่อ่านกลับไม่ได้** | ผ่าน `set_item_key` | ผ่าน `set_item_key` | ❌ |
| `assessment_assignments` (2B) | assessor · mentor ของรุ่น · trainee ของรุ่นเฉพาะที่ `published` | assessor + มองเห็นฉบับ + trigger: ฉบับต้อง published, หลักสูตรต้องอยู่ในโครงการของรุ่น · CHECK: เผยแพร่ได้เมื่อมี `close_at` เท่านั้น (2B.1) | ไม่รวม `instrument_version_id, cohort_id` · **หลังมีผู้เริ่มทำ: `passing_percent, purpose, course_id, time_limit_minutes` แก้ไม่ได้ และย้อนเป็น draft ไม่ได้ (SE004)** | assessor, เฉพาะ `draft` (มี attempt แล้ว → FK RESTRICT) |
| `assessment_attempts` (2B) | `can_view_attempt` — **ไม่มี `draft_json`** (คำตอบระหว่างทำเป็นของผู้เรียนจนกว่าจะส่ง; ผู้เรียนรับคืนผ่าน `start_attempt` เท่านั้น) · `draft_saved_at` เห็นได้ | ❌ — `start_attempt` | ❌ — `save_attempt_draft` / `submit_attempt` / งานปิดอัตโนมัติ | ❌ |
| `assessment_extra_attempts` (2B.1) | `can_view_attempt(assignment, user)` | `can_assess_assignment` (`assignment_id, user_id, reason`) + trigger: ผู้รับต้องเป็น trainee active ของรุ่น · `granted_by`/`created_at` โดย server | ❌ (append-only) | ❌ |
| `assessment_responses` (2B) | `can_view_attempt_id` — **ไม่มี `awarded_score`, `graded_*`** | ❌ — `submit_attempt` | ❌ | ❌ |
| `preregistrations` (2A) | ผู้นำเข้า · platform admin · district/school admin ของหน่วยงานนั้น (มีอีเมล = PII) | `can_grant_org_role` **และ** (ถ้ามีรุ่น) `can_grant_cohort_role` — สิทธิ์เท่ากับการมอบบทบาทโดยตรง | `status` → `cancelled` เฉพาะแถว pending | ❌ |
| `private.*` | ❌ ทุก role ของ client | ❌ | ❌ | ❌ |

`anon` ไม่มีสิทธิ์ใด ๆ ใน Phase 1

## 4. Trusted RPCs

| RPC | ใครเรียกได้ | การตรวจภายใน |
|---|---|---|
| `admin_set_profile_status(p_target, p_status, p_reason)` | authenticated | ต้องล็อกอิน · ห้ามแก้ตนเอง · `can_admin_user` · ผู้ถือ platform role แก้ได้เฉพาะ platform admin · ผู้ถือ admin/supervisor แก้ได้เฉพาะ district_admin เหนือ org (district_admin แก้ได้เฉพาะ platform admin) · บันทึก audit + เหตุผล |
| `get_profile_contact(p_target)` | authenticated | ตนเอง หรือ `can_admin_user` |

ทั้งสองฟังก์ชัน `REVOKE EXECUTE FROM PUBLIC, anon`

## 4.1 RPC เพิ่มใน Phase 2A

| RPC | ใครเรียกได้ | การตรวจภายใน |
|---|---|---|
| `course_access(p_course)` → `manage`/`view`/`none` | authenticated | SECURITY INVOKER; ตอบเฉพาะสิทธิ์ของผู้เรียก (ใช้ซ่อน/แสดงเครื่องมือเท่านั้น) |
| `reorder_course_items(p_kind, p_parent, p_ids[])` | authenticated | SECURITY INVOKER (ไม่เกินสิทธิ์ RLS) · ต้องส่ง id ครบทุกรายการของ parent ไม่ซ้ำ · ผิด → `22023` · ไม่มีสิทธิ์ → `42501` |
| `claim_my_preregistrations()` → จำนวนแถวที่ผูก | authenticated (anon ไม่ได้) | SECURITY DEFINER · ทำงานกับ `auth.uid()` เท่านั้น · อ่านอีเมลจาก `auth.users` และต้อง `email_confirmed_at` ไม่เป็น null · ตรวจซ้ำว่าผู้นำเข้า **ยังมีสิทธิ์มอบ** · เปิดใช้เฉพาะโปรไฟล์ `pending` (ไม่ปลดระงับ) · บันทึก audit `CLAIM_PREREGISTRATION` |

## 4.1b RPC เพิ่มใน Phase 2B (ทั้งหมด SECURITY DEFINER, `search_path = ''`, `REVOKE EXECUTE FROM PUBLIC, anon`)

| RPC | ใครเรียกได้ | การตรวจภายใน |
|---|---|---|
| `set_item_key(p_item, p_answer, p_scoring = '{}')` | ผู้สร้างข้อสอบ | ฉบับ draft เท่านั้น · ตรวจว่าเฉลยอ้าง id ตัวเลือกที่มีจริง · audit `SET_ANSWER_KEY` **ไม่เก็บเนื้อหาเฉลย** · ไม่คืนเฉลย · `p_scoring` ต้องเป็น `{}` (2C.1: วิธีให้คะแนนย้ายไป `instrument_items.scoring_mode` ซึ่งผู้สร้างแก้ได้เฉพาะฉบับ draft ตาม RLS/trigger เดิม) |
| `import_instrument_items(p_version, p_items)` → int (2D) | ผู้สร้างข้อสอบ | **SECURITY INVOKER**: แต่ละแถวผ่าน RLS ของ `instrument_items`, trigger ฉบับร่าง/ตรวจโครง และ `set_item_key` (ตรวจเฉลย + audit ไม่เก็บเฉลย) เหมือนพิมพ์ทีละข้อ · ทั้งหมดหรือไม่เลย · 4 ประเภทพื้นฐาน · ≤ 200 แถว · ห้ามมีรูป/field อื่น |
| `item_key_status(p_version)` → `(item_id, has_key, key_valid)` | ผู้สร้างข้อสอบ | คืนเพียงสถานะ ไม่คืนเนื้อหาเฉลย |
| `publish_instrument_version(p_version)` → `content_hash` | ผู้สร้างข้อสอบ | draft + มีอย่างน้อย 1 ข้อ + ทุกข้อมีเฉลยที่ถูกต้อง · ล็อก `FOR UPDATE` · hash ครอบเฉพาะเนื้อหาข้อ (ไม่รวมเฉลย — กันการเดาเฉลยจาก hash) |
| `clone_instrument_version(p_version)` → uuid ฉบับร่างใหม่ | ผู้สร้างข้อสอบ | ร่างได้ทีละ 1 ฉบับ (`23505`) · คัดลอกข้อ+เฉลยฝั่ง server · audit `CLONE_VERSION` |
| `start_attempt(p_assignment)` → `(attempt_id, attempt_no, started_at, resumed, deadline_at, server_now, draft, timed_out)` | trainee active ของรุ่น | assignment `published` · ครั้งที่ค้างอยู่ → ทำต่อ (ถ้ายังไม่เลยเส้นตาย+ผ่อนผัน) หรือ **ส่งอัตโนมัติจากคำตอบที่บันทึกไว้** (`timed_out`, ไม่เริ่มครั้งใหม่ในคำขอเดียวกัน) · ครั้งใหม่: อยู่ในช่วงเวลา (SE001) · จำนวนครั้ง = `attempt_limit` + สิทธิ์ทำเพิ่มของคนนั้น (SE002) · advisory lock ต่อ (assignment, คน) + partial unique index |
| `save_attempt_draft(p_attempt, p_responses, p_seq = null)` → `(saved_at, finalized, stale)` (2B.1) | เจ้าของ attempt | ยังไม่ส่ง (SE003) · ตรวจรูปแบบเหมือนตอนส่ง (22023) · เลยเส้นตาย+ผ่อนผันแล้ว → ไม่บันทึก แต่ส่งอัตโนมัติจากคำตอบที่บันทึกไว้ก่อนหน้า (`finalized = true`) · `p_seq` ไม่ใหม่กว่า `draft_seq` → ไม่บันทึก (`stale = true`) |
| `submit_attempt(p_attempt, p_responses, p_seq = null)` → คะแนนรวม + `auto_submitted` | เจ้าของ attempt | ยังไม่ส่ง (SE003) · หน้าที่ถูกหน้าใหม่กว่าแทนที่ส่งไม่ได้ (SE005) · ภายในเส้นตาย+ผ่อนผัน: ให้คะแนนคำตอบที่ส่ง · เลยแล้ว: **ไม่ใช้คำตอบที่ส่งมาช้า** ให้คะแนนจากคำตอบที่บันทึกไว้ · ให้คะแนนจาก `private.instrument_answer_keys` · ประทับ `submitted_at`/`score`/`passed` · คืนเฉพาะคะแนนรวม |
| `assignment_results(p_assignment)` (2B.1) | authenticated | **SECURITY INVOKER** — RLS ของผู้เรียกกำหนดแถว: assessor เห็นทั้งรุ่น, mentor เห็นผู้ที่ดูแล, trainee เห็นตนเอง, คนนอกได้ผลว่าง · หนึ่งแถวต่อคน (ครั้งแรก/สูงสุด/สถานะ/สิทธิ์เพิ่ม) |
| `item_statistics(p_assignment)` → jsonb (2B.1, 2C) | assessor ของรุ่น (mentor/trainee/คนนอก → 42501) | SECURITY DEFINER (ต้องอ่าน `awarded_score` และเฉลยเพื่อตัดสินรายส่วน) · คืนเฉพาะค่ารวม: p, D (27%), r item-total, จำนวนที่เลือกแต่ละตัวเลือก, KR-20/α, **สัดส่วนถูกรายส่วน** ของข้อแบบใหม่ · ใช้ครั้งแรกของแต่ละคน · **น้อยกว่า 5 คนคืนแค่จำนวน** · **ไม่ระบุตัวเลือกที่ถูก** (ไม่คืนเฉลย และไม่คืนจำนวนที่เลือกแต่ละตัวเลือกรายส่วน) |
| `private.finalize_expired_attempts()` (2B.1) | `pg_cron` ทุก 1 นาที (client เรียกไม่ได้) | ปิดครั้งที่เลยเส้นตาย+ผ่อนผันด้วยคำตอบที่บันทึกไว้ · lock เดียวกับ RPC · แต่ละแถวใน subtransaction |

เส้นตาย = ค่าที่มาก่อนระหว่าง `started_at + time_limit_minutes` กับ `close_at` (ค่าปัจจุบันของการมอบหมาย) · ช่วงผ่อนผัน `grace_minutes` ค่าเริ่มต้น 5 นาที

ลำดับการบันทึก (2B.1): `start_attempt` คืน `draft_seq` เป็นเลขฐานของหน้านั้น (สูงกว่าค่าที่เก็บไว้ 1,000,000) · หน้าบวกเลขทีละ 1 ทุกครั้งที่บันทึก/ส่ง · server รับเฉพาะเลขที่ใหม่กว่า → คำขอที่มาช้าไม่ทับคำตอบใหม่ และหน้าที่เปิดล่าสุดชนะ (`draft_seq` ไม่ GRANT ให้ client)

ไม่รับคะแนนหรือเวลาจาก client (ทดสอบว่าไม่มีพารามิเตอร์ `p_score`, `p_started_at`, `p_submitted_at`, `p_passed`)

## 4.2 Storage (`storage.objects`, bucket private ทั้งหมด)

path = `<resource_id>/<random>.<ext>` — โฟลเดอร์แรกกำหนดสิทธิ์ผ่าน `authz.object_owner_id()` (path ผิดรูป → NULL → ปฏิเสธ ไม่ error)

| Bucket | อ่าน / ขอ signed URL | เขียน / แก้ / ลบ | ข้อจำกัด |
|---|---|---|---|
| `lesson-media` | `authz.can_view_lesson(โฟลเดอร์แรก)` | `authz.can_manage_lesson(โฟลเดอร์แรก)` | 50 MiB · รูป/PDF/Office/mp4/webm (ไม่รับ `text/html`) |
| `avatars` | `authz.can_view_profile(โฟลเดอร์แรก)` | เจ้าของโฟลเดอร์เท่านั้น (`= auth.uid()`) · `profiles.avatar_path` ต้องอยู่ในโฟลเดอร์ตนเอง | 2 MiB · png/jpeg/webp |
| `assessment-media` (2B) | `can_manage_instrument(โฟลเดอร์แรก)` หรือ `can_view_instrument(โฟลเดอร์แรก)` — ผู้เรียนเห็นรูปหลังเริ่มทำแล้วเท่านั้น | เพิ่ม: `can_manage_instrument(โฟลเดอร์แรก)` · แก้/ลบ (2B.1): ต้องเป็นผู้สร้าง **และ** `not authz.assessment_media_in_use(name)` — รูปที่ข้อใดของฉบับใดยังใช้อยู่ (รวมฉบับที่เผยแพร่) ลบหรือเขียนทับไม่ได้ | 5 MiB · png/jpeg/webp/gif · path `<instrument_id>/<uuid>.<ext>` |

`anon` ไม่มีสิทธิ์ใด ๆ · `lesson_blocks.object_path` ต้องอยู่ในโฟลเดอร์ของบทเรียนเดียวกับบล็อก และห้าม `..`

## 5. Audit

`private.audit_logs` (append-only, client อ่านไม่ได้) บันทึกอัตโนมัติเมื่อ INSERT/UPDATE/DELETE ใน `organization_memberships`, `platform_role_assignments`, `cohort_memberships`, `mentor_assignments` และทุกครั้งที่เรียก `admin_set_profile_status` (actor, ค่าเดิม, ค่าใหม่, เหตุผล)

Phase 2B: ทุกการเปลี่ยน `assessment_assignments` (สร้าง/แก้/ลบ) · การแก้คอลัมน์หลักฐานของ `assessment_attempts` (สถานะ เวลา คะแนน — **ไม่รวมการบันทึกคำตอบระหว่างทำ** ตั้งแต่ 2B.1) และการลบ · การเปลี่ยนสถานะ `instrument_versions` · `SET_ANSWER_KEY` (ไม่เก็บเนื้อหาเฉลย) · `CLONE_VERSION`

## 6. Policy Test Matrix → ไฟล์ทดสอบ

| Scenario (Blueprint §7.4) | ผล | ทดสอบที่ |
|---|---|---|
| Anonymous อ่านอีเมล/โปรไฟล์ | DENY | `020` #1–3, integration |
| Trainee A อ่านข้อมูล Trainee B (รุ่นเดียวกัน/ต่างโรงเรียน) | DENY | `020` #5–6, `060` #2 |
| Trainee แก้ status/role ตนเอง, มอบ platform_admin/school_admin ให้ตนเอง | DENY | `020` #11–14 |
| Mentor อ่านครูนอกกลุ่มที่ดูแล | DENY | `040` #9–10, `060` #12 |
| School Admin A อ่านข้อมูลโรงเรียน B / อนุมัติผู้สมัครโรงเรียนอื่น | DENY | `030` #1–2, `020` #18, integration |
| ถอนสิทธิ์แล้วเข้าถึงใหม่ | DENY | `030` #13 |
| ตั้ง ended_at กลับเป็น null (re-activate เงียบ ๆ) | DENY | `030` #14 |
| เจ้าของเห็นข้อมูลของตน / Admin เปลี่ยนสถานะในขอบเขต + audit | ALLOW + AUDIT | `020` #4, #20, #24 |
| Trainee เห็นบทเรียน draft / หลักสูตร draft | DENY | `050` #2–4, integration |
| ปลอม `completed_at` / เขียน progress ใน enrollment คนอื่น | DENY | `060` #7, #9 |
| ส่งข้อสอบซ้ำพร้อมกัน / เริ่มพร้อมกันเกินจำนวนครั้ง | DENY (1 สำเร็จ, ที่เหลือ SE003 / ได้ attempt เดิม) | `120` + `tests/integration/assessment.test.js` (คำขอพร้อมกันจริง; mutation test ยืนยันว่าถ้าเอา lock ออก test ล้ม) |
| เฉลยรั่วไปที่ browser (ตาราง, embed, RPC, ไฟล์) | DENY | `100`, `110`, `120` + integration/E2E สแกน response ทุกตัวหา `correct`/`answer_json`/`scoring_json`/`tolerance`/`awarded_score` |
| ผู้เรียนดูข้อสอบก่อนกดเริ่ม / ดูรูปข้อสอบที่ไม่ได้รับมอบหมาย | DENY | `100`, `130` + `tests/integration/quizzes.test.js` |
| ปลอมคะแนน/เวลาเริ่ม/เวลาส่ง | DENY (ไม่มีช่องทาง) | `120` |
| mentor/trainee/admin ต่างเขต มอบหมายหรือแก้การมอบหมาย | DENY | `140` |
| แก้เกณฑ์ผ่าน/ประเภทหลังมีผู้ทำแล้ว (ผลเดิมเพี้ยน) | DENY (SE004) | `140` (mutation test ยืนยัน) + `tests/integration/assignments.test.js` |
| mentor เห็นผลของผู้เรียนที่ไม่ได้ดูแล / trainee เห็นผลคนอื่น | DENY | `100`, `140` + integration + E2E |
| ส่งคำตอบหลังหมดเวลาเพื่อแก้คำตอบ / บันทึกคำตอบลง attempt ของคนอื่น | DENY (ใช้คำตอบที่บันทึกก่อนหมดเวลา) / DENY | `150` (mutation test ยืนยัน) + `tests/integration/attempt-timing.test.js` |
| ให้สิทธิ์ทำเพิ่มแก่ตนเอง / mentor ให้สิทธิ์ / ปลอม `granted_by` / แก้หรือลบสิทธิ์ | DENY | `150` + integration |
| วิทยากร/ครูพี่เลี้ยง (หรือผู้เรียนเองผ่าน REST) อ่านคำตอบระหว่างทำ | DENY (42501) | `150` (mutation test ยืนยัน) + integration |
| เผยแพร่การมอบหมายโดยไม่มีเวลาปิดรับ | DENY (23514) | `140` (mutation test ยืนยัน) |
| การบันทึกที่มาช้าทับคำตอบใหม่ / หน้าเก่า (อีกเครื่อง) บันทึกหรือส่งหลังมีหน้าใหม่ | DENY (`stale`, SE005) | `160` (mutation test ยืนยัน) + integration + E2E สองเครื่อง |
| mentor/trainee/คนนอก ดูผลวิเคราะห์ข้อสอบ · ผลวิเคราะห์เปิดเผยรายบุคคลหรือเฉลย | DENY | `170` + integration |
| ลบหรือเขียนทับรูปข้อสอบที่ยังใช้อยู่ (แม้เป็นผู้สร้าง) | DENY | `180` (mutation test ยืนยัน) + integration ผ่าน Storage API จริง |
| ใส่เฉลยไว้ในโครงข้อสอบแบบใหม่ / รูปนอกโฟลเดอร์ในรายการใดของข้อ / เฉลยหรือลำดับที่ถูกหลุดไปกับลำดับที่ผู้เรียนเห็น (2C) | DENY | `190` + `tests/integration/item-types.test.js` |
| ผู้เรียนอ่าน `options_json` แล้วรู้เฉลยจากลำดับที่เก็บ (เรียงลำดับ/จับคู่) | DENY (เฉลยไม่ถูกต้อง → เผยแพร่ไม่ได้) | `210` (mutation test ยืนยัน) · หน้าสร้างข้อสอบเก็บแบบสลับ + รหัสสุ่ม |
| ผลวิเคราะห์รายส่วนเปิดเผยเฉลย/คำตอบที่พิมพ์ · mentor/trainee ดูผลวิเคราะห์รายส่วน (2C) | DENY | `220` (mutation test ยืนยันกฎถูก/ผิดรายส่วน) |
| ผู้เรียนแก้วิธีให้คะแนน · แก้วิธีให้คะแนนของข้อที่เผยแพร่แล้ว · ใส่วิธีให้คะแนนในเฉลย (2C.1) | DENY | `240` (mutation test ยืนยัน: ให้คะแนนตามโหมดของข้อ, ฉบับใหม่คัดลอกโหมด) + integration |
| mentor/trainee/คนนอก นำเข้าข้อสอบ · นำเข้าลงฉบับที่เผยแพร่แล้ว · นำเข้าครึ่งเดียวเมื่อบางแถวผิด · นำเข้าประเภทที่ยังไม่รองรับ/แนบรูป (2D) | DENY | `250` (mutation test ยืนยัน: เลขแถว, สิทธิ์ของผู้เรียก) + `tests/integration/import.test.js` |
| ผู้เรียนสร้าง Rubric · แก้ Rubric ที่เผยแพร่แล้ว · ใส่ข้อสอบใน Rubric/เกณฑ์ในแบบทดสอบ · ตั้งคะแนนเต็มของเกณฑ์เอง · ใส่เฉลยให้เกณฑ์ · มอบหมาย Rubric เป็นแบบทดสอบ (3) | DENY | `260` (mutation test ยืนยัน) |
| ผู้เรียนสร้างภาระงาน/เปิดให้รุ่น · เปิดภาระงานร่าง · ใช้ Rubric ร่างหรือแบบทดสอบเป็น Rubric · เปลี่ยน Rubric หลังมีผู้ส่ง (3) | DENY | `270` |
| ผู้ตรวจเห็นร่างของผู้เรียน · ผู้เรียนเห็น/แก้งานคนอื่น · ครูพี่เลี้ยงเห็นงานของครูที่ไม่ได้ดูแล · คนนอก/anon เห็นงานหรือไฟล์ (3) | DENY | `270` (mutation test ยืนยัน 3 กรณี) + `tests/integration/tasks.test.js` (Storage API จริง) |
| ตั้งเวลาส่ง/สถานะเอง · แก้งานหรือไฟล์หลังส่ง · อัปโหลดเข้าโฟลเดอร์คนอื่น · ไฟล์ชนิดอื่น (เช่น .exe) · เกิน 5 ไฟล์ · ลิงก์ที่ไม่ใช่ https (3) | DENY | `270` + integration |
| ผู้เรียน/ครูพี่เลี้ยงของคนอื่น/คนนอกตรวจงาน · ตรวจงานตัวเอง (แม้เป็นผู้ดูแลรุ่นด้วย) · ส่งคะแนนเอง · เขียน/แก้/ลบผลตรวจที่ส่งแล้ว (แม้เจ้าของฐานข้อมูล) · ส่งผลโดยไม่ครบเกณฑ์ · ตรวจใหม่โดยไม่มีเหตุผล · เห็นร่างผลตรวจของคนอื่น · ส่งรอบใหม่หลังผ่าน/เกินจำนวนรอบ (3) | DENY | `280` (mutation test ยืนยัน 4 กฎ) + integration |
| วิทยากร/ผู้เรียนของ**อีกรุ่น**ในโปรแกรมเดียวกันเห็นการเปิดภาระงาน งาน ผลตรวจ หรือไฟล์ · ตรวจหรือแก้วันที่ของรุ่นอื่น · ผู้เรียนที่ออกจากรุ่นแล้วเริ่มรอบใหม่ (3) | DENY | `290` (mutation test ยืนยัน) |
| ทำเครื่องหมายว่าเปิดดูผลแทนคนอื่น/ของผลที่ไม่ใช่งานตน/ตั้ง `user_id` เอง · แก้หรือลบเครื่องหมาย · เห็นเครื่องหมายของคนอื่น · ตัวเลขป้ายนับเกินสิทธิ์ (นับงานตนเองเป็น "รอตรวจ", ผู้เรียนต่างรุ่น/คนนอกได้ตัวเลขไม่เป็นศูนย์) (3b) | DENY | `300` (mutation test ยืนยัน 2 กรณี) |
| เรียกฟังก์ชันล้างไฟล์ (`task_files_cleanup_*`) ด้วยบัญชีผู้ใช้ใดก็ได้ รวมผู้ดูแลระบบ / anon · ล้างไฟล์ของงานที่ส่งแล้ว ไฟล์ที่เพิ่งอัปโหลด หรือร่างที่มีไฟล์ใหม่ · เรียก Edge Function ล้างไฟล์โดยไม่มี/ผิด `x-cron-secret` หรือใช้ token ผู้ใช้แทน · service role อ่าน/แก้/ลบ audit log (3b) | DENY | `310`, `tests/functions` (mutation test ยืนยัน 3 กรณี) |
| Edge Function ล้างไฟล์ (มี secret ถูกต้อง): ลบไฟล์ค้าง > 24 ชม. และไฟล์ของร่างที่นิ่ง > 30 วัน พร้อมบันทึก audit (3b) | ALLOW (service role เท่านั้น) | `310`, `tests/functions` |
| ส่งสำเนาไฟล์งานไป Google Drive (ภาระงานในรุ่นที่ตนเป็นผู้ตรวจ) · อ่านบันทึกการส่งและไฟล์ที่อยู่ใน Drive แล้ว (3b) | ALLOW: trainer / ผู้ดูแลรุ่น (`is_cohort_assessor`) | `320`, `tests/functions` |
| ส่งสำเนาโดยผู้เรียน ครูพี่เลี้ยง คนนอก หรือไม่ล็อกอิน · เห็นบันทึกการส่ง (ผู้เรียน/ครูพี่เลี้ยง) · เขียน/ลบบันทึกตรง · ปิดงานเอง (ปลอมผล) แม้เป็น trainer · ส่งร่างหรือไฟล์ของภาระงานอื่น · กดซ้ำระหว่างกำลังส่ง (SE008) · กุญแจ server ลบบันทึกหรือแก้ผู้กด/เวลาเริ่ม (3b) | DENY | `320`, `tests/functions` (mutation test ยืนยัน 2 กรณี) |
| ผู้ดูแลแก้ชื่อ ชื่อที่แสดง และรหัสประจำตัวของคนในขอบเขต (ผู้บริหารโรงเรียน → ครูของโรงเรียน · ผู้ดูแลเขต → คนในเขตรวมผู้บริหาร/ศน. · ผู้ดูแลระบบ → ทุกคนรวมตนเอง) (4a) | ALLOW | `330` |
| ตั้งรหัสของตนเอง (ยกเว้นผู้ดูแลระบบ) · แก้คนนอกขอบเขต · ผู้บริหารโรงเรียนแก้ผู้บริหาร/ศน./ผู้มีบทบาทระดับระบบ · รหัสซ้ำแม้ต่างตัวพิมพ์ · รูปแบบรหัสผิด · การนำเข้าเขียนทับหรือแย่งรหัสของคนอื่น (4a) | DENY | `330` (mutation test ยืนยัน 3 กรณี) |
| ลบหลักสูตร แบบทดสอบ Rubric ภาระงาน ที่ยังไม่มีผู้ใช้ (ผู้จัดการรายการนั้น · พิมพ์รหัส/ชื่อยืนยัน) (4a) | ALLOW | `340` |
| ลบรายการที่มีผู้ลงทะเบียน การสอบ งานที่ส่ง (แม้ร่าง) ผลตรวจ สำเนา Drive หรือ Rubric ที่ภาระงานเลือกใช้ · ลบโดยไม่ใช่ผู้จัดการ · ยืนยันผิด · ลบข้อของฉบับที่เผยแพร่แล้วโดยตรง · ผู้ใช้เรียกฟังก์ชันล้างสื่อ (4a) | DENY | `340` (mutation test ยืนยัน 3 กรณี) · FK RESTRICT ยืนยันว่าแม้ข้ามการตรวจก็ลบผลไม่ได้ |
| ลบบัญชี (ข้อมูลส่วนตัวหมด ผลคงอยู่แบบไม่ระบุตัว, พิมพ์อีเมลยืนยัน) (4a) | ALLOW: ผู้ดูแลระบบ | `350`, `tests/functions` |
| ผู้ดูแลเขต/อื่น ๆ ลบบัญชี · ผู้ดูแลระบบลบตนเองหรือผู้มีบทบาทระดับระบบ · ยืนยันอีเมลผิด · เปิดใช้/แก้บัญชีที่ลบแล้ว · ตั้งสถานะ deleted เอง · บัญชีที่ลบแล้วทำอะไรได้ (แม้ session ค้าง) (4a) | DENY | `350` (mutation test ยืนยัน 2 กรณี) · function test ยืนยันว่าเข้าสู่ระบบไม่ได้หลังลบ |
| รายชื่อบัญชีพร้อมอีเมลและการค้นหา (ผู้ดูแลระบบ: ทุกคน · ผู้ดูแลเขต/ผู้บริหารโรงเรียน: คนในขอบเขต) (4a) | ALLOW | `360` |
| ครู/ครูพี่เลี้ยงเรียกรายชื่อบัญชี · ค้นหาข้ามขอบเขต · เห็นอีเมลของบัญชีที่ลบแล้ว · หน้าเสนอปุ่มที่ฐานข้อมูลจะปฏิเสธ (4a) | DENY | `360`, `tests/unit/accounts.test.js`, `tests/e2e/accounts.spec.js` |
| เห็นเหตุผลที่ลบไม่ได้ + ลบด้วยการพิมพ์รหัส/ชื่อ + เก็บถาวร/นำกลับมาใช้ แบบทดสอบ Rubric (ผู้จัดการหลักสูตร) (4a) | ALLOW | `340`, `tests/unit/deletion.test.js`, `tests/unit/delete-wiring.test.js`, `tests/e2e/delete-unused.spec.js` |
| ปุ่มลบเปิดโดยไม่พิมพ์ยืนยันตรง · ส่งฟอร์มบังคับด้วยข้อความผิด · หน้าแสดงปุ่มลบให้รายการที่มีผู้ใช้ · ลบหลักสูตรที่มีผู้เรียน (E2E: เก็บถาวรได้ ลบไม่ได้ ข้อมูลผู้เรียนยังอยู่) (4a) | DENY | `deletion.test.js` (mutation test ยืนยัน 3 กรณี), E2E |
| มอบหมายแบบทดสอบที่เก็บถาวร (สร้าง เผยแพร่ร่าง เปิดการมอบหมายที่เก็บถาวรอีกครั้ง แม้ด้วยกุญแจ server ย้ายการมอบหมายไปฉบับนั้น) · เลือก Rubric ที่เก็บถาวรให้ภาระงาน (ใหม่หรือเปลี่ยน) (4d) | DENY (SE010) | `370` (mutation test: ถอด trigger แล้วตก 8 ข้อ), `tests/integration/assignments.test.js` |
| การมอบหมายที่เปิดอยู่ของแบบทดสอบที่เก็บถาวร: แก้ไข ปิด เก็บถาวร ผู้เรียนเริ่มทำ · ภาระงานที่มี Rubric นั้นอยู่แล้ว: แก้ไข ถอด Rubric ออก · นำกลับมาใช้แล้วมอบหมายได้อีก (4d) | ALLOW | `370` |
| แนบไฟล์เข้างานระหว่างที่งานนั้นกำลังถูกส่ง (race) · แนบพร้อมกันจนเกิน 5 ไฟล์ (3) | DENY (trigger ล็อกแถวของรอบก่อนตรวจ) | ทดลองสองเซสชันจริง (ดู TEST_REPORT_PHASE3 ขั้น 8) |
| Trainee อ่าน/อัปโหลดไฟล์ของบทเรียน draft หรือที่ตนไม่มีสิทธิ์ | DENY | `070` + `tests/integration/storage.test.js` |
| ผู้เรียนเห็นหน่วย/บทเรียน draft; ผู้แก้เรียงลำดับข้ามหลักสูตร | DENY | `050`, `080` |
| ฝัง `<script>`/`onerror`/`javascript:` ในบล็อกข้อความ | DENY (DB CHECK) | `080` |
| นำเข้ารายชื่อนอกขอบเขต / มอบบทบาทสูงกว่าสิทธิ์ตน | DENY | `090` |
| อีเมลยังไม่ยืนยัน / อีเมลไม่ตรงรายชื่อ / metadata ปลอม ผูกบัญชี | DENY (ไม่ผูก) | `090` + `tests/integration/preregistration.test.js` (GoTrue + Mailpit จริง) |
| ผู้นำเข้าถูกถอนสิทธิ์ก่อนผู้ใช้ล็อกอินครั้งแรก | DENY (ไม่ผูก) | `090` #26 |

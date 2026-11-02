# Permissions Model — SolveEdu Platform (Phase 1)

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
| `private.*` | ❌ ทุก role ของ client | ❌ | ❌ | ❌ |

`anon` ไม่มีสิทธิ์ใด ๆ ใน Phase 1

## 4. Trusted RPCs

| RPC | ใครเรียกได้ | การตรวจภายใน |
|---|---|---|
| `admin_set_profile_status(p_target, p_status, p_reason)` | authenticated | ต้องล็อกอิน · ห้ามแก้ตนเอง · `can_admin_user` · ผู้ถือ platform role แก้ได้เฉพาะ platform admin · ผู้ถือ admin/supervisor แก้ได้เฉพาะ district_admin เหนือ org (district_admin แก้ได้เฉพาะ platform admin) · บันทึก audit + เหตุผล |
| `get_profile_contact(p_target)` | authenticated | ตนเอง หรือ `can_admin_user` |

ทั้งสองฟังก์ชัน `REVOKE EXECUTE FROM PUBLIC, anon`

## 5. Audit

`private.audit_logs` (append-only, client อ่านไม่ได้) บันทึกอัตโนมัติเมื่อ INSERT/UPDATE/DELETE ใน `organization_memberships`, `platform_role_assignments`, `cohort_memberships`, `mentor_assignments` และทุกครั้งที่เรียก `admin_set_profile_status` (actor, ค่าเดิม, ค่าใหม่, เหตุผล)

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
| ส่งข้อสอบซ้ำพร้อมกัน / เฉลยรั่ว | — | Phase 2 |

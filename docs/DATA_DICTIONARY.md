# Data Dictionary — SolveEdu Platform (Phase 3)

> สร้างอัตโนมัติจากฐานข้อมูล Local ด้วย `scripts/db-local/gen-data-dictionary.py` — อย่าแก้ไขด้วยมือ  
> ทุกตารางใน `public` เปิด RLS; สิทธิ์รายคอลัมน์ดู `PERMISSIONS.md`

## สารบัญ

- [`profiles`](#profiles) — บัญชีบุคคล 1:1 กับ auth.users — ไม่มีรหัสผ่าน ไม่มีบทบาท (บทบาทอยู่ในตาราง membership)
- [`organizations`](#organizations) — หน่วยงานแบบลำดับชั้น (เขตพื้นที่ → โรงเรียน); trigger ป้องกันวงวน
- [`organization_memberships`](#organization-memberships) — บทบาทของบุคคลในหน่วยงาน; active = ended_at IS NULL; ถอนสิทธิ์ = ตั้ง ended_at (ทางเดียว)
- [`platform_role_assignments`](#platform-role-assignments) — บทบาทระดับระบบ (platform_admin/support) แยกจากผู้ดูแลเขตพื้นที่; ห้ามมอบให้ตนเอง
- [`programs`](#programs) — โครงการพัฒนาครู (fiscal_year = ปีงบประมาณ พ.ศ.)
- [`cohorts`](#cohorts) — รุ่น/กลุ่มผู้เข้าร่วมภายใต้โครงการ
- [`cohort_memberships`](#cohort-memberships) — บทบาทในรุ่น trainee\|trainer\|mentor\|coordinator — หนึ่งคนมีหลายบทบาทได้
- [`mentor_assignments`](#mentor-assignments) — การจับคู่พี่เลี้ยง–ครู ภายในรุ่นเดียวกัน (trigger ตรวจบทบาท)
- [`courses`](#courses) — หลักสูตร/รายวิชา — ใช้ซ้ำได้หลายโครงการผ่าน program_courses
- [`program_courses`](#program-courses) — ตารางเชื่อม M:N โครงการ–หลักสูตร
- [`course_units`](#course-units) — หน่วยการเรียนรู้ในหลักสูตร
- [`lessons`](#lessons) — บทเรียนย่อยในหน่วย
- [`lesson_blocks`](#lesson-blocks) — บล็อกเนื้อหาของบทเรียน; content_json ตรวจรูปแบบตาม block_type ด้วย CHECK
- [`course_enrollments`](#course-enrollments) — การลงทะเบียนหลักสูตรภายใต้บริบทรุ่น (cohort) เสมอ
- [`lesson_progress`](#lesson-progress) — ความก้าวหน้ารายบทเรียน; started_at/completed_at ประทับเวลาโดยเซิร์ฟเวอร์
- [`preregistrations`](#preregistrations) — รายชื่อลงทะเบียนล่วงหน้าจาก CSV — ผูกบัญชีเมื่อผู้ใช้ล็อกอินด้วยอีเมลที่ยืนยันแล้วตรงกัน (claim_my_preregistrations)
- [`instruments`](#instruments) — เครื่องมือวัด (Phase 2B: แบบทดสอบ quiz) — ผูกหน่วยงานเจ้าของ และอาจผูกหลักสูตร
- [`instrument_versions`](#instrument-versions) — ฉบับของเครื่องมือวัด — draft แก้ได้; published แก้ไม่ได้ (สร้างฉบับใหม่แทน); version_no กำหนดโดย server
- [`instrument_items`](#instrument-items) — ข้อคำถาม — options_json ตรวจรูปแบบตาม item_type และห้ามมีเฉลย; รูปอยู่ใต้โฟลเดอร์ <instrument_id>/
- [`assessment_assignments`](#assessment-assignments) — การมอบหมายฉบับที่เผยแพร่แล้วให้รุ่น (และหลักสูตร) พร้อมช่วงเวลา จำนวนครั้ง และเกณฑ์ผ่าน
- [`assessment_attempts`](#assessment-attempts) — ครั้งที่ทำแบบทดสอบ — เขียนโดย RPC ฝั่ง server เท่านั้น (คะแนน เวลาเริ่ม/ส่ง ไม่มาจาก browser)
- [`assessment_responses`](#assessment-responses) — คำตอบรายข้อ — client อ่านได้เฉพาะคำตอบ ไม่ได้รับ awarded_score รายข้อ
- [`assessment_extra_attempts`](#assessment-extra-attempts) — สิทธิ์ทำเพิ่มรายบุคคล (+1 ครั้งต่อแถว) — แก้/ลบไม่ได้; ผู้มอบและเวลาบันทึกโดย server
- [`tasks`](#tasks) — ภาระงานของหลักสูตร (Phase 3) · rubric_version_id = Rubric ฉบับเผยแพร่ (ไม่บังคับ) · draft/published/archived
- [`task_allocations`](#task-allocations) — เปิดภาระงานให้รุ่น: วันเปิด/กำหนดส่ง (ส่งช้าได้ แต่ติดป้าย)
- [`task_submissions`](#task-submissions) — การส่งงานรายรอบ: ผู้ส่งแก้ได้เฉพาะร่าง · ส่งแล้วแก้ไม่ได้ · submitted_at/is_late จาก server
- [`task_submission_files`](#task-submission-files) — ไฟล์ของการส่งงาน (bucket task-files ส่วนตัว) · ขนาด/ชนิดอ่านจาก storage ฝั่ง server
- [`task_reviews`](#task-reviews) — ผลการตรวจงานรายรอบ: ร่าง (เฉพาะผู้ตรวจ) → ส่งผล (ผู้เรียนเห็น, แก้ไม่ได้) · คะแนนรวมจาก server · ตรวจใหม่ = แถวใหม่ + เหตุผล + supersedes_id
- [`task_review_scores`](#task-review-scores) — ระดับที่เลือกรายเกณฑ์ของ Rubric + ความเห็น · score = คะแนนของระดับ (server)
- [`task_review_reads`](#task-review-reads) — ผู้เรียนเปิดดูผลตรวจที่ส่งแล้วหรือยัง (ป้ายแจ้งเตือนในเมนู) · เจ้าของงานเท่านั้นที่เพิ่มแถวของตนได้
- [`task_drive_exports`](#task-drive-exports) — การส่งสำเนาไฟล์งานไป Google Drive ส่วนกลาง (ต่อภาระงานต่อรุ่น): ใคร เมื่อไร ผลเป็นอย่างไร · เขียนผ่าน begin/finish เท่านั้น
- [`task_drive_copies`](#task-drive-copies) — ไฟล์งานที่อยู่ใน Google Drive แล้ว: ไฟล์ไหน = ไฟล์ Drive ใด ส่งในครั้งไหน

## profiles

บัญชีบุคคล 1:1 กับ auth.users — ไม่มีรหัสผ่าน ไม่มีบทบาท (บทบาทอยู่ในตาราง membership)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ |  |  |
| `full_name` | text | ✓ | `''::text` |  |
| `display_name` | text |  |  |  |
| `avatar_path` | text |  |  | Storage object path (private bucket) — ไม่ใช่ public URL |
| `contact_email` | text |  |  | อีเมลติดต่อ — ไม่ GRANT SELECT ให้ client; อ่านผ่าน get_profile_contact() |
| `requested_org_id` | uuid |  |  | สถานศึกษาที่ผู้สมัครขอสังกัด ใช้กำหนดผู้มีสิทธิ์อนุมัติ; แก้ได้เฉพาะช่วง pending |
| `status` | text | ✓ | `'pending'::text` | pending\|active\|suspended — เปลี่ยนได้ผ่าน admin_set_profile_status() เท่านั้น |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `profiles_avatar_path_own_folder`: `CHECK (((avatar_path IS NULL) OR (avatar_path ~~ ((id)::text \|\| '/%'::text))))`
- `profiles_display_name_len`: `CHECK (((display_name IS NULL) OR (char_length(display_name) <= 100)))`
- `profiles_full_name_len`: `CHECK ((char_length(full_name) <= 200))`
- `profiles_status_check`: `CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text])))`
- `profiles_id_fkey`: `FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE`
- `profiles_requested_org_fk`: `FOREIGN KEY (requested_org_id) REFERENCES organizations(id) ON DELETE SET NULL`
- `profiles_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE INDEX profiles_requested_org_idx ON public.profiles USING btree (requested_org_id)`
- `CREATE INDEX profiles_status_idx ON public.profiles USING btree (status)`

## organizations

หน่วยงานแบบลำดับชั้น (เขตพื้นที่ → โรงเรียน); trigger ป้องกันวงวน

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `org_type` | text | ✓ |  |  |
| `parent_id` | uuid |  |  |  |
| `active` | boolean | ✓ | `true` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `organizations_not_own_parent`: `CHECK (((parent_id IS NULL) OR (parent_id <> id)))`
- `organizations_org_type_check`: `CHECK ((org_type = ANY (ARRAY['district'::text, 'school'::text, 'other'::text])))`
- `organizations_parent_id_fkey`: `FOREIGN KEY (parent_id) REFERENCES organizations(id) ON DELETE RESTRICT`
- `organizations_pkey`: `PRIMARY KEY (id)`
- `organizations_code_unique`: `UNIQUE (org_type, code)`

**Indexes**

- `CREATE INDEX organizations_parent_idx ON public.organizations USING btree (parent_id)`

## organization_memberships

บทบาทของบุคคลในหน่วยงาน; active = ended_at IS NULL; ถอนสิทธิ์ = ตั้ง ended_at (ทางเดียว)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `user_id` | uuid | ✓ |  |  |
| `organization_id` | uuid | ✓ |  |  |
| `org_role` | text | ✓ |  | district_admin\|supervisor\|school_admin\|teacher — สิทธิ์ครอบคลุมหน่วยงานลูกทั้งหมด |
| `started_at` | timestamp with time zone | ✓ | `now()` |  |
| `ended_at` | timestamp with time zone |  |  |  |
| `granted_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `org_memberships_period`: `CHECK (((ended_at IS NULL) OR (ended_at >= started_at)))`
- `organization_memberships_org_role_check`: `CHECK ((org_role = ANY (ARRAY['district_admin'::text, 'supervisor'::text, 'school_admin'::text, 'teacher'::text])))`
- `organization_memberships_granted_by_fkey`: `FOREIGN KEY (granted_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `organization_memberships_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT`
- `organization_memberships_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `organization_memberships_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE UNIQUE INDEX org_memberships_active_unique ON public.organization_memberships USING btree (user_id, organization_id, org_role) WHERE (ended_at IS NULL)`
- `CREATE INDEX org_memberships_org_user_idx ON public.organization_memberships USING btree (organization_id, user_id) WHERE (ended_at IS NULL)`
- `CREATE INDEX org_memberships_user_org_idx ON public.organization_memberships USING btree (user_id, organization_id) WHERE (ended_at IS NULL)`

## platform_role_assignments

บทบาทระดับระบบ (platform_admin/support) แยกจากผู้ดูแลเขตพื้นที่; ห้ามมอบให้ตนเอง

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `user_id` | uuid | ✓ |  |  |
| `role` | text | ✓ |  |  |
| `granted_by` | uuid |  | `auth.uid()` |  |
| `granted_at` | timestamp with time zone | ✓ | `now()` |  |
| `revoked_at` | timestamp with time zone |  |  |  |

**Constraints**

- `platform_role_assignments_role_check`: `CHECK ((role = ANY (ARRAY['platform_admin'::text, 'platform_support'::text])))`
- `platform_roles_period`: `CHECK (((revoked_at IS NULL) OR (revoked_at >= granted_at)))`
- `platform_role_assignments_granted_by_fkey`: `FOREIGN KEY (granted_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `platform_role_assignments_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `platform_role_assignments_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE UNIQUE INDEX platform_roles_active_unique ON public.platform_role_assignments USING btree (user_id, role) WHERE (revoked_at IS NULL)`

## programs

โครงการพัฒนาครู (fiscal_year = ปีงบประมาณ พ.ศ.)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `description` | text |  |  |  |
| `fiscal_year` | integer | ✓ |  |  |
| `owner_org_id` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `start_at` | timestamp with time zone |  |  |  |
| `end_at` | timestamp with time zone |  |  |  |
| `created_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `programs_fiscal_year_check`: `CHECK (((fiscal_year >= 2500) AND (fiscal_year <= 2700)))`
- `programs_period`: `CHECK (((end_at IS NULL) OR (start_at IS NULL) OR (end_at >= start_at)))`
- `programs_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'closed'::text, 'archived'::text])))`
- `programs_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `programs_owner_org_id_fkey`: `FOREIGN KEY (owner_org_id) REFERENCES organizations(id) ON DELETE RESTRICT`
- `programs_pkey`: `PRIMARY KEY (id)`
- `programs_code_unique`: `UNIQUE (owner_org_id, code)`

**Indexes**

- `CREATE INDEX programs_owner_org_idx ON public.programs USING btree (owner_org_id)`

## cohorts

รุ่น/กลุ่มผู้เข้าร่วมภายใต้โครงการ

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `program_id` | uuid | ✓ |  |  |
| `code` | text | ✓ |  |  |
| `name` | text | ✓ |  |  |
| `start_at` | timestamp with time zone |  |  |  |
| `end_at` | timestamp with time zone |  |  |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `cohorts_period`: `CHECK (((end_at IS NULL) OR (start_at IS NULL) OR (end_at >= start_at)))`
- `cohorts_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'in_progress'::text, 'closed'::text, 'archived'::text])))`
- `cohorts_program_id_fkey`: `FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE RESTRICT`
- `cohorts_pkey`: `PRIMARY KEY (id)`
- `cohorts_code_unique`: `UNIQUE (program_id, code)`

**Indexes**

- `CREATE INDEX cohorts_program_idx ON public.cohorts USING btree (program_id)`

## cohort_memberships

บทบาทในรุ่น trainee\|trainer\|mentor\|coordinator — หนึ่งคนมีหลายบทบาทได้

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `cohort_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `cohort_role` | text | ✓ |  |  |
| `status` | text | ✓ | `'active'::text` |  |
| `approved_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `cohort_memberships_cohort_role_check`: `CHECK ((cohort_role = ANY (ARRAY['trainee'::text, 'trainer'::text, 'mentor'::text, 'coordinator'::text])))`
- `cohort_memberships_status_check`: `CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'withdrawn'::text])))`
- `cohort_memberships_approved_by_fkey`: `FOREIGN KEY (approved_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `cohort_memberships_cohort_id_fkey`: `FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT`
- `cohort_memberships_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `cohort_memberships_pkey`: `PRIMARY KEY (id)`
- `cohort_memberships_unique`: `UNIQUE (cohort_id, user_id, cohort_role)`

**Indexes**

- `CREATE INDEX cohort_memberships_cohort_idx ON public.cohort_memberships USING btree (cohort_id, user_id) WHERE (status = 'active'::text)`
- `CREATE INDEX cohort_memberships_user_idx ON public.cohort_memberships USING btree (user_id, cohort_id) WHERE (status = 'active'::text)`

## mentor_assignments

การจับคู่พี่เลี้ยง–ครู ภายในรุ่นเดียวกัน (trigger ตรวจบทบาท)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `cohort_id` | uuid | ✓ |  |  |
| `mentor_id` | uuid | ✓ |  |  |
| `trainee_id` | uuid | ✓ |  |  |
| `assigned_at` | timestamp with time zone | ✓ | `now()` |  |
| `ended_at` | timestamp with time zone |  |  |  |
| `assigned_by` | uuid |  | `auth.uid()` |  |

**Constraints**

- `mentor_assignments_distinct`: `CHECK ((mentor_id <> trainee_id))`
- `mentor_assignments_period`: `CHECK (((ended_at IS NULL) OR (ended_at >= assigned_at)))`
- `mentor_assignments_assigned_by_fkey`: `FOREIGN KEY (assigned_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `mentor_assignments_cohort_id_fkey`: `FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT`
- `mentor_assignments_mentor_id_fkey`: `FOREIGN KEY (mentor_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `mentor_assignments_trainee_id_fkey`: `FOREIGN KEY (trainee_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `mentor_assignments_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE UNIQUE INDEX mentor_assignments_active_unique ON public.mentor_assignments USING btree (cohort_id, mentor_id, trainee_id) WHERE (ended_at IS NULL)`
- `CREATE INDEX mentor_assignments_mentor_idx ON public.mentor_assignments USING btree (mentor_id, cohort_id) WHERE (ended_at IS NULL)`
- `CREATE INDEX mentor_assignments_trainee_idx ON public.mentor_assignments USING btree (trainee_id, cohort_id) WHERE (ended_at IS NULL)`

## courses

หลักสูตร/รายวิชา — ใช้ซ้ำได้หลายโครงการผ่าน program_courses

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `code` | text | ✓ |  |  |
| `title` | text | ✓ |  |  |
| `summary` | text |  |  |  |
| `description` | text |  |  |  |
| `duration_minutes` | integer |  |  |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `owner_org_id` | uuid | ✓ |  |  |
| `created_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `courses_duration_minutes_check`: `CHECK (((duration_minutes IS NULL) OR (duration_minutes >= 0)))`
- `courses_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))`
- `courses_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `courses_owner_org_id_fkey`: `FOREIGN KEY (owner_org_id) REFERENCES organizations(id) ON DELETE RESTRICT`
- `courses_pkey`: `PRIMARY KEY (id)`
- `courses_code_unique`: `UNIQUE (owner_org_id, code)`

**Indexes**

- `CREATE INDEX courses_owner_org_idx ON public.courses USING btree (owner_org_id)`
- `CREATE INDEX courses_status_idx ON public.courses USING btree (status)`

## program_courses

ตารางเชื่อม M:N โครงการ–หลักสูตร

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `program_id` | uuid | ✓ |  |  |
| `course_id` | uuid | ✓ |  |  |
| `display_order` | integer | ✓ | `0` |  |

**Constraints**

- `program_courses_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `program_courses_program_id_fkey`: `FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE`
- `program_courses_pkey`: `PRIMARY KEY (program_id, course_id)`

**Indexes**

- `CREATE INDEX program_courses_course_idx ON public.program_courses USING btree (course_id)`

## course_units

หน่วยการเรียนรู้ในหลักสูตร

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `course_id` | uuid | ✓ |  |  |
| `title` | text | ✓ |  |  |
| `description` | text |  |  |  |
| `display_order` | integer | ✓ |  |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `course_units_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))`
- `course_units_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE`
- `course_units_pkey`: `PRIMARY KEY (id)`
- `course_units_order_unique`: `UNIQUE (course_id, display_order) DEFERRABLE INITIALLY DEFERRED`

## lessons

บทเรียนย่อยในหน่วย

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `unit_id` | uuid | ✓ |  |  |
| `title` | text | ✓ |  |  |
| `learning_objectives` | text |  |  |  |
| `display_order` | integer | ✓ |  |  |
| `required` | boolean | ✓ | `true` |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `lessons_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))`
- `lessons_unit_id_fkey`: `FOREIGN KEY (unit_id) REFERENCES course_units(id) ON DELETE CASCADE`
- `lessons_pkey`: `PRIMARY KEY (id)`
- `lessons_order_unique`: `UNIQUE (unit_id, display_order) DEFERRABLE INITIALLY DEFERRED`

## lesson_blocks

บล็อกเนื้อหาของบทเรียน; content_json ตรวจรูปแบบตาม block_type ด้วย CHECK

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `lesson_id` | uuid | ✓ |  |  |
| `block_type` | text | ✓ |  |  |
| `content_json` | jsonb | ✓ | `'{}'::jsonb` |  |
| `display_order` | integer | ✓ |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `lesson_blocks_block_type_check`: `CHECK ((block_type = ANY (ARRAY['rich_text'::text, 'video'::text, 'image'::text, 'document'::text, 'link'::text, 'embed'::text, 'quiz_reference'::text])))`
- `lesson_blocks_content_valid`: `CHECK (private.is_valid_lesson_block(block_type, content_json))`
- `lesson_blocks_object_in_lesson_folder`: `CHECK ((((content_json ->> 'object_path'::text) IS NULL) OR (starts_with((content_json ->> 'object_path'::text), ((lesson_id)::text \|\| '/'::text)) AND ((content_json ->> 'object_path'::text) !~ '(^\|/)\.\.(/\|$)'::text))))`
- `lesson_blocks_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE`
- `lesson_blocks_pkey`: `PRIMARY KEY (id)`
- `lesson_blocks_order_unique`: `UNIQUE (lesson_id, display_order) DEFERRABLE INITIALLY DEFERRED`

## course_enrollments

การลงทะเบียนหลักสูตรภายใต้บริบทรุ่น (cohort) เสมอ

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `cohort_id` | uuid | ✓ |  |  |
| `course_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'active'::text` |  |
| `enrolled_at` | timestamp with time zone | ✓ | `now()` |  |
| `completed_at` | timestamp with time zone |  |  |  |
| `enrolled_by` | uuid |  | `auth.uid()` |  |

**Constraints**

- `course_enrollments_status_check`: `CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'withdrawn'::text])))`
- `course_enrollments_cohort_id_fkey`: `FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT`
- `course_enrollments_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `course_enrollments_enrolled_by_fkey`: `FOREIGN KEY (enrolled_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `course_enrollments_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT`
- `course_enrollments_pkey`: `PRIMARY KEY (id)`
- `course_enrollments_unique`: `UNIQUE (cohort_id, course_id, user_id)`

**Indexes**

- `CREATE INDEX course_enrollments_course_idx ON public.course_enrollments USING btree (course_id)`
- `CREATE INDEX course_enrollments_user_idx ON public.course_enrollments USING btree (user_id, cohort_id)`

## lesson_progress

ความก้าวหน้ารายบทเรียน; started_at/completed_at ประทับเวลาโดยเซิร์ฟเวอร์

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `enrollment_id` | uuid | ✓ |  |  |
| `lesson_id` | uuid | ✓ |  |  |
| `status` | text | ✓ | `'in_progress'::text` |  |
| `progress_percent` | numeric(5,2) | ✓ | `0` |  |
| `started_at` | timestamp with time zone |  |  |  |
| `completed_at` | timestamp with time zone |  |  |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `lesson_progress_progress_percent_check`: `CHECK (((progress_percent >= (0)::numeric) AND (progress_percent <= (100)::numeric)))`
- `lesson_progress_status_check`: `CHECK ((status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text])))`
- `lesson_progress_enrollment_id_fkey`: `FOREIGN KEY (enrollment_id) REFERENCES course_enrollments(id) ON DELETE RESTRICT`
- `lesson_progress_lesson_id_fkey`: `FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE RESTRICT`
- `lesson_progress_pkey`: `PRIMARY KEY (id)`
- `lesson_progress_unique`: `UNIQUE (enrollment_id, lesson_id)`

**Indexes**

- `CREATE INDEX lesson_progress_lesson_idx ON public.lesson_progress USING btree (lesson_id)`

## preregistrations

รายชื่อลงทะเบียนล่วงหน้าจาก CSV — ผูกบัญชีเมื่อผู้ใช้ล็อกอินด้วยอีเมลที่ยืนยันแล้วตรงกัน (claim_my_preregistrations)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `email` | text | ✓ |  |  |
| `full_name` | text | ✓ | `''::text` |  |
| `organization_id` | uuid | ✓ |  |  |
| `org_role` | text | ✓ | `'teacher'::text` |  |
| `cohort_id` | uuid |  |  |  |
| `cohort_role` | text |  |  |  |
| `status` | text | ✓ | `'pending'::text` |  |
| `batch_id` | uuid |  |  |  |
| `imported_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `claimed_by` | uuid |  |  |  |
| `claimed_at` | timestamp with time zone |  |  |  |

**Constraints**

- `prereg_claim_state`: `CHECK (((status = 'claimed'::text) = ((claimed_by IS NOT NULL) AND (claimed_at IS NOT NULL))))`
- `prereg_cohort_pair`: `CHECK (((cohort_id IS NULL) = (cohort_role IS NULL)))`
- `prereg_email_format`: `CHECK (((email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text) AND (char_length(email) <= 254)))`
- `prereg_email_normalised`: `CHECK ((email = lower(btrim(email))))`
- `prereg_name_len`: `CHECK ((char_length(full_name) <= 200))`
- `preregistrations_cohort_role_check`: `CHECK ((cohort_role = ANY (ARRAY['trainee'::text, 'trainer'::text, 'mentor'::text, 'coordinator'::text])))`
- `preregistrations_org_role_check`: `CHECK ((org_role = ANY (ARRAY['district_admin'::text, 'supervisor'::text, 'school_admin'::text, 'teacher'::text])))`
- `preregistrations_status_check`: `CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'cancelled'::text])))`
- `preregistrations_claimed_by_fkey`: `FOREIGN KEY (claimed_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `preregistrations_cohort_id_fkey`: `FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT`
- `preregistrations_imported_by_fkey`: `FOREIGN KEY (imported_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `preregistrations_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT`
- `preregistrations_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE INDEX prereg_email_pending_idx ON public.preregistrations USING btree (email) WHERE (status = 'pending'::text)`
- `CREATE INDEX prereg_org_idx ON public.preregistrations USING btree (organization_id, status)`
- `CREATE UNIQUE INDEX prereg_pending_unique ON public.preregistrations USING btree (email, organization_id, org_role, COALESCE(cohort_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = 'pending'::text)`

## instruments

เครื่องมือวัด (Phase 2B: แบบทดสอบ quiz) — ผูกหน่วยงานเจ้าของ และอาจผูกหลักสูตร

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `owner_org_id` | uuid | ✓ |  |  |
| `course_id` | uuid |  |  |  |
| `code` | text | ✓ |  |  |
| `title` | text | ✓ |  |  |
| `description` | text |  |  |  |
| `instrument_type` | text | ✓ | `'quiz'::text` | quiz \| rubric (Phase 3) — ตั้งได้ตอนสร้างเท่านั้น (ไม่มี grant update) |
| `status` | text | ✓ | `'active'::text` |  |
| `created_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `instruments_code_check`: `CHECK (((char_length(code) >= 1) AND (char_length(code) <= 50)))`
- `instruments_description_check`: `CHECK (((description IS NULL) OR (char_length(description) <= 5000)))`
- `instruments_instrument_type_check`: `CHECK ((instrument_type = ANY (ARRAY['quiz'::text, 'rubric'::text])))`
- `instruments_status_check`: `CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))`
- `instruments_title_check`: `CHECK (((char_length(title) >= 1) AND (char_length(title) <= 300)))`
- `instruments_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `instruments_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `instruments_owner_org_id_fkey`: `FOREIGN KEY (owner_org_id) REFERENCES organizations(id) ON DELETE RESTRICT`
- `instruments_pkey`: `PRIMARY KEY (id)`
- `instruments_code_unique`: `UNIQUE (owner_org_id, code)`

**Indexes**

- `CREATE INDEX instruments_course_idx ON public.instruments USING btree (course_id)`

## instrument_versions

ฉบับของเครื่องมือวัด — draft แก้ได้; published แก้ไม่ได้ (สร้างฉบับใหม่แทน); version_no กำหนดโดย server

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `instrument_id` | uuid | ✓ |  |  |
| `version_no` | integer | ✓ |  |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `published_at` | timestamp with time zone |  |  |  |
| `published_by` | uuid |  |  |  |
| `content_hash` | text |  |  |  |
| `created_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `instrument_versions_published_state`: `CHECK ((((status = 'draft'::text) = (published_at IS NULL)) AND ((status = 'draft'::text) = (content_hash IS NULL))))`
- `instrument_versions_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))`
- `instrument_versions_version_no_check`: `CHECK ((version_no >= 1))`
- `instrument_versions_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `instrument_versions_instrument_id_fkey`: `FOREIGN KEY (instrument_id) REFERENCES instruments(id) ON DELETE RESTRICT`
- `instrument_versions_published_by_fkey`: `FOREIGN KEY (published_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `instrument_versions_pkey`: `PRIMARY KEY (id)`
- `instrument_versions_no_unique`: `UNIQUE (instrument_id, version_no)`

**Indexes**

- `CREATE UNIQUE INDEX instrument_versions_one_draft ON public.instrument_versions USING btree (instrument_id) WHERE (status = 'draft'::text)`

## instrument_items

ข้อคำถาม — options_json ตรวจรูปแบบตาม item_type และห้ามมีเฉลย; รูปอยู่ใต้โฟลเดอร์ <instrument_id>/

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `instrument_version_id` | uuid | ✓ |  |  |
| `item_type` | text | ✓ |  | mcq_single\|mcq_multiple\|true_false\|numeric (2B) · ordering\|matching\|classification\|choice_matrix\|dropdown\|cloze\|image_labelling (2C) · rubric_criterion (3) |
| `prompt` | text | ✓ |  |  |
| `media_path` | text |  |  |  |
| `options_json` | jsonb | ✓ | `'{}'::jsonb` |  |
| `max_score` | numeric(10,2) | ✓ | `1` |  |
| `display_order` | integer | ✓ |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `scoring_mode` | text |  |  | partial \| all_or_nothing · null = ค่าเริ่มต้นของประเภท (mcq_multiple: all_or_nothing, ข้อแบบใหม่: partial) · ไม่ใช่ความลับ (2C.1) |

**Constraints**

- `instrument_items_item_type_check`: `CHECK ((item_type = ANY (ARRAY['mcq_single'::text, 'mcq_multiple'::text, 'true_false'::text, 'numeric'::text, 'ordering'::text, 'matching'::text, 'classification'::text, 'choice_matrix'::text, 'dropdown'::text, 'cloze'::text, 'image_labelling'::text, 'rubric_criterion'::text])))`
- `instrument_items_max_score_check`: `CHECK (((max_score > (0)::numeric) AND (max_score <= (1000)::numeric)))`
- `instrument_items_prompt_check`: `CHECK (((char_length(prompt) >= 1) AND (char_length(prompt) <= 5000)))`
- `instrument_items_scoring_mode_check`: `CHECK ((scoring_mode = ANY (ARRAY['partial'::text, 'all_or_nothing'::text])))`
- `instrument_items_scoring_mode_type_check`: `CHECK (((scoring_mode IS NULL) OR (item_type <> ALL (ARRAY['mcq_single'::text, 'true_false'::text, 'numeric'::text]))))`
- `instrument_items_instrument_version_id_fkey`: `FOREIGN KEY (instrument_version_id) REFERENCES instrument_versions(id) ON DELETE CASCADE`
- `instrument_items_pkey`: `PRIMARY KEY (id)`
- `instrument_items_order_unique`: `UNIQUE (instrument_version_id, display_order) DEFERRABLE INITIALLY DEFERRED`

## assessment_assignments

การมอบหมายฉบับที่เผยแพร่แล้วให้รุ่น (และหลักสูตร) พร้อมช่วงเวลา จำนวนครั้ง และเกณฑ์ผ่าน

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `instrument_version_id` | uuid | ✓ |  |  |
| `cohort_id` | uuid | ✓ |  |  |
| `course_id` | uuid |  |  |  |
| `purpose` | text | ✓ |  |  |
| `title` | text | ✓ |  |  |
| `instructions` | text |  |  |  |
| `open_at` | timestamp with time zone |  |  |  |
| `close_at` | timestamp with time zone |  |  | เวลาปิดรับ — บังคับเมื่อเผยแพร่ (ทุกครั้งที่ทำจึงมีเส้นตาย และถูกปิดอัตโนมัติเสมอ) |
| `attempt_limit` | integer | ✓ | `1` |  |
| `passing_percent` | numeric(5,2) |  |  | เกณฑ์ผ่าน (%) ต่อการมอบหมาย; null = ไม่ตัดสินผ่าน/ไม่ผ่าน |
| `status` | text | ✓ | `'draft'::text` |  |
| `created_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |
| `time_limit_minutes` | integer |  |  | เวลาทำต่อครั้ง (นาที); null = ใช้เฉพาะช่วงเปิด–ปิด — ตรึงเมื่อมีผู้เริ่มทำ |
| `grace_minutes` | integer | ✓ | `5` | ช่วงผ่อนผันหลังเส้นตาย (นาที) ที่ยังรับคำตอบ — กันเน็ตช้าตอนส่ง |
| `shuffle_items` | boolean | ✓ | `false` | สลับลำดับข้อต่อคน (บันทึกใน attempts.presentation_json) |
| `shuffle_choices` | boolean | ✓ | `false` | สลับลำดับตัวเลือกต่อคน (ข้อเรียงลำดับและฝั่งขวาของข้อจับคู่สลับเสมอ) |

**Constraints**

- `assessment_assignments_attempt_limit_check`: `CHECK (((attempt_limit >= 1) AND (attempt_limit <= 20)))`
- `assessment_assignments_grace_minutes_check`: `CHECK (((grace_minutes >= 0) AND (grace_minutes <= 60)))`
- `assessment_assignments_instructions_check`: `CHECK (((instructions IS NULL) OR (char_length(instructions) <= 5000)))`
- `assessment_assignments_passing_percent_check`: `CHECK (((passing_percent IS NULL) OR ((passing_percent >= (0)::numeric) AND (passing_percent <= (100)::numeric))))`
- `assessment_assignments_published_close`: `CHECK (((status <> 'published'::text) OR (close_at IS NOT NULL)))`
- `assessment_assignments_purpose_check`: `CHECK ((purpose = ANY (ARRAY['pretest'::text, 'posttest'::text, 'formative'::text])))`
- `assessment_assignments_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))`
- `assessment_assignments_time_limit_minutes_check`: `CHECK (((time_limit_minutes IS NULL) OR ((time_limit_minutes >= 1) AND (time_limit_minutes <= 600))))`
- `assessment_assignments_title_check`: `CHECK (((char_length(title) >= 1) AND (char_length(title) <= 300)))`
- `assessment_assignments_window`: `CHECK (((open_at IS NULL) OR (close_at IS NULL) OR (close_at > open_at)))`
- `assessment_assignments_cohort_id_fkey`: `FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT`
- `assessment_assignments_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `assessment_assignments_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `assessment_assignments_instrument_version_id_fkey`: `FOREIGN KEY (instrument_version_id) REFERENCES instrument_versions(id) ON DELETE RESTRICT`
- `assessment_assignments_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE INDEX assessment_assignments_cohort_idx ON public.assessment_assignments USING btree (cohort_id, status)`
- `CREATE INDEX assessment_assignments_version_idx ON public.assessment_assignments USING btree (instrument_version_id)`

## assessment_attempts

ครั้งที่ทำแบบทดสอบ — เขียนโดย RPC ฝั่ง server เท่านั้น (คะแนน เวลาเริ่ม/ส่ง ไม่มาจาก browser)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `assignment_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `attempt_no` | integer | ✓ |  |  |
| `status` | text | ✓ | `'in_progress'::text` |  |
| `started_at` | timestamp with time zone | ✓ | `now()` |  |
| `submitted_at` | timestamp with time zone |  |  |  |
| `score` | numeric(10,2) |  |  |  |
| `max_score` | numeric(10,2) |  |  |  |
| `passed` | boolean |  |  |  |
| `correct_count` | integer |  |  | จำนวนข้อที่ได้คะแนนเต็ม — แสดงผู้เรียนได้ (ไม่บอกว่าข้อไหน) |
| `item_count` | integer |  |  |  |
| `draft_json` | jsonb |  |  | คำตอบที่บันทึกระหว่างทำ — ไม่ GRANT ให้ client (ผู้เรียนรับคืนผ่าน start_attempt เท่านั้น); ใช้ให้คะแนนเมื่อหมดเวลา; ล้างเมื่อส่งแล้ว |
| `draft_saved_at` | timestamp with time zone |  |  |  |
| `auto_submitted` | boolean | ✓ | `false` | true = ระบบส่งให้เมื่อหมดเวลา (คะแนนจากคำตอบที่บันทึกไว้) |
| `draft_seq` | bigint | ✓ | `0` | ลำดับการบันทึกคำตอบล่าสุดที่รับไว้ — ไม่ GRANT ให้ client; กันคำขอที่มาช้าทับคำตอบใหม่ |
| `presentation_json` | jsonb |  |  | ลำดับข้อและตัวเลือกที่ผู้ทำเห็น {items:[ids], lists:{item:{list:[ids]}}} — สร้างโดย server ตอนเริ่ม |

**Constraints**

- `assessment_attempts_attempt_no_check`: `CHECK ((attempt_no >= 1))`
- `assessment_attempts_correct_count_check`: `CHECK (((correct_count IS NULL) OR (correct_count >= 0)))`
- `assessment_attempts_draft_shape`: `CHECK (((draft_json IS NULL) OR ((jsonb_typeof(draft_json) = 'object'::text) AND (octet_length((draft_json)::text) <= 65536))))`
- `assessment_attempts_item_count_check`: `CHECK (((item_count IS NULL) OR (item_count >= 0)))`
- `assessment_attempts_score_range`: `CHECK (((score IS NULL) OR ((score >= (0)::numeric) AND (max_score >= (0)::numeric) AND (score <= max_score))))`
- `assessment_attempts_scored`: `CHECK (((status = 'in_progress'::text) OR ((score IS NOT NULL) AND (max_score IS NOT NULL))))`
- `assessment_attempts_status_check`: `CHECK ((status = ANY (ARRAY['in_progress'::text, 'submitted'::text])))`
- `assessment_attempts_submitted_state`: `CHECK (((status = 'submitted'::text) = (submitted_at IS NOT NULL)))`
- `assessment_attempts_time_order`: `CHECK (((submitted_at IS NULL) OR (submitted_at >= started_at)))`
- `assessment_attempts_assignment_id_fkey`: `FOREIGN KEY (assignment_id) REFERENCES assessment_assignments(id) ON DELETE RESTRICT`
- `assessment_attempts_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT`
- `assessment_attempts_pkey`: `PRIMARY KEY (id)`
- `assessment_attempts_no_unique`: `UNIQUE (assignment_id, user_id, attempt_no)`

**Indexes**

- `CREATE UNIQUE INDEX assessment_attempts_one_open ON public.assessment_attempts USING btree (assignment_id, user_id) WHERE (status = 'in_progress'::text)`
- `CREATE INDEX assessment_attempts_user_idx ON public.assessment_attempts USING btree (user_id)`

## assessment_responses

คำตอบรายข้อ — client อ่านได้เฉพาะคำตอบ ไม่ได้รับ awarded_score รายข้อ

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `attempt_id` | uuid | ✓ |  |  |
| `item_id` | uuid | ✓ |  |  |
| `response_json` | jsonb | ✓ |  |  |
| `awarded_score` | numeric(10,2) |  |  |  |
| `graded_at` | timestamp with time zone |  |  |  |
| `graded_by` | uuid |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `assessment_responses_awarded_score_check`: `CHECK (((awarded_score IS NULL) OR (awarded_score >= (0)::numeric)))`
- `assessment_responses_attempt_id_fkey`: `FOREIGN KEY (attempt_id) REFERENCES assessment_attempts(id) ON DELETE RESTRICT`
- `assessment_responses_graded_by_fkey`: `FOREIGN KEY (graded_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `assessment_responses_item_id_fkey`: `FOREIGN KEY (item_id) REFERENCES instrument_items(id) ON DELETE RESTRICT`
- `assessment_responses_pkey`: `PRIMARY KEY (id)`
- `assessment_responses_unique`: `UNIQUE (attempt_id, item_id)`

**Indexes**

- `CREATE INDEX assessment_responses_item_idx ON public.assessment_responses USING btree (item_id)`

## assessment_extra_attempts

สิทธิ์ทำเพิ่มรายบุคคล (+1 ครั้งต่อแถว) — แก้/ลบไม่ได้; ผู้มอบและเวลาบันทึกโดย server

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `assignment_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `reason` | text |  |  |  |
| `granted_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `assessment_extra_attempts_reason_check`: `CHECK (((reason IS NULL) OR (char_length(reason) <= 500)))`
- `assessment_extra_attempts_assignment_id_fkey`: `FOREIGN KEY (assignment_id) REFERENCES assessment_assignments(id) ON DELETE RESTRICT`
- `assessment_extra_attempts_granted_by_fkey`: `FOREIGN KEY (granted_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `assessment_extra_attempts_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT`
- `assessment_extra_attempts_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE INDEX assessment_extra_attempts_idx ON public.assessment_extra_attempts USING btree (assignment_id, user_id)`

## tasks

ภาระงานของหลักสูตร (Phase 3) · rubric_version_id = Rubric ฉบับเผยแพร่ (ไม่บังคับ) · draft/published/archived

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `course_id` | uuid | ✓ |  |  |
| `unit_id` | uuid |  |  |  |
| `title` | text | ✓ |  |  |
| `instructions` | text |  |  |  |
| `rubric_version_id` | uuid |  |  |  |
| `max_attempts` | integer | ✓ | `3` |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `created_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `tasks_instructions_check`: `CHECK (((instructions IS NULL) OR (char_length(instructions) <= 10000)))`
- `tasks_max_attempts_check`: `CHECK (((max_attempts >= 1) AND (max_attempts <= 10)))`
- `tasks_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))`
- `tasks_title_check`: `CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 300)))`
- `tasks_course_id_fkey`: `FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT`
- `tasks_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `tasks_rubric_version_id_fkey`: `FOREIGN KEY (rubric_version_id) REFERENCES instrument_versions(id) ON DELETE RESTRICT`
- `tasks_unit_id_fkey`: `FOREIGN KEY (unit_id) REFERENCES course_units(id) ON DELETE SET NULL`
- `tasks_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE INDEX tasks_course_idx ON public.tasks USING btree (course_id)`

## task_allocations

เปิดภาระงานให้รุ่น: วันเปิด/กำหนดส่ง (ส่งช้าได้ แต่ติดป้าย)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `task_id` | uuid | ✓ |  |  |
| `cohort_id` | uuid | ✓ |  |  |
| `available_at` | timestamp with time zone |  |  |  |
| `due_at` | timestamp with time zone |  |  |  |
| `created_by` | uuid |  | `auth.uid()` |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `task_allocations_window`: `CHECK (((due_at IS NULL) OR (available_at IS NULL) OR (due_at > available_at)))`
- `task_allocations_cohort_id_fkey`: `FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT`
- `task_allocations_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL`
- `task_allocations_task_id_fkey`: `FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT`
- `task_allocations_pkey`: `PRIMARY KEY (id)`
- `task_allocations_once`: `UNIQUE (task_id, cohort_id)`

**Indexes**

- `CREATE INDEX task_allocations_cohort_idx ON public.task_allocations USING btree (cohort_id)`

## task_submissions

การส่งงานรายรอบ: ผู้ส่งแก้ได้เฉพาะร่าง · ส่งแล้วแก้ไม่ได้ · submitted_at/is_late จาก server

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `allocation_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ |  |  |
| `attempt_no` | integer | ✓ |  |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `text_response` | text |  |  |  |
| `links` | jsonb | ✓ | `'[]'::jsonb` |  |
| `submitted_at` | timestamp with time zone |  |  |  |
| `is_late` | boolean |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `task_submissions_attempt_no_check`: `CHECK (((attempt_no >= 1) AND (attempt_no <= 10)))`
- `task_submissions_evidence`: `CHECK (((status = 'submitted'::text) = ((submitted_at IS NOT NULL) AND (is_late IS NOT NULL))))`
- `task_submissions_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text])))`
- `task_submissions_text_response_check`: `CHECK (((text_response IS NULL) OR (char_length(text_response) <= 20000)))`
- `task_submissions_allocation_id_fkey`: `FOREIGN KEY (allocation_id) REFERENCES task_allocations(id) ON DELETE RESTRICT`
- `task_submissions_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT`
- `task_submissions_pkey`: `PRIMARY KEY (id)`
- `task_submissions_attempt`: `UNIQUE (allocation_id, user_id, attempt_no)`

**Indexes**

- `CREATE UNIQUE INDEX task_submissions_one_draft ON public.task_submissions USING btree (allocation_id, user_id) WHERE (status = 'draft'::text)`
- `CREATE INDEX task_submissions_user_idx ON public.task_submissions USING btree (user_id)`

## task_submission_files

ไฟล์ของการส่งงาน (bucket task-files ส่วนตัว) · ขนาด/ชนิดอ่านจาก storage ฝั่ง server

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `submission_id` | uuid | ✓ |  |  |
| `object_path` | text | ✓ |  |  |
| `file_name` | text | ✓ |  |  |
| `size_bytes` | bigint |  |  |  |
| `mime_type` | text |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `task_submission_files_file_name_check`: `CHECK (((char_length(file_name) >= 1) AND (char_length(file_name) <= 255)))`
- `task_submission_files_submission_id_fkey`: `FOREIGN KEY (submission_id) REFERENCES task_submissions(id) ON DELETE RESTRICT`
- `task_submission_files_pkey`: `PRIMARY KEY (id)`
- `task_submission_files_object_path_key`: `UNIQUE (object_path)`

**Indexes**

- `CREATE INDEX task_submission_files_submission_idx ON public.task_submission_files USING btree (submission_id)`

## task_reviews

ผลการตรวจงานรายรอบ: ร่าง (เฉพาะผู้ตรวจ) → ส่งผล (ผู้เรียนเห็น, แก้ไม่ได้) · คะแนนรวมจาก server · ตรวจใหม่ = แถวใหม่ + เหตุผล + supersedes_id

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `submission_id` | uuid | ✓ |  |  |
| `reviewer_id` | uuid | ✓ |  |  |
| `rubric_version_id` | uuid |  |  |  |
| `status` | text | ✓ | `'draft'::text` |  |
| `outcome` | text |  |  |  |
| `feedback` | text |  |  |  |
| `score` | numeric(9,2) |  |  |  |
| `max_score` | numeric(9,2) |  |  |  |
| `supersedes_id` | uuid |  |  |  |
| `regrade_reason` | text |  |  |  |
| `released_at` | timestamp with time zone |  |  |  |
| `created_at` | timestamp with time zone | ✓ | `now()` |  |
| `updated_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `task_reviews_feedback_check`: `CHECK (((feedback IS NULL) OR (char_length(feedback) <= 10000)))`
- `task_reviews_outcome_check`: `CHECK ((outcome = ANY (ARRAY['passed'::text, 'revise'::text])))`
- `task_reviews_regrade_reason_check`: `CHECK (((regrade_reason IS NULL) OR (char_length(regrade_reason) <= 1000)))`
- `task_reviews_released`: `CHECK (((status = 'released'::text) = ((released_at IS NOT NULL) AND (outcome IS NOT NULL))))`
- `task_reviews_status_check`: `CHECK ((status = ANY (ARRAY['draft'::text, 'released'::text])))`
- `task_reviews_reviewer_id_fkey`: `FOREIGN KEY (reviewer_id) REFERENCES profiles(id) ON DELETE RESTRICT`
- `task_reviews_rubric_version_id_fkey`: `FOREIGN KEY (rubric_version_id) REFERENCES instrument_versions(id) ON DELETE RESTRICT`
- `task_reviews_submission_id_fkey`: `FOREIGN KEY (submission_id) REFERENCES task_submissions(id) ON DELETE RESTRICT`
- `task_reviews_supersedes_id_fkey`: `FOREIGN KEY (supersedes_id) REFERENCES task_reviews(id) ON DELETE RESTRICT`
- `task_reviews_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE UNIQUE INDEX task_reviews_one_draft ON public.task_reviews USING btree (submission_id, reviewer_id) WHERE (status = 'draft'::text)`
- `CREATE INDEX task_reviews_submission_idx ON public.task_reviews USING btree (submission_id, released_at DESC)`

## task_review_scores

ระดับที่เลือกรายเกณฑ์ของ Rubric + ความเห็น · score = คะแนนของระดับ (server)

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `review_id` | uuid | ✓ |  |  |
| `criterion_id` | uuid | ✓ |  |  |
| `level_id` | text | ✓ |  |  |
| `score` | numeric(9,2) | ✓ |  |  |
| `comment` | text |  |  |  |

**Constraints**

- `task_review_scores_comment_check`: `CHECK (((comment IS NULL) OR (char_length(comment) <= 2000)))`
- `task_review_scores_criterion_id_fkey`: `FOREIGN KEY (criterion_id) REFERENCES instrument_items(id) ON DELETE RESTRICT`
- `task_review_scores_review_id_fkey`: `FOREIGN KEY (review_id) REFERENCES task_reviews(id) ON DELETE CASCADE`
- `task_review_scores_pkey`: `PRIMARY KEY (id)`
- `task_review_scores_once`: `UNIQUE (review_id, criterion_id)`

## task_review_reads

ผู้เรียนเปิดดูผลตรวจที่ส่งแล้วหรือยัง (ป้ายแจ้งเตือนในเมนู) · เจ้าของงานเท่านั้นที่เพิ่มแถวของตนได้

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `review_id` | uuid | ✓ |  |  |
| `user_id` | uuid | ✓ | `auth.uid()` |  |
| `read_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `task_review_reads_review_id_fkey`: `FOREIGN KEY (review_id) REFERENCES task_reviews(id) ON DELETE CASCADE`
- `task_review_reads_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE`
- `task_review_reads_pkey`: `PRIMARY KEY (review_id, user_id)`

## task_drive_exports

การส่งสำเนาไฟล์งานไป Google Drive ส่วนกลาง (ต่อภาระงานต่อรุ่น): ใคร เมื่อไร ผลเป็นอย่างไร · เขียนผ่าน begin/finish เท่านั้น

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `id` | uuid | ✓ | `gen_random_uuid()` |  |
| `allocation_id` | uuid | ✓ |  |  |
| `requested_by` | uuid | ✓ |  |  |
| `started_at` | timestamp with time zone | ✓ | `now()` |  |
| `finished_at` | timestamp with time zone |  |  |  |
| `status` | text | ✓ | `'running'::text` |  |
| `files_copied` | integer | ✓ | `0` |  |
| `files_skipped` | integer | ✓ | `0` |  |
| `files_failed` | integer | ✓ | `0` |  |
| `drive_folder_id` | text |  |  |  |
| `error` | text |  |  |  |

**Constraints**

- `task_drive_exports_drive_folder_id_check`: `CHECK (((drive_folder_id IS NULL) OR (drive_folder_id ~ '^[A-Za-z0-9_-]{1,200}$'::text)))`
- `task_drive_exports_error_check`: `CHECK (((error IS NULL) OR (char_length(error) <= 500)))`
- `task_drive_exports_files_copied_check`: `CHECK ((files_copied >= 0))`
- `task_drive_exports_files_failed_check`: `CHECK ((files_failed >= 0))`
- `task_drive_exports_files_skipped_check`: `CHECK ((files_skipped >= 0))`
- `task_drive_exports_finished`: `CHECK (((status = 'running'::text) = (finished_at IS NULL)))`
- `task_drive_exports_status_check`: `CHECK ((status = ANY (ARRAY['running'::text, 'done'::text, 'partial'::text, 'failed'::text])))`
- `task_drive_exports_allocation_id_fkey`: `FOREIGN KEY (allocation_id) REFERENCES task_allocations(id) ON DELETE RESTRICT`
- `task_drive_exports_requested_by_fkey`: `FOREIGN KEY (requested_by) REFERENCES profiles(id) ON DELETE RESTRICT`
- `task_drive_exports_pkey`: `PRIMARY KEY (id)`

**Indexes**

- `CREATE INDEX task_drive_exports_allocation_idx ON public.task_drive_exports USING btree (allocation_id, started_at DESC)`

## task_drive_copies

ไฟล์งานที่อยู่ใน Google Drive แล้ว: ไฟล์ไหน = ไฟล์ Drive ใด ส่งในครั้งไหน

| คอลัมน์ | ชนิด | NOT NULL | ค่าเริ่มต้น | หมายเหตุ |
|---|---|:-:|---|---|
| `file_id` | uuid | ✓ |  |  |
| `run_id` | uuid | ✓ |  |  |
| `drive_file_id` | text | ✓ |  |  |
| `copied_at` | timestamp with time zone | ✓ | `now()` |  |

**Constraints**

- `task_drive_copies_drive_file_id_check`: `CHECK ((drive_file_id ~ '^[A-Za-z0-9_-]{1,200}$'::text))`
- `task_drive_copies_file_id_fkey`: `FOREIGN KEY (file_id) REFERENCES task_submission_files(id) ON DELETE RESTRICT`
- `task_drive_copies_run_id_fkey`: `FOREIGN KEY (run_id) REFERENCES task_drive_exports(id) ON DELETE RESTRICT`
- `task_drive_copies_pkey`: `PRIMARY KEY (file_id)`

**Indexes**

- `CREATE INDEX task_drive_copies_run_idx ON public.task_drive_copies USING btree (run_id)`

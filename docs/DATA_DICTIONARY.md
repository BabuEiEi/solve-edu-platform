# Data Dictionary — SolveEdu Platform (Phase 1)

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

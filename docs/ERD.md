# ERD — Physical (Phase 1, ตาม Migration ที่สร้างจริง)

> ตารางของ Phase 2–4 (assessments, assignments, supervision) อยู่ใน `BLUEPRINT.md` §6 — จะเพิ่มเมื่อเขียน Migration จริง
> รายละเอียดคอลัมน์/constraint/index: `DATA_DICTIONARY.md` (สร้างอัตโนมัติจากฐานข้อมูล)

```mermaid
erDiagram
    AUTH_USERS ||--|| PROFILES : "id (trigger creates)"
    ORGANIZATIONS ||--o{ ORGANIZATIONS : "parent_id (no cycles)"
    ORGANIZATIONS ||--o{ PROFILES : "requested_org_id"
    PROFILES ||--o{ ORGANIZATION_MEMBERSHIPS : user_id
    ORGANIZATIONS ||--o{ ORGANIZATION_MEMBERSHIPS : organization_id
    PROFILES ||--o{ PLATFORM_ROLE_ASSIGNMENTS : user_id
    ORGANIZATIONS ||--o{ PROGRAMS : owner_org_id
    PROGRAMS ||--o{ COHORTS : program_id
    COHORTS ||--o{ COHORT_MEMBERSHIPS : cohort_id
    PROFILES ||--o{ COHORT_MEMBERSHIPS : user_id
    COHORTS ||--o{ MENTOR_ASSIGNMENTS : cohort_id
    PROFILES ||--o{ MENTOR_ASSIGNMENTS : "mentor_id / trainee_id"
    ORGANIZATIONS ||--o{ COURSES : owner_org_id
    PROGRAMS ||--o{ PROGRAM_COURSES : program_id
    COURSES ||--o{ PROGRAM_COURSES : course_id
    COURSES ||--o{ COURSE_UNITS : course_id
    COURSE_UNITS ||--o{ LESSONS : unit_id
    LESSONS ||--o{ LESSON_BLOCKS : lesson_id
    COHORTS ||--o{ COURSE_ENROLLMENTS : cohort_id
    COURSES ||--o{ COURSE_ENROLLMENTS : course_id
    PROFILES ||--o{ COURSE_ENROLLMENTS : user_id
    COURSE_ENROLLMENTS ||--o{ LESSON_PROGRESS : enrollment_id
    LESSONS ||--o{ LESSON_PROGRESS : lesson_id

    PROFILES {
        uuid id PK "= auth.users.id"
        text full_name
        text display_name
        text avatar_path "storage path"
        text contact_email "no client SELECT"
        uuid requested_org_id FK
        text status "pending|active|suspended"
    }
    ORGANIZATIONS {
        uuid id PK
        text code "UNIQUE(org_type, code)"
        text org_type "district|school|other"
        uuid parent_id FK
        bool active
    }
    ORGANIZATION_MEMBERSHIPS {
        uuid id PK
        uuid user_id FK
        uuid organization_id FK
        text org_role "district_admin|supervisor|school_admin|teacher"
        timestamptz ended_at "NULL = active; one-way"
        uuid granted_by "default auth.uid()"
    }
    PLATFORM_ROLE_ASSIGNMENTS {
        uuid id PK
        uuid user_id FK
        text role "platform_admin|platform_support"
        timestamptz revoked_at
    }
    PROGRAMS {
        uuid id PK
        text code "UNIQUE(owner_org_id, code)"
        int fiscal_year "พ.ศ."
        uuid owner_org_id FK
        text status
    }
    COHORTS {
        uuid id PK
        uuid program_id FK
        text code "UNIQUE(program_id, code)"
        text status
    }
    COHORT_MEMBERSHIPS {
        uuid id PK
        uuid cohort_id FK
        uuid user_id FK
        text cohort_role "trainee|trainer|mentor|coordinator"
        text status "invited|active|withdrawn"
    }
    MENTOR_ASSIGNMENTS {
        uuid id PK
        uuid cohort_id FK
        uuid mentor_id FK
        uuid trainee_id FK
        timestamptz ended_at
    }
    COURSES {
        uuid id PK
        text code "UNIQUE(owner_org_id, code)"
        text status "draft|published|archived"
        uuid owner_org_id FK
    }
    PROGRAM_COURSES {
        uuid program_id PK
        uuid course_id PK
        int display_order
    }
    COURSE_UNITS {
        uuid id PK
        uuid course_id FK
        int display_order "UNIQUE per course, deferrable"
        text status
    }
    LESSONS {
        uuid id PK
        uuid unit_id FK
        int display_order
        bool required
        text status
    }
    LESSON_BLOCKS {
        uuid id PK
        uuid lesson_id FK
        text block_type
        jsonb content_json "CHECK shape per type"
    }
    COURSE_ENROLLMENTS {
        uuid id PK
        uuid cohort_id FK
        uuid course_id FK
        uuid user_id FK
        text status "UNIQUE(cohort, course, user)"
    }
    LESSON_PROGRESS {
        uuid id PK
        uuid enrollment_id FK
        uuid lesson_id FK
        text status
        numeric progress_percent
        timestamptz started_at "server"
        timestamptz completed_at "server"
    }
```

## นโยบาย ON DELETE

| ความสัมพันธ์ | นโยบาย | เหตุผล |
|---|---|---|
| `auth.users → profiles` | CASCADE | ลบบัญชี Auth = ลบโปรไฟล์ (ต้องมี retention policy ก่อนใช้จริง) |
| `organizations`, `programs`, `cohorts`, `courses` เมื่อถูกอ้างอิง | RESTRICT | ป้องกันหลักฐานการอบรม/ประวัติหาย — ใช้ `status = archived` แทน |
| `courses → course_units → lessons → lesson_blocks` | CASCADE | เนื้อหาเป็นของหลักสูตร |
| `lessons`/`course_enrollments` ที่มี `lesson_progress` | RESTRICT | การลบบทเรียนที่มีผู้เรียนแล้วจะล้มเหลว → บังคับ archive |
| `granted_by`, `created_by`, `enrolled_by` | SET NULL | เก็บแถวไว้แม้ผู้ดำเนินการถูกลบ |

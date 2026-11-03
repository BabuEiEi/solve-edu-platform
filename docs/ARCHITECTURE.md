# Architecture — SolveEdu Platform

> สถานะ: **Phase 0–1 เสร็จ + Phase 2A เสร็จ** (Course Builder, หน้าเรียน, Private Storage, นำเข้ารายชื่อล่วงหน้า) · ยังไม่ Deploy · ยังไม่เชื่อม Supabase Remote · Assessment/Scoring อยู่ Phase 2B

## 1. ภาพรวม

```
Browser (Vite + Vanilla JS ES Modules + Tailwind 4)
  │  publishable key + user JWT
  ▼
Supabase Data API (PostgREST)  ── exposed schemas: public, graphql_public
  │  every request runs as role `authenticated` / `anon`
  ▼
PostgreSQL
  ├─ public   tables + RLS + column GRANTs + 2 trusted RPCs
  ├─ authz    RLS helper functions (definer, boolean, not exposed)
  ├─ private  audit_logs (and Phase 2 answer keys) — no client grants
  └─ auth     Supabase Auth (users, identities)
```

ADR ทั้งหมดใน `BLUEPRINT.md` §3 ยังคงใช้ ส่วนที่ตัดสินใจเพิ่มระหว่าง implement อยู่ใน `MIGRATION_FROM_LEGACY.md` §4

## 2. Frontend (Modular Monolith)

| เลเยอร์ | ที่ตั้ง | หน้าที่ |
|---|---|---|
| Core | `src/core/` | `supabaseClient` (publishable key เท่านั้น), `auth`, `router` (hash), `permissions` (UI flags), `errors` (`unwrap` บังคับตรวจ error) |
| Features | `src/features/<domain>/service.js` + `views.js` | service รับ `client` เป็น dependency (ทดสอบด้วย fake/PostgREST ได้), view render ด้วย `html```` |
| Shared | `src/shared/ui/html.js` | template ที่ escape อัตโนมัติ; ESLint ห้าม `innerHTML =` นอกไฟล์นี้ |
| Shared | `src/shared/utils/date.js` | แสดงเวลา Asia/Bangkok + พ.ศ. |

แนวทาง: query เลือกคอลัมน์ชัดเจนเสมอ (ห้าม `select('*')` กับ `profiles` — จะได้ 42501) · event delegation ด้วย `data-action` (ไม่มี inline handler) · CSP ใน `index.html`

## 3. Database

ลำดับ Migration (แยกตาม dependency):

| ไฟล์ | เนื้อหา |
|---|---|
| `20261102090000_foundation.sql` | schemas `authz`/`private`, ปิด default grants, `set_updated_at`, `audit_logs`, `audit_row()` |
| `20261102090100_identity_organizations.sql` | profiles, organizations (กันวงวน), memberships, platform roles, profile trigger, one-way end |
| `20261102090200_programs_cohorts.sql` | programs, cohorts, cohort_memberships, mentor_assignments (+invariant trigger) |
| `20261102090300_courses_lessons.sql` | courses → units → lessons → blocks (validated JSON), enrollments, progress (server timestamps) |
| `20261102090400_authz_helpers.sql` | ฟังก์ชันตรวจสิทธิ์ 23 ตัว |
| `20261102090500_rls_policies_and_rpcs.sql` | REVOKE ALL → GRANT รายคอลัมน์ → RLS policies → RPC 2 ตัว |
| `20261102090600_comments.sql` | คำอธิบายตาราง/คอลัมน์ (สร้าง data dictionary) |
| `20261103090000_storage_buckets_policies.sql` | bucket `lesson-media`/`avatars` (private) + policy บน `storage.objects` ผ่าน helper `authz` |
| `20261103090100_course_builder.sql` | `course_access`, `reorder_course_items`, ตรวจ rich text/path ใน DB |
| `20261103090110_row_based_select_policies.sql` | แก้บั๊ก `INSERT … RETURNING` (SELECT policy ตัดสินจากคอลัมน์ของแถว) |
| `20261103090200_preregistrations.sql` | `preregistrations` + `claim_my_preregistrations()` |

### เหตุผลการออกแบบสำคัญ

1. **Membership-based RBAC** — ไม่มี `role` ใน profiles; คนเดียวเป็นครูที่โรงเรียน A + trainer ในรุ่นหนึ่ง + mentor ในอีกรุ่นได้
2. **Scope ตามลำดับชั้นหน่วยงาน** — `has_org_role` เดินขึ้นหา ancestor (ลึกสุด 50) ทำให้ district_admin ครอบคลุมทุกโรงเรียนในเขตโดยไม่ต้อง grant ซ้ำ
3. **Helper แบบ SECURITY DEFINER ใน schema ที่ไม่ expose** — ป้องกัน RLS recursion และตอบเฉพาะคำถามเกี่ยวกับผู้เรียก
4. **Invariant ใน trigger** (mentor ต้องเป็น mentor ของรุ่น, enrollment ต้องเป็น trainee + หลักสูตรอยู่ในโครงการ, progress ต้องเป็นบทเรียน published) — ถูกต้องไม่ว่าใครเขียน (client, service role, migration)
5. **เวลาที่มีความหมายเชิงหลักฐาน** (`started_at`, `completed_at`, `granted_by`) ประทับโดยฐานข้อมูล ไม่รับจาก client
6. **Secure-by-default grants** — ตารางใหม่ใน Phase ถัดไปจะเข้าถึงไม่ได้จนกว่าจะเขียน GRANT + policy + test

## 4. ข้อจำกัดที่ทราบ / ควรทบทวน

| ประเด็น | ผลกระทบ | แนวทาง |
|---|---|---|
| Helper เรียก `is_active_user()` ซ้ำหลายครั้งต่อแถว | ช้าเมื่อข้อมูลหลักหมื่นแถว | วัดด้วย `EXPLAIN ANALYZE` ใน Phase 5; พิจารณา cache ใน JWT custom claim หรือ materialized scope |
| Trainer แก้หลักสูตรที่ใช้ร่วมหลายโครงการได้ | การแก้กระทบรุ่นอื่น | Phase 2: content versioning เมื่อ publish หรือ `course_editors` แยก |
| `auth.users` ON DELETE CASCADE → profiles | ลบบัญชีแล้วโปรไฟล์หาย (แต่ RESTRICT จาก enrollment จะกันไว้) | กำหนด retention / soft-delete ก่อนใช้ข้อมูลจริง |
| Storage ของ submissions/portfolio | ยังไม่มี bucket | Phase 3 |
| UI อัปโหลด avatar | bucket + policy พร้อมแล้ว แต่ยังไม่มีหน้าจอ | Phase 2B/3 |
| ไฟล์ที่ลบ/แทนที่ใน Builder | ลบไฟล์แบบ best-effort — อาจมีไฟล์กำพร้าถ้าเครือข่ายล้ม | งานล้างไฟล์กำพร้า (Phase 5) |
| เว็บไซต์ยังไม่ส่งอีเมลเชิญ | ผู้ถูกนำเข้าต้องสมัครเอง (ยืนยันอีเมลแล้วผูกอัตโนมัติ) | ต้องมี SMTP จริงก่อน pilot |
| `supabase start` ต้อง restart เมื่อแก้ `config.toml` (เช่น email confirmations) | `db reset` ไม่โหลด config Auth ใหม่ | `npx supabase stop && npx supabase start` |
| Editor | Tiptap 3 (MIT) โหลดแบบ lazy; ผลลัพธ์ผ่าน DOMPurify เสมอ + DB CHECK | — |
| ไม่ได้รัน `supabase start` (Docker image ถูกบล็อกใน workspace) | ยังไม่ยืนยันกับ GoTrue/Storage จริง | รันบนเครื่องผู้พัฒนาตาม README |

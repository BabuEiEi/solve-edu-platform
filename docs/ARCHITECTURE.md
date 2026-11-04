# Architecture — SolveEdu Platform

> สถานะ: **Phase 0–1 + 2A + 2B + 2B.1 + 2C เสร็จ** (Course Builder, หน้าเรียน, Private Storage, นำเข้ารายชื่อล่วงหน้า, แบบทดสอบ + ให้คะแนนฝั่ง server + ผลของรุ่น, จำกัดเวลา/บันทึกอัตโนมัติ/วิเคราะห์ข้อสอบ, ข้อสอบแบบใหม่ 7 แบบ) · ยังไม่ Deploy · ยังไม่เชื่อม Supabase Remote

## 1. ภาพรวม

```
Browser (Vite + Vanilla JS ES Modules + Tailwind 4)
  │  publishable key + user JWT
  ▼
Supabase Data API (PostgREST)  ── exposed schemas: public, graphql_public
  │  every request runs as role `authenticated` / `anon`
  ▼
PostgreSQL
  ├─ public   tables + RLS + column GRANTs + trusted RPCs (เช่น start/submit_attempt)
  ├─ authz    RLS helper functions (definer, boolean, not exposed)
  ├─ private  audit_logs, instrument_answer_keys, scoring helpers — no client grants
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
| Shared | `src/shared/utils/csv.js`, `src/shared/ui/download.js` | อ่าน/เขียน CSV (BOM สำหรับ Excel, กัน CSV injection) · ดาวน์โหลดผ่าน blob URL |
| Features (2B) | `quizzes/` (สร้างข้อสอบ), `assessments/` (ผู้เรียนทำแบบทดสอบ), `assignments/` (มอบหมายให้รุ่น + ผลของรุ่น) | `logic.js` เป็นฟังก์ชันล้วน (unit test); คะแนนไม่เคยคำนวณใน browser |
| Features (2C) | `quizzes/listEditors.js`, `quizzes/blankEditors.js` ฟอร์มสร้างข้อแบบใหม่ · `assessments/items.js` แสดงข้อทุกแบบ | แตะ/ปุ่ม/เมนูเลือกเท่านั้น (ไม่มีลากวาง) · ชื่อช่อง `q:<item>` และ `q:<item>:<slot\|blank>` · ลำดับตาม `presentation` ของ server |
| UI ร่วม (2C.1) | `shared/ui/components.js` `filePicker` + `bindFilePickers` (ผูกใน `main.js`) | ปุ่มเลือกไฟล์ภาษาไทยแทนข้อความของเบราว์เซอร์ · input จริงซ่อนแบบ sr-only ในป้าย (โฟกัส/แป้นพิมพ์ใช้ได้) · ชื่อไฟล์แสดงด้วย textContent · กล่อง `overflow-x-auto` ต้องมี `relative` เพื่อไม่ให้ sr-only ข้างในดันหน้าให้กว้างเกินจอ |

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
| `20261103090300_assessment_schema.sql` | instruments → versions → items, `private.instrument_answer_keys`, assignments, attempts, responses + guard triggers + authz helpers + RLS |
| `20261103090310_assessment_authoring.sql` | `set_item_key`, `item_key_status`, `publish_instrument_version`, `clone_instrument_version`, `content_hash` |
| `20261103090320_assessment_attempts.sql` | `start_attempt` / `submit_attempt` (advisory lock, ให้คะแนนฝั่ง server) |
| `20261103090330_assessment_media.sql` | bucket `assessment-media` + policy |
| `20261103090340_assessment_assignment_guard.sql` | หลังมีผู้เริ่มทำ ห้ามแก้เกณฑ์ผ่าน/ประเภท/หลักสูตร หรือย้อนเป็นร่าง (SE004) |
| `20261104090000_attempt_timing.sql` | (2B.1) เวลาทำต่อครั้ง, ช่วงผ่อนผัน, `save_attempt_draft`, ส่งอัตโนมัติเมื่อหมดเวลา (lazy + `pg_cron`), `assessment_extra_attempts` |
| `20261104090100_close_required_drafts_private.sql` | (2B.1) เผยแพร่ต้องมีเวลาปิดรับ · ถอนสิทธิ์อ่าน `draft_json` จาก client |
| `20261104090200_draft_sequence.sql` | (2B.1) ลำดับการบันทึก (`draft_seq`, `stale`, SE005) · audit attempts เฉพาะคอลัมน์หลักฐาน |
| `20261104090300_results_and_item_statistics.sql` | (2B.1) `assignment_results` (invoker) · `item_statistics` (p, D, r, ตัวเลือก, KR-20/α) |
| `20261104090400_assessment_media_cleanup.sql` | (2B.1) ลบ/เขียนทับรูปข้อสอบได้เฉพาะที่ไม่มีข้อใดใช้ |
| `20261104090500_item_types_group_a.sql` | (2C) เรียงลำดับ จับคู่ จัดกลุ่ม ตารางตัวเลือก · สลับลำดับฝั่ง server (`presentation_json`) |
| `20261104090600_item_types_group_b.sql` | (2C) ดรอปดาวน์ เติมคำ (เทียบข้อความไทย) ติดป้ายบนรูป |
| `20261104090700_key_position_guard.sql` | (2C) เฉลยไม่ถูกต้องถ้าลำดับที่เก็บบอกเฉลย (เรียงลำดับ: เก็บในลำดับที่ถูก · จับคู่: ทุกคู่อยู่ตำแหน่งเดียวกัน) |
| `20261104090800_item_statistics_slots.sql` | (2C) `private.slot_hits` ถูก/ผิดรายส่วน (ใช้ทั้งให้คะแนนและวิเคราะห์) · `private.slot_labels` · `item_statistics` เพิ่ม `slots` (สัดส่วนถูกรายส่วน ไม่บอกเฉลย) |
| `20261105090000_thai_mark_order.sql` | (2C.1) `private.thai_mark_order`: เทียบคำตอบไทยได้ทุกลำดับการพิมพ์สระ/วรรณยุกต์ (ไม่ตรวจคำสะกดใกล้เคียง) |
| `20261105090100_scoring_mode_on_item.sql` | (2C.1) วิธีให้คะแนนย้ายจากเฉลยไป `instrument_items.scoring_mode` (อ่านกลับได้, เฉลยยังอ่านไม่ได้) · ย้ายค่าข้อเดิม · `scoring_json` = `{}` เสมอ · `finalize_attempt` และ `clone_instrument_version` อ่าน/คัดลอกโหมดจากข้อ |

### เหตุผลการออกแบบสำคัญ

1. **Membership-based RBAC** — ไม่มี `role` ใน profiles; คนเดียวเป็นครูที่โรงเรียน A + trainer ในรุ่นหนึ่ง + mentor ในอีกรุ่นได้
2. **Scope ตามลำดับชั้นหน่วยงาน** — `has_org_role` เดินขึ้นหา ancestor (ลึกสุด 50) ทำให้ district_admin ครอบคลุมทุกโรงเรียนในเขตโดยไม่ต้อง grant ซ้ำ
3. **Helper แบบ SECURITY DEFINER ใน schema ที่ไม่ expose** — ป้องกัน RLS recursion และตอบเฉพาะคำถามเกี่ยวกับผู้เรียก
4. **Invariant ใน trigger** (mentor ต้องเป็น mentor ของรุ่น, enrollment ต้องเป็น trainee + หลักสูตรอยู่ในโครงการ, progress ต้องเป็นบทเรียน published) — ถูกต้องไม่ว่าใครเขียน (client, service role, migration)
5. **เวลาที่มีความหมายเชิงหลักฐาน** (`started_at`, `completed_at`, `granted_by`) ประทับโดยฐานข้อมูล ไม่รับจาก client
6. **Secure-by-default grants** — ตารางใหม่ใน Phase ถัดไปจะเข้าถึงไม่ได้จนกว่าจะเขียน GRANT + policy + test
7. **เฉลยเขียนได้แต่อ่านไม่ได้** (2B) — เฉลยอยู่ใน `private` ซึ่ง client ไม่มีสิทธิ์; ผู้สร้างเห็นเพียง `has_key/key_valid`; รหัสตัวเลือกไม่ถูกเรียงใหม่เมื่อลบตัวเลือก (เฉลยอ้างรหัส)
8. **ฉบับที่เผยแพร่แล้วแก้ไม่ได้** (2B) — คะแนนที่บันทึกแล้วยังหมายถึงข้อสอบชุดเดิมเสมอ; แก้ = clone เป็นฉบับใหม่
9. **การตั้งค่าที่ให้ความหมายกับผล** (เกณฑ์ผ่าน, ประเภท) ถูกตรึงเมื่อมีผู้เริ่มทำ (2B) — ส่วนช่วงเวลา/จำนวนครั้งยังขยายได้

## 4. ข้อจำกัดที่ทราบ / ควรทบทวน

| ประเด็น | ผลกระทบ | แนวทาง |
|---|---|---|
| Helper เรียก `is_active_user()` ซ้ำหลายครั้งต่อแถว | ช้าเมื่อข้อมูลหลักหมื่นแถว | วัดด้วย `EXPLAIN ANALYZE` ใน Phase 5; พิจารณา cache ใน JWT custom claim หรือ materialized scope |
| Trainer แก้หลักสูตรที่ใช้ร่วมหลายโครงการได้ | การแก้กระทบรุ่นอื่น | Phase 2: content versioning เมื่อ publish หรือ `course_editors` แยก |
| `auth.users` ON DELETE CASCADE → profiles | ลบบัญชีแล้วโปรไฟล์หาย (แต่ RESTRICT จาก enrollment จะกันไว้) | กำหนด retention / soft-delete ก่อนใช้ข้อมูลจริง |
| Storage ของ submissions/portfolio | ยังไม่มี bucket | Phase 3 |
| UI อัปโหลด avatar | bucket + policy พร้อมแล้ว แต่ยังไม่มีหน้าจอ | Phase 3 |
| ครั้งที่เริ่มแล้วไม่ส่ง | 2B.1: ปิดอัตโนมัติจากคำตอบที่บันทึกไว้ เมื่อเลยเส้นตาย+ผ่อนผัน · การมอบหมายที่เผยแพร่ต้องมีเวลาปิดรับ (CHECK) จึงมีเส้นตายเสมอ | — |
| ข้อมูลตัวอย่างที่มีรูป (2C) | รูปของข้อติดป้ายอยู่ที่ `supabase/seed-media/` อัปโหลดโดย `db reset --local` ผ่าน `[storage.buckets.assessment-media]` ใน `config.toml` (ค่าเดียวกับ migration: private, 5 MiB, รูปเท่านั้น) | ใช้กับเครื่อง local เท่านั้น — ไม่มีการ push config ไป remote |
| `pg_cron` (2B.1) | ต้องมีบน Supabase จริง (มีให้ใช้แล้ว) · ถ้าไม่มี ระบบยังปิดเมื่อผู้เรียนกลับมาเปิด/บันทึก/ส่ง | ตรวจ `cron.job` หลัง deploy |
| รูปข้อสอบที่ไม่ได้ใช้ | 2B.1: ผู้สร้างกด "ล้างรูปที่ไม่ได้ใช้" ได้ (ไฟล์ที่ไม่มีข้อใดใช้และเก่ากว่า 24 ชม.; DB กันไฟล์ที่ใช้อยู่) · ยังไม่มีงานล้างอัตโนมัติทั้งระบบ | Edge Function ตามเวลา (Phase 5) ถ้าจำเป็น |
| ผลของรุ่น (2B.1) | สรุปบน server แล้ว (`assignment_results` หนึ่งแถวต่อคน) — ยังไม่แบ่งหน้า; รุ่นหลักพันคนอาจต้องแบ่งหน้า | วัดเมื่อมีข้อมูลจริง |
| ไฟล์ที่ลบ/แทนที่ใน Builder | ลบไฟล์แบบ best-effort — อาจมีไฟล์กำพร้าถ้าเครือข่ายล้ม | งานล้างไฟล์กำพร้า (Phase 5) |
| เว็บไซต์ยังไม่ส่งอีเมลเชิญ | ผู้ถูกนำเข้าต้องสมัครเอง (ยืนยันอีเมลแล้วผูกอัตโนมัติ) | ต้องมี SMTP จริงก่อน pilot |
| `supabase start` ต้อง restart เมื่อแก้ `config.toml` (เช่น email confirmations) | `db reset` ไม่โหลด config Auth ใหม่ | `npx supabase stop && npx supabase start` |
| Editor | Tiptap 3 (MIT) โหลดแบบ lazy; ผลลัพธ์ผ่าน DOMPurify เสมอ + DB CHECK | — |
| ไม่ได้รัน `supabase start` (Docker image ถูกบล็อกใน workspace) | ยังไม่ยืนยันกับ GoTrue/Storage จริง | รันบนเครื่องผู้พัฒนาตาม README |

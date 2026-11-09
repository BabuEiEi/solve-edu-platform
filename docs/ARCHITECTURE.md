# Architecture — SolveEdu Platform

> สถานะ: **Phase 0–1 + 2A + 2B + 2B.1 + 2C + 2C.1 + 2D + 3 เสร็จ** (Course Builder, หน้าเรียน, Private Storage, นำเข้ารายชื่อล่วงหน้า, แบบทดสอบ + ให้คะแนนฝั่ง server + ผลของรุ่น, จำกัดเวลา/บันทึกอัตโนมัติ/วิเคราะห์ข้อสอบ, ข้อสอบแบบใหม่ 7 แบบ, ปิดความเสี่ยงหลัง 2C, นำเข้าข้อสอบจากไฟล์ CSV, ภาระงาน + Rubric) · ยังไม่ Deploy · ยังไม่เชื่อม Supabase Remote

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
| Shared | `src/shared/utils/csv.js`, `src/shared/ui/download.js` | อ่าน/เขียน CSV (BOM สำหรับ Excel, กัน CSV injection, ถอดรหัส UTF-8 / Windows-874) · ดาวน์โหลดผ่าน blob URL (`downloadTable` = Excel หรือ CSV จากแถวชุดเดียวกัน, `exportButtons` ปุ่มคู่) |
| Shared (4b) | `src/shared/utils/xlsx.js`, `src/shared/utils/tableFile.js` | เขียน/อ่านไฟล์ Excel (.xlsx) ด้วย `fflate` (zip) + XML ที่เขียนเอง · เขียน: ข้อความเป็นข้อความเสมอ (ไม่เป็นสูตร) ตัวเลขเป็นตัวเลข หัวตารางตัวหนา+ตรึง · อ่าน (ไฟล์ที่ผู้ใช้อัปโหลด = ไม่น่าไว้ใจ): จำกัดขนาดไฟล์ 5 MB และขนาดหลังแตก (ต่อส่วน 20 / รวม 40 MB ตรวจจากขนาดที่ประกาศก่อนแตก) · ปฏิเสธ DOCTYPE/ENTITY · ชีตแรกเท่านั้น ≤ 10,000 แถว ≤ 100 คอลัมน์ · .xls เก่า/ไฟล์มีรหัสผ่าน/ไฟล์เสีย = ข้อความไทย · `readTableFile(file)` เลือก xlsx/CSV จากเนื้อไฟล์ |
| Shared (4c) | `src/shared/ui/dialog.js` | กล่องยืนยัน/กล่องพิมพ์ข้อความของทั้งแอป (`confirmDialog` → true/false, `promptDialog` → ข้อความหรือ null) แทน `window.confirm`/`window.prompt` · ไฟล์เดียวที่ import SweetAlert2 (11.26.25, รุ่น `sweetalert2.esm.min.js` ที่ไม่ฝัง CSS; stylesheet อยู่ใน cascade layer `swal2` ของ `styles/main.css` ใต้ utilities ของ Tailwind) · ข้อความทุกส่วนเป็นข้อความล้วน (`titleText`, `text`, `inputLabel`) ส่วนที่ไลบรารีอ่านเป็น HTML (ปุ่ม, ข้อความแจ้งเตือนของ validate) ถูก escape · `danger` = ปุ่มแดง + โฟกัสที่ยกเลิก · เปลี่ยนหน้า (hashchange) = ปิดกล่องเป็นยกเลิก · ยกเว้นตัวกันออกจากหน้า 2 จุด (`assessments/views.js`, `shared/ui/autosave.js`) ที่ยังใช้ `window.confirm` เพราะต้องตอบทันที |
| Features (2B) | `quizzes/` (สร้างข้อสอบ), `assessments/` (ผู้เรียนทำแบบทดสอบ), `assignments/` (มอบหมายให้รุ่น + ผลของรุ่น) | `logic.js` เป็นฟังก์ชันล้วน (unit test); คะแนนไม่เคยคำนวณใน browser |
| Features (2C) | `quizzes/listEditors.js`, `quizzes/blankEditors.js` ฟอร์มสร้างข้อแบบใหม่ · `assessments/items.js` แสดงข้อทุกแบบ | แตะ/ปุ่ม/เมนูเลือกเท่านั้น (ไม่มีลากวาง) · ชื่อช่อง `q:<item>` และ `q:<item>:<slot\|blank>` · ลำดับตาม `presentation` ของ server |
| Features (2D) | `quizzes/importFile.js` (ไม่มี DOM: แม่แบบ CSV/Excel, อ่านแถว (`analyzeQuizImportRows`; `analyzeQuizImport` = ข้อความ CSV) → `buildItemDraft` ตัวเดียวกับหน้าสร้างข้อสอบ) | error รายแถวภาษาไทย · ได้ `items` เมื่อไม่มี error เท่านั้น |
| Rubric (3) | `rubrics/logic.js` (`buildCriterionDraft`: 2–6 ระดับ คะแนนไม่ซ้ำ ข้อความไทย) · `rubrics/views.js` (`#/courses/:id/rubrics`, `…/rubrics/:rubricId`) · ใช้ `quizzes/service.js` ตัวเดิม (`listForCourse(id, 'rubric')`, `createInstrument(…, 'rubric')`, ข้อ/ฉบับ/เผยแพร่ เหมือนแบบทดสอบ) | หน้า Rubric แยกจากหน้าแบบทดสอบ (กรองตาม `instrument_type`) · เปิด id ผิดชนิดแล้วไม่แสดง · ลิงก์ "Rubric" ในหน้าตัวสร้างหลักสูตร |
| ภาระงาน — ตั้งค่า (3) | `tasks/logic.js` (`buildTaskPayload`, `buildAllocationPayload`: วันเวลาเขตเวลากรุงเทพ → +07:00, กำหนดส่งต้องหลังวันเปิด) · `tasks/service.js` · `tasks/views.js` (`#/courses/:id/tasks`, `…/tasks/:taskId`) | สร้างเป็นร่าง → เผยแพร่ → เปิดให้รุ่น (เฉพาะรุ่นที่ผู้ใช้เป็นวิทยากร/ผู้ประสานงาน) · เลือก Rubric ได้เฉพาะฉบับเผยแพร่ · ใช้ `dateField` ของหน้ามอบหมายแบบทดสอบร่วมกัน (แสดงวันที่เป็น พ.ศ.) · ลิงก์ "ภาระงาน" ในหน้าตัวสร้างหลักสูตร |
| ภาระงาน — ฝั่งผู้เรียน (3) | `submissions/logic.js` (ชนิด/ขนาดไฟล์, ลิงก์ https, สถานะรอบ, `nextAction`) · `submissions/service.js` (อัปโหลดแล้วบันทึกแถวไฟล์, ลบวัตถุที่บันทึกไม่สำเร็จ, `cleanOrphans`) · `submissions/views.js` (`#/tasks`, `#/tasks/:allocationId`) | เมนู "ภาระงาน" สำหรับผู้เรียน · บันทึกร่างแล้วส่ง (ส่งแล้วแก้ไม่ได้) · ผลการตรวจ/คะแนนรายเกณฑ์/ผลก่อนหน้าที่ถูกตรวจใหม่ · ไฟล์เปิดผ่าน signed URL อายุ 1 ชม. · ลิงก์เปิดด้วย `rel=noopener` เฉพาะ https |
| ภาระงาน — ฝั่งผู้ตรวจ (3) | `reviews/logic.js` (`groupByPerson` สถานะรายคนจากรอบล่าสุด, `buildReviewPayload` ส่งเฉพาะระดับ/ความเห็น ไม่ส่งคะแนน, `reviewCsvRows`) · `reviews/service.js` · `reviews/views.js` (`#/staff/tasks` คิว, `…/tasks/:allocationId` รายคน + กรอง + CSV, `…/tasks/review/:submissionId` ฟอร์มตรวจ) | เมนู "ตรวจงาน" (วิทยากร/ผู้ประสานงาน/ผู้จัดการโปรแกรม/ครูพี่เลี้ยง) · ผู้ดูแลรุ่นเห็นรายชื่อทั้งรุ่นรวมคนที่ยังไม่ส่ง, ครูพี่เลี้ยงเห็นเฉพาะที่ RLS ให้ · ฟอร์มเริ่มจากร่างของตน หรือผลที่ใช้อยู่ (เพื่อตรวจใหม่) · ส่งผลต้องครบเกณฑ์/มีผล/มีเหตุผลเมื่อตรวจใหม่ · CSV ไม่มีเนื้อหางาน · embed `profiles` ของ cohort_memberships ต้องระบุ FK (`…_user_id_fkey`) เพราะมี 2 เส้นไปที่ profiles |
| บันทึกร่างอัตโนมัติ (3b) | `shared/ui/autosave.js` `createAutosave` — ใช้กับร่างงานของผู้เรียน (ข้อความ+ลิงก์) และร่างการตรวจของผู้ตรวจ | บันทึกเมื่อหยุดพิมพ์ 1 วินาที · ไม่บันทึกซ้อนกัน (ข้อมูลที่มาระหว่างบันทึกถูกบันทึกต่อทันที) · ข้อมูลที่ยังไม่ถูกต้อง (เช่น ลิงก์ที่พิมพ์ไม่เสร็จ) ไม่ถูกส่ง สถานะบอกเหตุผล · เตือนก่อนปิดแท็บ/คลิกลิงก์ในแอปถ้ายังไม่บันทึก · ถอด listener เองเมื่อฟอร์มออกจากหน้า · ปุ่ม "บันทึกร่าง" ยังอยู่ · ร่างการตรวจยังเป็นส่วนตัวของผู้ตรวจ (ผู้เรียนไม่เห็นจนกว่าจะส่งผล) |
| แจ้งเตือนในระบบ (3b) | `notices/service.js` (`counts()` ไม่ throw: ล้มเหลว = ไม่มีป้าย) · `layout.js` (`badge` ต่อเมนู, `updateNavBadges`) · `main.js` ดึงตัวเลขทุกครั้งที่เปลี่ยนหน้า และส่ง `refreshNotices` ให้หน้า | ป้ายที่ "ภาระงาน" = ผลที่ยังไม่เปิดดู + งานที่ต้องแก้ไข · ป้ายที่ "ตรวจงาน" = จำนวนคนที่รอตรวจ · เปิดหน้าภาระงานแล้วป้ายลดลงทันที · ป้ายบนรายการ: "มีผลตรวจใหม่" / "ต้องแก้ไข" · ป้ายมี aria-label (ชื่อลิงก์ของเมนูจึงเปลี่ยนเมื่อมีป้าย — test ใช้ href ไม่ใช้ชื่อ) |
| Edge Functions (3b) | `supabase/functions/_shared/` (`http.js`: handle/HttpError/CORS allow-list · `auth.js`: cron secret, ผู้ใช้ตรวจกับ Supabase Auth) · `google.js` (token service account) · `drive.js` (Drive v3: หาด้วย appProperties) · `cleanup-task-files/` · `drive-export-task/` (`exporter.js` ตรรกะไม่ผูก Deno, `index.js` จุดเข้า) · `delete-account/` (4a: `deleter.js` + `index.js` — soft delete ใน Supabase Auth และลบรูปโปรไฟล์) | กุญแจ service role อยู่ใน function เท่านั้น · ฐานข้อมูลตัดสินว่าลบอะไรได้ function ลบไฟล์ผ่าน Storage API · ตั้งเวลาด้วย pg_cron + pg_net (เจ้าของระบบตั้ง) · รายละเอียดและขั้นติดตั้ง: `docs/EDGE_FUNCTIONS.md` |
| ส่งสำเนาไป Google Drive (3b) | `drive/service.js` (`exportTask` เรียก function · รหัสข้อผิดพลาดของ function → ข้อความไทย · `history` ไม่ throw) · `drive/logic.js` (ข้อความผลและประวัติ, `explainError`) · ส่วน "สำเนาไฟล์งานไป Google Drive ส่วนกลาง" ในหน้า `#/staff/tasks/:allocationId` (`reviews/views.js`) | แสดงเฉพาะผู้ตรวจของรุ่น (`canAssessHint`; ฐานข้อมูลตัดสินจริง) · กดแล้วมีคำถามยืนยัน (ชื่อผู้เรียนจะอยู่ในชื่อโฟลเดอร์) · ระหว่างส่งปุ่มถูกปิดและมีข้อความบอก · ผลแบบ ส่งครบ/ส่งยังไม่ครบ (กดต่อ)/ไม่สำเร็จ + ลิงก์เปิดโฟลเดอร์ + ประวัติ 5 ครั้งล่าสุด (รหัสข้อผิดพลาดแปลเป็นไทย เก็บรหัสเดิมไว้ให้ผู้ดูแล) |
| จัดการบัญชี (4a) | `admin/accounts.js` หน้า `#/admin/accounts` (เมนู "จัดการบัญชี" สำหรับผู้อนุมัติผู้ใช้) · `admin/service.js` (`listAccounts`, `updateAccount`, `deleteAccount` → Edge Function `delete-account`) · `profiles/views.js` `renderDeletedScreen` | ค้นหา/กรองสถานะ/แบ่งหน้า 50 · แก้ชื่อ ชื่อที่แสดง รหัสประจำตัว · อนุมัติ/ระงับ (ถามเหตุผล)/เปิดใช้ · ลบบัญชี (ผู้ดูแลระบบ) ปุ่มเปิดเมื่อพิมพ์อีเมลตรง · ล้มกลางทางแสดงเหตุผลและกดซ้ำได้ · ปุ่มแสดงตามสิทธิ์ที่ฐานข้อมูลบอกต่อแถว · บัญชีที่ถูกลบเห็นหน้า "บัญชีนี้ถูกลบแล้ว" |
| ลบ / เก็บถาวร (4a) | `deletion/zone.js` (`watchDeleteZones`: ส่วน `<section data-delete-zone data-kind data-id>` เติมตัวเองเมื่อหน้าวาดใหม่ผ่าน MutationObserver · ฟังที่ตัว container ไม่ชน handler ของหน้า) · `deletion/service.js` (`usage`, `remove` → RPC `deletion_usage` / `delete_course` / `delete_instrument` / `delete_task`, SE009 เป็นข้อความไทย) · `deletion/logic.js` (เหตุผลเป็นประโยค, ยืนยันต้องตรงทุกตัวอักษร) · วางในหน้าหลักสูตร (builder) แบบทดสอบ Rubric ภาระงาน (แทนปุ่มลบฉบับร่างเดิม) · `quizzes/service.js` `setInstrumentStatus` (เก็บถาวร/นำกลับมาใช้) | ยังไม่มีผู้ใช้ → "ลบ…" พิมพ์รหัส (หลักสูตร/แบบทดสอบ/Rubric) หรือชื่อ (ภาระงาน) ปุ่มเปิดเมื่อตรงเท่านั้น แล้วไปหน้ารายการ · มีผู้ใช้แล้ว → เหตุผลเป็นจำนวน + "เก็บถาวร" · แบบทดสอบ/Rubric ที่เก็บถาวร: ป้าย "เก็บถาวร" จัดท้ายรายการ, ปุ่ม "นำกลับมาใช้", Rubric ไม่ถูกเสนอเมื่อสร้างภาระงานใหม่ (ที่ภาระงานใช้อยู่ยังแสดง), ซ่อนปุ่มมอบหมายให้รุ่น · หน้า "มอบหมายให้รุ่น" ที่เปิดจากที่อยู่เว็บบอกว่าเก็บถาวรแล้ว (4d) — ฐานข้อมูลบังคับด้วย (SE010, 4d) |
| หน้านำเข้าข้อสอบ (2D) | `quizzes/views.js` ปุ่ม "นำเข้าจากไฟล์ (Excel/CSV)" (เฉพาะฉบับร่าง) → แผงนำเข้า · `quizzes/service.js importItems` | ขั้นตอน: ดาวน์โหลดแม่แบบ → เลือกไฟล์ → ดูตัวอย่างทุกข้อ หรือรายการแถวที่ผิด → ยืนยัน · ปุ่มยืนยันมีเฉพาะเมื่อไม่มี error · ไฟล์อ่านในเบราว์เซอร์ ส่งเฉพาะแถวที่ผ่านแล้วไป RPC · server ปฏิเสธ → บอกข้อ/แถวของไฟล์ + "ยังไม่มีข้อใดถูกนำเข้า" |
| UI ร่วม (2C.1) | `shared/ui/components.js` `filePicker` + `bindFilePickers` (ผูกใน `main.js`) | ปุ่มเลือกไฟล์ภาษาไทยแทนข้อความของเบราว์เซอร์ · input จริงซ่อนแบบ sr-only ในป้าย (โฟกัส/แป้นพิมพ์ใช้ได้) · ชื่อไฟล์แสดงด้วย textContent · กล่อง `overflow-x-auto` ต้องมี `relative` เพื่อไม่ให้ sr-only ข้างในดันหน้าให้กว้างเกินจอ |
| E2E (2C.1) | `tests/e2e/fixtures.js` (ทุก spec import `test` จากที่นี่: ปิด context ที่ test เปิดเองเมื่อจบ) · Playwright project `chromium` (ชุดหลัก) และ `webkit-iphone` (iPhone 15, timeout ยาวกว่า) | สอง project ใช้ฐานข้อมูลเดียวกัน → รันแยก `test:e2e` / `test:e2e:webkit` แต่ละคำสั่ง reset ก่อน · ห้ามเพิ่ม retries (รอบซ้ำจะเจอสถานะที่รอบแรกทิ้งไว้) |

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
| `20261103090200_preregistrations.sql` | `preregistrations` + `claim_my_preregistrations()` · (4a) นำเข้ารายชื่อมีคอลัมน์ `user_code` ไม่บังคับ (รูปแบบเดียวกับฐานข้อมูล, ซ้ำในไฟล์ = ผิดแถวนั้น, ใส่ให้ตอนผูกบัญชีโดยไม่เขียนทับ) |
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
| `20261105090200_import_instrument_items.sql` | (2D) `import_instrument_items`: นำเข้าข้อ+เฉลยต่อท้ายฉบับร่าง ทั้งหมดหรือไม่เลย · SECURITY INVOKER (ผ่าน RLS/trigger/`set_item_key` เดิม) · error บอก `แถวที่ n` |
| `20261105090300_rubric_instruments.sql` | (3) Rubric = instrument ประเภท `rubric` (มีฉบับ/เผยแพร่แล้วแก้ไม่ได้) · ข้อ `rubric_criterion` {levels 2–6: id, label, score, description} · คะแนนเต็ม = ระดับสูงสุด (server) · Rubric มีแต่เกณฑ์ แบบทดสอบไม่มีเกณฑ์ · เผยแพร่ไม่ต้องมีเฉลย · มอบหมายเป็นแบบทดสอบไม่ได้ |
| `20261105090400_tasks.sql` | (3) `tasks` (ภาระงาน, Rubric ฉบับเผยแพร่ไม่บังคับ) · `task_allocations` (เปิดให้รุ่น วันเปิด/กำหนดส่ง) · `task_submissions` (รายรอบ: ร่างแก้ได้เฉพาะเจ้าของ, `submit_task_submission` ประทับเวลา/ส่งช้าที่ server แล้วแก้ไม่ได้) · `task_submission_files` (ขนาด/ชนิดอ่านจาก storage) · bucket `task-files` ส่วนตัว 20 MB PDF/Office/รูป · Rubric ของภาระงานอ่านได้โดยผู้ที่เห็นภาระงาน |
| `20261105090500_task_reviews.sql` | (3) `task_reviews` (ร่างของผู้ตรวจ → ส่งผล แก้ไม่ได้ · ตรวจใหม่ = แถวใหม่ + เหตุผล + `supersedes_id`) · `task_review_scores` (ระดับรายเกณฑ์, คะแนนจากระดับ) · `save_task_review` / `release_task_review` (คะแนนรวมที่ server, audit ค่าเดิม/ใหม่/เหตุผล) · ส่งรอบใหม่ได้เมื่อผลล่าสุดของรอบล่าสุด = ส่งกลับแก้ไข · ผู้ส่งงานตรวจงานตัวเองไม่ได้ |
| `20261105090600_task_notices.sql` | (3b) `task_review_reads` (ผู้เรียนเปิดดูผลแล้ว; เพิ่มได้เฉพาะแถวของตนสำหรับผลตรวจที่ส่งแล้วบนงานของตน) · `mark_task_results_seen(allocation)` · `task_notice_counts()` → `{unread_results, revise, waiting}` (นับเฉพาะภาระงานที่เผยแพร่ — ภาระงานที่เก็บถาวรไม่อยู่ในหน้าใด ป้ายจึงต้องไม่ค้าง) — ทั้งสองฟังก์ชัน SECURITY INVOKER (ตัวเลขไม่เกินที่ RLS ของผู้เรียกให้เห็น) |
| `20261105090700_task_files_cleanup.sql` | (3b) ล้างไฟล์ค้าง: `task_files_cleanup_orphans` (ไฟล์ไม่มีแถว > 24 ชม.) · `task_files_cleanup_stale_drafts` (ไฟล์ของร่างที่นิ่ง > 30 วัน: ล็อกร่างแบบ skip locked, บันทึก audit แล้วลบแถวในคำสั่งเดียว) · `task_files_cleanup_record` (audit ของไฟล์ค้างที่หายจริง) — SECURITY INVOKER เรียกได้เฉพาะ `service_role` · `service_role` ได้ INSERT บน `private.audit_logs` อย่างเดียว |
| `20261105090800_task_drive_exports.sql` | (3b) ส่งสำเนาไป Google Drive: `task_drive_exports` (การกดแต่ละครั้ง: ใคร เมื่อไร ผล) · `task_drive_copies` (ไฟล์ใด = ไฟล์ Drive ใด) — ผู้ตรวจของรุ่นอ่านได้ ไม่มีใครเขียนตรง · `begin_task_drive_export` (DEFINER: ผู้ตรวจของรุ่น, ล็อกการกดซ้ำ SE008, คืนรายการรอบที่ส่งแล้วที่มีไฟล์) · `finish_task_drive_export` (INVOKER, service_role เท่านั้น, บันทึกเฉพาะไฟล์ของภาระงาน/รุ่นนั้น) · service_role ลบ/แก้ "ใคร/เมื่อไร" ไม่ได้ |
| `20261108090000_user_codes.sql` | (4a) `profiles.user_code` รหัสประจำตัว (ไม่ซ้ำแบบไม่สนตัวพิมพ์, `[0-9A-Za-zก-๙._-]{1,50}`, ไม่อยู่ใน grant แก้ไขของตนเอง) · `authz.may_manage_account` กฎเดียวว่าใครจัดการบัญชีใครได้ (แยกจาก `admin_set_profile_status` ความหมายเดิม) · `admin_update_profile` (DEFINER: แก้ชื่อ/ชื่อที่แสดง/รหัส, ผู้ดูแลระบบแก้ของตนได้, audit `UPDATE_PROFILE`) · `preregistrations.user_code` ใส่ให้ตอนผูกบัญชีถ้ายังไม่มีและไม่ซ้ำ |
| `20261108090100_delete_unused.sql` | (4a) ลบเฉพาะที่ยังไม่มีผู้ใช้: `deletion_usage(kind, id)` (นับเหตุที่ลบไม่ได้) · `delete_course` / `delete_instrument` / `delete_task` (DEFINER, ผู้จัดการรายการนั้น, พิมพ์รหัส/ชื่อยืนยัน, ล็อกแถว, ตรวจซ้ำ, ลบส่วนย่อย, audit, SE009 = มีผู้ใช้แล้ว) · ตาราง ผลทุกตารางเป็น FK RESTRICT จึงลบหลักฐานไม่ได้แม้แข่งกัน · ตัวกันข้อสอบยอมให้ลบต่อเนื่องเมื่อทั้งฉบับถูกลบ · `media_cleanup_orphans/_record` (service_role) รูปของบทเรียน/แบบทดสอบที่ถูกลบ ล้างทุกคืนโดย `cleanup-task-files` |
| `20261108090200_account_deletion.sql` | (4a) สถานะ `deleted` · `admin_delete_account(id, confirm_email)` (DEFINER, ผู้ดูแลระบบเท่านั้น, ไม่ใช่ตนเอง/ผู้มีบทบาทระดับระบบ, พิมพ์อีเมล): ลบข้อมูลส่วนตัวในโปรไฟล์ ยุติสมาชิกหน่วยงาน/รุ่น/คู่ครูพี่เลี้ยง ล้างอีเมล/ชื่อ/รหัสในรายชื่อนำเข้า ลบ key ข้อมูลส่วนตัวใน audit · ผลการอบรมคงอยู่แบบไม่ระบุตัว · สถานะ deleted ย้อนคืน/แก้ไขไม่ได้ · ตัวกันรายชื่อนำเข้ายอมแก้เฉพาะช่องข้อมูลส่วนตัวหลังผูกบัญชี |
| `20261108090300_admin_list_accounts.sql` | (4a) `admin_list_accounts(search, status, limit, offset)` (DEFINER) รายชื่อสำหรับหน้า "จัดการบัญชี": เฉพาะคนที่ผู้เรียกดูแล (`can_admin_user`) · ค้นหาชื่อ/รหัส/อีเมล · แบ่งหน้าฝั่งเซิร์ฟเวอร์ (≤ 200) · บอก `can_edit` / `can_manage` / `can_delete` ต่อแถว · ไม่แสดงอีเมลของบัญชีที่ลบแล้ว |
| `20261109090000_archived_instrument_guard.sql` | (4d) แบบทดสอบ/Rubric ที่เก็บถาวรใช้งานใหม่ไม่ได้: trigger `assessment_assignments_validate_active` (สร้าง เปลี่ยนฉบับ หรือเผยแพร่/เปิดอีกครั้ง) และ `tasks_validate_rubric_active` (ภาระงานใหม่หรือเปลี่ยน Rubric) → SE010 · ที่ใช้อยู่แล้วไม่ถูกกระทบ · `private.instrument_status_for_use` อ่านสถานะพร้อม `FOR SHARE` กันแข่งกับการเก็บถาวร · ชื่อ trigger เรียงหลัง `*_validate` เดิม ข้อผิดพลาดเรื่องสิทธิ์จึงมาก่อน |

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
| Storage ของ portfolio | ไฟล์งาน (`task-files`) มีแล้วตั้งแต่ Phase 3 · ล้างไฟล์ค้างและสำเนาไป Google Drive (3b) · portfolio ยังไม่มี | ภายหลัง |
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

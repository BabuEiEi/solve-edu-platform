# Migration from Legacy — Phase 0 Audit Report

> ตรวจเมื่อ 2 พ.ย. 2569 (2026-11-02) แบบ read-only — **ไม่ได้แก้ไข/Push/Force-push Repository ต้นฉบับ**

| Repository | Branch | Commit SHA ที่ตรวจ | Commit ล่าสุด |
|---|---|---|---|
| `BabuEiEi/solve-edu-lms` | `main` | `6061bff87a8e6e15886ff3fe73dfb598a8a9bf51` | 2026-04-24 |
| `BabuEiEi/LMS` | `main` | `253cad6b23a5c5eb20677a6e87ad345302ed59d2` | 2026-02-26 |

## 1. Inventory

### 1.1 `solve-edu-lms` (Vite 8 + Vanilla JS + Tailwind 4 + Supabase JS 2)

| ส่วน | ที่ตั้ง | รายละเอียด |
|---|---|---|
| Frontend ทั้งระบบ | `src/main.js` (3,415 บรรทัด, ไฟล์เดียว) | Auth, Course CRUD, Quiz, Video Quiz, Upload, Mentor Review, Score Matrix, Excel |
| ตารางที่โค้ดเรียกใช้ | `src/main.js` | `courses`, `users_profile`, `quiz_questions`, `quiz_results`, `video_questions`, `video_watch_logs`, `course_logs`, `submissions` |
| RPC ที่เรียกใช้ | `src/main.js` | `get_all_profiles`, `get_all_quiz_results`, `get_all_course_logs`, `get_all_submissions`, `review_submission`, `update_profile_status`, `delete_profile`, `admin_update_profile`, `admin_update_quiz_result`, `admin_delete_quiz_result`, `admin_cancel_quiz_result` |
| Schema ที่ commit ไว้ | `supabase/courses.sql`, `score_matrix_admin_rpcs.sql` | มีเพียง `courses`, `quiz_result_audit_logs` และ 3 admin RPC |
| Storage buckets | `src/main.js` | `profile-images`, `submissions` (ใช้ `getPublicUrl`) |
| Apps Script | `Code.gs` (72 บรรทัด) | `doGet`/`doPost` อ่าน–เขียน Sheet "Courses" **ไม่มีการตรวจสิทธิ์** |
| Import script | `scripts/import-courses.mjs` | ใช้ `SUPABASE_SERVICE_ROLE_KEY` จาก env (ไม่ได้ commit ค่า) |

### 1.2 `LMS` (Google Apps Script + HTML/Tailwind CDN)

| ส่วน | ที่ตั้ง | รายละเอียด |
|---|---|---|
| Backend | `Code.gs` (≈560 บรรทัด) | `setupSheet`, `uploadFile`, `fetchLessonList`, `saveLesson`, `updateLesson`, `deleteLesson`, `checkAdmin`, `getAdminProfile`, `updateAdminProfile`, `loginStudent`, `getStudents`, `saveStudent`, `updateStudent`, `deleteStudent`, `getExams`, `saveExam`, `updateExam`, `deleteExam`, `submitExam`, `getExamResults` |
| Frontend | `index.html` (≈72 KB) | Rich Text (CKEditor 4.22.1 CDN), Lesson Gallery, Exam with images, `google.script.run` |
| ข้อมูล | Google Sheets | `admin`, `students`, `exams_pre`, `exams_post`, `scores`, lessons |

## 2. Risk Register (ยืนยันจากโค้ดจริง)

| รหัส | ความเสี่ยง | หลักฐาน | การจัดการในระบบใหม่ |
|---|---|---|---|
| SEC-01 | Admin เริ่มต้น + password ข้อความธรรมดา | `LMS/Code.gs` `setupSheet()` เขียนบัญชี admin ตั้งต้นลง Sheet | ไม่ย้าย; ใช้ Supabase Auth เท่านั้น ไม่มีตาราง password |
| SEC-02 | Endpoint ไม่ตรวจสิทธิ์ | `LMS/Code.gs` ทุกฟังก์ชัน CRUD; `solve-edu-lms/Code.gs` `doPost` | ทุกการเข้าถึงผ่าน RLS + trusted RPC (ทดสอบ 103 assertions) |
| SEC-03 | ส่ง password และเฉลยไป browser | `getAdminProfile()` คืน password admin; `getStudents()` คืน password นักเรียน; `getExams()` คืน `correct_answer`; `solve` โหลด `quiz_questions` ด้วย `select('*')` ซึ่งมี `answer` | ไม่มีคอลัมน์ password; `profiles.contact_email` ไม่ GRANT SELECT; Phase 2 เฉลยอยู่ schema `private` (ปิดแล้วตั้งแต่ Phase 1) |
| SEC-04 | คะแนนคำนวณฝั่ง Client | `solve/src/main.js` `submitQuiz` คำนวณ `score`/`passed` แล้ว insert | Phase 2: Server-side scoring (โครง schema `private` พร้อม) |
| SEC-05 | ไม่ตรวจ error ตอนบันทึกผล | `submitQuiz` ใช้ `try { await insert } catch {}` — supabase-js ไม่ throw จึงกลืน error เงียบ | `unwrap()` บังคับตรวจ `error` ทุก call + unit test |
| SEC-06 | Public URL ของไฟล์งาน | `uploadWork` → `getPublicUrl`; `LMS uploadFile` ตั้ง `ANYONE_WITH_LINK` | `avatar_path`/`object_path` เก็บ path เท่านั้น; Private bucket + signed URL ใน Phase 2–3 |
| SEC-07 | `innerHTML` จากข้อมูลภายนอก | `solve` 66 จุด + inline `onclick=` 45 จุด; `LMS` 14 จุด | `html```` escape อัตโนมัติ + ESLint ห้าม `innerHTML=` นอก `html.js` + ไม่มี inline handler |
| SEC-08 | Schema ไม่ครบ | ตาราง 7 ตารางและ RPC 8 ตัวที่โค้ดเรียกไม่มีใน repo | Migration ครบชุด สร้างใหม่ได้จากศูนย์ (`db reset`) |
| SEC-09 | `.env` อยู่ใน public repo | commit `cef5f8b` มี `VITE_SUPABASE_URL` และ `VITE_SUPABASE_ANON_KEY` (ค่าเป็น `sb_publishable_…`) | ไม่ copy `.env`; `.gitignore` ใหม่ + `.env.example` |
| SEC-10 | Dashboard ดึงภาพรวมทั้งระบบ | RPC `get_all_*` และกรองฝั่ง client ด้วย `role === 'student'` | RLS scope ตามโรงเรียน/รุ่น/พี่เลี้ยง (ดู PERMISSIONS.md) |

### 2.1 ข้อค้นพบเพิ่มเติมที่ Blueprint ไม่ได้ระบุ

1. **`solve-edu-lms/Code.gs`** — มี Apps Script อีกชุด (`doGet`/`doPost` จัดการ Sheet "Courses") ที่ไม่ตรวจสิทธิ์ใด ๆ หากยัง Deploy เป็น Web App อยู่ ใครที่รู้ URL สามารถเพิ่ม/แก้/ลบรายวิชาใน Sheet ได้ → **ควรยกเลิก Deployment นั้น**
2. **ผลการสแกน secret ใน git history** — `.env` มีเพียง URL + publishable key (ออกแบบให้เปิดเผยได้ ความปลอดภัยขึ้นกับ RLS ของโปรเจกต์เดิม) ส่วนคำว่า `SUPABASE_SERVICE_ROLE_KEY` ใน `COURSES_MIGRATION.md` เป็น placeholder (`YOUR_SER…`) **ไม่พบ service-role/secret key จริง** ใน `solve-edu-lms`; ใน `LMS` ไม่พบรูปแบบ secret
   ⚠️ แต่โค้ดเดิมให้ client `insert` แถว `users_profile` พร้อม `role` เอง และ policy ของ `users_profile` ไม่อยู่ใน repo จึง**ตรวจไม่ได้ว่าผู้ใช้ตั้ง `role: 'admin'` ให้ตนเองได้หรือไม่** — หากโปรเจกต์ Supabase เดิมยังเปิดอยู่ ควรตรวจ policy ของ `users_profile` หรือปิดการสมัครใหม่
3. **`LMS/submitExam(studentUsername, …)`** เชื่อ username ที่ client ส่งมา → ส่งคะแนนแทนผู้อื่นได้ (impersonation)
4. **Admin RPC ใน `score_matrix_admin_rpcs.sql`** เป็น `SECURITY DEFINER` + `set search_path = public` และตรวจ `role in ('admin','staff')` ภายใน (ดี) แต่ไม่ได้ `REVOKE EXECUTE … FROM PUBLIC` — `anon` เรียกได้แต่จะถูกปฏิเสธโดยการตรวจภายใน (ความเสี่ยงต่ำ)
5. **Pretest 1 ครั้ง** ตรวจด้วย `select … limit 1` แล้วจึง insert (ไม่ atomic) และเกณฑ์ผ่าน `percent >= 80` hardcode

## 3. Take / Rewrite / Drop

| จากโค้ดเดิม | ตัดสินใจ | ปลายทาง | สถานะ |
|---|---|---|---|
| `solve` แนวคิด Auth + Approval + Google OAuth | **Rewrite** | `src/core/auth.js`, `features/profiles`, `features/admin`, RPC `admin_set_profile_status` | ✅ Phase 1 |
| `solve` บทบาท `student/teacher/staff/admin` ใน `users_profile.role` | **Drop → Redesign** | membership 3 ระดับ (platform / organization / cohort) | ✅ Phase 1 |
| `solve` Course listing | **Rewrite** | `features/courses` (Program → Course → Unit → Lesson → Block) | ✅ Phase 1 (อ่าน) |
| `solve` Course CRUD UI | Rewrite | Course Builder (`features/builder`) | ✅ Phase 2A |
| `solve` Quiz UI หลายรูปแบบ / Video Quiz | Take UI ideas, Rewrite scoring | `features/assessments` + server scoring | ⏳ Phase 2 |
| `solve` Upload / Mentor Review | Rewrite (versioned attempts, rubric, private storage) | `features/assignments` | ⏳ Phase 3 |
| `solve` Score Matrix / ExcelJS | Take concept | `features/analytics` (scope-aware, pseudonymized) | ⏳ Phase 5 |
| `solve` audit-log pattern | **Take (ปรับ)** | `private.audit_logs` + trigger `private.audit_row()` | ✅ Phase 1 |
| `LMS` Rich Text Lesson + Gallery | Take UX, Rewrite | `lesson_blocks` (`rich_text`, `image`, …) + Tiptap + DOMPurify + signed URL | ✅ Phase 2A |
| `LMS` ภาพในโจทย์/ตัวเลือก | Take UX | Assessment items | ⏳ Phase 2 |
| `LMS` CKEditor 4.22.1 | **Drop** | Tiptap 3 (MIT) + DOMPurify (MPL-2.0/Apache-2.0) | ✅ Phase 2A |
| `LMS` Google Sheets / Apps Script backend / login | **Drop** | Supabase | ✅ |
| `.env`, ข้อมูลผู้ใช้/คะแนนเดิม | **Drop** | ไม่ย้าย (ระบบทดลองใหม่) | ✅ |

**ไม่มีการ copy ไฟล์ใดจาก Repository เดิมแบบทั้งไฟล์** — โค้ดใหม่เขียนขึ้นใหม่ทั้งหมด

## 4. ความแตกต่างจาก Blueprint (ตัดสินใจระหว่าง Implement)

| ประเด็น | Blueprint | ที่ทำจริง | เหตุผล |
|---|---|---|---|
| Schema ของ helper | ใช้ `private` | แยก `authz` (helper, grant usage ให้ `authenticated`) กับ `private` (ข้อมูลลับ, ไม่ grant เลย) | ถ้าใช้ schema เดียว ต้อง grant usage `private` ให้ `authenticated` เพื่อให้ policy เรียก helper ได้ ซึ่งเสี่ยงต่อตารางเฉลยใน Phase 2 |
| ผู้อนุมัติผู้สมัครใหม่ | ไม่ระบุ | เพิ่ม `profiles.requested_org_id` — ผู้สมัครเลือกโรงเรียน, ผู้บริหารโรงเรียน/เขตที่ครอบคลุมเห็นและอนุมัติ | แก้ปัญหา "ผู้สมัครยังไม่มี membership จึงไม่มีใครเห็น" โดยไม่ต้องเปิดรายชื่อผู้สมัครทั้งระบบ |
| `contact_email` | เก็บใน profiles | เก็บแต่ **ไม่ GRANT SELECT** ให้ client; อ่านผ่าน `get_profile_contact()` | blueprint 7.2 ข้อ 3 ไม่ expose PII เกินจำเป็น |
| Default privileges | ไม่ระบุ | Migration แรกเพิกถอน default grant ของ Supabase สำหรับตาราง/ฟังก์ชันใหม่ใน `public` | ตารางใหม่ใน Phase ถัดไปจะ "ปิด" จนกว่าจะ GRANT เอง (secure-by-default) |
| `supabase db reset --local` | ใช้ Docker | Workspace นี้ดึง image ของ Supabase ไม่ได้ (registry ถูกบล็อก) จึงทดสอบบน PostgreSQL 16 + shim ที่จำลอง `auth`/roles + PostgREST 12 | ต้องรัน `npx supabase db reset --local && npx supabase test db` บนเครื่องผู้พัฒนาอีกครั้ง (ดู TEST_REPORT_PHASE1.md) |

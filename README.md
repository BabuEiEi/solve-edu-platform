# SolveEdu Integrated Platform

แพลตฟอร์มเดียวสำหรับอบรมพัฒนาครู ประเมินสมรรถนะ นิเทศ 6Es ติดตาม Coaching/PLC และวิเคราะห์ข้อมูลวิจัย
สร้างใหม่จากการศึกษา `solve-edu-lms` และ `LMS` ตาม [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md)

**สถานะ:** Phase 0–1 + Phase 2A (Course Builder, หน้าเรียน, Private Storage, นำเข้ารายชื่อ CSV) + Phase 2B/2B.1 (แบบทดสอบ, ให้คะแนนฝั่ง server, มอบหมาย, จำกัดเวลา/บันทึกอัตโนมัติ, ผลของรุ่นและวิเคราะห์ข้อสอบ) + Phase 2C (ข้อสอบแบบใหม่ 7 แบบ: เรียงลำดับ จับคู่ จัดกลุ่ม ตารางตัวเลือก ดรอปดาวน์ เติมคำ ติดป้ายบนรูป) + Phase 2C.1 (เทียบข้อความไทยทุกลำดับการพิมพ์, วิธีให้คะแนนอ่านกลับได้, ใช้บนมือถือ/Safari ได้ดีขึ้น) + Phase 2D (นำเข้าข้อสอบจากไฟล์ CSV) + Phase 3 (ภาระงาน + Rubric: ส่งงานหลายรอบ ตรวจด้วย Rubric ส่งกลับแก้ไข ตรวจใหม่พร้อมเหตุผล) เสร็จ · ระบบทดลอง · **ยังไม่ Deploy**

## Stack

Vite 7 · Vanilla JS (ES Modules) · Tailwind CSS 4 · Supabase (Postgres + Auth + Data API) · Vitest · pgTAP

## เริ่มต้นบนเครื่อง (Local)

ต้องมี Node ≥ 20 และ Docker (Docker Desktop / OrbStack / Colima)

```bash
npm install
npx supabase start                 # สตาร์ต Supabase Local (ครั้งแรกจะดึง image)
npx supabase db reset --local      # สร้างฐานข้อมูลจาก migrations + seed (LOCAL เท่านั้น)
npx supabase test db               # รันชุดทดสอบ RLS (pgTAP)

cp .env.example .env.local         # ใส่ API URL และ Publishable key ที่ได้จาก `supabase start`
npm run dev                        # http://127.0.0.1:5173
```

> ⚠️ ห้ามใช้ `supabase db reset --linked` หรือ `db push` กับโปรเจกต์จริงจนกว่าจะผ่าน Definition of Ready (BLUEPRINT §19)

### บัญชีทดลอง (seed — ข้อมูลสมมติทั้งหมด, ใช้ได้เฉพาะ Local)

รหัสผ่านทุกบัญชี: `DemoPass#2569`

| อีเมล | บทบาท |
|---|---|
| `platform.admin@example.test` | ผู้ดูแลระบบ |
| `district.admin@example.test` | ผู้ดูแลเขตพื้นที่ (เขตสาธิต) |
| `supervisor@example.test` | ศึกษานิเทศก์ (จัดการโครงการ/หลักสูตร) |
| `school.admin.a@example.test` / `school.admin.b@example.test` | ผู้บริหารโรงเรียน ก / ข |
| `trainer@example.test` | วิทยากรรุ่น C1 |
| `mentor@example.test` | ครูพี่เลี้ยง (ดูแลครู ก1 เท่านั้น) |
| `teacher.a1@example.test`, `teacher.a2@example.test`, `teacher.b1@example.test` | ผู้เข้ารับการอบรม |
| `newcomer@example.test` | ผู้สมัครใหม่สถานะ pending (ขอสังกัดโรงเรียน ก) |

ลองเข้าด้วย `school.admin.a` → เมนู "อนุมัติผู้ใช้" จะเห็น newcomer; เข้าด้วย `school.admin.b` จะไม่เห็น

## คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` / `build` / `preview` | พัฒนา / build / ดูผล build |
| `npm run lint` · `npm test` · `npm run check` | ESLint · Vitest · lint+test+build |
| `npm run db:reset` · `npm run db:test` | Supabase Local reset · pgTAP |
| `npm run db:reset:pg` · `npm run db:test:pg` | ทางเลือกเมื่อไม่มี Docker: PostgreSQL 15+ ในเครื่อง + shim (ดู `scripts/db-local/`) |
| `npm run test:integration` | Integration: service layer → Supabase Local จริง |
| `npm run test:e2e` · `npm run test:e2e:webkit` | E2E บน Chromium (ชุดหลัก) · บน WebKit จำลอง iPhone 15 (ชุดเสริม รันแยก) — ทั้งสองคำสั่ง reset ฐานข้อมูลก่อน · ครั้งแรกต้อง `npx playwright install webkit` |
| `POSTGREST_BIN=… scripts/db-local/test-rest.sh` | Integration: service layer → PostgREST → RLS |
| `python3 scripts/db-local/gen-data-dictionary.py > docs/DATA_DICTIONARY.md` | สร้าง data dictionary ใหม่จาก schema |

## โครงสร้าง

```
src/core/          supabaseClient, auth, router, permissions (UI only), errors
src/features/      profiles, admin, organizations, programs, courses, builder, lessons,
                   preregistration, quizzes, assessments, assignments (+ dashboard)
src/shared/        ui/html.js (escape อัตโนมัติ), components, layout, utils/date.js (พ.ศ.)
supabase/          config.toml, migrations/, seed.sql, tests/ (pgTAP)
tests/unit/        Vitest · tests/integration/ Supabase Local จริง · tests/e2e/ Playwright
scripts/db-local/  shim + reset/test scripts เมื่อไม่มี Docker
docs/              BLUEPRINT, ARCHITECTURE, ERD, DATA_DICTIONARY, PERMISSIONS, API_CONTRACTS,
                   MIGRATION_FROM_LEGACY, TEST_REPORT_PHASE1/2A/2B/2B1/2C/2C1/2D/3
```

## หลักความปลอดภัยที่บังคับในโค้ด

- ไม่มีตาราง/คอลัมน์ password · บทบาทอยู่ในตาราง membership ไม่ใช่ใน metadata ที่ผู้ใช้แก้ได้
- ทุกตารางเปิด RLS + GRANT รายคอลัมน์; ตารางใหม่ถูกปิดโดยปริยาย
- Browser ใช้ publishable key เท่านั้น (`supabaseClient.js` ปฏิเสธ secret key)
- ห้าม `innerHTML =` นอก `src/shared/ui/html.js` (ESLint) · CSP ใน `index.html`
- `.env*` ไม่ถูก commit (ยกเว้น `.env.example`)

## Roadmap

Phase 2 Integrated LMS (Course Builder, Storage, Assessment + server scoring) → Phase 3 Assignments/Rubric/Needs Assessment (PNI) → Phase 4 Supervision 6Es → Phase 5 Analytics/Research/Pilot

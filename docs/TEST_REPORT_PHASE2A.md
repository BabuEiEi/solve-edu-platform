# Test Report — Phase 2A

วันที่รัน: 3 พ.ย. 2569 · สภาพแวดล้อม: macOS, Node 24, Docker + Supabase CLI 2.122 (Postgres 17, GoTrue, Storage, PostgREST, Mailpit จริง)

| ชุดทดสอบ | คำสั่ง | ผล |
|---|---|---|
| Lint + Unit + Build | `npm run check` | ✅ PASS — unit 101 (integration 36 ถูก skip ในคำสั่งนี้) · build สำเร็จ (Tiptap แยก lazy chunk) |
| DB reset + pgTAP | `npx supabase db reset --local && npx supabase test db` | ✅ PASS 188/188 (11 ไฟล์) |
| Integration (Supabase Local จริง) | `npm run test:integration` | ✅ PASS 36/36 (5 ไฟล์) |
| `npm audit --omit=dev` | — | ✅ 0 vulnerabilities |
| `scripts/db-local/test.sh` (PostgreSQL ล้วน ไม่มี Docker) | — | ⏭️ SKIP — เครื่องนี้ไม่มี `psql`; เพิ่ม storage shim แล้วแต่ **ยังไม่ได้รันจริง** |
| E2E เบราว์เซอร์จริง (Playwright, Chromium headless) | `npm run test:e2e` | ✅ PASS 3/3 — trainee เรียนจบบทเรียน · trainee เข้า builder/approvals ไม่ได้ · trainer เพิ่มวิดีโอ YouTube แล้ว trainee เห็น iframe `youtube-nocookie` โดยไม่มี CSP violation (ยังไม่ได้ตรวจว่าวิดีโอเล่นได้จริง ซึ่งขึ้นกับเจ้าของวิดีโอ) |
| Google OAuth | — | ⏭️ SKIP — ต้องมี Client ID/Secret |

## pgTAP เพิ่มใน Phase 2A (+85 assertions)

| ไฟล์ | # | ครอบคลุม |
|---|---|---|
| `070_storage.sql` | 22 | bucket private/จำกัด MIME · anon · trainee เห็นเฉพาะ published · อัปโหลดเฉพาะผู้จัดการ · path ผิดรูป · avatar เจ้าของเท่านั้น · ถอนสิทธิ์ |
| `080_course_builder.sql` | 27 | `course_access` · reorder (ครบ/ซ้ำ/ข้าม parent/kind ผิด/ไม่มีสิทธิ์) · publish · XSS ถูกปฏิเสธใน DB · path traversal |
| `085_insert_returning.sql` | 10 | `INSERT … RETURNING` ของผู้เขียนที่ชอบธรรม + ไม่เปิดการมองเห็นเพิ่ม |
| `090_preregistrations.sql` | 26 | สิทธิ์นำเข้า · ไม่ยกระดับสิทธิ์ · PII · ผูกด้วยอีเมลยืนยันแล้ว · ไม่ยืนยัน/ไม่ตรง/ผู้นำเข้าถูกถอนสิทธิ์ → ไม่ผูก · audit |

## Integration ที่พิสูจน์ด้วยระบบจริง

- Storage API: อัปโหลด/signed URL/ลบ ตาม policy · public URL ใช้ไม่ได้ · MIME `text/html` ถูกปฏิเสธ
- Lesson page: เริ่ม/เรียนจบ (เวลาประทับโดย server) · ไม่ลดสถานะ · เขียน progress ของคนอื่นไม่ได้
- Builder: สร้างหลักสูตร 2 หน่วย × 2 บท → บล็อก → reorder → publish · ผู้เรียนแก้ไม่ได้ · ลบบทที่มีความก้าวหน้าไม่ได้
- Pre-registration: สมัครจริงผ่าน GoTrue (**email confirmation เปิด**) → ล็อกอินก่อนยืนยันไม่ได้ → ยืนยันผ่านอีเมลใน Mailpit → ผูกบัญชี · อีเมลนอกรายชื่อ + metadata ปลอม → ไม่ได้อะไร · แถวที่ยกเลิกไม่ผูก

## บั๊กที่การทดสอบพบและแก้ในรอบนี้

1. **RLS `INSERT … RETURNING`** (ซ่อนมาตั้งแต่ Phase 1): SELECT policy ของ courses/units/lessons/programs/cohorts เรียก helper ที่ค้นแถวด้วย id ซึ่งมองไม่เห็นแถวใหม่ → ผู้มีสิทธิ์สร้างไม่ได้ (42501) — แก้ใน migration `…090110`
2. Regex Postgres: `\b` คือ backspace ไม่ใช่ word boundary (ต้องใช้ `\y`) — ทำให้ตรวจ `<script>` พลาด; ชุดทดสอบจับได้
3. `CHECK` ที่เรียก function ใน schema `private` ล้มเมื่อรันในสิทธิ์ client — inline ตรรกะแทน

## ข้อจำกัด / ความเสี่ยงคงเหลือ

- E2E ครอบคลุมเพียง 3 สถานการณ์ (ยังไม่ครอบคลุม นำเข้า CSV ผ่านหน้าจอ, อัปโหลดรูป, Vimeo) และรันเฉพาะ Chromium
- ไม่ส่งอีเมลเชิญ: ผู้ถูกนำเข้าต้องสมัครเองด้วยอีเมลเดียวกัน; ต้องตั้ง SMTP จริงก่อน pilot (rate limit อีเมลใน `config.toml`)
- ผู้ที่มีบัญชีอยู่แล้วและยัง active จะถูกผูกสิทธิ์ตามรายชื่อเมื่อล็อกอินครั้งถัดไป (ตั้งใจ)
- Reorder/ลบไฟล์ใน Builder เป็น best-effort — อาจเหลือไฟล์กำพร้า
- Trainer ที่ใช้หลักสูตรร่วมหลายโครงการแก้เนื้อหากระทบทุกรุ่น (ยังไม่มี versioning — ข้อจำกัดเดิมใน ARCHITECTURE.md)
- `npm audit` dev dependencies: moderate 5 (minimatch ผ่าน eslint — เหมือนเดิม ไม่ถูก bundle)
- ผู้นำเข้า district_admin นำเข้ารุ่นได้ตาม `can_grant_cohort_role`; ไม่มีหน้าจอดูประวัติ batch (มี `batch_id` ในตารางแล้ว)

# Test Report — Phase 2B (Assessment + server-side scoring)

วันที่รัน: 4 พ.ย. 2569 · สภาพแวดล้อม: macOS, Node 24, Docker + Supabase CLI 2.122 (Postgres 17, GoTrue, Storage, PostgREST จริง) · branch `phase-2b`

| ชุดทดสอบ | คำสั่ง | ผล |
|---|---|---|
| Lint + Unit + Build | `npm run check` | ✅ PASS — unit 161 (เพิ่ม 60 จาก 2A) · build สำเร็จ |
| DB reset + pgTAP | `npx supabase db reset --local && npx supabase test db` | ✅ PASS 387/387 (16 ไฟล์; เพิ่ม 199) |
| Integration (Supabase Local จริง) | `npm run test:integration` | ✅ PASS 54/54 (8 ไฟล์; เพิ่ม 18) |
| E2E (Playwright, Chromium headless) | `npm run test:e2e` | ✅ PASS 9/9 (เพิ่ม 5) · ไม่มี CSP violation |
| Prettier | `npx prettier --check src tests` | ✅ PASS |
| `npm audit --omit=dev` | — | ✅ 0 vulnerabilities |
| `scripts/db-local/test.sh` (PostgreSQL ล้วน) | — | ⏭️ SKIP — เครื่องนี้ไม่มี `psql` |

## pgTAP เพิ่มใน Phase 2B (+199 assertions)

| ไฟล์ | # | ครอบคลุม |
|---|---|---|
| `100_assessment_schema.sql` | 64 | GRANT/RLS ของ 6 ตาราง · `options_json` ห้ามมีเฉลย · ฉบับ published แก้ไม่ได้ · ผู้เรียนเห็นข้อหลังเริ่มทำเท่านั้น · responses ไม่มี `awarded_score` · audit |
| `110_assessment_authoring.sql` | 39 | เฉลยตั้งได้แต่อ่านไม่ได้ · publish gate (ทุกข้อต้องมีเฉลยที่ถูกต้อง) · hash ไม่รวมเฉลย · clone · ร่างได้ทีละ 1 · audit ไม่เก็บเนื้อหาเฉลย |
| `120_assessment_attempts.sql` | 46 | ตัวให้คะแนน (all-or-nothing, partial ไม่ติดลบ, numeric tolerance) · ช่วงเวลา (SE001) · จำนวนครั้ง (SE002) · ส่งซ้ำ (SE003) · input ผิดรูป (22023) · ไม่มีพารามิเตอร์คะแนน/เวลา · คืนเฉพาะคะแนนรวม |
| `130_assessment_media.sql` | 16 | bucket private 5 MiB รูปเท่านั้น · ผู้เรียนเห็นรูปหลังเริ่มทำ · คนนอกอ่าน/อัปโหลดไม่ได้ |
| `140_assessment_assignments.sql` | 34 | ใครมอบหมาย/แก้/ลบได้ · มอบหมายฉบับ draft ไม่ได้ · หลักสูตรต้องอยู่ในโครงการของรุ่น · **หลังมีผู้เริ่มทำ ห้ามแก้เกณฑ์ผ่าน/ประเภท/หลักสูตร หรือย้อนเป็นร่าง (SE004)** · mentor เห็นเฉพาะผู้ที่ดูแล · audit |

## Integration ที่พิสูจน์ด้วยระบบจริง

- **คำขอพร้อมกันจริง** (`assessment.test.js`): เริ่มพร้อมกัน 5 คำขอ → ได้ 1 attempt · ส่งพร้อมกัน 4 คำขอ → สำเร็จ 1 และ SE003 3 ครั้ง
- **ไม่มีเฉลยใน response**: สแกน JSON ทุกตัวที่ trainee/ผู้สร้าง/staff ได้รับ หา `correct`, `answer_json`, `scoring_json`, `tolerance`, `is_correct`, `awarded_score`
- Quiz Builder (`quizzes.test.js`): อัปโหลดรูปและขอ signed URL ผ่าน Storage API จริง · publish ไม่ได้ถ้ายังไม่มีเฉลย · clone ได้ฉบับร่างพร้อมเฉลย
- ผลของรุ่น (`assignments.test.js`): embed `profiles` ผ่าน FK hint · trainer เห็นทั้งรุ่น 3 คน · mentor เห็นเฉพาะครู ก1 ทั้งรายชื่อและ attempts · SE004 ผ่าน PostgREST · คนนอกได้ผลว่าง

## Mutation tests (ยืนยันว่า test จับได้จริง)

| สิ่งที่ถอดออกชั่วคราว | ผล |
|---|---|
| advisory lock + partial unique index ของ `start_attempt` | integration เริ่มพร้อมกัน **FAIL** (ได้หลาย attempt) |
| trigger `assessment_assignments_lock` | pgTAP `140` **FAIL** 4 ข้อ (#18–21) |

กู้คืนแล้ว reset DB ทุกครั้ง

## E2E (เบราว์เซอร์จริง)

1. ผู้เรียนทำ pretest: คำตอบที่พักไว้ไม่หายเมื่อรีเฟรช · ตอบเลขไทย `๗๕` ได้ · เห็นเฉพาะคะแนนรวม · ทำครบแล้วไม่มีปุ่มเริ่ม · ไม่มีเฉลยใน response
2. staff ที่ไม่ใช่ผู้เรียนไม่เห็นเมนู "แบบทดสอบ"
3. ผู้สร้างสร้างข้อสอบที่มีรูปในตัวเลือก → ตั้งเฉลย → เผยแพร่ → ฉบับนั้นแก้ไม่ได้
4. บล็อก "แบบทดสอบ" ในบทเรียนพาผู้เรียนไปหน้าทำแบบทดสอบ
5. **trainer มอบหมาย posttest จากหน้าข้อสอบ → ผู้เรียนทำ → trainer เห็นผลอัปเดต + เกณฑ์ผ่านถูกล็อก + ดาวน์โหลด CSV ได้ → mentor เห็นเฉพาะครูที่ดูแลและไม่มีฟอร์มตั้งค่า**

## บั๊กที่การทดสอบพบและแก้ใน Phase 2B

1. ผู้สร้างมองไม่เห็นรูปของข้อสอบตัวเองถ้ายังไม่มีฉบับใด (`can_view_instrument` เดินผ่าน versions) — pgTAP `130` จับได้ แก้ policy ให้ผ่าน `can_manage_instrument` ด้วย
2. Test แทรก `id` เองไม่ได้ (ไม่มี column grant บน `id` — ตั้งใจ) → ใช้ subquery/CTE หาแถวแทน
3. SQL `OR` ไม่ short-circuit → `jsonb_array_length` บนค่าที่ไม่ใช่ array error → แยกเป็น IF ซ้อน

## ข้อจำกัด / ความเสี่ยงคงเหลือ

- ไม่มีช่วงผ่อนผันหลัง `close_at`: กำลังทำอยู่แล้วเวลาหมด → ส่งไม่ได้ (SE001) · ครั้งที่เริ่มแต่ไม่ส่งค้างเป็น "กำลังทำ" และนับเป็น 1 ครั้ง
- ไม่มีตัวจับเวลาถอยหลังในหน้าทำข้อสอบ
- คำตอบที่พักไว้ใน `localStorage` ค้างอยู่บนเครื่องที่ใช้ร่วมกันจนกว่าจะส่ง
- รูปข้อสอบไม่ถูกลบ (ฉบับเก่าใช้ร่วม) → มีไฟล์กำพร้าได้
- สรุปผลของรุ่นคำนวณใน browser (ดึง attempts ทั้งรุ่น) — ยังไม่มีวิเคราะห์รายข้อ (ค่าความยาก/อำนาจจำแนก) เพราะ client ไม่ได้รับคะแนนรายข้อ
- ช่องวันเวลาใช้ปฏิทินของเบราว์เซอร์ (แสดงปี ค.ศ.) แต่ส่วนอื่นของระบบแสดง พ.ศ.
- ผล unit/integration ไม่สม่ำเสมอ 1 ครั้งหลัง `db reset` ระหว่างขั้น 2 (ไม่ได้บันทึกชื่อ test; รันซ้ำ 10+2 รอบไม่เกิดอีก)
- E2E รันเฉพาะ Chromium

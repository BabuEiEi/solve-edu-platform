# Test Report — Phase 0 & Phase 1

วันที่รัน: 2 พ.ย. 2569 · สภาพแวดล้อม: Linux workspace, Node 22, PostgreSQL 16.15, pgTAP 1.3.3, PostgREST 12.2.12

## สรุป

| ชุดทดสอบ | คำสั่ง | ผล |
|---|---|---|
| Lint | `npm run lint` | ✅ PASS (0 problems) |
| Unit (Vitest, jsdom) | `npm test` | ✅ PASS 37/37 (7 ไฟล์) |
| Build | `npm run build` | ✅ PASS (JS 261 kB / gzip 69 kB, CSS 21 kB) |
| DB migrations + seed (สร้างใหม่จากศูนย์) | `scripts/db-local/reset.sh` | ✅ PASS 7 migrations + seed |
| DB / RLS (pgTAP) | `scripts/db-local/test.sh` | ✅ PASS 103/103 assertions (7 ไฟล์) |
| **Mutation check** (จงใจทำ policy หละหลวม 3 จุด) | ดูด้านล่าง | ✅ ชุดทดสอบจับได้ 8 assertions ล้มเหลวตามคาด |
| Integration: service layer → PostgREST → RLS | `POSTGREST_BIN=… scripts/db-local/test-rest.sh` | ✅ PASS 9/9 |
| `npx supabase db reset --local` / `supabase test db` | — | ⏭️ SKIP — ดึง Docker image ของ Supabase ไม่ได้ (registry ถูกนโยบายเครือข่ายของ workspace บล็อก) |
| E2E (เบราว์เซอร์ + Supabase Auth จริง) | — | ⏭️ SKIP — ต้องมี Supabase Local; กำหนดไว้ Phase 2 (Playwright) |
| Google OAuth | — | ⏭️ SKIP — ต้องมี Client ID/Secret จริง (`config.toml` ตั้งเป็น `env()` และปิดไว้) |

## รายละเอียด pgTAP

| ไฟล์ | Assertions | ครอบคลุม |
|---|---|---|
| `000_test_helpers.sql` | 2 | ติดตั้ง helper `tests.authenticate_as()` ตรวจว่ามี seed |
| `010_schema_security.sql` | 13 | RLS ทุกตาราง · anon ไม่มี grant · `private`/`authz` ปิด · `contact_email`/`status` ไม่ให้ client · definer ทุกตัวตรึง `search_path` · trigger ไม่เชื่อ metadata role |
| `020_profiles_identity.sql` | 24 | anon deny · trainee isolation · ยกระดับสิทธิ์ตนเอง 5 แบบ · workflow อนุมัติตาม `requested_org_id` · audit |
| `030_organizations_memberships.sql` | 17 | scope โรงเรียน/เขต · ลำดับการมอบบทบาท · ถอนสิทธิ์แล้วเข้าไม่ได้ · ended_at ทางเดียว · กันวงวนหน่วยงาน · platform role ห้ามมอบตนเอง |
| `040_programs_cohorts.sql` | 16 | ขอบเขตโครงการ/รุ่น · mentor เห็นเฉพาะครูที่ดูแล · coordinator ตั้ง coordinator ไม่ได้ · invariant mentor |
| `050_courses_content.sql` | 16 | draft ถูกซ่อน · trainer แก้ได้เฉพาะที่ได้รับมอบหมาย · FK แม่แก้ไม่ได้ · ตรวจ `content_json` |
| `060_enrollment_progress.sql` | 15 | เห็นเฉพาะของตน · server ประทับเวลา · ปลอม completed_at ไม่ได้ · enrollment invariant |

## Mutation check

แก้ migration ในสำเนาชั่วคราว 3 จุด: (1) `profiles_select using (true)` (2) `course_enrollments_insert with check (true)` (3) ตัดเงื่อนไข published ใน `can_view_lesson` → ผล: 020 ล้ม 2, 030 ล้ม 2, 040 ล้ม 1, 050 ล้ม 2, 060 ล้ม 1 — ยืนยันว่าชุดทดสอบตรวจจับการรั่วของสิทธิ์ได้จริง ไม่ใช่ผ่านเพราะทดสอบหลวม

## วิธีที่ทดสอบโดยไม่มี Docker

`scripts/db-local/supabase_shim.sql` จำลองส่วนที่ Migration พึ่งพา: roles `anon`/`authenticated`/`service_role`, `auth.users`/`auth.identities`, `auth.uid()`/`auth.role()`/`auth.jwt()` (นิยามเดียวกับ Supabase) และ **default privileges แบบเปิดกว้างของ Supabase** — เพื่อพิสูจน์ว่า Migration ปิดสิทธิ์ได้เองจริง
ข้อจำกัด: ไม่ได้ทดสอบกับ GoTrue, Storage, Realtime และ Postgres 17 ของ Supabase → **ต้องรันซ้ำบนเครื่องผู้พัฒนา**:

```bash
npx supabase start
npx supabase db reset --local
npx supabase test db
```

## สิ่งที่ยังไม่ได้ทำ (นอกขอบเขต Phase 1)

- Storage buckets + policies (avatar, media, submissions)
- Assessment engine, server-side scoring, attempt limit แบบ atomic (Phase 2)
- Course Builder UI, lesson player, editor (Phase 2)
- E2E แบบหลายบทบาท (Playwright) และ CI pipeline (secret scanning, dependency audit)
- `npm audit`: production dependencies 0 vulnerabilities; dev dependencies มี moderate 1 รายการ (`minimatch` ผ่าน toolchain) — ไม่ถูก bundle ไปยังเบราว์เซอร์

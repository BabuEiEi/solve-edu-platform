# Edge Functions

> งานที่ฐานข้อมูลทำเองไม่ได้ (ลบไฟล์ใน Storage, เรียกบริการภายนอก) ทำใน Supabase Edge Functions (Deno)
> โค้ดอยู่ที่ `supabase/functions/` เป็น JavaScript ธรรมดา (ผ่าน ESLint/Prettier ชุดเดียวกับหน้าเว็บ)

## หลักการ

- **กุญแจฝั่ง server (service role) อยู่ใน function เท่านั้น** ไม่ส่งไปเบราว์เซอร์ ไม่อยู่ใน git
- **ฐานข้อมูลเป็นผู้ตัดสินว่าอะไรทำได้** — function เรียก RPC ที่ล็อกแถว ตรวจเงื่อนไข และบันทึก audit ในคำสั่งเดียว function แค่ลงมือส่วนที่ SQL ทำไม่ได้
- **ล้มเหลวแบบปิด** — secret ไม่ได้ตั้งหรือสั้นเกินไป = ปฏิเสธทุกคำขอ (500 `not_configured`) ไม่ใช่เปิดให้ทุกคน
- **ข้อผิดพลาดไม่รั่ว** — ผู้เรียกได้แค่ `{ "error": "<code>" }` รายละเอียด (SQL, stack) อยู่ใน log ของ function เท่านั้น

## โครงร่วม (`supabase/functions/_shared/`)

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `http.js` | `handle(fn, {cors})` ห่อ handler: `HttpError(status, code)` → `{error: code}` · อื่น ๆ → 500 `internal` · ตอบ JSON แบบ `no-store` · CORS เฉพาะ origin ที่อยู่ในรายการ · `readJson` · `unwrap` |
| `auth.js` | `requireCronSecret(req, secret)` (งานตั้งเวลา: header `x-cron-secret`, เทียบแบบเวลาคงที่, ≥ 32 ตัวอักษร) · `requireUser(req, makeClient)` (ผู้ใช้ที่ล็อกอิน: token ถูกตรวจกับ Supabase Auth จริง ไม่ใช่แค่ถอดรหัส แล้วได้ client ที่ทำงานในนามผู้เรียก — RLS ใช้กับเขา) · `requireEnv` |

ไฟล์เหล่านี้ไม่ใช้ `Deno` จึงทดสอบด้วย Vitest ได้ (`tests/unit/edge-shared.test.js`) — มีแค่ `index.js` ของแต่ละ function ที่ใช้ `Deno.serve` / `Deno.env`

## `cleanup-task-files` — ล้างไฟล์ค้าง (คืนละครั้ง)

| | |
|---|---|
| เรียกโดย | ตัวตั้งเวลา (pg_cron + pg_net) · `POST` · header `x-cron-secret: <CRON_SECRET>` |
| `POST {}` | ลบ (1) ไฟล์ใน `task-files` ที่ไม่มีแถวในงานส่งและเก่ากว่า 24 ชม. (2) ไฟล์ของ **ร่าง** ที่ไม่มีใครแตะเกิน 30 วัน (ข้อความ ลิงก์ และไฟล์) → `{stale_draft_files_removed, orphans_removed, orphans_logged, failed[]}` |
| `POST {"dry_run": true}` | แสดงรายการที่จะลบ ไม่ลบอะไร → `{orphans[], stale_draft_files[]}` |
| ไม่แตะ | งานที่ส่งแล้ว (ไม่ว่าเก่าแค่ไหน) · ไฟล์ที่เพิ่งอัปโหลด (< 24 ชม., แถวอาจกำลังจะตามมา) · ร่างที่มีไฟล์ใหม่ภายใน 30 วัน · bucket อื่น |
| บันทึก | `private.audit_logs` ทุกไฟล์ที่ลบ (`reason` ขึ้นต้น `cleanup:`; ร่าง: แถวไฟล์เดิมทั้งแถว · ไฟล์ค้าง: เฉพาะที่หายจาก storage จริง) |
| ล้มเหลวกลางทาง | ร่าง: ลบแถวก่อน แล้วลบไฟล์ — ไฟล์ที่ลบไม่สำเร็จกลายเป็น "ไฟล์ค้าง" และถูกลบคืนถัดไป · ข้อผิดพลาดของฐานข้อมูลหยุดก่อนลบไฟล์ใด ๆ |
| ร่างเองยังอยู่ | ข้อความและลิงก์ของร่างไม่ถูกลบ ผู้เรียนกลับมาทำต่อได้ (แค่ต้องแนบไฟล์ใหม่) |

ฐานข้อมูล (migration `20261105090700_task_files_cleanup.sql`): `task_files_cleanup_orphans` · `task_files_cleanup_stale_drafts` · `task_files_cleanup_record` — SECURITY INVOKER, **เรียกได้เฉพาะ `service_role`** (anon/ผู้ใช้ที่ล็อกอิน แม้ผู้ดูแลระบบ = 42501) · ขั้นต่ำที่ฐานข้อมูลบังคับ: อายุไฟล์ค้าง ≥ 1 ชม., ร่างนิ่ง ≥ 7 วัน, ครั้งละ ≤ 1000 · `service_role` ได้สิทธิ์ **เพิ่ม** แถวใน audit log เท่านั้น (อ่าน/แก้/ลบไม่ได้)

`verify_jwt = false` ใน `supabase/config.toml` เพราะผู้เรียกคือตัวตั้งเวลา ไม่ใช่ผู้ใช้ — function ตรวจ `x-cron-secret` เองทุกครั้ง

## ทดสอบในเครื่อง

```bash
npm run test:functions   # รีเซ็ตฐานข้อมูล → serve functions ด้วย CRON_SECRET สุ่มครั้งเดียว (ไฟล์ชั่วคราว 600, ลบเมื่อจบ) → tests/functions → รีเซ็ต
```

ลองเรียกเอง: `npx supabase functions serve --env-file <ไฟล์ที่มี CRON_SECRET=…>` แล้ว
`curl -X POST http://127.0.0.1:54321/functions/v1/cleanup-task-files -H "x-cron-secret: …" -d '{"dry_run":true}'`
ไฟล์ env ของเครื่องตัวเองตั้งชื่อ `supabase/functions/.env` ได้ (ถูก `.gitignore` แล้ว) — ห้าม commit

## ติดตั้งบนโปรเจกต์จริง — เจ้าของระบบเป็นผู้ทำ / อนุมัติทุกข้อ

> ทุกคำสั่งในส่วนนี้แตะโปรเจกต์จริง agent ไม่รันเอง

1. **สร้าง secret**: `openssl rand -hex 32` (เก็บในที่ปลอดภัย ไม่ส่งในแชท/อีเมล)
2. **ตั้ง secret ให้ function**: Dashboard → Edge Functions → Secrets → `CRON_SECRET` (หรือ `npx supabase secrets set CRON_SECRET=… --project-ref <ref>`) · ตรวจว่ามี `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY` (Supabase ใส่ให้เอง)
3. **deploy**: `npx supabase functions deploy cleanup-task-files --project-ref <ref>` (อ่าน `verify_jwt = false` จาก `config.toml`)
4. **ลองแบบไม่ลบก่อน**: `curl -X POST https://<ref>.supabase.co/functions/v1/cleanup-task-files -H "x-cron-secret: …" -d '{"dry_run":true}'` ตรวจรายการว่าสมเหตุสมผล
5. **ตั้งเวลา** (SQL Editor; เปิด extension `pg_net` ก่อนที่ Database → Extensions) — 02:30 น. เวลาไทย = 19:30 UTC:

```sql
select vault.create_secret('<CRON_SECRET>', 'cleanup_task_files_secret');
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select cron.schedule('cleanup-task-files-nightly', '30 19 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/cleanup-task-files',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cleanup_task_files_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$$);
```

6. **ตรวจหลังคืนแรก**: Edge Functions → Logs (บรรทัด `{"fn":"cleanup-task-files", …}`) · `select * from cron.job_run_details order by start_time desc limit 5;` · `select occurred_at, table_name, before_json, reason from private.audit_logs where reason like 'cleanup:%' order by occurred_at desc limit 20;`

เปลี่ยน secret: ตั้งค่าใหม่ทั้งที่ Edge Functions → Secrets และใน Vault (`vault.update_secret`) พร้อมกัน · หยุดชั่วคราว: `select cron.unschedule('cleanup-task-files-nightly');`

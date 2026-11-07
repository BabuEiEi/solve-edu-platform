# ติดตั้ง Phase 3b บนโปรเจกต์จริง — รายการสำหรับเจ้าของระบบ

> ทุกข้อในเอกสารนี้แตะโปรเจกต์ Supabase จริงหรือบัญชี Google ขององค์กร — **agent ไม่ทำเอง** เจ้าของระบบเป็นผู้ทำหรืออนุมัติทีละข้อ
> รายละเอียดของแต่ละ function: `docs/EDGE_FUNCTIONS.md`
> สถานะการติดตั้งทั้งระบบ (Supabase/Vercel, Auth URL, ผู้ดูแลคนแรก): `docs/DEPLOY.md` — ข้อ 2 (db push) และการติดตั้ง function ทำแล้วเมื่อ 2569-11-08

## สิ่งที่ Phase 3b เพิ่ม

| ส่วน | ต้องติดตั้งอะไร | ใช้ได้ทันทีหลัง db push + deploy หน้าเว็บ? |
|---|---|---|
| บันทึกร่างอัตโนมัติ (ขั้น 1) | หน้าเว็บเท่านั้น | ✅ |
| ป้ายแจ้งเตือนในเมนู (ขั้น 2) | migration `20261105090600` | ✅ |
| ล้างไฟล์ค้างทุกคืน (ขั้น 3) | migration `20261105090700` + function `cleanup-task-files` + `CRON_SECRET` + ตัวตั้งเวลา | ❌ ต้องทำข้อ 3 |
| ส่งสำเนาไป Google Drive (ขั้น 4–5) | migration `20261105090800` + function `drive-export-task` + Google + secrets | ❌ ต้องทำข้อ 4–5 (ก่อนนั้นปุ่มตอบ "ยังไม่ได้ตั้งค่า Google Drive") |

ทุก migration เป็นการ **เพิ่ม** (ตาราง ฟังก์ชัน สิทธิ์) ไม่แก้หรือลบข้อมูลเดิม

## 1. ก่อนเริ่ม

- [ ] สำรองฐานข้อมูล (Dashboard → Database → Backups) หรือยืนยันว่ามี backup ล่าสุด
- [ ] merge `phase-3b` เข้า `main` แล้ว และ `npm run check` / `npx supabase test db` ผ่านบนเครื่อง
- [ ] **PDPA**: ยืนยันว่าส่งชื่อผู้เรียนและไฟล์งานไปไว้ใน Google Drive ขององค์กรได้ และกำหนดว่าใครเข้าถึง Shared Drive ได้ (ถ้ายังไม่ยืนยัน ข้ามข้อ 4–5 ไปก่อน ส่วนอื่นใช้ได้ตามปกติ)

## 2. ฐานข้อมูลและหน้าเว็บ — ต้องอนุมัติ

- [ ] `npx supabase db push` (ใช้ migration `20261105090600`–`20261105090800`) — ตรวจรายการ migration ที่จะลงก่อนยืนยัน
- [ ] deploy หน้าเว็บตามปกติ
- [ ] ตรวจ: ผู้เรียนเห็นป้ายที่ "ภาระงาน" เมื่อมีผลตรวจใหม่ · ผู้ตรวจเห็นตัวเลขที่ "ตรวจงาน"

## 3. ล้างไฟล์ค้างทุกคืน — ต้องอนุมัติ

- [ ] สร้าง secret: `openssl rand -hex 32` (เก็บในที่ปลอดภัย)
- [ ] Edge Functions → Secrets: `CRON_SECRET`
- [ ] `npx supabase functions deploy cleanup-task-files --project-ref <ref>`
- [ ] ลองแบบไม่ลบ (`{"dry_run": true}`) ตาม `docs/EDGE_FUNCTIONS.md` แล้วตรวจรายการ
- [ ] เปิด extension `pg_net` แล้วตั้งเวลา (SQL ใน `docs/EDGE_FUNCTIONS.md`: Vault 2 ค่า + `cron.schedule` 02:30 น.)
- [ ] เช้าวันถัดไป: `cron.job_run_details` สำเร็จ · log ของ function มีบรรทัด `{"fn":"cleanup-task-files", …}`

## 4. เตรียม Google — เจ้าของระบบ / ผู้ดูแล Google Workspace

- [ ] Google Cloud: โปรเจกต์ขององค์กร → เปิด Google Drive API
- [ ] สร้าง service account → สร้าง key แบบ JSON (ห้าม commit ห้ามส่งในแชท)
- [ ] สร้าง Shared Drive → เพิ่ม service account เป็น **Content manager**
- [ ] คัด id ของโฟลเดอร์กลาง และ id ของ Shared Drive

## 5. ส่งสำเนาไป Google Drive — ต้องอนุมัติ

- [ ] Edge Functions → Secrets: `GOOGLE_SERVICE_ACCOUNT_JSON` · `GOOGLE_DRIVE_FOLDER_ID` · `GOOGLE_SHARED_DRIVE_ID` · `ALLOWED_ORIGINS` (= origin ของเว็บจริง เช่น `https://<โดเมน>`; ไม่ตั้ง = เบราว์เซอร์เรียกไม่ได้)
- [ ] **ห้ามตั้ง** `GOOGLE_TOKEN_URL` / `GOOGLE_DRIVE_API` / `GOOGLE_DRIVE_UPLOAD` (ใช้ใน test เท่านั้น)
- [ ] `npx supabase functions deploy drive-export-task --project-ref <ref>`
- [ ] ทดลองกับภาระงานที่มีงานส่งไม่กี่ชิ้น: กดปุ่ม → เปิดลิงก์โฟลเดอร์ ตรวจโครง หลักสูตร / รุ่น / ภาระงาน / ผู้เรียน / รอบที่ → กดซ้ำ ต้องได้ "มีใน Drive อยู่แล้ว"
- [ ] ถ้าประวัติแสดง "Google Drive ไม่อนุญาต" → ตรวจสมาชิกของ Shared Drive · "เข้าสู่ระบบ Google ไม่สำเร็จ" → ตรวจ JSON ของ key · "ไม่พบโฟลเดอร์" → ตรวจ `GOOGLE_DRIVE_FOLDER_ID`

## ปิด / ย้อนกลับ

| ต้องการ | ทำ |
|---|---|
| หยุดล้างไฟล์ | `select cron.unschedule('cleanup-task-files-nightly');` |
| หยุดส่งสำเนาไป Drive | ลบ secret `GOOGLE_SERVICE_ACCOUNT_JSON` (ปุ่มตอบ "ยังไม่ได้ตั้งค่า") หรือ disable key ที่ Google Cloud |
| key รั่ว | Google Cloud → ลบ key ทันที → สร้างใหม่ → ตั้ง secret ใหม่ |
| `CRON_SECRET` รั่ว | ตั้งค่าใหม่ทั้งใน Secrets และ Vault (`vault.update_secret`) |
| ย้อนหน้าเว็บ | deploy เวอร์ชันก่อนหน้าได้เลย — ตาราง/ฟังก์ชันใหม่ไม่กระทบหน้าเดิม |

## ตรวจย้อนหลัง

```sql
-- ไฟล์ที่ระบบล้าง
select occurred_at, table_name, before_json ->> 'object_path' as file, before_json ->> 'name' as object, reason
  from private.audit_logs where reason like 'cleanup:%' order by occurred_at desc limit 50;
-- การส่งสำเนาไป Drive
select started_at, status, files_copied, files_skipped, files_failed, error, requested_by
  from public.task_drive_exports order by started_at desc limit 50;
```

# การติดตั้งระบบ (Supabase + Vercel)

> ทุกคำสั่งที่แตะบริการจริงต้องได้รับอนุมัติจากเจ้าของระบบ · ห้ามใช้โปรเจกต์ Supabase ของระบบเดิม (`ioeqyonmpjbesrzyrhgw` "SolveEdu LMS Database")
> ขั้นเฉพาะของ Phase 3b (ล้างไฟล์ทุกคืน, Google Drive): `docs/DEPLOY_PHASE3B.md`

## สถานะ (2569-11-08)

| ส่วน | ที่อยู่ | สถานะ |
|---|---|---|
| ฐานข้อมูล / Auth / Storage | Supabase `solve-edu-platform` · ref `hcudarobowuwsmmyoyrd` · Singapore (ap-southeast-1) | ✅ migration 34 ไฟล์ (ถึง `20261105090800`) ไม่มีข้อมูลสาธิต · ตรวจ RLS/สิทธิ์แล้ว |
| Edge Functions | `cleanup-task-files`, `drive-export-task` (v1) | ✅ ติดตั้งแล้ว · ⏸ ยังไม่มี secret จึงปฏิเสธทุกคำขอ (`not_configured`) |
| หน้าเว็บ | Vercel โปรเจกต์ `solve-edu-platform` (ทีม `babueieis-projects`) | ✅ **production** https://solve-edu-platform.vercel.app (2569-11-08) · preview ต้องล็อกอิน Vercel · ตรวจแล้ว: ชี้ `hcudarobowuwsmmyoyrd`, header ครบ, ไฟล์ภายในเป็น 404 |
| Auth URL | Site URL + Redirect URLs (production และ preview) | ✅ ตั้งแล้ว (เจ้าของระบบ) |
| ผู้ดูแลระบบคนแรก | ด้วย SQL ด้านล่าง | ✅ 1 คน |
| หน่วยงาน | สพม.พิษณุโลก อุตรดิตถ์ + โรงเรียน 57 แห่ง (รหัส 10 หลักทางการ) | ✅ (รหัสเขตเป็นรหัสชั่วคราว — ปรับเป็นรหัสทางการเมื่อขยายระดับ สพฐ.) |
| Google login | Google Cloud โปรเจกต์ "SolveEdu" (บัญชีส่วนตัวของเจ้าของระบบ, External) | ✅ เปิดใช้แล้ว · ⏸ ต้องกด Publish app (ใส่ลิงก์หน้าแรกและนโยบายใน Branding แล้ว) จึงใช้ได้ทุกคน |
| นโยบายความเป็นส่วนตัว | https://solve-edu-platform.vercel.app/privacy.html | ✅ ลิงก์จากหน้าเข้าสู่ระบบ |
| SMTP | Gmail + App Password ของเจ้าของระบบ · จำกัด 100 ฉบับ/ชม. | ✅ ทดสอบแล้ว (2569-11-08) อีเมลยืนยันถึงกล่องจดหมาย |
| ผู้ดูแลเขต, ล้างไฟล์ทุกคืน, Google Drive | — | ⏸ เจ้าของระบบ (ดูด้านล่างและ `docs/DEPLOY_PHASE3B.md`) |

## หน้าเว็บบน Vercel

- `vercel.json` — build ด้วย Vite (`npm ci` → `npm run build` → `dist`) · header ความปลอดภัยที่ meta tag ทำไม่ได้ (`frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) · ไฟล์ใน `/assets/` cache ได้ 1 ปี (ชื่อไฟล์มี hash)
- `.vercelignore` — อัปโหลด **เฉพาะ** `src/`, `index.html`, `package*.json`, `vite.config.js`, `vercel.json` (ไม่มี `.env*`, `supabase/`, test, เอกสาร)
- ค่าที่ใช้ตอน build (ค่าสาธารณะ ฝังในหน้าเว็บ): `VITE_SUPABASE_URL` = `https://hcudarobowuwsmmyoyrd.supabase.co` · `VITE_SUPABASE_PUBLISHABLE_KEY` = publishable key (`sb_publishable_…`) — **ห้ามใส่ secret/service key** (หน้าเว็บจะ throw ทันทีถ้าเจอ)
- ตั้งค่าแล้วทั้ง **Preview** และ **Production**

ข้อควรระวังที่เจอจริง:
- โปรเจกต์ที่ยังไม่ผูก git: `vercel deploy` ครั้งแรกขึ้น **production** เอง แม้ไม่ใส่ `--prod` → ใส่ `--target=preview` ทุกครั้งที่ต้องการ preview
- `vercel env add … preview` (CLI 51.8) วนถามเรื่อง branch ไม่จบ → ตั้งผ่าน `vercel api /v10/projects/<id>/env?teamId=<team>&upsert=true --method POST --input <file.json>`
- เปิด preview ที่ล็อกไว้จากเครื่อง: `vercel curl / --deployment <url> --yes`

### ขึ้น production — ต้องอนุมัติ

1. ตั้ง `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` ให้ target `production` (วิธีเดียวกับ preview)
2. `vercel deploy --prod --yes` แล้วตรวจ: หน้าโหลดได้ · header ครบ · `/.env.local`, `/supabase/config.toml` เป็น 404 · bundle ชี้ `hcudarobowuwsmmyoyrd`
3. ถ้าจะใช้โดเมนขององค์กร: Vercel → Domains แล้วเพิ่มโดเมนนั้นในข้อ "Auth URL" ด้านล่างและใน `ALLOWED_ORIGINS`

## ตั้งค่า Auth ของ Supabase — เจ้าของระบบ (Dashboard)

Authentication → URL Configuration:
- **Site URL**: `https://solve-edu-platform.vercel.app` (หรือโดเมนขององค์กร)
- **Redirect URLs**: `https://solve-edu-platform.vercel.app/**` และ `https://solve-edu-platform-*-babueieis-projects.vercel.app/**` (preview)

Authentication → Emails / SMTP: บริการอีเมลในตัวของ Supabase ส่งได้ไม่กี่ฉบับต่อชั่วโมง (พอสำหรับทดลอง) — ก่อนเปิดใช้จริงตั้ง SMTP ขององค์กร
Google login (ถ้าใช้): Authentication → Providers → Google ใส่ client ID/secret ของ Google OAuth (คนละชุดกับ service account ของ Drive) และเพิ่ม callback ของ Supabase ใน Google Cloud

## ผู้ดูแลระบบคนแรก — เจ้าของระบบรันเอง (SQL Editor)

ผู้สมัครใหม่ทุกคนเป็น `pending` จนผู้ดูแลอนุมัติ ผู้ดูแลคนแรกจึงต้องตั้งด้วย SQL ครั้งเดียว:
1. สมัครผ่านหน้าเว็บด้วยอีเมลจริงของผู้ดูแล แล้วยืนยันอีเมล
2. SQL Editor (โปรเจกต์ `hcudarobowuwsmmyoyrd`) — เปลี่ยน `<อีเมล>` แล้วรันทั้งก้อน:

```sql
begin;
do $$
declare
  v_email text := '<อีเมล>';
  v_id uuid;
begin
  select id into strict v_id from auth.users where lower(email) = lower(v_email);  -- ต้องเจอคนเดียวพอดี
  update public.profiles set status = 'active' where id = v_id;
  insert into public.platform_role_assignments (user_id, role, granted_by)
  values (v_id, 'platform_admin', null)
  on conflict do nothing;
end $$;
select p.full_name, p.status, r.role
  from public.profiles p join public.platform_role_assignments r on r.user_id = p.id and r.revoked_at is null
 where p.id = (select id from auth.users where lower(email) = lower('<อีเมล>'));
commit;
```

ผลที่ถูก: แถวเดียว `active | platform_admin` · การให้บทบาทถูกบันทึกใน `private.audit_logs` โดยอัตโนมัติ · ผู้ดูแลคนต่อไปให้คนแรกตั้งผ่านหน้าเว็บ ไม่ต้องใช้ SQL อีก

## ขึ้น Phase 4a บนระบบจริง — ต้องอนุมัติทีละข้อ

| ลำดับ | ทำอะไร | หมายเหตุ |
|---|---|---|
| 1 | `npx supabase db push --dry-run` แล้ว `db push` | migration `20261108090000`–`20261108090300` (รหัสประจำตัว · ลบที่ยังไม่ใช้ · ลบบัญชี · รายชื่อบัญชี) เพิ่มอย่างเดียว ไม่แก้ข้อมูลเดิม |
| 2 | `npx supabase functions deploy delete-account --project-ref hcudarobowuwsmmyoyrd` | function ใหม่ · ต้องมี secret `ALLOWED_ORIGINS` = `https://solve-edu-platform.vercel.app` (ไม่ใช่ความลับ ตั้งได้เมื่ออนุมัติ) |
| 3 | `npx supabase functions deploy cleanup-task-files --project-ref hcudarobowuwsmmyoyrd` | รุ่นใหม่ลบรูปของบทเรียน/แบบทดสอบที่ถูกลบด้วย (ยังต้องมี `CRON_SECRET` + ตัวตั้งเวลา จึงจะทำงานทุกคืน) |
| 4 | `vercel deploy --prod` | หน้า "จัดการบัญชี" ปุ่มลบ/เก็บถาวร และนโยบายความเป็นส่วนตัวฉบับปรับปรุง |
| 5 | ตรวจ | security advisor · หน้า "จัดการบัญชี" ในฐานะผู้ดูแลระบบ · ลบหลักสูตรทดลองที่ไม่มีผู้ใช้ 1 รายการ |

## ขึ้น Phase 4b บนระบบจริง (Excel) — ต้องอนุมัติ

Phase 4b ไม่มี migration ไม่มี Edge Function และไม่มี secret ใหม่ — เปลี่ยนเฉพาะหน้าเว็บ (เพิ่ม dependency `fflate` ในตัวหน้าเว็บ)

| ลำดับ | ทำอะไร | หมายเหตุ |
|---|---|---|
| 1 | `vercel deploy --prod` | หน้าเว็บรุ่นที่มีปุ่ม Excel และนำเข้า Excel |
| 2 | ตรวจ | เปิดหน้าผลสอบ → ดาวน์โหลด (Excel) แล้วเปิดในโปรแกรม Excel · หน้านำเข้ารายชื่อ → ดาวน์โหลดไฟล์ตัวอย่าง Excel แล้วเลือกไฟล์นั้นกลับ ควรได้ "ถูกต้อง 2" |

ย้อนกลับ: ใน Vercel เลือก deployment ก่อนหน้าแล้ว Promote (ไม่มีข้อมูลในฐานข้อมูลที่ต้องย้อน)


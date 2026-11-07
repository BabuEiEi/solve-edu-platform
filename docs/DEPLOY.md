# การติดตั้งระบบ (Supabase + Vercel)

> ทุกคำสั่งที่แตะบริการจริงต้องได้รับอนุมัติจากเจ้าของระบบ · ห้ามใช้โปรเจกต์ Supabase ของระบบเดิม (`ioeqyonmpjbesrzyrhgw` "SolveEdu LMS Database")
> ขั้นเฉพาะของ Phase 3b (ล้างไฟล์ทุกคืน, Google Drive): `docs/DEPLOY_PHASE3B.md`

## สถานะ (2569-11-08)

| ส่วน | ที่อยู่ | สถานะ |
|---|---|---|
| ฐานข้อมูล / Auth / Storage | Supabase `solve-edu-platform` · ref `hcudarobowuwsmmyoyrd` · Singapore (ap-southeast-1) | ✅ migration 34 ไฟล์ (ถึง `20261105090800`) ไม่มีข้อมูลสาธิต · ตรวจ RLS/สิทธิ์แล้ว |
| Edge Functions | `cleanup-task-files`, `drive-export-task` (v1) | ✅ ติดตั้งแล้ว · ⏸ ยังไม่มี secret จึงปฏิเสธทุกคำขอ (`not_configured`) |
| หน้าเว็บ | Vercel โปรเจกต์ `solve-edu-platform` (ทีม `babueieis-projects`) | ✅ preview (ต้องล็อกอิน Vercel) · ⏸ production: `solve-edu-platform.vercel.app` ยังเป็น build ที่ไม่มีค่า Supabase (หน้า "ยังไม่ได้ตั้งค่า") |
| ตั้งค่า Auth URL, ผู้ดูแลคนแรก, SMTP | — | ⏸ เจ้าของระบบ |

## หน้าเว็บบน Vercel

- `vercel.json` — build ด้วย Vite (`npm ci` → `npm run build` → `dist`) · header ความปลอดภัยที่ meta tag ทำไม่ได้ (`frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) · ไฟล์ใน `/assets/` cache ได้ 1 ปี (ชื่อไฟล์มี hash)
- `.vercelignore` — อัปโหลด **เฉพาะ** `src/`, `index.html`, `package*.json`, `vite.config.js`, `vercel.json` (ไม่มี `.env*`, `supabase/`, test, เอกสาร)
- ค่าที่ใช้ตอน build (ค่าสาธารณะ ฝังในหน้าเว็บ): `VITE_SUPABASE_URL` = `https://hcudarobowuwsmmyoyrd.supabase.co` · `VITE_SUPABASE_PUBLISHABLE_KEY` = publishable key (`sb_publishable_…`) — **ห้ามใส่ secret/service key** (หน้าเว็บจะ throw ทันทีถ้าเจอ)
- ตั้งค่าแล้วสำหรับ **Preview** เท่านั้น · Production ต้องตั้งก่อน deploy production

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

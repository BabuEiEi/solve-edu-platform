-- =====================================================================
-- SolveEdu Platform — Migration 07: Catalog comments (feeds DATA_DICTIONARY.md)
-- =====================================================================
comment on schema authz   is 'RLS helper functions (SECURITY DEFINER, boolean answers about the caller only). Not exposed via Data API.';
comment on schema private is 'Sensitive data (audit logs; later answer keys). No grants to anon/authenticated. Never expose.';

comment on table public.profiles is 'บัญชีบุคคล 1:1 กับ auth.users — ไม่มีรหัสผ่าน ไม่มีบทบาท (บทบาทอยู่ในตาราง membership)';
comment on column public.profiles.status is 'pending|active|suspended — เปลี่ยนได้ผ่าน admin_set_profile_status() เท่านั้น';
comment on column public.profiles.contact_email is 'อีเมลติดต่อ — ไม่ GRANT SELECT ให้ client; อ่านผ่าน get_profile_contact()';
comment on column public.profiles.requested_org_id is 'สถานศึกษาที่ผู้สมัครขอสังกัด ใช้กำหนดผู้มีสิทธิ์อนุมัติ; แก้ได้เฉพาะช่วง pending';
comment on column public.profiles.avatar_path is 'Storage object path (private bucket) — ไม่ใช่ public URL';

comment on table public.organizations is 'หน่วยงานแบบลำดับชั้น (เขตพื้นที่ → โรงเรียน); trigger ป้องกันวงวน';
comment on table public.organization_memberships is 'บทบาทของบุคคลในหน่วยงาน; active = ended_at IS NULL; ถอนสิทธิ์ = ตั้ง ended_at (ทางเดียว)';
comment on column public.organization_memberships.org_role is 'district_admin|supervisor|school_admin|teacher — สิทธิ์ครอบคลุมหน่วยงานลูกทั้งหมด';
comment on table public.platform_role_assignments is 'บทบาทระดับระบบ (platform_admin/support) แยกจากผู้ดูแลเขตพื้นที่; ห้ามมอบให้ตนเอง';

comment on table public.programs is 'โครงการพัฒนาครู (fiscal_year = ปีงบประมาณ พ.ศ.)';
comment on table public.cohorts is 'รุ่น/กลุ่มผู้เข้าร่วมภายใต้โครงการ';
comment on table public.cohort_memberships is 'บทบาทในรุ่น trainee|trainer|mentor|coordinator — หนึ่งคนมีหลายบทบาทได้';
comment on table public.mentor_assignments is 'การจับคู่พี่เลี้ยง–ครู ภายในรุ่นเดียวกัน (trigger ตรวจบทบาท)';

comment on table public.courses is 'หลักสูตร/รายวิชา — ใช้ซ้ำได้หลายโครงการผ่าน program_courses';
comment on table public.program_courses is 'ตารางเชื่อม M:N โครงการ–หลักสูตร';
comment on table public.course_units is 'หน่วยการเรียนรู้ในหลักสูตร';
comment on table public.lessons is 'บทเรียนย่อยในหน่วย';
comment on table public.lesson_blocks is 'บล็อกเนื้อหาของบทเรียน; content_json ตรวจรูปแบบตาม block_type ด้วย CHECK';
comment on table public.course_enrollments is 'การลงทะเบียนหลักสูตรภายใต้บริบทรุ่น (cohort) เสมอ';
comment on table public.lesson_progress is 'ความก้าวหน้ารายบทเรียน; started_at/completed_at ประทับเวลาโดยเซิร์ฟเวอร์';

comment on function public.admin_set_profile_status(uuid, text, text) is 'อนุมัติ/ระงับผู้ใช้ตามขอบเขตสิทธิ์ พร้อมบันทึก audit (SECURITY DEFINER)';
comment on function public.get_profile_contact(uuid) is 'คืนอีเมลติดต่อของตนเองหรือผู้ที่ตนมีสิทธิ์ดูแล';

-- =====================================================================
-- Phase 2B.1 / step 4 — clean up unused quiz images, safely
--
-- Authors may now delete images nobody uses (the quiz editor's "ล้างรูปที่
-- ไม่ได้ใช้"). The database refuses to delete or overwrite an image that any
-- item of any version still references — published versions included — so
-- a buggy or hostile client cannot break a test that has been taken.
-- =====================================================================

create or replace function authz.assessment_media_in_use(p_name text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.instrument_items i
     where i.instrument_version_id in (
             select v.id from public.instrument_versions v where v.instrument_id = authz.object_owner_id(p_name))
       and (i.media_path = p_name
            or exists (select 1
                         from jsonb_array_elements(coalesce(i.options_json -> 'options', '[]'::jsonb)) o
                        where o ->> 'image_path' = p_name))
  );
$$;

revoke execute on function authz.assessment_media_in_use(text) from public, anon;
grant execute on function authz.assessment_media_in_use(text) to authenticated, service_role;

drop policy assessment_media_update on storage.objects;
create policy assessment_media_update on storage.objects
  for update to authenticated
  using (bucket_id = 'assessment-media' and authz.can_manage_instrument(authz.object_owner_id(name))
         and not authz.assessment_media_in_use(name))
  with check (bucket_id = 'assessment-media' and authz.can_manage_instrument(authz.object_owner_id(name))
              and not authz.assessment_media_in_use(name));

drop policy assessment_media_delete on storage.objects;
create policy assessment_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'assessment-media' and authz.can_manage_instrument(authz.object_owner_id(name))
         and not authz.assessment_media_in_use(name));

comment on function authz.assessment_media_in_use(text) is 'รูปนี้ยังถูกข้อใดของแบบทดสอบนั้นอ้างถึงอยู่ไหม (ทุกฉบับ รวมที่เผยแพร่แล้ว) — ห้ามลบ/เขียนทับ';

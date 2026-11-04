-- =====================================================================
-- SolveEdu Platform — Migration 15: assessment-media bucket
--
--   assessment-media/<instrument_id>/<random>.<ext>
--     view  = authz.can_manage_instrument or authz.can_view_instrument
--             (authors, staff of an assigned cohort, a trainee only after starting an attempt)
--     write = authz.can_manage_instrument
--
-- Images only, small. Versions of one instrument share its folder, so a
-- clone keeps working images; files are never deleted by the quiz builder
-- (a published version may still reference them).
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('assessment-media', 'assessment-media', false, 5242880,
   array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy assessment_media_select on storage.objects
  for select to authenticated
  using (bucket_id = 'assessment-media'
         and (authz.can_manage_instrument(authz.object_owner_id(name))
              -- can_view_instrument goes through versions; authors need access before the first one
              or authz.can_view_instrument(authz.object_owner_id(name))));

create policy assessment_media_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'assessment-media' and authz.can_manage_instrument(authz.object_owner_id(name)));

create policy assessment_media_update on storage.objects
  for update to authenticated
  using (bucket_id = 'assessment-media' and authz.can_manage_instrument(authz.object_owner_id(name)))
  with check (bucket_id = 'assessment-media' and authz.can_manage_instrument(authz.object_owner_id(name)));

create policy assessment_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'assessment-media' and authz.can_manage_instrument(authz.object_owner_id(name)));

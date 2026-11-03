-- =====================================================================
-- SolveEdu Platform — Migration 08: Private Storage buckets + policies
--
-- Buckets are PRIVATE: files are served only through short-lived signed
-- URLs, and the Storage API checks these policies (as the caller's role)
-- before signing. Policies reuse the existing authz helpers so file access
-- can never be wider than access to the owning row.
--
-- Object path layout (first folder = owning resource id):
--   lesson-media/<lesson_id>/<random>.<ext>   view = can_view_lesson,  write = can_manage_lesson
--   avatars/<user_id>/<random>.<ext>          view = can_view_profile, write = owner only
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('lesson-media', 'lesson-media', false, 52428800, array[
     'image/png', 'image/jpeg', 'image/webp', 'image/gif',
     'application/pdf',
     'video/mp4', 'video/webm',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
   ]),
  ('avatars', 'avatars', false, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- Parse a path segment as uuid WITHOUT raising (a malformed path must be
-- denied by the policy, not abort the request with 22P02).
-- ---------------------------------------------------------------------
create or replace function authz.uuid_or_null(p_text text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_text::uuid
  end
$$;

-- Owning resource id = first folder of the object name (null if absent/invalid).
create or replace function authz.object_owner_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select authz.uuid_or_null((storage.foldername(p_name))[1])
$$;

revoke execute on function authz.uuid_or_null(text) from public, anon;
revoke execute on function authz.object_owner_id(text) from public, anon;
grant execute on function authz.uuid_or_null(text) to authenticated, service_role;
grant execute on function authz.object_owner_id(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- lesson-media
-- ---------------------------------------------------------------------
create policy lesson_media_select on storage.objects
  for select to authenticated
  using (bucket_id = 'lesson-media' and authz.can_view_lesson(authz.object_owner_id(name)));

create policy lesson_media_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lesson-media' and authz.can_manage_lesson(authz.object_owner_id(name)));

create policy lesson_media_update on storage.objects
  for update to authenticated
  using (bucket_id = 'lesson-media' and authz.can_manage_lesson(authz.object_owner_id(name)))
  with check (bucket_id = 'lesson-media' and authz.can_manage_lesson(authz.object_owner_id(name)));

create policy lesson_media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'lesson-media' and authz.can_manage_lesson(authz.object_owner_id(name)));

-- ---------------------------------------------------------------------
-- avatars (anyone who may see the profile may see its avatar)
-- ---------------------------------------------------------------------
create policy avatars_select on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and authz.can_view_profile(authz.object_owner_id(name)));

create policy avatars_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and authz.object_owner_id(name) = (select auth.uid()));

create policy avatars_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and authz.object_owner_id(name) = (select auth.uid()))
  with check (bucket_id = 'avatars' and authz.object_owner_id(name) = (select auth.uid()));

create policy avatars_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and authz.object_owner_id(name) = (select auth.uid()));

-- profiles.avatar_path must point into the owner's own avatar folder.
alter table public.profiles
  add constraint profiles_avatar_path_own_folder
  check (avatar_path is null or avatar_path like id::text || '/%');

comment on function authz.object_owner_id(text) is
  'Storage path → owning resource uuid (first folder); null when missing/malformed so policies deny.';

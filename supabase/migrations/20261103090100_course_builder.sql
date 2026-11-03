-- =====================================================================
-- SolveEdu Platform — Migration 09: Course Builder support
--   * course_access()        : what may the caller do with a course (UI hint)
--   * reorder_course_items() : atomic reorder of units / lessons / blocks
--   * lesson block hardening : dangerous rich-text markup rejected in the DB
--                              (defence in depth — the app sanitises on save
--                              AND on render); media must live in the block's
--                              own lesson folder of the lesson-media bucket.
-- Both RPCs are SECURITY INVOKER: they never exceed the caller's RLS rights.
-- =====================================================================

-- ---------------------------------------------------------------------
-- course_access(course) → 'manage' | 'view' | 'none'
-- authz helpers answer only about auth.uid(), so exposing the answer is safe.
-- ---------------------------------------------------------------------
create or replace function public.course_access(p_course uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when authz.can_manage_course(p_course) then 'manage'
    when authz.can_view_course(p_course) then 'view'
    else 'none'
  end
$$;

-- ---------------------------------------------------------------------
-- reorder_course_items(kind, parent, ids[])
--   kind = 'unit'   → course_units  of course p_parent
--          'lesson' → lessons       of unit   p_parent
--          'block'  → lesson_blocks of lesson p_parent
-- p_ids must list EVERY child of the parent exactly once; positions become
-- 1..n in one statement (display_order uniques are DEFERRABLE, so swaps work).
-- ---------------------------------------------------------------------
create or replace function public.reorder_course_items(p_kind text, p_parent uuid, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_table text;
  v_parent_col text;
  v_allowed boolean;
  v_children uuid[];
  v_updated integer;
begin
  case p_kind
    when 'unit'   then v_table := 'course_units';  v_parent_col := 'course_id'; v_allowed := authz.can_manage_course(p_parent);
    when 'lesson' then v_table := 'lessons';       v_parent_col := 'unit_id';   v_allowed := authz.can_manage_unit(p_parent);
    when 'block'  then v_table := 'lesson_blocks'; v_parent_col := 'lesson_id'; v_allowed := authz.can_manage_lesson(p_parent);
    else raise exception 'invalid kind: %', p_kind using errcode = 'invalid_parameter_value';
  end case;

  if not coalesce(v_allowed, false) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;

  if p_ids is null or cardinality(p_ids) = 0
     or array_position(p_ids, null) is not null
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'ids must be a non-empty list without duplicates' using errcode = 'invalid_parameter_value';
  end if;

  execute format('select array_agg(id order by id) from public.%I where %I = $1', v_table, v_parent_col)
     into v_children using p_parent;

  if v_children is distinct from (select array_agg(x order by x) from unnest(p_ids) x) then
    raise exception 'ids must list every item of the parent exactly once' using errcode = 'invalid_parameter_value';
  end if;

  execute format(
    'update public.%I t set display_order = o.pos
       from unnest($2) with ordinality as o(id, pos)
      where t.id = o.id and t.%I = $1 and t.display_order is distinct from o.pos',
    v_table, v_parent_col)
  using p_parent, p_ids;

  -- Rows hidden by RLS would be silently skipped; verify the final state instead.
  execute format(
    'select count(*) from public.%I t join unnest($2) with ordinality as o(id, pos) on o.id = t.id
      where t.%I = $1 and t.display_order = o.pos',
    v_table, v_parent_col)
  into v_updated using p_parent, p_ids;
  if v_updated <> cardinality(p_ids) then
    raise exception 'not allowed' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke execute on function public.course_access(uuid) from public, anon;
revoke execute on function public.reorder_course_items(text, uuid, uuid[]) from public, anon;
grant execute on function public.course_access(uuid) to authenticated;
grant execute on function public.reorder_course_items(text, uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- Lesson block hardening
-- NOTE: the HTML checks are inlined on purpose. This function runs inside a
-- CHECK constraint as the *calling* role; a nested call to another private.*
-- function would need USAGE on schema private, which clients must never get.
-- ---------------------------------------------------------------------
create or replace function private.is_valid_lesson_block(p_type text, p_content jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_content) = 'object'
     and case p_type
       when 'rich_text' then jsonb_typeof(p_content -> 'html') = 'string'
                         and char_length(p_content ->> 'html') <= 200000
                         -- active / form / embedding elements (\y = word boundary in PG regex; \b is backspace)
                         and (p_content ->> 'html') !~* '<\s*/?\s*(script|style|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|option|link|meta|base|svg|math|template)\y'
                         -- inline event handlers inside a tag: <a onclick=...>
                         and (p_content ->> 'html') !~* '<[^>]*\son[a-z]+\s*='
                         -- script-capable URL schemes in URL attributes
                         and (p_content ->> 'html') !~* '\s(href|src|xlink:href|action|formaction)\s*=\s*["'']?\s*(javascript|vbscript|data)\s*:'
       when 'video' then
            (p_content ->> 'provider') in ('youtube', 'vimeo', 'storage')
        and (
              ((p_content ->> 'provider') in ('youtube', 'vimeo') and coalesce(p_content ->> 'video_id', '') ~ '^[A-Za-z0-9_-]{6,64}$')
           or ((p_content ->> 'provider') = 'storage' and coalesce(p_content ->> 'object_path', '') <> '')
        )
       when 'image'    then coalesce(p_content ->> 'object_path', '') <> ''
       when 'document' then coalesce(p_content ->> 'object_path', '') <> ''
       when 'link'     then coalesce(p_content ->> 'url', '') ~* '^https://'
       when 'embed'    then coalesce(p_content ->> 'url', '') ~* '^https://'
       when 'quiz_reference' then coalesce(p_content ->> 'assessment_assignment_id', '') ~*
                                   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       else false
     end
$$;

-- Media referenced by a block must be stored under that block's lesson folder,
-- so the storage policy for the lesson governs who can fetch it.
alter table public.lesson_blocks
  add constraint lesson_blocks_object_in_lesson_folder
  check (
    content_json ->> 'object_path' is null
    or (starts_with(content_json ->> 'object_path', lesson_id::text || '/')
        and content_json ->> 'object_path' !~ '(^|/)\.\.(/|$)')
  );

comment on function public.course_access(uuid) is 'manage|view|none สำหรับผู้เรียก — ใช้แสดง/ซ่อนเครื่องมือแก้ไขใน UI (สิทธิ์จริงบังคับด้วย RLS)';
comment on function public.reorder_course_items(text, uuid, uuid[]) is 'เรียงลำดับหน่วย/บทเรียน/บล็อกแบบ atomic (SECURITY INVOKER — ไม่เกินสิทธิ์ RLS ของผู้เรียก)';

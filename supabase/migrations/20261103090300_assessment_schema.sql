-- =====================================================================
-- SolveEdu Platform — Migration 12: Assessment engine (schema + RLS)
--
-- instruments → instrument_versions → instrument_items
--   * A version is editable only while 'draft'; once published it is
--     immutable (items AND answer keys), so old scores keep their meaning.
--   * Answer keys live in private.instrument_answer_keys: no grants to
--     anon/authenticated at all, never selectable through the Data API.
--   * options_json is shape-checked per item_type; a choice may only carry
--     id / text / image_path, so a "correct" flag cannot slip into it.
--
-- assessment_assignments → assessment_attempts → assessment_responses
--   * Attempts and responses have NO client INSERT/UPDATE/DELETE grants.
--     They are written only by trusted RPCs (next migrations), so score,
--     passed, started_at and submitted_at never come from the browser.
--   * Per-item awarded_score is not column-granted (trainees see the total
--     only, not which items were right).
--
-- item_type in Phase 2B: mcq_single, mcq_multiple (choices may be images),
-- true_false, numeric. New types extend the CHECK, private.item_shape_error(),
-- private.answer_key_error() and the scorer.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.instruments (
  id              uuid primary key default gen_random_uuid(),
  owner_org_id    uuid not null references public.organizations (id) on delete restrict,
  course_id       uuid references public.courses (id) on delete restrict,
  code            text not null check (char_length(code) between 1 and 50),
  title           text not null check (char_length(title) between 1 and 300),
  description     text check (description is null or char_length(description) <= 5000),
  instrument_type text not null default 'quiz' check (instrument_type in ('quiz')),
  status          text not null default 'active' check (status in ('active', 'archived')),
  created_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint instruments_code_unique unique (owner_org_id, code)
);

create index instruments_course_idx on public.instruments (course_id);

create trigger instruments_set_updated_at
  before update on public.instruments
  for each row execute function private.set_updated_at();

create table public.instrument_versions (
  id            uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references public.instruments (id) on delete restrict,
  version_no    integer not null check (version_no >= 1),
  status        text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at  timestamptz,
  published_by  uuid references public.profiles (id) on delete set null,
  content_hash  text,
  created_by    uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint instrument_versions_no_unique unique (instrument_id, version_no),
  constraint instrument_versions_published_state
    check ((status = 'draft') = (published_at is null) and (status = 'draft') = (content_hash is null))
);

-- At most one editable draft per instrument
create unique index instrument_versions_one_draft
  on public.instrument_versions (instrument_id) where status = 'draft';

create trigger instrument_versions_set_updated_at
  before update on public.instrument_versions
  for each row execute function private.set_updated_at();

create table public.instrument_items (
  id                    uuid primary key default gen_random_uuid(),
  instrument_version_id uuid not null references public.instrument_versions (id) on delete cascade,
  item_type             text not null
                          check (item_type in ('mcq_single', 'mcq_multiple', 'true_false', 'numeric')),
  prompt                text not null check (char_length(prompt) between 1 and 5000),
  media_path            text,
  options_json          jsonb not null default '{}'::jsonb,
  max_score             numeric(10, 2) not null default 1 check (max_score > 0 and max_score <= 1000),
  display_order         integer not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint instrument_items_order_unique unique (instrument_version_id, display_order) deferrable initially deferred
);

create trigger instrument_items_set_updated_at
  before update on public.instrument_items
  for each row execute function private.set_updated_at();

create table private.instrument_answer_keys (
  item_id      uuid primary key references public.instrument_items (id) on delete cascade,
  answer_json  jsonb not null,
  scoring_json jsonb not null default '{}'::jsonb,
  updated_by   uuid,
  updated_at   timestamptz not null default now()
);

create table public.assessment_assignments (
  id                    uuid primary key default gen_random_uuid(),
  instrument_version_id uuid not null references public.instrument_versions (id) on delete restrict,
  cohort_id             uuid not null references public.cohorts (id) on delete restrict,
  course_id             uuid references public.courses (id) on delete restrict,
  purpose               text not null check (purpose in ('pretest', 'posttest', 'formative')),
  title                 text not null check (char_length(title) between 1 and 300),
  instructions          text check (instructions is null or char_length(instructions) <= 5000),
  open_at               timestamptz,
  close_at              timestamptz,
  attempt_limit         integer not null default 1 check (attempt_limit between 1 and 20),
  passing_percent       numeric(5, 2) check (passing_percent is null or passing_percent between 0 and 100),
  status                text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by            uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint assessment_assignments_window check (open_at is null or close_at is null or close_at > open_at)
);

create index assessment_assignments_cohort_idx on public.assessment_assignments (cohort_id, status);
create index assessment_assignments_version_idx on public.assessment_assignments (instrument_version_id);

create trigger assessment_assignments_set_updated_at
  before update on public.assessment_assignments
  for each row execute function private.set_updated_at();

create table public.assessment_attempts (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assessment_assignments (id) on delete restrict,
  user_id       uuid not null references public.profiles (id) on delete restrict,
  attempt_no    integer not null check (attempt_no >= 1),
  status        text not null default 'in_progress' check (status in ('in_progress', 'submitted')),
  started_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  score         numeric(10, 2),
  max_score     numeric(10, 2),
  passed        boolean,
  constraint assessment_attempts_no_unique unique (assignment_id, user_id, attempt_no),
  constraint assessment_attempts_submitted_state check ((status = 'submitted') = (submitted_at is not null)),
  constraint assessment_attempts_scored check (status = 'in_progress' or (score is not null and max_score is not null)),
  constraint assessment_attempts_score_range check (score is null or (score >= 0 and max_score >= 0 and score <= max_score)),
  constraint assessment_attempts_time_order check (submitted_at is null or submitted_at >= started_at)
);

-- One open attempt per person per assignment (second line of defence for the RPC lock)
create unique index assessment_attempts_one_open
  on public.assessment_attempts (assignment_id, user_id) where status = 'in_progress';
create index assessment_attempts_user_idx on public.assessment_attempts (user_id);

create table public.assessment_responses (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references public.assessment_attempts (id) on delete restrict,
  item_id       uuid not null references public.instrument_items (id) on delete restrict,
  response_json jsonb not null,
  awarded_score numeric(10, 2) check (awarded_score is null or awarded_score >= 0),
  graded_at     timestamptz,
  graded_by     uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint assessment_responses_unique unique (attempt_id, item_id)
);

create index assessment_responses_item_idx on public.assessment_responses (item_id);

-- ---------------------------------------------------------------------
-- Shape validation (per item_type). Returns an error message or null.
-- Called from SECURITY DEFINER triggers only (clients have no USAGE on private).
-- ---------------------------------------------------------------------
create or replace function private.item_shape_error(p_type text, p_options jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_opt jsonb;
  v_ids text[] := '{}';
begin
  if jsonb_typeof(p_options) is distinct from 'object' then
    return 'options_json must be an object';
  end if;

  case p_type
    when 'mcq_single', 'mcq_multiple' then
      if exists (select 1 from jsonb_object_keys(p_options) k where k <> 'options') then
        return 'options_json may only contain "options"';
      end if;
      if jsonb_typeof(p_options -> 'options') is distinct from 'array' then
        return 'options must be an array of 2-10 choices';
      end if;
      if jsonb_array_length(p_options -> 'options') not between 2 and 10 then
        return 'options must be an array of 2-10 choices';
      end if;
      for v_opt in select value from jsonb_array_elements(p_options -> 'options') loop
        if jsonb_typeof(v_opt) is distinct from 'object' then
          return 'each choice must be an object';
        end if;
        if exists (select 1 from jsonb_object_keys(v_opt) k where k not in ('id', 'text', 'image_path')) then
          return 'a choice may only contain id, text, image_path';
        end if;
        if jsonb_typeof(v_opt -> 'id') is distinct from 'string' or (v_opt ->> 'id') !~ '^[a-z0-9]{1,8}$' then
          return 'choice id must match [a-z0-9]{1,8}';
        end if;
        if (v_opt ->> 'id') = any (v_ids) then
          return 'duplicate choice id';
        end if;
        v_ids := v_ids || (v_opt ->> 'id');
        if (v_opt ? 'text' and jsonb_typeof(v_opt -> 'text') is distinct from 'string')
           or (v_opt ? 'image_path' and jsonb_typeof(v_opt -> 'image_path') is distinct from 'string') then
          return 'choice text and image_path must be strings';
        end if;
        if coalesce(btrim(v_opt ->> 'text'), '') = '' and coalesce(v_opt ->> 'image_path', '') = '' then
          return 'a choice needs text or an image';
        end if;
        if char_length(coalesce(v_opt ->> 'text', '')) > 1000 then
          return 'choice text is too long';
        end if;
      end loop;
    when 'true_false' then
      if p_options <> '{}'::jsonb then
        return 'true_false takes no options';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_options) k where k <> 'unit') then
        return 'numeric options may only contain "unit"';
      end if;
      if p_options ? 'unit' and (jsonb_typeof(p_options -> 'unit') is distinct from 'string'
                                 or char_length(p_options ->> 'unit') > 32) then
        return 'unit must be a short string';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

-- Answer key vs item. Returns an error message or null.
--   mcq_single   {"correct": ["a"]}              exactly one existing choice id
--   mcq_multiple {"correct": ["a","c"]}          >= 1 distinct existing ids
--                scoring_json {"mode": "all_or_nothing" | "partial"}
--   true_false   {"correct": true}
--   numeric      {"value": 12.5, "tolerance": 0.5}   tolerance optional, >= 0
create or replace function private.answer_key_error(p_type text, p_options jsonb, p_answer jsonb, p_scoring jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids text[];
  v_correct text[];
begin
  if jsonb_typeof(p_answer) is distinct from 'object' or jsonb_typeof(p_scoring) is distinct from 'object' then
    return 'answer_json and scoring_json must be objects';
  end if;

  case p_type
    when 'mcq_single', 'mcq_multiple' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'correct')
         or jsonb_typeof(p_answer -> 'correct') is distinct from 'array' then
        return 'answer_json must be {"correct": [choice ids]}';
      end if;
      if exists (select 1 from jsonb_array_elements(p_answer -> 'correct') e where jsonb_typeof(e) <> 'string') then
        return 'answer_json must be {"correct": [choice ids]}';
      end if;
      select array_agg(o ->> 'id') into v_ids from jsonb_array_elements(p_options -> 'options') o;
      select array_agg(e) into v_correct from jsonb_array_elements_text(p_answer -> 'correct') e;
      if v_correct is null or cardinality(v_correct) <> (select count(distinct x) from unnest(v_correct) x) then
        return 'correct choices must be a non-empty list without duplicates';
      end if;
      if not (v_correct <@ coalesce(v_ids, '{}')) then
        return 'correct choice id does not exist in the item';
      end if;
      if p_type = 'mcq_single' then
        if cardinality(v_correct) <> 1 then
          return 'mcq_single needs exactly one correct choice';
        end if;
        if p_scoring <> '{}'::jsonb then
          return 'mcq_single takes no scoring options';
        end if;
      elsif exists (select 1 from jsonb_object_keys(p_scoring) k where k <> 'mode')
            or coalesce(p_scoring ->> 'mode', 'all_or_nothing') not in ('all_or_nothing', 'partial') then
        return 'scoring_json must be {"mode": "all_or_nothing" | "partial"}';
      end if;
    when 'true_false' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k <> 'correct')
         or jsonb_typeof(p_answer -> 'correct') is distinct from 'boolean' then
        return 'answer_json must be {"correct": true|false}';
      end if;
      if p_scoring <> '{}'::jsonb then
        return 'true_false takes no scoring options';
      end if;
    when 'numeric' then
      if exists (select 1 from jsonb_object_keys(p_answer) k where k not in ('value', 'tolerance'))
         or jsonb_typeof(p_answer -> 'value') is distinct from 'number'
         or (p_answer ? 'tolerance' and jsonb_typeof(p_answer -> 'tolerance') is distinct from 'number') then
        return 'answer_json must be {"value": number, "tolerance": number >= 0}';
      end if;
      if coalesce((p_answer ->> 'tolerance')::numeric, 0) < 0 then
        return 'answer_json must be {"value": number, "tolerance": number >= 0}';
      end if;
      if p_scoring <> '{}'::jsonb then
        return 'numeric takes no scoring options';
      end if;
    else
      return 'unknown item_type';
  end case;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Invariant triggers
-- ---------------------------------------------------------------------

-- An instrument tied to a course belongs to the course's owner organization
-- (a course trainer cannot file instruments under another org).
create or replace function private.instruments_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.course_id is not null and not exists (
    select 1 from public.courses c where c.id = new.course_id and c.owner_org_id = new.owner_org_id
  ) then
    raise exception 'instrument owner must be the owner organization of its course'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;
  return new;
end;
$$;

create trigger instruments_validate
  before insert or update of owner_org_id, course_id on public.instruments
  for each row execute function private.instruments_validate();

-- version_no is assigned by the server; a new version always starts as draft;
-- publication is one-way (draft → published → archived) and freezes the hash.
create or replace function private.instrument_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version_no := coalesce(
      (select max(v.version_no) from public.instrument_versions v where v.instrument_id = new.instrument_id), 0) + 1;
    new.status := 'draft';
    new.published_at := null;
    new.published_by := null;
    new.content_hash := null;
    new.created_by := coalesce(auth.uid(), new.created_by);
    return new;
  end if;

  if new.instrument_id <> old.instrument_id or new.version_no <> old.version_no then
    raise exception 'instrument_id/version_no are immutable' using errcode = 'check_violation';
  end if;
  if old.status <> 'draft' then
    if new.status = 'draft'
       or (old.status = 'archived' and new.status <> 'archived')
       or new.published_at is distinct from old.published_at
       or new.published_by is distinct from old.published_by
       or new.content_hash is distinct from old.content_hash then
      raise exception 'a published version is immutable (create a new version instead)'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger instrument_versions_guard
  before insert or update on public.instrument_versions
  for each row execute function private.instrument_versions_guard();

-- Items: only inside a draft version; shape-checked; media under the
-- instrument's own folder (assessment-media/<instrument_id>/...).
create or replace function private.instrument_items_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version uuid := case when tg_op = 'DELETE' then old.instrument_version_id else new.instrument_version_id end;
  v_status text;
  v_instrument uuid;
  v_error text;
  v_path text;
begin
  select v.status, v.instrument_id into v_status, v_instrument
    from public.instrument_versions v where v.id = v_version;
  if v_status is distinct from 'draft'
     or (tg_op = 'UPDATE' and new.instrument_version_id <> old.instrument_version_id) then
    raise exception 'items of a published version cannot change (create a new version instead)'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_error := private.item_shape_error(new.item_type, new.options_json);
  if v_error is not null then
    raise exception 'invalid item: %', v_error using errcode = 'check_violation';
  end if;

  for v_path in
    select new.media_path
    union all
    select o ->> 'image_path'
      from jsonb_array_elements(coalesce(new.options_json -> 'options', '[]'::jsonb)) o
  loop
    if v_path is not null
       and (not starts_with(v_path, v_instrument::text || '/') or v_path ~ '(^|/)\.\.(/|$)') then
      raise exception 'invalid item: media must be stored under the instrument folder'
        using errcode = 'check_violation';
    end if;
  end loop;

  -- A changed item type makes the old answer key meaningless.
  if tg_op = 'UPDATE' and new.item_type <> old.item_type then
    delete from private.instrument_answer_keys where item_id = old.id;
  end if;
  return new;
end;
$$;

create trigger instrument_items_guard
  before insert or update or delete on public.instrument_items
  for each row execute function private.instrument_items_guard();

create or replace function private.instrument_answer_keys_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item uuid := case when tg_op = 'DELETE' then old.item_id else new.item_id end;
  v_type text;
  v_options jsonb;
  v_status text;
  v_error text;
begin
  select i.item_type, i.options_json, v.status into v_type, v_options, v_status
    from public.instrument_items i
    join public.instrument_versions v on v.id = i.instrument_version_id
   where i.id = v_item;

  -- v_status is null while the item itself is being cascade-deleted
  if v_status is not null and v_status <> 'draft' then
    raise exception 'answer keys of a published version cannot change' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  v_error := private.answer_key_error(v_type, v_options, new.answer_json, new.scoring_json);
  if v_error is not null then
    raise exception 'invalid answer key: %', v_error using errcode = 'check_violation';
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;

create trigger instrument_answer_keys_guard
  before insert or update or delete on private.instrument_answer_keys
  for each row execute function private.instrument_answer_keys_guard();

-- Assignments: only published versions; course must belong to the cohort's program.
create or replace function private.assessment_assignments_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.instrument_versions v
     where v.id = new.instrument_version_id and v.status = 'published'
  ) and (tg_op = 'INSERT' or new.status = 'published') then
    raise exception 'only a published instrument version can be assigned' using errcode = 'check_violation';
  end if;

  if new.course_id is not null and not exists (
    select 1
      from public.cohorts c
      join public.program_courses pc on pc.program_id = c.program_id
     where c.id = new.cohort_id and pc.course_id = new.course_id
  ) then
    raise exception 'course is not part of the program of this cohort' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;
  return new;
end;
$$;

create trigger assessment_assignments_validate
  before insert or update of instrument_version_id, cohort_id, course_id, status on public.assessment_assignments
  for each row execute function private.assessment_assignments_validate();

-- Evidence trail: assignment settings and any change to an attempt after insert.
create trigger assessment_assignments_audit
  after insert or update or delete on public.assessment_assignments
  for each row execute function private.audit_row();
create trigger assessment_attempts_audit
  after update or delete on public.assessment_attempts
  for each row execute function private.audit_row();
create trigger instrument_versions_audit
  after update on public.instrument_versions
  for each row execute function private.audit_row();

revoke all on function private.item_shape_error(text, jsonb) from public;
revoke all on function private.answer_key_error(text, jsonb, jsonb, jsonb) from public;
revoke all on function private.instruments_validate() from public;
revoke all on function private.instrument_versions_guard() from public;
revoke all on function private.instrument_items_guard() from public;
revoke all on function private.instrument_answer_keys_guard() from public;
revoke all on function private.assessment_assignments_validate() from public;

-- ---------------------------------------------------------------------
-- authz helpers (answer about auth.uid() only)
-- ---------------------------------------------------------------------
-- Authors: platform admin, district admin/supervisor of the owner org, or a
-- manager (e.g. cohort trainer) of the course the instrument belongs to.
create or replace function authz.can_manage_instrument_row(p_owner_org uuid, p_course uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_create_course_in_org(p_owner_org)
      or (p_course is not null and authz.can_manage_course(p_course));
$$;

create or replace function authz.can_manage_instrument(p_instrument uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.instruments i
     where i.id = p_instrument and authz.can_manage_instrument_row(i.owner_org_id, i.course_id)
  );
$$;

create or replace function authz.can_manage_version(p_version uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.instrument_versions v
     where v.id = p_version and authz.can_manage_instrument(v.instrument_id)
  );
$$;

-- Runs assessments for a cohort and sees all of its results.
create or replace function authz.is_cohort_assessor(p_cohort uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_cohort(p_cohort) or authz.is_cohort_member(p_cohort, array['trainer']);
$$;

-- Item content is visible to authors, to staff of a cohort the version is
-- assigned to, and to a trainee only once they have started an attempt
-- (no previewing the test before it counts as an attempt).
create or replace function authz.can_view_version(p_version uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select authz.can_manage_version(p_version)
      or exists (
           select 1 from public.assessment_assignments a
            where a.instrument_version_id = p_version
              and (authz.is_cohort_assessor(a.cohort_id)
                   or authz.is_cohort_member(a.cohort_id, array['mentor']))
         )
      or (authz.is_active_user() and exists (
           select 1
             from public.assessment_attempts t
             join public.assessment_assignments a on a.id = t.assignment_id
            where a.instrument_version_id = p_version
              and t.user_id = (select auth.uid())
         ));
$$;

create or replace function authz.can_view_instrument(p_instrument uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.instrument_versions v
     where v.instrument_id = p_instrument and authz.can_view_version(v.id)
  );
$$;

-- Own attempts; cohort assessors; the trainee's assigned mentor.
create or replace function authz.can_view_attempt(p_assignment uuid, p_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (p_user = (select auth.uid()) and authz.is_active_user())
      or exists (
           select 1 from public.assessment_assignments a
            where a.id = p_assignment
              and (authz.is_cohort_assessor(a.cohort_id) or authz.is_mentor_of(p_user, a.cohort_id))
         );
$$;

create or replace function authz.can_view_attempt_id(p_attempt uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assessment_attempts t
     where t.id = p_attempt and authz.can_view_attempt(t.assignment_id, t.user_id)
  );
$$;

revoke execute on all functions in schema authz from public, anon;
grant execute on all functions in schema authz to authenticated, service_role;

-- ---------------------------------------------------------------------
-- GRANTs + RLS
-- Policies decide from the row's own columns where INSERT ... RETURNING
-- must see the new row (see migration 10).
-- ---------------------------------------------------------------------
alter table public.instruments            enable row level security;
alter table public.instrument_versions    enable row level security;
alter table public.instrument_items       enable row level security;
alter table public.assessment_assignments enable row level security;
alter table public.assessment_attempts    enable row level security;
alter table public.assessment_responses   enable row level security;

-- instruments (owner_org_id / course_id immutable for clients)
grant select on public.instruments to authenticated;
grant insert (owner_org_id, course_id, code, title, description, instrument_type) on public.instruments to authenticated;
grant update (code, title, description, status) on public.instruments to authenticated;

create policy instruments_select on public.instruments
  for select to authenticated
  using (authz.can_manage_instrument_row(owner_org_id, course_id) or authz.can_view_instrument(id));
create policy instruments_insert on public.instruments
  for insert to authenticated
  with check (authz.can_manage_instrument_row(owner_org_id, course_id));
create policy instruments_update on public.instruments
  for update to authenticated
  using (authz.can_manage_instrument_row(owner_org_id, course_id))
  with check (authz.can_manage_instrument_row(owner_org_id, course_id));

-- instrument_versions: clients only open a new draft; publish/clone via RPC
grant select on public.instrument_versions to authenticated;
grant insert (instrument_id) on public.instrument_versions to authenticated;

create policy instrument_versions_select on public.instrument_versions
  for select to authenticated
  using (authz.can_manage_instrument(instrument_id) or authz.can_view_version(id));
create policy instrument_versions_insert on public.instrument_versions
  for insert to authenticated
  with check (authz.can_manage_instrument(instrument_id));

-- instrument_items (draft-only edits enforced by trigger)
grant select on public.instrument_items to authenticated;
grant insert (instrument_version_id, item_type, prompt, media_path, options_json, max_score, display_order)
  on public.instrument_items to authenticated;
grant update (item_type, prompt, media_path, options_json, max_score, display_order)
  on public.instrument_items to authenticated;
grant delete on public.instrument_items to authenticated;

create policy instrument_items_select on public.instrument_items
  for select to authenticated
  using (authz.can_view_version(instrument_version_id));
create policy instrument_items_insert on public.instrument_items
  for insert to authenticated
  with check (authz.can_manage_version(instrument_version_id));
create policy instrument_items_update on public.instrument_items
  for update to authenticated
  using (authz.can_manage_version(instrument_version_id))
  with check (authz.can_manage_version(instrument_version_id));
create policy instrument_items_delete on public.instrument_items
  for delete to authenticated
  using (authz.can_manage_version(instrument_version_id));

-- assessment_assignments (version / cohort immutable for clients)
grant select on public.assessment_assignments to authenticated;
grant insert (instrument_version_id, cohort_id, course_id, purpose, title, instructions,
              open_at, close_at, attempt_limit, passing_percent, status)
  on public.assessment_assignments to authenticated;
grant update (course_id, purpose, title, instructions, open_at, close_at, attempt_limit, passing_percent, status)
  on public.assessment_assignments to authenticated;
grant delete on public.assessment_assignments to authenticated;

create policy assessment_assignments_select on public.assessment_assignments
  for select to authenticated
  using (
    authz.is_cohort_assessor(cohort_id)
    or authz.is_cohort_member(cohort_id, array['mentor'])
    or (status = 'published' and authz.is_cohort_member(cohort_id, array['trainee']))
  );
-- The assigner must be able to see the version (no assigning someone else's test by id).
create policy assessment_assignments_insert on public.assessment_assignments
  for insert to authenticated
  with check (authz.is_cohort_assessor(cohort_id) and authz.can_view_version(instrument_version_id));
create policy assessment_assignments_update on public.assessment_assignments
  for update to authenticated
  using (authz.is_cohort_assessor(cohort_id))
  with check (authz.is_cohort_assessor(cohort_id));
-- Drafts only; attempts reference assignments with ON DELETE RESTRICT anyway.
create policy assessment_assignments_delete on public.assessment_assignments
  for delete to authenticated
  using (status = 'draft' and authz.is_cohort_assessor(cohort_id));

-- assessment_attempts: read-only for clients
grant select on public.assessment_attempts to authenticated;

create policy assessment_attempts_select on public.assessment_attempts
  for select to authenticated
  using (authz.can_view_attempt(assignment_id, user_id));

-- assessment_responses: read-only, and never the per-item score
grant select (id, attempt_id, item_id, response_json, created_at) on public.assessment_responses to authenticated;

create policy assessment_responses_select on public.assessment_responses
  for select to authenticated
  using (authz.can_view_attempt_id(attempt_id));

-- ---------------------------------------------------------------------
-- Catalog comments (feed DATA_DICTIONARY.md)
-- ---------------------------------------------------------------------
comment on table public.instruments is 'เครื่องมือวัด (Phase 2B: แบบทดสอบ quiz) — ผูกหน่วยงานเจ้าของ และอาจผูกหลักสูตร';
comment on table public.instrument_versions is 'ฉบับของเครื่องมือวัด — draft แก้ได้; published แก้ไม่ได้ (สร้างฉบับใหม่แทน); version_no กำหนดโดย server';
comment on table public.instrument_items is 'ข้อคำถาม — options_json ตรวจรูปแบบตาม item_type และห้ามมีเฉลย; รูปอยู่ใต้โฟลเดอร์ <instrument_id>/';
comment on column public.instrument_items.item_type is 'mcq_single|mcq_multiple|true_false|numeric (Phase 2B)';
comment on table private.instrument_answer_keys is 'เฉลยและวิธีให้คะแนน — ไม่ GRANT ให้ client; อ่านได้เฉพาะ RPC ให้คะแนนฝั่ง server';
comment on table public.assessment_assignments is 'การมอบหมายฉบับที่เผยแพร่แล้วให้รุ่น (และหลักสูตร) พร้อมช่วงเวลา จำนวนครั้ง และเกณฑ์ผ่าน';
comment on column public.assessment_assignments.passing_percent is 'เกณฑ์ผ่าน (%) ต่อการมอบหมาย; null = ไม่ตัดสินผ่าน/ไม่ผ่าน';
comment on table public.assessment_attempts is 'ครั้งที่ทำแบบทดสอบ — เขียนโดย RPC ฝั่ง server เท่านั้น (คะแนน เวลาเริ่ม/ส่ง ไม่มาจาก browser)';
comment on table public.assessment_responses is 'คำตอบรายข้อ — client อ่านได้เฉพาะคำตอบ ไม่ได้รับ awarded_score รายข้อ';

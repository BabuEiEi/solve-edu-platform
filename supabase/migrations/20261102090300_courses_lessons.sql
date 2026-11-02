-- =====================================================================
-- SolveEdu Platform — Migration 04: Courses, Units, Lessons, Enrollment
-- Course → Unit → Lesson → Lesson Blocks; Cohort-scoped enrollment
-- =====================================================================

create table public.courses (
  id               uuid primary key default gen_random_uuid(),
  code             text not null,
  title            text not null,
  summary          text,
  description      text,
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  status           text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  owner_org_id     uuid not null references public.organizations (id) on delete restrict,
  created_by       uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint courses_code_unique unique (owner_org_id, code)
);

create index courses_owner_org_idx on public.courses (owner_org_id);
create index courses_status_idx on public.courses (status);

create trigger courses_set_updated_at
  before update on public.courses
  for each row execute function private.set_updated_at();

-- M:N — one course can be reused in several programs
create table public.program_courses (
  program_id    uuid not null references public.programs (id) on delete cascade,
  course_id     uuid not null references public.courses (id) on delete restrict,
  display_order integer not null default 0,
  primary key (program_id, course_id)
);

create index program_courses_course_idx on public.program_courses (course_id);

create table public.course_units (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses (id) on delete cascade,
  title         text not null,
  description   text,
  display_order integer not null,
  status        text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint course_units_order_unique unique (course_id, display_order) deferrable initially deferred
);

create trigger course_units_set_updated_at
  before update on public.course_units
  for each row execute function private.set_updated_at();

create table public.lessons (
  id                  uuid primary key default gen_random_uuid(),
  unit_id             uuid not null references public.course_units (id) on delete cascade,
  title               text not null,
  learning_objectives text,
  display_order       integer not null,
  required            boolean not null default true,
  status              text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint lessons_order_unique unique (unit_id, display_order) deferrable initially deferred
);

create trigger lessons_set_updated_at
  before update on public.lessons
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- lesson_blocks.content_json shape validation (per block_type).
-- HTML sanitisation itself happens in the trusted app layer before save
-- AND at render time; the DB only guarantees a well-formed shape.
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

create table public.lesson_blocks (
  id            uuid primary key default gen_random_uuid(),
  lesson_id     uuid not null references public.lessons (id) on delete cascade,
  block_type    text not null
                  check (block_type in ('rich_text', 'video', 'image', 'document', 'link', 'embed', 'quiz_reference')),
  content_json  jsonb not null default '{}'::jsonb,
  display_order integer not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint lesson_blocks_order_unique unique (lesson_id, display_order) deferrable initially deferred,
  constraint lesson_blocks_content_valid check (private.is_valid_lesson_block(block_type, content_json))
);

create trigger lesson_blocks_set_updated_at
  before update on public.lesson_blocks
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- Enrollment always carries Cohort context so scores never mix across cohorts
-- ---------------------------------------------------------------------
create table public.course_enrollments (
  id           uuid primary key default gen_random_uuid(),
  cohort_id    uuid not null references public.cohorts (id) on delete restrict,
  course_id    uuid not null references public.courses (id) on delete restrict,
  user_id      uuid not null references public.profiles (id) on delete restrict,
  status       text not null default 'active' check (status in ('active', 'completed', 'withdrawn')),
  enrolled_at  timestamptz not null default now(),
  completed_at timestamptz,
  enrolled_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  constraint course_enrollments_unique unique (cohort_id, course_id, user_id)
);

create index course_enrollments_user_idx on public.course_enrollments (user_id, cohort_id);
create index course_enrollments_course_idx on public.course_enrollments (course_id);

create or replace function private.course_enrollments_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.cohorts c
      join public.program_courses pc on pc.program_id = c.program_id
     where c.id = new.cohort_id and pc.course_id = new.course_id
  ) then
    raise exception 'course is not part of the program of this cohort'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.cohort_memberships
     where cohort_id = new.cohort_id and user_id = new.user_id
       and cohort_role = 'trainee' and status = 'active'
  ) then
    raise exception 'user is not an active trainee of this cohort'
      using errcode = 'check_violation';
  end if;

  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.course_enrollments_validate() from public;

create trigger course_enrollments_validate
  before insert or update of cohort_id, course_id, user_id, status on public.course_enrollments
  for each row execute function private.course_enrollments_validate();

create table public.lesson_progress (
  id               uuid primary key default gen_random_uuid(),
  enrollment_id    uuid not null references public.course_enrollments (id) on delete restrict,
  lesson_id        uuid not null references public.lessons (id) on delete restrict,
  status           text not null default 'in_progress'
                     check (status in ('not_started', 'in_progress', 'completed')),
  progress_percent numeric(5, 2) not null default 0 check (progress_percent between 0 and 100),
  started_at       timestamptz,
  completed_at     timestamptz,
  updated_at       timestamptz not null default now(),
  constraint lesson_progress_unique unique (enrollment_id, lesson_id)
);

create index lesson_progress_lesson_idx on public.lesson_progress (lesson_id);

-- Timestamps come from the server clock, never from the client.
create or replace function private.lesson_progress_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1
        from public.course_enrollments e
        join public.course_units u on u.course_id = e.course_id
        join public.lessons l on l.unit_id = u.id
       where e.id = new.enrollment_id
         and l.id = new.lesson_id
         and e.status = 'active'
         and l.status = 'published'
         and u.status = 'published'
    ) then
      raise exception 'lesson is not a published lesson of an active enrollment'
        using errcode = 'check_violation';
    end if;
    new.started_at := now();
    new.completed_at := null;
  else
    if new.enrollment_id <> old.enrollment_id or new.lesson_id <> old.lesson_id then
      raise exception 'enrollment_id/lesson_id are immutable' using errcode = 'check_violation';
    end if;
    new.started_at := old.started_at;
    new.completed_at := old.completed_at;
  end if;

  if new.status = 'completed' then
    new.progress_percent := 100;
    new.completed_at := coalesce(new.completed_at, now());
  else
    new.completed_at := null;
    if new.status = 'not_started' then
      new.progress_percent := 0;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.lesson_progress_validate() from public;

create trigger lesson_progress_validate
  before insert or update on public.lesson_progress
  for each row execute function private.lesson_progress_validate();

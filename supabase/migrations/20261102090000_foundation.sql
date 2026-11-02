-- =====================================================================
-- SolveEdu Platform — Migration 01: Foundation
-- Schemas, default privileges, shared trigger functions, audit log.
-- =====================================================================
-- Schema layout
--   public  : tables exposed through the Supabase Data API (RLS on every table)
--   authz   : RLS helper functions (NOT exposed via Data API; usage granted to
--             authenticated only so policies can call them)
--   private : sensitive data (audit logs, later answer keys). No grants to
--             anon/authenticated at all. Never add this schema to [api].schemas.
-- =====================================================================

create schema if not exists private;
create schema if not exists authz;

revoke all on schema private from public;
revoke all on schema authz from public;
grant usage on schema private to service_role;
grant usage on schema authz to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Secure-by-default: new tables/functions created by this owner in
-- `public` are NOT automatically readable/executable by anon/authenticated.
-- Every table must receive explicit, minimal GRANTs in the RLS migration.
-- ---------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema authz revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Append-only audit log for role / permission / status changes.
-- Written only by SECURITY DEFINER triggers or trusted RPCs.
-- ---------------------------------------------------------------------
create table private.audit_logs (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,                -- auth.uid() at the time (null = service/migration)
  action      text not null,       -- INSERT | UPDATE | DELETE | custom verb
  table_name  text not null,
  record_id   uuid,
  before_json jsonb,
  after_json  jsonb,
  reason      text
);

create index audit_logs_record_idx on private.audit_logs (table_name, record_id);
create index audit_logs_actor_idx  on private.audit_logs (actor_id, occurred_at desc);

-- Generic row-audit trigger (tables must have a uuid `id` column)
create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.audit_logs (actor_id, action, table_name, record_id, before_json, after_json)
  values (
    auth.uid(),
    tg_op,
    tg_table_schema || '.' || tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null; -- AFTER trigger
end;
$$;

revoke all on function private.set_updated_at() from public;
revoke all on function private.audit_row() from public;

# CLAUDE.md — instructions for coding agents

Source of truth: `docs/BLUEPRINT.md`. Current state and decisions: `docs/ARCHITECTURE.md`, `docs/MIGRATION_FROM_LEGACY.md`.

## Non-negotiables
- Never modify, push to, or force-push `BabuEiEi/solve-edu-lms` or `BabuEiEi/LMS` (read-only references).
- Never run `supabase db reset --linked`, `db push`, or anything against a remote project without explicit owner approval.
- No secrets in code or git. Browser uses the publishable key only. `.env*` stays untracked (except `.env.example`).
- Every new table in `public`: GRANT minimal columns + RLS policies + pgTAP allow/deny tests in the same change.
  (Migration 01 revokes Supabase default grants, so a new table is inaccessible until you grant it.)
- Helper/authorization functions go in schema `authz`; sensitive data (answer keys, audit) in `private`. Never add either to `[api].schemas`.
- SECURITY DEFINER only with `set search_path = ''`, explicit `auth.uid()` checks, `revoke execute ... from public, anon`, and negative tests.
- Scores, answer keys, timestamps that are evidence (`started_at`, `submitted_at`, `graded_at`) are produced server-side only.
- UI: render through `html``…`` / `render()`; never assign `innerHTML` directly; no inline event handlers. Always `unwrap()` Supabase responses.
- Select explicit columns (`profiles` has a column-protected `contact_email`; `select('*')` returns 42501).
- Seed/test data must be fictitious (`*.example.test`).

## Verify before reporting a phase done
```bash
npm run check                      # lint + unit + build
npx supabase db reset --local && npx supabase test db
# without Docker:  scripts/db-local/test.sh   (PostgreSQL 15+ superuser required)
```
Report in Thai: changes, files, commands run with PASS/FAIL/SKIP + reasons, remaining risks, next steps.

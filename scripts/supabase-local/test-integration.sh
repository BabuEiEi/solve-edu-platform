#!/usr/bin/env bash
# Integration tests (service layer → Supabase Local API → RLS).
# Resets the LOCAL database first because the tests mutate demo data.
# LOCAL ONLY: reads keys from `supabase status`, never touches a linked project.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|JWT_SECRET|PUBLISHABLE_KEY)=')"
case "${API_URL:-}" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Refusing: API_URL '${API_URL:-}' is not a local Supabase"; exit 1 ;;
esac

npx supabase db reset --local >/dev/null
SOLVEEDU_REST_URL="$API_URL/rest/v1" \
SOLVEEDU_STORAGE_URL="$API_URL/storage/v1" \
SOLVEEDU_JWT_SECRET="$JWT_SECRET" \
SOLVEEDU_API_KEY="$PUBLISHABLE_KEY" \
  npx vitest run tests/integration
status=$?
# Leave the database in its seeded state for the next developer step.
npx supabase db reset --local >/dev/null
exit $status

#!/usr/bin/env bash
# Edge Function tests against Supabase LOCAL only (see functions-up.sh).
# Resets the local database before and after: the tests change demo data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=functions-up.sh
. "$ROOT/scripts/supabase-local/functions-up.sh"
trap functions_down EXIT

npx supabase status >/dev/null 2>&1 || { echo "Supabase Local is not running (npx supabase start)"; exit 1; }
npx supabase db reset --local >/dev/null
functions_up

status=0
SOLVEEDU_API_URL="$API_URL" \
SOLVEEDU_JWT_SECRET="$JWT_SECRET" \
SOLVEEDU_API_KEY="$PUBLISHABLE_KEY" \
SOLVEEDU_CRON_SECRET="$CRON_SECRET" \
FAKE_GOOGLE_PORT="$FAKE_GOOGLE_PORT" \
FAKE_GOOGLE_EMAIL="$FAKE_GOOGLE_EMAIL" \
FAKE_GOOGLE_PUBLIC_KEY_FILE="$WORK/sa.pub.pem" \
  npx vitest run tests/functions --no-file-parallelism || status=$?  # the files share the demo task
if [ $status -ne 0 ]; then echo "--- function log ---"; tail -40 "$LOG_FILE"; fi
npx supabase db reset --local >/dev/null
exit $status

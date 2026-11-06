#!/usr/bin/env bash
# Edge Function tests against Supabase LOCAL only.
#   - serves supabase/functions with a one-off random CRON_SECRET (temp file,
#     mode 600, deleted on exit; never written into the repo)
#   - resets the local database before and after (the tests change demo data)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

eval "$(npx supabase status -o env 2>/dev/null | grep -E '^(API_URL|JWT_SECRET|PUBLISHABLE_KEY)=')"
case "${API_URL:-}" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Refusing: API_URL '${API_URL:-}' is not a local Supabase"; exit 1 ;;
esac

ENV_FILE="$(mktemp)"
LOG_FILE="$(mktemp)"
chmod 600 "$ENV_FILE"
CRON_SECRET="$(openssl rand -hex 32)"
printf 'CRON_SECRET=%s\n' "$CRON_SECRET" > "$ENV_FILE"
SERVE_PID=""
cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

npx supabase db reset --local >/dev/null
npx supabase functions serve --env-file "$ENV_FILE" >"$LOG_FILE" 2>&1 &
SERVE_PID=$!
# ready = the function answers. GET is refused (405) before any secret
# check, so readiness never depends on the behaviour under test.
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X GET "$API_URL/functions/v1/cleanup-task-files" || true)"
  [ "$code" = "405" ] && break
  sleep 2
done
if [ "${code:-}" != "405" ]; then
  echo "Edge Functions did not start (last status: ${code:-none}). Log:"; cat "$LOG_FILE"; exit 1
fi

status=0
SOLVEEDU_API_URL="$API_URL" \
SOLVEEDU_JWT_SECRET="$JWT_SECRET" \
SOLVEEDU_API_KEY="$PUBLISHABLE_KEY" \
SOLVEEDU_CRON_SECRET="$CRON_SECRET" \
  npx vitest run tests/functions || status=$?
if [ $status -ne 0 ]; then echo "--- function log ---"; tail -40 "$LOG_FILE"; fi
rm -f "$LOG_FILE"
npx supabase db reset --local >/dev/null
exit $status

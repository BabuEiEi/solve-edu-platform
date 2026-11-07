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

WORK="$(mktemp -d)"
chmod 700 "$WORK"
ENV_FILE="$WORK/functions.env"
LOG_FILE="$WORK/serve.log"
CRON_SECRET="$(openssl rand -hex 32)"
# A throwaway service-account key for the FAKE Google (tests/fake-google.js);
# the Edge runtime reaches the fake on this machine via host.docker.internal.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORK/sa.pem" 2>/dev/null
openssl pkey -in "$WORK/sa.pem" -pubout -out "$WORK/sa.pub.pem"
FAKE_GOOGLE_PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
FAKE_GOOGLE_EMAIL="copier@solveedu-test.iam.gserviceaccount.example.test"
FAKE="http://host.docker.internal:$FAKE_GOOGLE_PORT"
SA_JSON="$(node -e "console.log(JSON.stringify({type:'service_account',client_email:process.argv[1],private_key:require('fs').readFileSync(process.argv[2],'utf8')}))" "$FAKE_GOOGLE_EMAIL" "$WORK/sa.pem")"
{
  printf 'CRON_SECRET=%s\n' "$CRON_SECRET"
  printf "GOOGLE_SERVICE_ACCOUNT_JSON='%s'\n" "$SA_JSON"
  printf 'GOOGLE_DRIVE_FOLDER_ID=rootFolder0001\n'
  printf 'GOOGLE_TOKEN_URL=%s/token\nGOOGLE_DRIVE_API=%s/drive/v3\nGOOGLE_DRIVE_UPLOAD=%s/upload/drive/v3\n' "$FAKE" "$FAKE" "$FAKE"
  printf 'ALLOWED_ORIGINS=http://127.0.0.1:5173\n'
} > "$ENV_FILE"
chmod 600 "$ENV_FILE" "$WORK/sa.pem"
SERVE_PID=""
cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null || true
  rm -rf "$WORK"
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
FAKE_GOOGLE_PORT="$FAKE_GOOGLE_PORT" \
FAKE_GOOGLE_EMAIL="$FAKE_GOOGLE_EMAIL" \
FAKE_GOOGLE_PUBLIC_KEY_FILE="$WORK/sa.pub.pem" \
  npx vitest run tests/functions --no-file-parallelism || status=$?  # the files share the demo task
if [ $status -ne 0 ]; then echo "--- function log ---"; tail -40 "$LOG_FILE"; fi
npx supabase db reset --local >/dev/null
exit $status

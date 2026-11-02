#!/usr/bin/env bash
# Integration test: frontend service layer → PostgREST → RLS, on a LOCAL database.
# Requires a PostgREST binary (POSTGREST_BIN) when `supabase start` is unavailable.
#   POSTGREST_BIN=/path/to/postgrest scripts/db-local/test-rest.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB=solveedu_rest
PORT="${REST_PORT:-3300}"
SECRET="local-only-test-secret-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PASS="local-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BIN="${POSTGREST_BIN:?set POSTGREST_BIN to a PostgREST v12+ binary}"

"$ROOT/scripts/db-local/reset.sh" "$DB" >/dev/null
psql -X -q -d "$DB" -c "alter role authenticator with login password '$PASS';"

CONF="$(mktemp)"
cat > "$CONF" <<CFG
db-uri = "postgres://authenticator:$PASS@127.0.0.1:5432/$DB"
db-schemas = "public"
db-anon-role = "anon"
db-extra-search-path = "public, extensions"
jwt-secret = "$SECRET"
server-host = "127.0.0.1"
server-port = $PORT
CFG
"$BIN" "$CONF" > "$(mktemp)" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -f "$CONF"' EXIT
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.2; done

SOLVEEDU_REST_URL="http://127.0.0.1:$PORT" SOLVEEDU_JWT_SECRET="$SECRET" \
  npx vitest run tests/integration

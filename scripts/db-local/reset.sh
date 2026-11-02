#!/usr/bin/env bash
# Rebuild a throw-away LOCAL database from: shim → migrations → seed.
# Usage: scripts/db-local/reset.sh [dbname]   (default: solveedu_local)
# Requires a local PostgreSQL 15+ superuser connection (PGHOST/PGUSER or sudo -u postgres).
# This script NEVER touches a remote/linked Supabase project.
set -euo pipefail
DB="${1:-solveedu_local}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL="${PSQL:-psql}"
run() { $PSQL -X -v ON_ERROR_STOP=1 -q "$@"; }

case "$DB" in *prod*|*production*) echo "Refusing to reset a database named '$DB'"; exit 1;; esac

run -d postgres -c "drop database if exists \"$DB\" with (force);"
run -d postgres -c "create database \"$DB\";"
sed "s/current_database_placeholder/\"$DB\"/" "$ROOT/scripts/db-local/supabase_shim.sql" | run -d "$DB"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "  migrate  $(basename "$f")"
  run -d "$DB" -f "$f"
done
echo "  seed     supabase/seed.sql"
run -d "$DB" -f "$ROOT/supabase/seed.sql"
echo "OK: $DB rebuilt"

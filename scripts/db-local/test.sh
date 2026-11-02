#!/usr/bin/env bash
# Run pgTAP files in supabase/tests against a freshly reset LOCAL database.
# Mirrors `supabase test db` (which uses pg_prove) when Docker is unavailable.
set -uo pipefail
DB="${1:-solveedu_test}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL="${PSQL:-psql}"
"$ROOT/scripts/db-local/reset.sh" "$DB" >/dev/null || { echo "reset failed"; exit 1; }
$PSQL -X -q -d "$DB" -c "create extension if not exists pgtap with schema extensions;" >/dev/null

total=0; failed=0; files_failed=0
for f in "$ROOT"/supabase/tests/*.sql; do
  out="$($PSQL -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1)"; rc=$?
  ok=$(grep -cE '^ok ' <<<"$out"); nok=$(grep -cE '^not ok ' <<<"$out")
  plan=$(grep -oE '^1\.\.[0-9]+' <<<"$out" | head -1 | cut -d. -f3)
  total=$((total+ok+nok)); failed=$((failed+nok))
  status="PASS"
  if [[ $rc -ne 0 || $nok -gt 0 || -z "$plan" || $((ok+nok)) -ne ${plan:-0} ]]; then
    status="FAIL"; files_failed=$((files_failed+1))
    grep -E '^not ok|^#|ERROR|psql:' <<<"$out" | head -40
  fi
  printf '%-4s %-48s %3s/%-3s\n' "$status" "$(basename "$f")" "$ok" "${plan:-?}"
done
echo "----"
echo "assertions: $total, failed: $failed, files failed: $files_failed"
[[ $failed -eq 0 && $files_failed -eq 0 ]]

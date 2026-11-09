#!/usr/bin/env bash
# Browser tests (Playwright) against Supabase LOCAL, with the Edge Functions
# served too (see functions-up.sh) so the Google Drive button can be tested
# end to end against the fake Google that the spec itself starts.
#   usage: test-e2e.sh chromium|webkit-iphone [playwright args…]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PROJECT="${1:?usage: test-e2e.sh chromium|webkit-iphone [playwright args…]}"
shift
# shellcheck source=functions-up.sh
. "$ROOT/scripts/supabase-local/functions-up.sh"
trap functions_down EXIT

npx supabase db reset --local >/dev/null
functions_up

status=0
# the Drive copy is hidden in production (no Shared Drive); its spec needs the button
VITE_DRIVE_EXPORT=true \
FAKE_GOOGLE_PORT="$FAKE_GOOGLE_PORT" \
FAKE_GOOGLE_EMAIL="$FAKE_GOOGLE_EMAIL" \
FAKE_GOOGLE_PUBLIC_KEY_FILE="$WORK/sa.pub.pem" \
  npx playwright test --project="$PROJECT" "$@" || status=$?
if [ $status -ne 0 ]; then echo "--- function log (tail) ---"; tail -20 "$LOG_FILE"; fi
exit $status

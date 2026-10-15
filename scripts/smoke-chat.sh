#!/usr/bin/env bash
# Scripted end-to-end test of the chat engine.
#
# Usage: scripts/smoke-chat.sh <book-hash> "<step>|<step>|..." [seconds]
#
# A step is a question, unless it starts with a verb:
#   newconv       start a new conversation
#   delete        delete the current conversation
#   book:<hash>   switch book without leaving the app
#   model:<id>    change model mid-conversation
#   abort         stop the engine
#   wait:<ms>     pause
#   page:<n>      go to page n of a PDF
#   select:<page>:<start>...<end>
#                 attach the passage of that page running from <start> to <end>
#                 (spaces ignored), as Ask AI does; its image is logged in chunks
#   toggleimg:<k> / remove:<k> / clear
#                 act on pending passage k, or on all of them
#
# Prints the engine events and the scenario trace. Uses the real subscription.
set -u
. "$(dirname "$0")/test-process.sh"
HASH="${1:?book hash}"; SCRIPT="${2:?steps}"; WAIT="${3:-120}"
BIN="${MARGINALIA_TEST_BINARY:-$(cd "$(dirname "$0")/.." && pwd)/app/src-tauri/target/release/Marginalia}"
OUT="${MARGINALIA_TEST_LOG:-$(mktemp /tmp/smoke-chat.XXXXXX.log)}"
MARGINALIA_PERF_OPEN="$HASH" MARGINALIA_SMOKE_ASK="$SCRIPT" start_test_process "$BIN"
for _ in $(seq "$WAIT"); do
  grep -aq "smoke: scenario done" "$OUT" && break
  sleep 1
done
sleep 2
stop_test_process
if ! grep -aq 'smoke: scenario done' "$OUT"; then
  echo "Scénario inachevé. Journal: $OUT" >&2
  exit 1
fi
echo "=== trace ==="
grep -aE "smoke: |engine event: " "$OUT" |
  sed -E 's/^.*\[js\] console\.(info|warn|error): //' | cut -c1-220
echo "=== erreurs ==="
grep -aE "\[js\] console\.(warn|error)|claude:" "$OUT" | grep -v "cover.png" | cut -c1-220 | head -10
echo "(journal: $OUT)"

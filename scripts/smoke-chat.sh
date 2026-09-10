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
#
# Prints the engine events and the scenario trace. Uses the real subscription.
set -u
HASH="${1:?book hash}"; SCRIPT="${2:?steps}"; WAIT="${3:-120}"
BIN="$(cd "$(dirname "$0")/.." && pwd)/app/src-tauri/target/release/Marginalia"
OUT=$(mktemp /tmp/smoke-chat.XXXXXX.log)
pkill -x Marginalia 2>/dev/null; sleep 1
MARGINALIA_PERF_OPEN="$HASH" MARGINALIA_SMOKE_ASK="$SCRIPT" "$BIN" > "$OUT" 2>&1 &
PID=$!
for _ in $(seq "$WAIT"); do
  grep -aq "smoke: scenario done" "$OUT" && break
  sleep 1
done
sleep 2
kill "$PID" 2>/dev/null; sleep 1; pkill -x Marginalia 2>/dev/null
echo "=== trace ==="
grep -aE "smoke: |engine event: " "$OUT" |
  sed -E 's/^.*\[js\] console\.(info|warn|error): //' | cut -c1-220
echo "=== erreurs ==="
grep -aE "\[js\] console\.(warn|error)|claude:" "$OUT" | grep -v "cover.png" | cut -c1-220 | head -10
echo "(journal: $OUT)"

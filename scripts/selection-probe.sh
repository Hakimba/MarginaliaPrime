#!/usr/bin/env bash
# Replays scripted mouse selections on a page of a book and prints, for each,
# what should be selected and what actually is.
#
#   scripts/selection-probe.sh <book-hash> <page> [seconds]
#
# Cases: a word, the same word with a shaky hand, a whole line, three lines, a
# line flanked by a marginal note, the note itself.  It exercises the reader's
# own selection path; the feel of a real drag still has to be judged by hand.
set -u
. "$(dirname "$0")/test-process.sh"
HASH="${1:?book hash}"; PAGE="${2:?page number}"; WAIT="${3:-60}"
BIN="${MARGINALIA_TEST_BINARY:-$(cd "$(dirname "$0")/.." && pwd)/app/src-tauri/target/release/Marginalia}"
OUT="${MARGINALIA_TEST_LOG:-$(mktemp /tmp/selection-probe.XXXXXX.log)}"
MARGINALIA_PERF_OPEN="$HASH" MARGINALIA_SELECT_TEST="$PAGE" start_test_process "$BIN"
for _ in $(seq "$WAIT"); do
  grep -aq "\[sel\] probe done" "$OUT" && break
  sleep 1
done
sleep 1
stop_test_process
if ! grep -aq '\[sel\] probe done' "$OUT"; then
  echo "Sonde de sélection inachevée. Journal: $OUT" >&2
  exit 1
fi
echo "=== sélections ==="
grep -a "\[sel\]" "$OUT" | sed -E 's/^.*\[js\] console\.(info|warn|error): //' | cut -c1-400
echo "=== erreurs ==="
grep -aE "\[js\] console\.(warn|error)" "$OUT" | grep -v "cover.png" | cut -c1-200 | head -5
echo "(journal: $OUT)"

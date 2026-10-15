#!/usr/bin/env bash
# Usage: scripts/perf-run.sh <label> <binary> [book-path] [seconds-to-wait]
#   MARGINALIA_PERF_OPEN=<book hash> scripts/perf-run.sh "click path" app/src-tauri/target/release/Marginalia "" 20
# Launches the app (optionally with a book), waits, kills it, and prints the [perf] marks
# (see app/src/utils/perf.ts) with times in ms relative to process start.
set -u
. "$(dirname "$0")/test-process.sh"
LABEL="$1"; BIN="$2"; FILE="${3:-}"; WAIT="${4:-25}"
OUT="${MARGINALIA_TEST_LOG:-$(mktemp /tmp/marginalia-perf.XXXXXX.log)}"
T0=$(date +%s%3N)
if [ -n "$FILE" ]; then MARGINALIA_PERF=1 start_test_process "$BIN" "$FILE"; else MARGINALIA_PERF=1 start_test_process "$BIN"; fi
sleep "$WAIT"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "Application arrêtée avant la fin de l'essai. Journal: $OUT" >&2
  exit 1
fi
stop_test_process
echo "### $LABEL  (process start epoch ms = $T0)"
if ! grep -aq '\[perf\]' "$OUT"; then
  echo "Aucune mesure de performance. Journal: $OUT" >&2
  exit 1
fi
if grep -aE '\[ERROR\]|console.error:|unhandled rejection' "$OUT" | grep -v 'cover.png' >&2; then
  exit 1
fi
EXPECTED="${MARGINALIA_PERF_EXPECT:-library:ready}"
if [ -n "$FILE" ] || [ -n "${MARGINALIA_PERF_OPEN:-}" ]; then EXPECTED="${MARGINALIA_PERF_EXPECT:-book:first-relocate}"; fi
grep -a "\[perf\]" "$OUT" | python3 -c "
import sys, json, re
t0=int(sys.argv[1]); expected=sys.argv[2]; origin=None
rows=[]
for line in sys.stdin:
    m=re.search(r'\[perf\] (\S+) (\{.*\})', line)
    if not m: continue
    name=m.group(1); d=json.loads(m.group(2))
    if 'timeOrigin' in d: origin=d['timeOrigin']
    elif 'origin' in d: origin=d['origin']
    rows.append((name,d))
if not any(name == expected for name,d in rows) or any(name == 'perf:trace-limit' for name,d in rows):
    sys.exit('Essai incomplet ou traces tronquées')
if expected == 'book:first-relocate' and any(d.get('layout') == 'pre-paginated' for name,d in rows if name == 'book:parse'):
    if not any(name == 'pdf:spread-ready' and d.get('renders') and all(r and r.get('status') == 'completed' for r in d['renders']) for name,d in rows):
        sys.exit('Aucune double page PDF entièrement rendue')
for name,d in rows:
    t=d.get('t',0)
    abs_ms = (origin + t - t0) if origin else None
    extra={k:v for k,v in d.items() if k not in ('t','origin')}
    print(f'{(abs_ms if abs_ms is not None else t):>8} ms  {name:22s} {json.dumps(extra, ensure_ascii=False)}')
" "$T0" "$EXPECTED" || exit 1
grep -ac "\[perf\]" "$OUT" | sed 's/^/perf lines total: /'
echo "(journal: $OUT)"

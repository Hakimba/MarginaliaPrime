#!/usr/bin/env bash
# Usage: scripts/perf-run.sh <label> <binary> [book-path] [seconds-to-wait]
#   MARGINALIA_PERF_OPEN=<book hash> scripts/perf-run.sh "click path" app/src-tauri/target/release/Marginalia "" 20
# Launches the app (optionally with a book), waits, kills it, and prints the [perf] marks
# (see app/src/utils/perf.ts) with times in ms relative to process start.
set -u
LABEL="$1"; BIN="$2"; FILE="${3:-}"; WAIT="${4:-25}"
T0=$(date +%s%3N)
if [ -n "$FILE" ]; then "$BIN" "$FILE" >/tmp/perf_stdout_$$.txt 2>&1 & else "$BIN" >/tmp/perf_stdout_$$.txt 2>&1 & fi
PID=$!
sleep "$WAIT"
kill "$PID" 2>/dev/null; sleep 1; pkill -x "$(basename "$BIN")" 2>/dev/null
echo "### $LABEL  (process start epoch ms = $T0)"
grep -a "\[perf\]" /tmp/perf_stdout_$$.txt | python3 -c "
import sys, json, re
t0=int(sys.argv[1]); origin=None
rows=[]
for line in sys.stdin:
    m=re.search(r'\[perf\] (\S+) (\{.*\})', line)
    if not m: continue
    name=m.group(1); d=json.loads(m.group(2))
    if 'origin' in d: origin=d['origin']
    rows.append((name,d))
for name,d in rows:
    t=d.get('t',0)
    abs_ms = (origin + t - t0) if origin else None
    extra={k:v for k,v in d.items() if k not in ('t','origin')}
    print(f'{(abs_ms if abs_ms is not None else t):>8} ms  {name:22s} {json.dumps(extra, ensure_ascii=False)}')
" "$T0"
grep -ac "\[perf\]" /tmp/perf_stdout_$$.txt | sed 's/^/perf lines total: /'; rm -f /tmp/perf_stdout_$$.txt

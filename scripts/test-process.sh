#!/usr/bin/env bash

start_test_process() {
  setsid "$@" > "$OUT" 2>&1 &
  PID=$!
  trap stop_test_process EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

stop_test_process() {
  if [ -n "${PID:-}" ]; then
    kill -TERM -- "-$PID" 2>/dev/null || true
    sleep 0.3
    kill -KILL -- "-$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    PID=
  fi
}

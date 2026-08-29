#!/usr/bin/env bash
# 停止 Knee42 手語辨識服務。與 stop_0813.sh 同一套規矩：
# 先驗明 PID 真的是我們起的那支，才送 TERM，等不到再 KILL。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT/logs/knee42.pid"
mkdir -p "$ROOT/logs"
exec 9> "$ROOT/logs/knee42-lifecycle.lock"
flock 9

pid_matches() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local command
  command="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$command" == *"webservice.server"* ]]
}

if [[ -f "$PID_FILE" ]]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    if ! pid_matches "$pid"; then
      echo "Refusing to stop PID $pid: it is not the expected Knee42 process." >&2
      exit 1
    fi
    kill -TERM "$pid"
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if pid_matches "$pid"; then
      kill -KILL "$pid"
    fi
  fi
  rm -f "$PID_FILE"
fi

echo "Knee42 stopped."

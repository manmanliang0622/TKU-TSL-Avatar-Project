#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT/logs/bundle-server.pid"
MODEL_PID_FILE="$ROOT/logs/v11-model.pid"
mkdir -p "$ROOT/logs"
exec 9> "$ROOT/logs/lifecycle.lock"
flock 9

pid_matches() {
  local pid="$1"
  local expected="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local command
  command="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$command" == *"$expected"* ]]
}

stop_verified_pid() {
  local pid="$1"
  local expected="$2"
  local label="$3"
  if ! pid_matches "$pid" "$expected"; then
    echo "Refusing to stop PID $pid: it is not the expected $label process." >&2
    return 1
  fi
  kill -TERM "$pid"
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  if pid_matches "$pid" "$expected"; then
    kill -KILL "$pid"
  fi
}

if [[ -f "$PID_FILE" ]]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    stop_verified_pid "$pid" "$ROOT/bundle_server.py" "0813 bundle server"
  fi
  rm -f "$PID_FILE"
fi

if [[ -f "$MODEL_PID_FILE" ]]; then
  model_pid="$(tr -d '[:space:]' < "$MODEL_PID_FILE")"
  if kill -0 "$model_pid" 2>/dev/null; then
    stop_verified_pid "$model_pid" "$ROOT/model_service/scripts/serve_model.py" "0813 v11 model"
  fi
  rm -f "$MODEL_PID_FILE"
fi

echo "0813 stopped."

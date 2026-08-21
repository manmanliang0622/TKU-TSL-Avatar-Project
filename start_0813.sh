#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HOST="127.0.0.1"
PORT="${PORT:-8083}"
MODEL_PORT="${MODEL_PORT:-8877}"
START_TIMEOUT="${START_TIMEOUT:-360}"
PID_FILE="$ROOT/logs/bundle-server.pid"

mkdir -p "$ROOT/logs"
exec 9> "$ROOT/logs/lifecycle.lock"
flock 9
export PYTHONNOUSERSITE=1
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

required=(
  "$ROOT/.venv/bin/python3"
  "$ROOT/bundle_server.py"
  "$ROOT/model_service/base_model/config.json"
  "$ROOT/model_service/base_model/model.safetensors"
  "$ROOT/model_service/checkpoint/adapter_config.json"
  "$ROOT/model_service/checkpoint/adapter_model.safetensors"
  "$ROOT/model_service/scripts/serve_model.py"
)

for path in "${required[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "Missing required 0813 artifact: $path" >&2
    exit 1
  fi
done

pid_is_ours() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  local command
  command="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$command" == *"$ROOT/bundle_server.py"* ]]
}

wait_for_health() {
  local pid="$1"
  local deadline=$((SECONDS + START_TIMEOUT))
  while (( SECONDS < deadline )); do
    http_code="$(curl -sS -o "$ROOT/logs/last-health.json" -w '%{http_code}' \
      "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
    if [[ "$http_code" == "200" ]]; then
      cat "$ROOT/logs/last-health.json"
      echo
      echo "0813 is ready: http://$HOST:$PORT/"
      return 0
    fi
    if grep -q '"model_restart_exhausted": true' "$ROOT/logs/last-health.json" 2>/dev/null; then
      echo "0813 v11 model exhausted its bounded restart attempts." >&2
      cat "$ROOT/logs/last-health.json" >&2
      return 1
    fi
    if ! pid_is_ours "$pid"; then
      echo "0813 exited before becoming healthy." >&2
      tail -n 80 "$ROOT/logs/bundle-server.err.log" >&2 || true
      return 1
    fi
    sleep 2
  done
  echo "0813 did not become healthy within ${START_TIMEOUT}s." >&2
  "$ROOT/health_0813.sh" || true
  tail -n 80 "$ROOT/logs/v11-model.err.log" >&2 || true
  return 1
}

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if pid_is_ours "$existing_pid"; then
    echo "0813 is already running with PID $existing_pid."
    wait_for_health "$existing_pid"
    exit $?
  fi
fi

for busy_port in "$PORT" "$MODEL_PORT"; do
  if ss -ltnH "sport = :$busy_port" | grep -q .; then
    echo "Port $busy_port is already in use; refusing to start 0813." >&2
    exit 1
  fi
done

nohup "$ROOT/.venv/bin/python3" "$ROOT/bundle_server.py" \
  --host "$HOST" --port "$PORT" --model-port "$MODEL_PORT" \
  > "$ROOT/logs/bundle-server.log" \
  2> "$ROOT/logs/bundle-server.err.log" < /dev/null 9>&- &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"

echo "Starting self-contained 0813 with PID $pid..."
echo "The v11 model may take 10-60 seconds to load."
wait_for_health "$pid"
echo "Team tunnel: ssh -p 2288 -N -L 8083:127.0.0.1:8083 b310ai@163.13.202.125"

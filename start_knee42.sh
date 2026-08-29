#!/usr/bin/env bash
# 啟動 Knee42 手語辨識服務（https://github.com/Mikullee/Sign-Language-Recognition-Gemma）。
#
# 它是獨立 repo、獨立 venv（torch CPU 版），不併進 0813 的 .venv——
# 0813 那份只裝模型服務要用的套件，混裝 torch 2.13 會動到 Gemma 的相依。
# 只綁 loopback：對外一律經 bundle_server 的 /recognize/* 白名單轉發，
# 辨識服務自己的 /analyze_url（會對外抓影片）等端點不暴露。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

KNEE42_ROOT="${KNEE42_ROOT:-$HOME/Sign-Language-Recognition-Gemma}"
KNEE42_PORT="${KNEE42_PORT:-8642}"
START_TIMEOUT="${START_TIMEOUT:-120}"
PID_FILE="$ROOT/logs/knee42.pid"

mkdir -p "$ROOT/logs"
exec 9> "$ROOT/logs/knee42-lifecycle.lock"
flock 9

required=(
  "$KNEE42_ROOT/.venv/bin/python3"
  "$KNEE42_ROOT/webservice/server.py"
  "$KNEE42_ROOT/artifacts/realtime/best_current/best_model.pt"
  "$KNEE42_ROOT/artifacts/realtime/best_current/label_map_knee42.json"
  "$KNEE42_ROOT/artifacts/realtime/best_current/display_text_map.json"
)

for path in "${required[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "Missing required Knee42 artifact: $path" >&2
    echo "初次安裝：git clone 到 $KNEE42_ROOT，建立 .venv 並" >&2
    echo "  .venv/bin/pip install -r requirements-transformer.txt" >&2
    echo "（torch 用 CPU 版：--index-url https://download.pytorch.org/whl/cpu）" >&2
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
  [[ "$command" == *"webservice.server"* && "$command" == *"$KNEE42_ROOT"* ]]
}

wait_for_health() {
  local pid="$1"
  local deadline=$((SECONDS + START_TIMEOUT))
  while (( SECONDS < deadline )); do
    # 自簽憑證，-k 是預期行為（只打 loopback，不經網路）
    http_code="$(curl -sSk -o "$ROOT/logs/last-knee42-health.json" -w '%{http_code}' \
      "https://127.0.0.1:$KNEE42_PORT/health" 2>/dev/null || true)"
    if [[ "$http_code" == "200" ]]; then
      cat "$ROOT/logs/last-knee42-health.json"
      echo
      echo "Knee42 is ready on https://127.0.0.1:$KNEE42_PORT/ (loopback only)."
      echo "前端入口：bundle_server 的 /recognize/*（線上站走 /api/recognize/*）"
      return 0
    fi
    if ! pid_is_ours "$pid"; then
      echo "Knee42 exited before becoming healthy." >&2
      tail -n 60 "$ROOT/logs/knee42.err.log" >&2 || true
      return 1
    fi
    sleep 2
  done
  echo "Knee42 did not become healthy within ${START_TIMEOUT}s." >&2
  tail -n 60 "$ROOT/logs/knee42.err.log" >&2 || true
  return 1
}

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if pid_is_ours "$existing_pid"; then
    echo "Knee42 is already running with PID $existing_pid."
    wait_for_health "$existing_pid"
    exit $?
  fi
fi

if ss -ltnH "sport = :$KNEE42_PORT" | grep -q .; then
  echo "Port $KNEE42_PORT is already in use; refusing to start Knee42." >&2
  exit 1
fi

# cwd 必須是 Knee42 自己的 repo：webservice.server 以相對路徑找
# configs/auto_trigger_knee_v1.json 與 artifacts/。subshell 只為了 cd，
# PID 在裡面寫進檔案，外面再讀回來。
(
  cd "$KNEE42_ROOT"
  nohup "$KNEE42_ROOT/.venv/bin/python3" -m webservice.server \
    --host 127.0.0.1 --port "$KNEE42_PORT" \
    > "$ROOT/logs/knee42.log" \
    2> "$ROOT/logs/knee42.err.log" < /dev/null 9>&- &
  printf '%s\n' "$!" > "$PID_FILE"
)
pid="$(tr -d '[:space:]' < "$PID_FILE")"

echo "Starting Knee42 recognizer with PID $pid (model loads in a few seconds)..."
wait_for_health "$pid"

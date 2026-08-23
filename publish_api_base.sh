#!/usr/bin/env bash
# 把目前的 tunnel 網址寫進 Cloudflare KV，前端的 Pages Function
# （functions/api/[[path]].js）會讀這個值決定要轉去哪。
#
# 這支取代舊流程裡「改 signavatar-config.js → push GitHub → 等 Pages 重建」
# 那一段：KV 是秒級生效，repo 完全不用動，deploy key 也可以收掉。
#
#     ./publish_api_base.sh https://xxxx.trycloudflare.com
#     ./publish_api_base.sh --force https://xxxx.trycloudflare.com
#
# 認證放在 ~/.tsl-cf-kv.env（chmod 600，不要進版控）：
#     CF_ACCOUNT_ID=...
#     CF_KV_NAMESPACE_ID=...
#     CF_KV_TOKEN=...        # API token，權限只勾 Workers KV Storage:Edit
#
# KV 免費方案每天只有 1000 次寫入，而 autopublish 是每 2 分鐘跑一次
# （720 次/天）——所以預設「值沒變就不寫」，只有真的換址才動 KV。

set -euo pipefail

KEY="${CF_KV_KEY:-apiBase}"
ENV_FILE="${CF_KV_ENV_FILE:-$HOME/.tsl-cf-kv.env}"
STATE_FILE="${CF_KV_STATE_FILE:-$HOME/.cache/tsl-api-base}"
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=1; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

url="${1:-}"
if [[ -z "$url" ]]; then
  echo "usage: $0 [--force] <https://tunnel-url>" >&2
  exit 2
fi
url="${url%/}"
if [[ ! "$url" =~ ^https://[A-Za-z0-9._-]+(:[0-9]+)?$ ]]; then
  echo "refusing to publish a non-https or malformed origin: $url" >&2
  exit 2
fi

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

for var in CF_ACCOUNT_ID CF_KV_NAMESPACE_ID CF_KV_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    echo "missing $var (set it in $ENV_FILE)" >&2
    exit 1
  fi
done

if [[ "$force" -eq 0 && -f "$STATE_FILE" ]] && [[ "$(cat "$STATE_FILE")" == "$url" ]]; then
  echo "apiBase unchanged ($url); not touching KV."
  exit 0
fi

api="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${KEY}"
response="$(curl -sS --max-time 30 -X PUT "$api" \
  -H "Authorization: Bearer ${CF_KV_TOKEN}" \
  -H "Content-Type: text/plain" \
  --data-raw "$url")" || {
    echo "KV write failed: curl error" >&2
    exit 1
  }

# 成功與否只認 API 回應裡的 success，HTTP 200 配 success:false 是有的
if ! printf '%s' "$response" | grep -q '"success":[[:space:]]*true'; then
  echo "KV write rejected: $response" >&2
  exit 1
fi

mkdir -p "$(dirname "$STATE_FILE")"
printf '%s\n' "$url" > "$STATE_FILE"
echo "apiBase → $url"

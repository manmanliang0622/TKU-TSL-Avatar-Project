#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8083}"
mkdir -p "$ROOT/logs"
body_file="$(mktemp "$ROOT/logs/health.XXXXXX")"
trap 'rm -f "$body_file"' EXIT

http_code="$(curl -sS -o "$body_file" -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true)"
cat "$body_file"
echo
echo "HTTP $http_code"
[[ "$http_code" == "200" ]]


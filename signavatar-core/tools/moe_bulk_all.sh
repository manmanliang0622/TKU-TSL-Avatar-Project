#!/bin/bash
# 教育部常用手語辭典 — 全量補詞批次檔
#
# 一次執行,分塊把 MOE 辭典的缺詞全部載回來:
#   每塊下載 CHUNK 個詞(YouTube 下載間隔 ~6 秒抖動,防封鎖),
#   塊與塊之間休息 REST_MIN 分鐘,直到沒有新詞可補為止。
#   任何時候 Ctrl-C 中斷,之後重跑會自動接續(已下載的檔案會跳過)。
#
# 用法:
#   ./tools/moe_bulk_all.sh                 # 預設每塊 300 詞、休息 10 分鐘
#   ./tools/moe_bulk_all.sh 200 15          # 每塊 200 詞、休息 15 分鐘
#   caffeinate -i ./tools/moe_bulk_all.sh   # macOS 防睡眠(建議長跑時用)
#
# 全量約 7,700+ 詞,含休息預估 15-20 小時;分幾天跑也完全沒問題。
set -u
CHUNK="${1:-300}"
REST_MIN="${2:-10}"
cd "$(dirname "$0")/.."

LOG="recordings/moe_bulk_all.log"
count_lexicon() {
  python3 -c "import json; print(len(json.load(open('recordings/lexicon.json'))))"
}

echo "[moe_bulk_all] 開始:每塊 ${CHUNK} 詞,休息 ${REST_MIN} 分鐘(log: ${LOG})"
round=1
while true; do
  before=$(count_lexicon)
  echo "[moe_bulk_all] 第 ${round} 塊(目前詞庫 ${before} 條)$(date '+%H:%M')" | tee -a "$LOG"
  uv run signavatar moe bulk --limit "$CHUNK" --delay 6 --dir recordings 2>&1 |
    grep -v "clearcut\|W0000\|E0000\|I0000\|portable\|Source Location" | tee -a "$LOG"
  after=$(count_lexicon)
  echo "[moe_bulk_all] 詞庫 ${before} → ${after}" | tee -a "$LOG"
  if [ "$after" -le "$before" ]; then
    echo "[moe_bulk_all] 沒有新詞進帳(補完了,或下載連續失敗=可能被暫時限流)。" | tee -a "$LOG"
    echo "[moe_bulk_all] 若是限流,幾小時後重跑本腳本即可接續。結束。" | tee -a "$LOG"
    break
  fi
  echo "[moe_bulk_all] 休息 ${REST_MIN} 分鐘(防 YouTube 封鎖)…" | tee -a "$LOG"
  sleep "$((REST_MIN * 60))"
  round=$((round + 1))
done

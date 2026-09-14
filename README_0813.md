# 0813 完整整合專案

`0813` 內含 0812 前端、後端、3D avatar 與動作資料，以及可離線載入的 Gemma 基礎模型、v11 adapter 和 Python 環境。執行時不依賴原本的專案或 Hugging Face 快取。

## 在學校電腦啟動

```bash
cd /home/b310ai/0813
./start_0813.sh
```

健康檢查：

```bash
cd /home/b310ai/0813
./health_0813.sh
```

停止：

```bash
cd /home/b310ai/0813
./stop_0813.sh
```

## 組員從自己的電腦開啟

每位組員在自己的電腦建立 SSH tunnel：

```bash
ssh -N -L 8083:127.0.0.1:8083 tku-gpu   # tku-gpu：自己 ~/.ssh/config 裡的主機別名
```

保持該終端機開啟，再用瀏覽器進入：

```text
http://127.0.0.1:8083/
```

若組員自己的 8083 已被占用，可改用不同的本機連接埠，例如 `-L 18083:127.0.0.1:8083`，並開啟 `http://127.0.0.1:18083/`。

## 服務介面

- `GET /`：前端首頁
- `GET /health`：前端與 v11 模型健康狀態
- `POST /translate`：中文轉臺灣手語 Gloss（同一句第二次直接回快取，不重跑模型）
- `GET /clip?name=&start=&end=`：單一詞條的動作片段
- `POST /clips`：整句一次要（body `{"items":[{name,start,end}, ...]}`），
  回 `{"clips":[...], "missing":[...]}`，順序與送出的一致

所有執行日誌與 PID 都位於 `logs/`。

## 線上站怎麼找到這台（固定 API 入口）

cloudflared quick tunnel 每次重拉網址都會變。舊做法是讓 autopublish 改
`signavatar-config.js`、push 上 GitHub、等 Pages 重新部署——偵測到換址算起
三到五分鐘，這期間前端手上是死網址，`/clips` 打不到，虛擬人完全不動。

現在前端一律打同源的 `/api/*`，由 `functions/api/[[path]].js`（Cloudflare
Pages Function）轉給這台；真正的 tunnel 網址只存在 Workers KV。換通道時
repo 完全不用動，秒級生效，順帶因為同源，CORS 也不需要了。

只轉白名單內的 `translate`／`clips`／`clip`／`health`——這台同時也在服務
`models/`、`recordings/`、`vendor/`，不設白名單那支 proxy 會變成整台機器的
公開跳板。

一次性設定（Cloudflare 儀表板）：

1. Workers & Pages → KV → 建一個 namespace（例如 `tsl-config`）。
2. Pages 專案 → Settings → Bindings → 加 KV namespace，變數名 **`TSL_CONFIG`**。
3. My Profile → API Tokens → 建 token，權限只勾 **Workers KV Storage : Edit**。

學校這台加一個 `~/.tsl-cf-kv.env`（`chmod 600`，不進版控）：

```
CF_ACCOUNT_ID=...
CF_KV_NAMESPACE_ID=...
CF_KV_TOKEN=...
```

然後 `autopublish.sh` 起完 cloudflared、拿到新網址之後呼叫：

```bash
/path/to/publish_api_base.sh "$TUNNEL_URL"
```

KV 免費方案每天只有 1000 次寫入，而 autopublish 是每 2 分鐘跑一次
（720 次/天），所以 `publish_api_base.sh` 預設「值沒變就不寫」，只有真的
換址才動 KV。它不會開背景行程，`9>&-` 那條規矩用不到。

KV 讀不到（還沒設好、namespace 被清掉）時，Function 會退回自己檔頭的
`FALLBACK_ORIGIN`，站台不會整個掛掉。

要確認 KV 真的有被讀到，看回應標頭 —— binding 名字打錯時會安靜地退回
保底值，而保底值多半就是當下能用的網址，光看有沒有回 200 分不出來：

```bash
curl -sI https://signbridge-2co.pages.dev/api/health | grep -i x-tsl-api-base-source
```

`kv` 才是正常。`fallback` 代表 Function 沒讀到 KV —— 多半是 Pages 的
binding 變數名不叫 `TSL_CONFIG`，或 Production／Preview 只加了一邊。

## 手語辨識（Knee42，Sign-Language-Recognition-Gemma）

辨識方向（手語 → 文字）用的是
[Mikullee/Sign-Language-Recognition-Gemma](https://github.com/Mikullee/Sign-Language-Recognition-Gemma)
的 Knee42 Transformer（42 句固定詞句、CPU 推論），跑在學校這台上，
與 0813 的 Gemma 完全分開：獨立 repo、獨立 venv、獨立 port（8642，只綁 loopback）。

### 初次安裝（學校電腦，一次性）

```bash
cd ~
git clone https://github.com/Mikullee/Sign-Language-Recognition-Gemma
cd Sign-Language-Recognition-Gemma
python3 -m venv .venv
.venv/bin/pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -r requirements-transformer.txt
```

模型 bundle（`artifacts/realtime/best_current/`）repo 內附，不必另外下載。
MediaPipe 的 `.task` 檔與網頁資產**都不需要**：骨架抽取在使用者的瀏覽器做
（本專案自己載 CDN 的 hand + pose landmarker），送到伺服器的只有座標。

裝在別的位置就設 `KNEE42_ROOT` 再跑啟動腳本。

### 日常啟動／停止

```bash
cd /home/b310ai/0813
./start_knee42.sh    # 冪等：已在跑就只做健康檢查
./stop_knee42.sh
```

日誌與 PID 一樣在 `logs/`（`knee42.log`、`knee42.err.log`、`knee42.pid`）。
辨識服務掛了不影響翻譯與虛擬人；反過來也一樣。

### 前端怎麼打到它

瀏覽器永遠不直連 8642。路徑跟 `/translate` 同一套：

- 學校主機／tunnel 直開：`bundle_server` 的 `/recognize/*`（白名單轉發到 8642）
- 線上站（pages.dev）：同源 `/api/recognize/*` → Pages Function → tunnel → `bundle_server`

只轉 `predict`／`stream`／`health`／`labels` 四條。辨識服務還有
`/analyze_url`（會 shell 出 yt-dlp 對外抓影片）、`/analyze_upload` 等端點，
刻意不轉——上傳影片在前端就地抽骨架走 `/predict`，影片檔不必離開瀏覽器。

兩種輸入的分工：

- **即時攝影機**：每 400ms 把累積的骨架送 `/recognize/stream`，起訖判定
  （校準過的七百行狀態機）在伺服器上，比完把手放回身側就自動出結果。
- **上傳影片**：影片播一次、逐格抽骨架，整段送 `/recognize/predict`，
  伺服器切段＋逐段推論；單句影片常切不出段，整段結果才是答案。

辨識出的句子會再丟回 Gemma `/translate` 取手語語序（伺服器端有快取），
Gemma 離線就退回內建對照表——語序列是輔助顯示，不卡辨識結果。

### 健康檢查

```bash
curl -k https://127.0.0.1:8642/health          # 辨識服務本體
curl http://127.0.0.1:8083/recognize/health    # 經 bundle_server 轉發
curl https://signbridge-2co.pages.dev/api/recognize/health   # 線上站全鏈路
```

前端連不到時會明講「請確認學校電腦已跑 start_knee42.sh」，不會退回假資料。

### 已知限制（照實講給使用者聽）

- 42 句是封閉集合，詞表外的手語一定會亂答；信心低於 50% 前端會標「信心不足」。
- 模型 gate 是 PROVISIONAL，跨手語者準確率 72.9%–86.1%。

## 為什麼前端不直接抓 recordings/

一個詞條是整支錄影檔裡的 0.3～3 秒：「我」是 `moc_G2D1P1.json`（11.5 MB、
2050 格）裡的 19 格。前端原本為了那 19 格把整支檔案抓下來，一句三個詞就是
33 MB、六秒鐘——十一秒的等待裡有六秒在這。

現在 `composer.js` 改走 `/clips`，伺服器切好再送（同一句約 0.2 秒）。
切片存在 `clip_cache/`（gzip，用 `recording|start|end` 的 SHA-1 當檔名），
**不對外供檔**，也不入版控——刪掉只是下次重切，不會掉資料。

靜態託管（Cloudflare Pages）沒有這個端點，`composer.js` 會自動退回原本
抓整支檔案的路徑，功能不變，只是慢。

### 先把切片切好（選用）

伺服器遇到沒切過的詞會當場切（讀一次原檔，10-80 MB 約 0.2-1 秒），切完就
進快取。要讓第一個使用者也不必等，先跑一次：

```bash
cd /home/b310ai/0813
.venv/bin/python3 prewarm_clips.py
```

全部 16,063 個詞條約 8 分鐘、1.6 GB。可中斷續跑（已切過的會跳過）。

## 擴充詞庫（資料爬取）

詞庫來源與授權狀態全部登記在 `signavatar-core/docs/data-sources.md`，
逐筆出處在 `recordings/lexicon.json`（`source` 欄位）與
`recordings/external_manifest.json`。

`0813` 的 `.venv` 只裝了模型服務要用的套件，沒有 MediaPipe；
爬取／萃取要借用 `~/SignAvatar-main/.venv`，並用 `PYTHONPATH`
指回本專案的 `signavatar-core`，確保跑的是這份程式碼：

```bash
cd /home/b310ai/0813/signavatar-core
PYTHONPATH=/home/b310ai/0813/signavatar-core/src \
  ~/SignAvatar-main/.venv/bin/python -m signavatar.cli placenames bulk \
  --dir /home/b310ai/0813/recordings --workers 6
```

需要下載 YouTube 影片的來源（教育部辭典、TASLI 新詞網）還要 `yt-dlp`，
**用 0813 自己那份**，並把它放進 PATH：

```bash
PATH=/home/b310ai/0813/.venv/bin:$PATH PYTHONPATH=/home/b310ai/0813/signavatar-core/src \
  ~/SignAvatar-main/.venv/bin/python -m signavatar.cli tasli bulk \
  --dir /home/b310ai/0813/recordings --workers 4
```

（`~/SignAvatar-main/.uv-tools/` 裡那份 yt-dlp **不能用** —— 整包是從某人的 Mac
複製過來的，shebang 指向 `/Users/kiki/...`，連裡面的 python 都是 macOS 執行檔。）

台灣手語地名網（1000 個地名）的兩個步驟：

- `placenames fetch`：爬全站 metadata → `recordings/placenames.json`
  （含逐字素構詞分析；重跑下載時不必再爬一次）
- `placenames bulk`：下載影片 → MediaPipe 萃取 → 寫入詞庫，可中斷續跑

影片與萃取結果一律存成 `recordings/<檔名>.mp4` + 同名 `.json`，
與 `moc_` / `moe_` / twtsl 既有素材同一套規則。

## 缺詞時虛擬人怎麼處理

`composer.js` 的 `resolve(gloss, lexicon)` 是唯一入口，回傳「要打哪幾個動作」
的陣列（多數是一個，數字與指拼會展開成多個）。依序試：

1. 原樣命中詞庫
2. 去語料庫標註記號（`買++`→`買`、`告訴(他)`→`告訴`）
3. 阿拉伯數字逐位打（`2009`→`二/零/零/九`）——詞庫本來就有中文數字，不必拍片
4. 大小寫／括號折疊（`Line`→`LINE (通訊軟體)`、`email`→`EMAIL`）
5. 指拼（見下）

都不中就回空陣列，該詞不打——**寧可不動，也不要用短詞硬拼出錯的手勢**。

### 要補英文字母指拼的話

外語詞優先用既定手語（twtsl 收了 `LINE (通訊軟體)`、`EMAIL`、`FB`、`IG` 等）；
沒有既定手語的（BB call、KTV、NIKE…，資料集裡 59 次）才需要指拼。
**目前詞庫沒有任何字母動作**——教育部辭典的英文字母只有手形圖沒有影片
（`basis/4` 全 26 筆 `youtubeKey` 皆為 null），twtsl 也沒有，所以只能自己錄。

錄好之後，詞條鍵用 **`fs:A` … `fs:Z`**（刻意加 `fs:` 前綴，才不會跟詞庫裡
真的叫 `A`、`C` 的詞條撞名）。程式已經寫好，26 個字母到齊就自動生效，
不必改任何程式；缺任何一個字母則整個詞不打，不會拼出殘缺字串。

跑測試：

```bash
cd /home/b310ai/0813/signavatar-core
PYTHONPATH=/home/b310ai/0813/signavatar-core/src \
  ~/SignAvatar-main/.venv/bin/pytest tests -q
```

（`tests/test_viewer_server.py` 的 2 個測試在本目錄會失敗：
這份 bundle 沒有帶 `web/` 目錄，與詞庫無關。）

前端與服務的測試則是 bundle 自己那套（unittest，`.venv` 沒裝 pytest），
**一定要用 0813 自己的直譯器**，否則 `test_runtime_independence.py`
會因為載到別的 venv 而假性失敗：

```bash
cd /home/b310ai/0813
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

改了 `composer.js`／`signavatar-bridge.js`／`avatar3d.js` 之後，
記得把 `index.html`、`generate.html`、`viewer.html` 裡的 `?v=` 快取版本一起 bump
（`tests/test_avatar_framing.py` 會把關），不然瀏覽器會繼續用舊快取。

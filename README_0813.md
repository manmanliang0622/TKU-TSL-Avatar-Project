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
ssh -p 2288 -N -L 8083:127.0.0.1:8083 b310ai@163.13.202.125
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

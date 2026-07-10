# 手譯橋 SignBridge — 完整開發規劃書

> 最後更新：2026-07-10
> 目標：讓網站可被搜尋、手語辨識接 MediaPipe + 自訓模型、手語生成接虛擬人模型、收藏與紀錄可跨裝置。
> 各階段都含「前置條件 → 詳細步驟 → 驗收標準 → 常見坑」，照順序做即可。

---

## 全局架構

```
使用者瀏覽器（靜態前端，Cloudflare Pages）
 ├─ 手語辨識：攝影機/影片 → MediaPipe 抽關鍵點（瀏覽器內）
 │              → 序列分類模型（TF.js 瀏覽器推論；跑不動才走後端）
 │              → 手語語序 → 口語句子
 ├─ 手語生成：口語句子 → POST /generate（GPU 後端）
 │              → 手語語序 + 虛擬人動畫（影片或骨架序列）→ 前端播放
 └─ 收藏/紀錄：localStorage（現在）→ Supabase 帳號同步（階段 6）

GPU 後端（FastAPI）
 ├─ POST /generate    虛擬人生成模型
 ├─ POST /to-spoken   手語語序 → 口語句子（LLM 或規則式）
 └─ POST /recognize   辨識模型（僅當瀏覽器跑不動時才需要）
```

執行順序與依賴：

| 順序 | 階段 | 規模 | 依賴 |
|---|---|---|---|
| 1 | 部署上線 + SEO 收尾 | 半天 | 無 |
| 2 | 生成 API 契約 + 後端骨架 | 1–2 天 | 需向模型提供方確認輸出格式 |
| 3 | 辨識頁接 MediaPipe 關鍵點 | 2–3 天 | 無 |
| 4 | 資料收集 + 訓練辨識模型 | 數週 | 階段 3 的抽取程式碼 |
| 5 | 辨識模型接回網頁 | 3–5 天 | 階段 4 |
| 6 | 雲端收藏 / 紀錄 | 2–3 天 | 隨時可插入 |

---

## 階段 1：部署上線 + SEO 收尾

**目標**：網站有公開網址，Google 搜尋得到。
**現況**：SEO 檔案（OG meta、JSON-LD、robots.txt、sitemap.xml、og-image.jpg）已完成並 commit。

### 步驟

1. **推上 GitHub**
   ```bash
   cd ~/Documents/手語前端優化
   git push -u origin main
   ```

2. **部署到 Cloudflare Pages**（免費、自動 HTTPS）
   1. 登入 [dash.cloudflare.com](https://dash.cloudflare.com) → 左側 **Workers & Pages** → **Create** → **Pages** 分頁
   2. **Connect to Git** → 授權 GitHub → 選 `TKU-TSL-Avatar-Project`
   3. 設定頁全部留空／預設（Framework preset: None、Build command 空白、Output directory 空白或 `/`）
   4. **Save and Deploy** → 完成後拿到 `https://<專案名>.pages.dev`
   5. 之後每次 `git push` 都會自動重新部署

3. **把佔位網址換成真實網址**
   目前三個檔案裡寫的是佔位網址 `https://signbridge.pages.dev`，共 8 處：
   - `index.html`：`canonical`、`og:url`、`og:image`、`twitter:image`、JSON-LD 的 `url`
   - `robots.txt`：`Sitemap:` 那行
   - `sitemap.xml`：`<loc>`

   全案搜尋取代一次即可（拿到真實網址後，也可以請 Claude 代改）。改完 commit + push。

4. **提交 Google Search Console**
   1. 到 [search.google.com/search-console](https://search.google.com/search-console) → 新增資源 → 選 **網址前置字元**，填部署網址
   2. 驗證方式選 **HTML 標記**：把 Google 給的 `<meta name="google-site-verification" content="...">` 貼進 `index.html` 的 `<head>`，push 部署後按驗證
   3. 左側 **Sitemap** → 提交 `sitemap.xml`
   4. 左側 **網址檢查** → 貼上首頁網址 → **要求建立索引**（加速收錄）

5. **（選配）自訂網域**：在 Cloudflare 買網域（如 `signbridge.tw`，約 NT$300–600/年）→ Pages 專案的 **Custom domains** 加上去 → 記得回頭把步驟 3 的網址再換一次，Search Console 也要新增新資源。

### 驗收標準
- [ ] 公開網址可開啟，手機也正常
- [ ] 貼到 LINE / Facebook 有預覽圖和標題
- [ ] Search Console 顯示 sitemap「成功」
- [ ] 1–4 週後搜「手譯橋 SignBridge」找得到

### 常見坑
- 中文檔名（`彩色圖_aligned.webp` 等）在 Cloudflare Pages 沒問題，但若改用其他主機出現破圖，就把圖檔改英文名。
- Search Console 的收錄要等，不是提交當天就搜得到；「要求建立索引」能加速到幾天內。

---

## 階段 2：生成 API 契約 + 後端骨架

**目標**：定死前後端規格，讓虛擬人模型（已存在、需 GPU）不管輸出影片還是骨架序列都能對接。
**前置**：向模型提供方問清楚三件事——(1) 輸出是影片檔還是關鍵點/骨骼動作序列？(2) 生成一句要幾秒？(3) 程式碼和權重能不能拿到、環境需求（CUDA 版本、VRAM）？

### API 契約（v1）

```
POST /generate
Request:  { "sentence": "我要喝水" }
Response: {
  "gloss": ["我", "水", "喝", "要"],
  "animation": {
    "type": "video",                     // 或 "pose"
    "url": "https://.../clip.mp4",       // type=video 時
    "fps": 30,                           // type=pose 時
    "frames": [ { "joints": [[x,y,z], ...] }, ... ],
    "gloss_spans": [ {"gloss":"我","start":0,"end":42}, ... ]  // 每個詞對應的幀區間，前端詞卡高亮用
  }
}
錯誤格式：HTTP 4xx/5xx + { "error": "訊息" }
```

```
POST /to-spoken
Request:  { "gloss": ["我", "水", "喝", "要"] }
Response: { "sentence": "我要喝水" }
```

### 步驟

1. **建後端 repo**（獨立於前端），FastAPI 骨架：
   ```python
   # main.py
   from fastapi import FastAPI
   from fastapi.middleware.cors import CORSMiddleware
   from pydantic import BaseModel

   app = FastAPI()
   app.add_middleware(CORSMiddleware,
       allow_origins=["https://<你的前端網址>", "http://127.0.0.1:8742"],
       allow_methods=["POST"], allow_headers=["*"])

   class GenReq(BaseModel):
       sentence: str

   @app.post("/generate")
   def generate(req: GenReq):
       gloss = convert_to_sign_order(req.sentence)   # 先移植前端的查表邏輯
       animation = run_avatar_model(gloss)            # 之後接真模型
       return {"gloss": gloss, "animation": animation}
   ```
   第一版 `run_avatar_model` 可以先回假資料（`type:"video"` 指向一段測試影片），讓前後端先通。

2. **部署後端**（二選一）：
   - **Hugging Face Spaces（推薦先用）**：建 Docker Space，硬體選 GPU（T4 約 US$0.6/hr，可設閒置自動休眠省錢）。適合展示。
   - **學校 / 雲端 GPU 主機**：用 `uvicorn main:app --host 0.0.0.0 --port 7860` + Cloudflare Tunnel 取得公開網址。

3. **前端加 API 設定與分流播放**：
   - `script.js` 開頭加 `const API_BASE = "https://<後端網址>";`
   - `generateSign` 按鈕改成 `fetch(API_BASE + "/generate")`，失敗時 fallback 回現有的本地查表（網站永遠不會壞）
   - `createAvatarPlayer()` 依 `animation.type` 分流：
     - `video` → avatar-stage 裡放 `<video>`，用 `gloss_spans` + `timeupdate` 事件做詞卡高亮，速度鈕改控制 `video.playbackRate`（慢 0.6 / 普通 1.0 / 快 1.6）
     - `pose` → 進入階段 2b（Three.js 虛擬人，見下）

4. **（2b，僅當輸出是骨架序列）Three.js 虛擬人**：
   - CDN 載入 three.js + `@pixiv/three-vrm`，找一個免費 VRM 模型（VRoid Hub 有 CC 授權的）
   - 每幀把 `joints` 映射到 VRM 骨骼旋轉（需要模型提供方給關節定義表）
   - 這條路工作量大，若模型能直接輸出影片，v1 用影片就好

### 驗收標準
- [ ] 從部署後的網站按「轉成手語」，能打到後端並播放回傳的動畫
- [ ] 後端掛掉時前端 fallback 回本地查表，不會白畫面
- [ ] 詞卡高亮跟著動畫進度走，速度切換有效

### 常見坑
- **CORS**：後端一定要設 `allow_origins` 含前端網址，否則瀏覽器直接擋掉。
- **GPU 冷啟動**：HF Spaces 休眠後第一次請求要等 30–60 秒，前端要有「模型喚醒中」的狀態提示。
- 影片檔別直接放 HF Spaces 容器內回傳大檔，放 R2 / S3 之類的物件儲存再回傳 URL。

---

## 階段 3：辨識頁接 MediaPipe 關鍵點抽取

**目標**：攝影機/影片畫面即時顯示手部骨架，建立「影像 → 關鍵點」管線（之後訓練與推論都用它）。
**前置**：無，可立即做。

### 步驟

1. **載入 MediaPipe Tasks Vision**（純前端、免後端），`script.js` 改為 module 或另開 `recognition.js`：
   ```js
   import { FilesetResolver, HandLandmarker } from
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10/vision_bundle.mjs";

   const vision = await FilesetResolver.forVisionTasks(
     "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10/wasm");
   const landmarker = await HandLandmarker.createFromOptions(vision, {
     baseOptions: {
       modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
       delegate: "GPU"
     },
     runningMode: "VIDEO",
     numHands: 2
   });
   ```

2. **攝影機模式**：`previewBox` 裡疊一層 `<canvas>`（絕對定位蓋在 video 上）：
   ```js
   const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 } });
   previewVideo.srcObject = stream;
   function loop() {
     const res = landmarker.detectForVideo(previewVideo, performance.now());
     drawSkeleton(canvas, res.landmarks);        // 21 點 + 連線
     collectFrame(res);                           // 存進當前序列 buffer
     requestAnimationFrame(loop);
   }
   ```

3. **上傳影片模式**：對 `previewVideo` 播放中同樣跑 `detectForVideo` 迴圈（影片播完即抽完）。

4. **關鍵點序列 buffer（訓練與推論共用的資料格式，一開始就定好）**：
   ```
   每幀特徵 = 左手 21 點 + 右手 21 點，每點 (x, y, z)，缺手補 0 → 126 維
   正規化：每隻手以手腕(第0點)為原點平移，再除以「手腕到中指根部(第9點)」距離
   取樣：固定 25 fps（用時間戳重取樣，不依賴螢幕更新率）
   ```

5. **UI 接線**：步驟一「影像分析」在偵測到手時亮起；`recognitionStatus` 顯示「偵測到 1/2 隻手」。步驟二、三先維持模擬，等階段 5 換真的。

### 驗收標準
- [ ] 攝影機畫面上骨架即時跟手動，順暢（≥ 20 fps）
- [ ] 上傳影片也能逐幀畫骨架
- [ ] console 可 dump 出正規化後的 126 維序列 JSON
- [ ] 手機瀏覽器也能跑（MediaPipe wasm 支援）

### 常見坑
- **HTTPS 必須**：`getUserMedia` 只在 https 或 localhost 可用——部署到 Pages 後自然沒問題。
- `detectForVideo` 的時間戳必須嚴格遞增，影片 seek 時要注意。
- 若之後發現只有手部特徵不夠（台灣手語有表情、位置語意），升級成 `HolisticLandmarker`（臉 + 姿態 + 雙手）——**但升級後訓練資料要重錄或重抽，所以第 4 步的格式版本號要留欄位**。

---

## 階段 4：資料收集 + 訓練辨識模型

**目標**：訓練出「關鍵點序列 → 手語詞」分類模型。
**前置**：階段 3 完成；團隊定好第一批詞彙表。

### 步驟

1. **定詞彙表 v1（20–50 詞）**：從生成頁常用句子涵蓋的詞開始（我、你、好、水、喝、要、吃、飯、謝謝、廁所、哪裡、幫忙…）。存成 `labels.json`，前後端與訓練程式共用。

2. **做錄製工具**：加一個隱藏頁 `collect.html`（不放進導覽列與 sitemap），複用階段 3 的抽取程式碼：
   - 選詞 → 按錄製 → 打一次手語 → 自動存 `{ label, version, fps, frames[[126]...] }` JSON
   - 下載成檔案或直接 POST 到收集用的簡易後端
   - 顯示「該詞已錄 n 段」計數器
   - **每段 1–3 秒、一段只含一個詞**（v1 做孤立詞分類，不做連續手語）

3. **收集量**：每詞 30–50 段起步；**至少 3 位以上不同的打手語者**，訓練/驗證集要「按人切分」（某人的資料只能在其中一邊），否則準確率會虛高。

4. **訓練（Python）**：
   ```python
   # 模型：輸入 (T=75幀, 126)，padding + masking
   model = keras.Sequential([
       keras.layers.Masking(mask_value=0.0, input_shape=(75, 126)),
       keras.layers.Bidirectional(keras.layers.LSTM(128, return_sequences=True)),
       keras.layers.Bidirectional(keras.layers.LSTM(64)),
       keras.layers.Dense(64, activation="relu"),
       keras.layers.Dropout(0.3),
       keras.layers.Dense(num_classes, activation="softmax"),
   ])
   ```
   - 資料增強：時間縮放 ±20%、加小噪聲、水平鏡像（左右手互換——注意有些詞鏡像後語意不同，要排除）
   - 目標：驗證集 top-1 ≥ 85% 再進階段 5；不到就先加資料而不是加模型

5. **匯出成瀏覽器可用格式**：
   ```bash
   pip install tensorflowjs
   tensorflowjs_converter --input_format=keras model.h5 web_model/
   ```
   `web_model/`（model.json + 權重分片，通常只有幾 MB）放進前端 repo。

### 驗收標準
- [ ] `labels.json` 定案且三方（錄製工具/訓練/前端）共用同一份
- [ ] 每詞 ≥ 30 段、≥ 3 位錄製者
- [ ] 按人切分的驗證集 top-1 ≥ 85%
- [ ] 匯出的 TF.js 模型在瀏覽器 console 能載入並推論

### 常見坑
- **最大的坑：訓練與推論特徵不一致。** 錄製工具一定要用網頁同一套抽取＋正規化程式碼，不要在 Python 端用另一套 MediaPipe 重抽。
- 驗證集混到同一人的資料 → 分數漂亮、上線就掛。
- 錄製環境太單一（同背景、同光線、同距離）會過擬合，刻意換場地錄。

---

## 階段 5：辨識模型接回網頁

**目標**：把 `simulateRecognition()` 換成真管線：關鍵點 → 詞序列 → 口語句子。

### 步驟

1. **載入模型**（TF.js CDN）：
   ```js
   import * as tf from "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4/dist/tf.fesm.min.js";
   const model = await tf.loadLayersModel("web_model/model.json");
   ```

2. **連續影像切詞（v1 簡化法）**：用「移動量門檻」切段——雙手總移動量低於門檻 0.5 秒視為停頓，兩個停頓之間就是一個詞的片段 → 重取樣到 75 幀 → 丟進模型 → 信心值 > 0.7 才輸出詞卡。

3. **UI 接線**：
   - 步驟 1「影像分析」= MediaPipe 偵測中；步驟 2「手語語序辨識」= 每切出一段就即時把詞 push 進 `recognitionTokens`；步驟 3「口語轉換」= 使用者按停止（或影片播完）後觸發
   - 語序 → 口語：呼叫後端 `POST /to-spoken`（先規則式：依台灣手語「主題—述語」語序重排 + 補虛詞；效果不夠再換 LLM，prompt 給 few-shot 範例即可，用 Haiku 等級便宜快速）
   - 結果照現有邏輯存進 `recognitionHistory`（localStorage），這部分不用動

4. **效能**：推論放 Web Worker 避免卡 UI；或每 2 幀抽 1 幀。

### 驗收標準
- [ ] 對著攝影機打詞彙表內的手語，2 秒內出正確詞卡
- [ ] 上傳測試影片能跑出完整語序 + 口語句子
- [ ] 詞彙表外的動作不會亂輸出（信心值門檻擋住）
- [ ] 中階手機可用（fps 不掉到 10 以下）

### 常見坑
- 連續手語切分是研究級難題，v1 守住「孤立詞 + 停頓切分」就好，demo 時打手語的人詞與詞之間稍作停頓。
- 信心值門檻寧高勿低：漏詞比出錯詞觀感好。

---

## 階段 6：收藏 / 查詢紀錄雲端化

**目標**：登入後收藏與紀錄跨裝置同步；未登入維持現在的 localStorage 行為。
**前置**：無硬性依賴，隨時可做；展示用途可略過。

### 步驟

1. **建 Supabase 專案**（[supabase.com](https://supabase.com) 免費方案夠用）→ Authentication → Providers 開 **Google**（照精靈到 Google Cloud Console 建 OAuth 憑證，redirect URL 用 Supabase 給的）。

2. **建表 + Row Level Security**（SQL Editor 貼上）：
   ```sql
   create table favorites (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null default auth.uid() references auth.users,
     sentence text not null,
     gloss jsonb,
     created_at timestamptz default now()
   );
   create table history (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null default auth.uid() references auth.users,
     kind text check (kind in ('recognition','generation')),
     payload jsonb not null,
     created_at timestamptz default now()
   );
   alter table favorites enable row level security;
   alter table history enable row level security;
   create policy "own rows" on favorites for all
     using (auth.uid() = user_id) with check (auth.uid() = user_id);
   create policy "own rows" on history for all
     using (auth.uid() = user_id) with check (auth.uid() = user_id);
   ```

3. **前端接線**（CDN 載入 `@supabase/supabase-js@2`）：
   - 導覽列加「登入」鈕 → `supabase.auth.signInWithOAuth({ provider: "google" })`
   - 把 `script.js` 現有的讀寫函式（`getFavorites`/`saveFavorites`/`readList`/`saveList`）包一層：**永遠先寫 localStorage**（未登入＝現在的行為、離線也能用），已登入時再非同步 upsert 到 Supabase
   - 首次登入：把本機既有收藏/紀錄批次上傳合併（以 sentence 去重）
   - 登入狀態下開頁：先顯示本機資料，再拉雲端覆蓋

### 驗收標準
- [ ] 未登入行為與現在完全相同
- [ ] A 裝置收藏 → B 裝置登入同帳號看得到
- [ ] RLS 生效：換帳號看不到別人的資料

### 常見坑
- Supabase 的 anon key 放前端是正常設計，安全靠 RLS——**表一定要開 RLS**，不然任何人都能讀全表。
- Google OAuth 的授權網域要同時加 Supabase 網域和你的正式網域。

---

## 風險與備案總表

| 風險 | 備案 |
|---|---|
| 生成模型拿不到或整合太難 | 退回「每詞預錄影片串播」：找人錄詞彙表每個詞的手語短片，後端只做語序轉換 + 回傳影片清單，前端無縫接（契約已相容） |
| 辨識準確率上不去 | 縮小詞彙表、增加錄製者、換 HolisticLandmarker 加臉部/姿態特徵 |
| GPU 費用太高 | HF Spaces 設自動休眠；demo 場次前手動喚醒 |
| 訓練人力不足 | 詞彙表先砍到 10–15 個 demo 必用詞，流程跑通比涵蓋率重要 |

## 待你們確認的三件事

1. 生成模型輸出格式（影片 or 骨架序列）→ 決定階段 2 走 2a 還是 2b
2. 生成模型部署去處（HF Spaces GPU or 學校主機）
3. 詞彙表 v1 的 20–50 個詞清單 → 階段 4 的起點

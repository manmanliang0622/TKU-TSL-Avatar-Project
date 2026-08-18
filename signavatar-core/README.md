# SignAvatar

台灣手語虛擬人動畫系統 — Taiwan Sign Language avatar animation toolchain.

## Goal / 專案目標

輸入中文,3D 虛擬人打出臺灣手語(TSL)。兩條管線,一個資料契約:

```text
【動作擷取】 Webcam / 影片
  → MediaPipe landmarks(手 21 + 身體 33 + 臉 52 blendshapes)
  → JSON recording(src/signavatar/schema.py = 兩端共用契約)
  → web 檢視器(骨架/VRM 虛擬人、來源影片同步對照)/ Blender 播放

【手語生成】 中文句子
  → 翻譯層(claude CLI LLM + 語料庫平行句 few-shot;規則式 fallback)
  → TSL gloss 序列 + 句型標記(疑問/否定)
  → 詞級詞庫檢索(文化部臺灣手語語料庫,詞級毫秒時間戳自動切分)
  → 距離感知拼接 + 非手部訊號(挑眉/皺眉/搖頭)
  → VRM 虛擬人播放(/generate.html)
```

Taiwan Sign Language avatar toolchain: capture side (MediaPipe → JSON)
and generation side (Chinese → TSL glosses → stitched word-level signs →
VRM avatar), sharing one recording format.

## 目前規模(2026-07-05)

| 項目 | 數量 | 說明 |
|---|---|---|
| 可播詞彙 | **2,500 條** | 2,299 自然手語(文化部語料庫)+ 190 文法手語(教育部辭典)+ 11 手動 |
| 平行語料 | **5,066 句** | 中文↔gloss 配對(語料庫全量 407 單元),LLM few-shot 用 |
| 完全可播例句 | **2,783 句** | 每個 gloss 都在詞庫,點擊即生成 |
| 已萃取語料影片 | 206/207 敘事單元 | 對話類 200 單元為雙人影片,只收文字平行句 |
| 翻譯品質 | LLM **82.7% F1** / 規則式 65.0% | `signavatar eval` 以語料參考譯文回歸測試 |
| 可再擴充 | MOE 辭典尚餘 ~7,750 詞 | `./tools/moe_bulk_all.sh` 一鍵分塊補完 |

每一筆詞彙與例句都帶出處記錄(來源單元、演繹者、授權、抓取時間),
可在 `/sources.html` 逐詞追溯;登記簿見 `docs/data-sources.md`。

## Requirements

- Python 3.10–3.12 (managed with [uv](https://docs.astral.sh/uv/))
- [Claude Code](https://claude.com/claude-code) CLI(`claude`),供
  中文→TSL 的 LLM 翻譯(沒有也能跑,自動退回規則式翻譯)
- A webcam, for capture(生成功能不需要)
- [Blender](https://www.blender.org/) 4.x, for playback (not needed for capture)

## Quickstart

```bash
uv sync

# ── 手語生成(主要功能)─────────────────────────────
# 起 server → 瀏覽器開 http://127.0.0.1:<port>/generate.html
uv run signavatar view recordings/moc_G2D1P1.json

# 詞彙庫擴充:文化部語料庫(節流下載 + 4 進程平行萃取,可續跑)
uv run signavatar corpus bulk                  # 全部敘事單元一次收完
uv run signavatar corpus ingest G2D1P1 …       # 或指定單元
uv run signavatar corpus pairs                 # 收割全庫中文↔gloss 平行句(不下載影片)

# 詞彙庫擴充:教育部辭典補缺詞(YouTube 節流防封鎖,可續跑)
uv run signavatar moe fetch                    # 抓全詞表(8,710 詞 metadata)
uv run signavatar moe bulk --limit 200         # 補 200 個高頻缺詞(按語料頻率排序)
caffeinate -i ./tools/moe_bulk_all.sh          # 一鍵分塊補完全部缺詞(~15-20hr,可中斷續跑)

# 其他資料源與品質
uv run signavatar yt <url> <name> --license-note "CC-BY(...)"  # 收 CC 授權影片入庫
uv run signavatar eval [--llm --limit 25]      # 翻譯品質回歸測試(語料參考譯文)

# ── 動作擷取 ─────────────────────────────────────
uv run signavatar record recordings/wave.json --label wave   # 錄 webcam(R 開始/停,Q 離開)
uv run signavatar extract clip.mp4 recordings/clip.json      # 或從影片檔萃取
uv run signavatar info recordings/wave.json                  # 摘要
uv run signavatar view recordings/clip.json --video clip.mp4 # 檢視器(+影片對照)

# ── Blender 播放 ─────────────────────────────────
blender --python blender/playback.py -- recordings/wave.json
```

On macOS, if `blender` is not on your PATH:

```bash
alias blender=/Applications/Blender.app/Contents/MacOS/Blender
```

## 使用說明(Web App)

### 啟動

```bash
uv run signavatar view recordings/moc_G2D1P1.json
```

會啟動本機 server 並開啟瀏覽器。`recording` 參數是檢視器的預設項目;
所有功能(手語生成、上傳、影片庫、合成)都在同一個 server 上。

### 手語生成頁(`/generate.html`)

首頁第一張卡片。輸入中文 → AI 翻成自然 TSL 語序(顯示 gloss 標籤、
疑問/否定標記與翻譯來源)→ 虛擬人全螢幕打手語,目前打到的詞即時
高亮。可拖曳旋轉、滾輪縮放、變速、切換虛擬人。翻譯的 few-shot
例句自動取自已 ingest 的語料庫平行句(`recordings/tsl_pairs.json`)。

### 詞庫總覽頁(`/corpus.html`)

即時統計儀表板:可播詞彙(自然/文法/手動分項與組成比例條)、
平行例句數、完全可播例句數、已萃取單元數;詞彙與例句全部可搜尋,
**點任何詞或例句直接跳到生成頁打出來**(`generate.html?text=…`)。

### 資料來源頁(`/sources.html`)

出處追溯:三個來源的授權徽章與即時詞數;**輸入任何詞可追出完整
出處鏈**(錄製檔+時間段 → 語料單元 → 演繹者屬性 → 原始影片連結 →
授權與引用格式 → 抓取時間);407 個語料單元的完整記錄表。

### Landing(首頁 `/`)

- **手語生成 / 詞庫總覽 / 資料來源**三張入口卡片。
- **內建影片庫**:`recordings/` 內所有已分析的 JSON 自動列出
  (名稱、長度、幀數;同檔名的影片會一起帶入對照)。點選進入檢視器。
- **上傳影片分析**:拖放或選擇影片(mp4/webm/mov/avi/mkv)→ 顯示
  「分析中 n/m 幀」進度 → **分析完成才會進入檢視器**,並自動加入影片庫。
  單人、正面、手部清楚的影片效果最好;中文檔名 OK。

### 檢視器(viewer)

| 功能 | 操作 |
|---|---|
| 播放控制 | 空白鍵播放/暫停 · ←→ 逐格 · 底部時間軸(藍=左手、橘=右手偵測)可拖曳 seek · 0.25×–2× 變速 |
| 視角 | 拖曳旋轉 · 滾輪縮放 |
| 顯示層 | TRAILS 手腕軌跡 · POSE 身體骨架 · AVATAR 3D 虛擬人 |
| 影片對照 | 左下角子母畫面與播放頭同步;MIRROR 切換鏡像視角 |
| 虛擬人切換 | 右上下拉選單(`web/models/*.vrm`),或直接拖放 .vrm 檔;可用 [VRoid Studio](https://vroid.com/studio) 免費自製 |
| 表情讀數 | 右側即時顯示最強的 blendshape 係數 |
| 匯出影片 | ⏺ EXPORT 錄一輪播放,下載 .webm |
| 上傳 | UPLOAD VIDEO 按鈕或直接拖放影片(分析完自動切換) |

### 手語合成(文字 → 手語)

按右上「手語合成」開啟面板:

1. **標註**:播放到手勢起點按「設起點」、終點按「設終點」、
   輸入詞彙名稱按「儲存」→ 寫入 `recordings/lexicon.json`。
2. **合成**:輸入句子按「合成播放」。預設勾選「自然手語語序
   (AI 翻譯)」— 句子先經 `POST /translate` 翻成自然 TSL 的
   gloss 序列(本機 `claude` CLI;失敗自動退回規則式:時間詞前置、
   否定後置、丟虛詞),再從詞彙庫檢索拼接。過渡時長依手腕移動距離
   自動調整;疑問句在最後一個手語詞疊加挑眉/皺眉、否定句疊加搖頭
   (非手部訊號)。取消勾選則為逐詞比對的舊模式。
3. 點詞彙庫中任一詞條可單獨播放;✕ 刪除。

### 詞彙庫擴充

**文化部臺灣手語語料庫**(自然手語,主要來源;現已全數收完):

```bash
uv run signavatar corpus bulk                 # 全部敘事單元:節流下載+4進程平行萃取,可續跑
uv run signavatar corpus list                 # 列出 407 個語料單元
uv run signavatar corpus ingest G2D1P1        # 指定單元:下載影片→萃取→依詞級時間戳建詞條
uv run signavatar corpus pairs                # 收割全庫平行句(API-only,不下載影片)
```

- 影片與萃取 JSON 存 `recordings/`(不入版控);gloss 自動去標點;
  不覆蓋手動標註;單元失敗跳過並逐單元存檔。敘事類(type 1)單簽者
  影片才能萃取;對話類(type 2)雙人同框,只收平行句。
- 平行句作為 LLM 翻譯的 few-shot 例句(依字元重疊挑 6 句最相關)。

**教育部常用手語辭典**(文法手語,只補自然手語的缺詞):

```bash
uv run signavatar moe fetch                   # 全詞表 metadata(8,710 詞含影片鍵)
uv run signavatar moe bulk --limit 200        # 補高頻缺詞(語料頻率排序;YouTube 節流)
uv run signavatar moe ingest 謝謝 再見        # 或指定詞
caffeinate -i ./tools/moe_bulk_all.sh         # 一鍵分塊補完(300詞/塊+休息,可中斷續跑)
```

MOE 詞條強制標 `system: 文法手語`,**絕不覆蓋**自然手語詞條。

**其他影片源**:`signavatar yt <url> <name> --license-note "CC-BY(...)"`
(如師大「線上手語教室」CC-BY 課程)。

**出處記錄**:每筆資料都帶 `source` 欄位;`moc_manifest.json` /
`external_manifest.json` 記錄來源 URL、演繹者屬性、授權與抓取時間。

詞彙庫格式與完整設計(語序轉換、表情文法等路線)見
`docs/text-to-sign.md`;頁面流程與 API 見 `docs/app-structure.md`。

### 翻譯品質(`signavatar eval`)

以語料庫平行句為標準答案回歸測試(few-shot 排除受測句防洩漏):

| 路徑 | exact-sequence | bag-of-gloss F1 |
|---|---|---|
| 規則式(fallback) | 14.2% | 65.0% |
| LLM(claude CLI) | 30.0% | 82.7% |

(2026-07-05,詞庫 872 條時測;`--llm --limit N` 抽樣測 LLM 路徑)

## 資料來源與授權

所有外部資料的出處與授權狀態記錄於 **`docs/data-sources.md`**。摘要:

- **文化部臺灣手語語料庫**(tslcorpus.moc.gov.tw)— 詞庫與平行語料
  主要來源。著作權聲明明文允許**研究/學術/教育之非商業用途**,
  使用須註明出處:
  > 張榮興(主編)(2025)。《臺灣手語語料庫》。臺北:中華民國文化部。
- 下載素材(影片、萃取 JSON)不入版控、不散布;本 repo 為 private。
- 候選來源(教育部常用手語辭典 15,770 詞條開放 API、師大「線上手語
  教室」CC-BY 頻道等)的授權證據與評估見登記簿。

### 檔案慣例

- `recordings/*.json` = 影片庫本體(上傳分析的結果也存這裡,
  與來源影片同檔名);`recordings/lexicon.json` = 詞彙庫。
- `web/models/*.vrm` = 可切換的虛擬人;放新檔案重新整理即可。

## Roadmap

- [x] **M1a — Capture**: webcam → MediaPipe hand landmarks → JSON recording
- [x] **M1b — Playback**: JSON → animated landmark empties in Blender
- [x] **M1c — Video & viewer**: extract from video files; browser viewer with
      synced source-video comparison
- [x] **M2 — Beyond hands**: body pose (33 landmarks) and face blendshapes
      (52 ARKit coefficients) captured per frame — facial grammar is core to
      sign language
- [x] **M3 — 3D avatar (web)**: rigged VRM characters driven by recordings —
      body-frame IK arms, exact palm orientation, kalidokit fingers,
      blendshape face; switchable models (`web/models/*.vrm`, drag-drop too)
- [x] **M4 — Vocabulary & composition (v1)**: in-viewer segment annotation →
      `recordings/lexicon.json`; text input → greedy match → stitched sign
      playback with cross-fades. Design & roadmap: `docs/text-to-sign.md`
- [x] **M4.5 — TSL generation (方案B)**: word-level lexicon from the MOC
      TSL corpus (`signavatar corpus ingest`, per-word timestamps);
      中文→TSL gloss translation (claude-CLI LLM + rule fallback,
      lexicon-constrained); distance-aware stitching + neutral-pose
      trimming; non-manual markers (question brows, negation headshake).
      Spec: `docs/superpowers/specs/2026-07-05-tsl-generation-design.md`
- [x] **M4.6 — Data at scale + provenance**: MOC narrative corpus fully
      ingested (2,299 natural words, 5,066 parallel pairs); MOE
      dictionary gap-fill pipeline (190 done, ~7,750 available via
      `tools/moe_bulk_all.sh`); resumable throttled bulk tooling;
      eval harness (LLM 82.7% F1); dedicated pages: generate /
      corpus stats / per-word provenance; every datum carries a source.
- [ ] **M5 — Blender/production**: retarget onto an armature, export
      glTF/FBX animation, rendered video output
- [ ] Later: spatial grammar (呼應動詞 loci、分類詞述語), mouthing,
      Deaf-community review loop — see `docs/text-to-sign.md`

## Notes

- MediaPipe's Tasks-API `HandLandmarker` reports handedness for *unmirrored*
  input. This pipeline stores selfie-view (mirrored) coordinates, so the
  tracker swaps the labels back — `Left`/`Right` in recordings always mean
  the signer's actual hands.

## Retargeting math / 座標映射與幾何公式

從影片到虛擬人,一筆 landmark 會經過四個座標系。這裡記錄每一步的
慣例與公式(對應程式碼位置標在各段開頭)。

### 0. 座標系與鏡像約定(`schema.py`, `capture/tracker.py`)

MediaPipe 的兩種輸出:

- **影像座標** `landmarks`:x∈[0,1] 向右、y∈[0,1] 向下、z 為相對深度。
- **世界座標** `world_landmarks`:公尺;pose 原點在髖部中點、hand 原點在
  手部幾何中心;軸向同影像座標。
- **重要陷阱**:z 值**越負越靠近鏡頭**(兩種座標皆然)。

錄製時先做水平翻轉(selfie view),因此 recording 存的是
**鏡像座標 + 簽者真實側的標籤**:

- Tasks API 的 handedness 以「未鏡像輸入」為準(與舊 mp.solutions 相反),
  翻轉後標籤會顛倒 → `HandTracker` 以 `mirrored_handedness()` 換回、
  `PoseTracker` 以 `_mirrored_pose_index_map()` 對調 LEFT_*/RIGHT_* index。
- 臉部 blendshapes 名稱帶 Left/Right,故 `FaceTracker` 直接吃**未翻轉**原始幀。

### 1. 2D 骨架檢視器(`web/viewer.html`)

場景為 z-up、+y 朝向預設鏡頭(第三人稱視角,與未鏡像影片同向):

```text
mpToScene(p) = ( x, -z, -y )
```

手的世界座標不含全域位置,以影像座標的手腕錨定
(`VIEW_WIDTH_M = 0.8`、`BASE_HEIGHT_M = 1.2`,aspect = 高/寬):

```text
anchor = ( (wx - 0.5)·W,  0,  (0.5 - wy)·W·aspect + H )
scene_point = anchor + mpToScene(world_landmark)
```

### 2. 3D 虛擬人(`web/avatar3d.js`)

顯示空間為 three.js 慣例:x 螢幕右、y 上、z 朝鏡頭;模型面向 +Z。
從「儲存的鏡像世界座標」到虛擬人空間是三個負號:

```text
mpToAvatar(p) = ( -x, -y, -z )   # 解鏡像、y 下→上、z 負向鏡頭→正向鏡頭
```

**(a) 位置:身體座標系映射** — 手語的位置意義是「相對身體」的
(下巴、胸口、鼻子),不能用公尺等比縮放(動漫體型會把臉旁映到領口)。
每幀從簽者 pose 建身體框架:右向 r̂(肩→肩)、上向 û(髖中點→肩中點)、
前向 f̂ = r̂ × û,肩寬 w、軀幹長 t = |肩中點 − 髖中點|。手腕對肩膀的
偏移 o 分解為無量綱係數,再用虛擬人的框架重建:

```text
c = ( o·r̂ / w_signer,  o·û / t_signer,  o·f̂ / t_signer )
T = S_avatar + c_x·w_avatar·r̂_A + c_y·t_avatar·û_A + c_z·t_avatar·f̂_A
```

**(b) 手臂:解析式二骨 IK** — 目標 T、肩 S、上臂長 L1、前臂長 L2,
d = |T − S|(clamp ≤ 0.985(L1+L2)),餘弦定理求肘:

```text
a = (L1² − L2² + d²) / 2d          # 肘沿 d̂ 的投影
h = √(L1² − a²)                     # 肘偏離軸線的高度
elbow = S + d̂·a + m̂·h
```

m̂(pole vector)= 錄到的手肘位置經同一身體映射後,投影到垂直 d̂
平面的方向 — 手肘朝向跟著簽者走。骨骼旋轉的通式:

```text
q_world = quatFromUnitVectors(restDir, targetDir) · q_rest
q_local = q_parent⁻¹ · q_world
```

**(c) 掌心朝向:掌面基底** — 由手的世界座標三點建**右手系**正交基底:

```text
x̂ = normalize(middleMCP − wrist)          # 指向
ŷ = normalize(x̂ × (indexMCP − pinkyMCP))  # 掌面法向
ẑ = x̂ × ŷ
R = [ x̂ ŷ ẑ ],  Δ = R_now · R_rest⁻¹,  手腕世界旋轉 = Δ · q_rest
```

⚠️ 基底必須是右手系(det = +1):第三軸若寫成 ŷ × x̂ 會得到
det = −1 的鏡射矩陣,`setFromRotationMatrix` 會產生錯誤的四元數
(這個 bug 曾讓所有掌向都亂掉)。

**(d) 頭部**(鼻/耳幾何,earDist 為兩耳距):

```text
pitch = (nose_y − earMid_y)/earDist − 0.45   # 0.45 = 鼻低於耳線的基準
yaw   = (nose_x − earMid_x)/earDist × 1.4
roll  = atan2(earL_y − earR_y, earL_x − earR_x)
```

**(e) 手指** — Kalidokit `Hand.solve()`(需**未鏡像**影像座標:x→1−x)。
拇指三節對映 VRM1 的 Metacarpal/Proximal/Distal(命名與 VRM0 不同)。
Kalidokit 全面要求 MediaPipe 原生(未鏡像)輸入 — 直接餵鏡像資料
會把 hips 朝向解成 ~166°(整個人轉背)。

**(f) 表情** — ARKit blendshapes → VRM expressions 直接映射:
`eyeBlinkL/R→blinkL/R`、`jawOpen→aa`、`mouthPucker→ou`、
`mouthSmile→happy`、`browInnerUp→surprised`。

### 3. Blender(`blender/playback.py`)

z-up:`mp_to_blender(p) = (x, z, −y)`,錨定同 2D viewer。
(Blender 端深度沿用舊號誌、自成一體;做 armature retarget 時
再統一成上述慣例。)

## Layout

```text
src/signavatar/         capture + generation package (runs in the uv venv)
  schema.py             recording format — the contract, stdlib-only
  capture/              MediaPipe tracking + webcam/video-file capture
  corpus.py             文化部臺灣手語語料庫 API client
  moe_dict.py           教育部常用手語辭典 API client + yt-dlp download
  lexicon.py            word-level lexicon + parallel-pair building
  bulk.py               throttled bulk ingestion (parallel extraction, resumable)
  translate.py          中文→TSL gloss (rules + claude-CLI LLM few-shot)
  evaluate.py           translation scoring vs corpus reference glosses
  data/tsl_rules.json   語序規則檔 (time-fronting, negation-final, …)
  viewer.py             local HTTP server (viewer + /translate + upload)
  cli.py                signavatar record|extract|info|view|corpus|moe|yt|eval
blender/                playback-side scripts (run inside Blender's Python)
web/                    browser app
  index.html            landing: 生成/詞庫/來源三卡 + 內建影片庫 + 上傳分析
  generate.html         手語生成 dedicated page (text → TSL → VRM avatar)
  corpus.html           詞庫總覽 stats dashboard (click-to-generate)
  sources.html          資料來源 per-word provenance tracing
  viewer.html           viewer: skeleton/avatar, timeline, video comparison,
                        sign composer & annotation (?rec=&video= select item)
  composer.js           shared composer core (tokenize/trim/stitch/NMM)
  avatar3d.js           3D VRM avatar (vendored three.js + kalidokit)
  models/*.vrm          switchable avatars (VRoid/VRM samples) — drop in any
                        VRM, e.g. your own VRoid Studio export
recordings/             local recordings (gitignored except samples/; tracked:
                        lexicon.json 詞庫 / tsl_pairs.json 平行語料 /
                        moc_manifest.json + external_manifest.json 出處 /
                        moe_dict.json 教育部詞表)
tools/moe_bulk_all.sh   一鍵分塊補完教育部辭典缺詞 (resumable)
docs/data-sources.md    資料來源登記簿 (provenance & licenses)
tests/
```

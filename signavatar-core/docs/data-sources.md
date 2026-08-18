# 資料來源登記簿(Data Provenance)

本專案所有外部資料的出處、取得方式與授權狀態都記錄在此。
機器可讀的逐筆出處:

- `recordings/lexicon.json` — 每個詞條的 `source` 欄位(如 `moc:G2D1P1`)
- `recordings/tsl_pairs.json` — 每個平行句的 `source` 欄位
- `recordings/moc_manifest.json` — 每個語料單元的來源 URL、主題、
  演繹者屬性、影片路徑、抓取時間(由 `signavatar corpus ingest|pairs`
  自動維護)

## 使用原則

- **非商用研究用途**(使用者 2026-07-05 裁示)。文化部語料庫的
  著作權聲明已確認**明文允許**此用途(見下),使用時必須註明出處:
  > 張榮興(主編)(2025)。《臺灣手語語料庫》。臺北:中華民國文化部。
- 下載素材(影片、大 JSON)**不入版控、不散布**
  (`.gitignore: recordings/*`);repo 維持 private。
- **訓練資料一律不對外公開**(使用者 2026-08-17 裁示)。各來源取得的
  同意都只涵蓋「使用」,不等於可以公開資料集;要連同資料一起發表前,
  必須逐一回頭確認該來源的同意範圍是否涵蓋散布。
- 每一筆進入詞庫/平行句的資料都必須帶 `source` 欄位,無來源不收。

## 來源清單

### 1. 文化部臺灣手語語料庫 ★ 主要來源

- **URL**:https://tslcorpus.moc.gov.tw/(2025-04-01 上線,
  國家語言整體發展方案產出)
- **取得方式**:公開 REST API,無需認證
  - `POST /api/corpus/getCorpusList` — 407 個單元
    (207 敘事 type=1 單簽者;200 對話 type=2 雙簽者同框)
  - `POST /api/corpus/findCorpusDetailByUuid` — 逐句中文 `Text` +
    gloss `Hand` + 逐詞毫秒時間戳 `wordList`;`film_url` 可直接下載 MP4
  - robots.txt 不禁止;著作權條款已確認(見下方授權狀態)
- **我們取用**(2026-07-05 現況):
  - **詞級詞庫**:23 個 type=1 單元影片 → MediaPipe 萃取 → 依
    wordList 切出 **549 個詞條**(對話類雙人同框,單人追蹤管線
    不適用,不取影片);gloss 已去除語料庫附帶的句讀標點
  - **平行句**:全部 407 單元的 Text↔Hand 配對 = **5,066 句**
    (不需影片),作為 LLM 翻譯的 few-shot 例句
  - 逐單元出處:`recordings/moc_manifest.json`(407 單元全記錄)
- **授權狀態:已確認(2026-07-05,自 /copyright 頁前端 bundle 逐字
  擷取)**。著作權聲明第三條:
  > 「本語料庫檢索結果,以及本語料庫明示同意提供下載之相關資料,
  > 僅提供使用者進行研究、學術、教育等非商業性質用途,且不得為任何
  > 超出著作權法有關合理使用之規定。依上述規定利用時,應註明出處」
  引用格式:張榮興(主編)(2025)。《臺灣手語語料庫》。臺北:
  中華民國文化部。另不得侵害著作人格權、不得惡意變更資訊。
  → **與本專案(非商業研究)完全相容**;README 已載明出處。
  客服信箱:corpus.tsl@gmail.com。

### 2. 教育部常用手語辭典(高價值候選,調查完成 2026-07-05)

- **URL**:https://special.moe.gov.tw/signlanguage
- **規模(實測)**:辭彙 14 大類、**15,770 個詞條、17,087 筆打法
  (變體)記錄**;另有基礎(60 基本手勢、音標、部首、字母)與會話。
- **機器取得**:未公開文件但完全開放、無需驗證的 REST API
  (自頁面 JS 逆向,已實測):
  - `GET /signlanguage/api/contentTypes?type=vocabulary` → 14 大類
  - `GET /signlanguage/api/contentTypes?type=vocabulary%2F01` →
    該類全部詞條(title、英文釋義、isCommon、**youtubeKey 影片鍵**)
  - `GET /signlanguage/api/contents?type=vocabulary%2F01` → 打法層
    (打法A/B、手形圖)
  - 影片:`https://www.youtube.com/embed/<youtubeKey>`,掛在 YouTube
    頻道「全國特教資訊網教育部」(標準 YouTube 授權、非 CC)
- **授權證據**:該站「政府網站資料開放宣告」(逐字):
  > 「教育部全球資訊網上刊載之所有資料與素材……以無償、非專屬,
  > 得再授權之方式提供公眾使用,使用者得不限時間及地域,重製、
  > 改作、編輯、公開傳輸……應註明出處。」
  注意:(a) 條文為 gov.tw 通用範本,與辭典子站的涵蓋關係未逐字明示;
  (b) 頁尾另有 All Right Reserved 字樣;(c) 影片本體在 YouTube 為
  標準授權——**JSON 詞條資料可依開放宣告使用(註明出處);影片
  下載重製建議先去函教育部確認**。
- **取用狀態(2026-07-05 起,使用者指示試點)**:
  - `signavatar moe fetch` 已抓全詞表 metadata → `recordings/moe_dict.json`
    (**8,710 個有影片的獨特詞**,其中 5,785 常用)
  - `signavatar moe ingest <詞>` 逐詞下載影片(yt-dlp)→ 萃取 →
    詞條**強制標 `system: 文法手語`**,且**絕不覆蓋**已存在的
    自然手語(MOC)詞條——只補缺詞
  - 逐筆出處記錄於 `recordings/external_manifest.json`
  - **偏「文法手語」**(李信賢音韻分析,https://www.tcda.org.tw/675)
    ——與自然手語詞條以 system 欄位區隔,避免混用毀掉可懂度。

### 3. 中正大學台灣手語線上辭典 ★ 詞級主力來源

- **URL**:https://twtsl.ccu.edu.tw/(第五版,蔡素娟、戴浩一團隊)
- **機器取得**:React SPA,頁面上抓不到東西,資料全在 JSON API:
  - `GET /api/querySearch?id=N&lang=zh` 逐 id 抓(id 1..3617,其中 692 個空號)
  - `GET /api/group` 同義詞、`GET /api/sentence` 例句
  - **`lang` 必須是 `zh`**,用 `zh-TW` 會回 "Missing or invalid parameters"
  - 影片在 `https://twtsl.ccu.edu.tw/{clip}.mp4`,部分路徑含空白／括號要先 URL 編碼
- **規模(實測)**:3,508 個詞條、3,506 支影片、4,650 個中文詞
  (辭典正式名 + 同義索引名)、546 句例句。
- **取用狀態**:
  - 影片與 MediaPipe 萃取結果:`recordings/<id:04d>_<詞>.mp4` + 同名 `.json`,
    3,506 支全數在庫
  - 詞庫詞條:**3,354 條**,標 `source: twtsl:<id>`,`text` 欄位放辭典的
    動作描述。同義索引名各自成一條詞條、共用同一支影片,所以詞條數(3,354)
    多於影片數(2,557 支被引用)
  - 補登工具:`signavatar lexicon backfill`(影片已萃取但沒進詞庫的補成詞條,
    不覆蓋既有詞條)
  - **無逐筆 manifest**——與 moc/moe/placename 不同,本來源的出處直接由
    `twtsl:<id>` 回推辭典頁 `https://twtsl.ccu.edu.tw/?id=<id>`,不另建檔
- **授權狀態:已確認(使用者 2026-08-04 裁示)**。
  **模型訓練、對外散布模型、重製散布資料皆合法,唯一條件是標明出處**:
  > 蔡素娟等(2026)。中正大學手語語言學台灣研究中心。

  注意這推翻了本文件早期版本「版權保護學術資源、無開放授權、不爬取」的判斷。
  屬使用者口頭確認、非本專案獨立查證;書面依據存檔另議。
  惟仍受「使用原則」的**訓練資料一律不對外公開**限制:授權允許散布不代表
  本專案要散布。學術合作聯絡:Lngsign@ccu.edu.tw。

### 4. TASLI 臺灣手語新詞數位學習網(2026-08-18 已取用)

- **URL**:https://newtsl.taslifamily.org/
  (社團法人臺灣手語翻譯協會 X 臺灣智慧生活科技促進協會 X 众社會企業)
- **性質**:收「新詞」——時事、品牌、科技、醫療這類辭典來不及收的詞
  (ChatGPT、台積電、小紅書、載具、葉克膜、AED)。**不是補缺口用的**:
  實測 518 個詞裡只有 1 個命中當時的缺詞清單,價值在於擴充虛擬人
  講得出、但訓練資料沒用到的實用詞彙。
- **機器取得**:Google Sites。導覽與內文是前端渲染,但**連結與 iframe 的
  aria-label 都在原始 HTML 裡**,純 HTTP + regex 就夠,不必開瀏覽器。
  - 枚舉要靠索引頁聯集:每頁導覽只展開當前區塊(約 163/518),
    要掃過 15 個主題頁 + 8 個年度頁才湊得齊
  - 詞頁 `/新詞彙/<5位編號>_<詞>`;正式詞形在 `"pageTitle"` 欄位
    (URL 上的是小寫去標點版,如 `00001_優步uber` vs `優步（Uber）`)
  - 每詞兩支 YouTube 影片:**詞彙**與**例句**。詞彙那支的標籤跨年份至少
    五種寫法(`手語詞彙`/`- 詞彙`/`詞彙`/`- 詞𢑥`(異體字)/`手語辭彙`,
    早期批次直接拿詞名當標籤),所以**用排除法認「例句」**再取另一支;
    照正面列舉寫會漏掉 274 個詞(實測 197 vs 471)
- **取用狀態(2026-08-18)**:
  - `signavatar tasli fetch` → `recordings/tasli.json`(518 詞,471 個有詞彙影片)
  - `signavatar tasli bulk` → `recordings/tasli_<編號>_<詞>.mp4/.json`,
    **425 個詞條**,標 `source: tasli:<編號>`
  - 括號別名各自成鍵:`優步（Uber）` → `優步` 與 `Uber` 指向同一支影片
  - 只補缺詞,不覆蓋既有詞條;逐筆出處在 `recordings/external_manifest.json`
    (含例句影片的 YouTube id,備日後取用)
- **授權狀態:已取得使用同意(使用者 2026-08-18 確認)**。
  同第 1、3 節,屬使用者口頭確認、非本專案獨立查證。仍受「使用原則」的
  **訓練資料一律不對外公開**限制。窗口:tasli.tw@gmail.com。

### 5. 線上手語教室 YouTube 頻道(CC-BY!高價值候選)

- **URL**:https://www.youtube.com/@線上手語教室
  (channelId `UCnqptEcnbKHkg5bQq2aPzFA`)
- **規模**:76 部影片(2015–2022,每集一個生活主題會話單元)。
  營運:國立臺灣師範大學特殊教育中心;聾人老師陳濂僑(公視聽聽看
  金鐘主持人)、聽人老師魏如君(台灣手語翻譯協會理事長)。
- **授權證據**:抽驗影片 watch 頁 metadata 明載
  「創用 CC 姓名標示授權(允許再利用)」= **CC-BY**(YouTube 官方
  授權欄位)——目前唯一明確 CC 授權的成段 TSL 會話影片來源。
- **用途**:連續手語(非單詞)素材;無 gloss 標註,需自行切分,
  適合過渡動作(epenthesis)研究與未來連續手語資料。
- **取用狀態(2026-07-05 起,使用者指示試點)**:
  `signavatar yt <url> <name> --license-note "CC-BY(...)"` 下載+萃取
  入影片庫;出處與授權記於 `recordings/external_manifest.json`。
  首支試點:pGR_xt-BeQs(該支已逐字驗證 CC-BY 標示)。
  CC-BY 要求署名:國立臺灣師範大學特殊教育中心「線上手語教室」。

### 6. 其他影片來源(候選/死路)

- 臺灣手語教材資源網(國教署委辦,張榮興主編):
  https://jung-hsingchang.tw/twsl/index.html — 18 冊教材 PDF+影片;
  **未標示授權**,聯絡 tw.slt.digi@gmail.com(政府委辦,可去函)。
- 台灣手語地名電子資料庫:https://jung-hsingchang.tw/placenames.php
  — 1,000 個地名手語;「版權所有 All Rights Reserved」→ 需洽談。
  **2026-08-17 更新:已取得同意並全站取用,見下方第 9 節。**
- 公視手語新聞 YouTube:https://www.youtube.com/@slnewsptsTaiwan
  — 標準授權、無開放跡象 → 死路(法律意見:非商用仍應取得授權)。
- SignTube:https://www.youtube.com/@tslsigner — 標準授權。
- ~~TASLI 新詞網:Google Sites 動態頁無法批次;需洽談。~~
  **已解決**:連結與影片標籤其實都在原始 HTML,純 HTTP 抓得完;
  授權亦已取得。見上方第 4 節。
- 彙整入口:國家語言數位資源網
  https://ntlgportal.moc.gov.tw/NTLGPortal/RelatedLinks?nodeId=43

### 7. 已確認的死路(2026-07-05 調查)

- **data.gov.tw**:全站 74,259 筆掃描,「手語」僅 8 筆地方政府
  手譯服務行政統計(政府資料開放授權第 1 版),無任何 TSL 語料。
- **HuggingFace / Zenodo / GitHub**:無 TSL 資料集(sign-language-
  processing/datasets 的 28 個手語資料集皆無 TSL)——自建資料集
  在國際上仍是空白,本專案的詞庫+平行語料有獨特價值。
- ~~twtsl.ccu.edu.tw:主機連線被拒(多次),日後再試。~~
  **已解決**:站點是 React SPA,要走 JSON API 而非頁面;2026-08-13 已全站
  爬完並入庫,見上方第 3 節。

### 8. 專案內既有素材(里程碑 1-4 測試用)

- 財神到 MV、聽我說謝謝你手語歌(SignTube)——**有版權**,
  僅本地測試,repo 必須維持 private;正式詞庫已改用語料庫來源。

### 9. 台灣手語地名網(2026-08-17 依使用者指示取用)

- **URL**:https://jung-hsingchang.tw/name/placenames_database.php
  (張榮興台灣手語研究室;影片原掛 signlanguage.ccu.edu.tw)
- **規模(實測)**:19 縣市索引頁 + **1000 個地名**(serno 1–1000,
  無空號),每個地名一支 MP4(約 200–500 KB,全站約 300 MB),
  外加**逐字素構詞分析**:表達方式(取字義/取字形/綜合字形字義/
  補充訊息)、造詞策略(全字直譯/替代後直譯/刪減後直譯/全字形體
  取代……)、運用手形、打法描述。
- **機器取得**:無 API,2010 年的靜態 PHP + Dreamweaver 巢狀表格,
  以 regex 解析固定樣板(`src/signavatar/placenames.py`):
  - `placenames_database.php?searchtp=0&&localname=<0-18>` → 該縣市
    的 `areavideo.php?serno=N` 清單(只取 `right_menu` 區段,
    避開導覽列與廣告區的同型連結)
  - `areavideo.php?serno=N` → 地名、`<source src>` 影片、構詞分析表
  - 影片:`https://jung-hsingchang.tw/name/admin/upload/p_<serno:03d>.mp4`
  - robots.txt 不存在(404)
- **取用狀態**:
  - `signavatar placenames fetch` → `recordings/placenames.json`
    (全站 metadata + 構詞分析全文,重跑不必再爬)
  - `signavatar placenames bulk` → 下載 + MediaPipe 萃取 →
    `recordings/pn_<serno:04d>_<地名>.mp4/.json`,可續跑
  - 詞條 `source: placename:<serno>`,`text` 放打法描述、`county`
    放縣市;**只補缺詞,絕不覆蓋**既有的自然手語(MOC)詞條
  - 同地名多種打法(基隆1/基隆2)在詞庫收斂成一鍵(先到先得),
    變體影片與構詞分析仍全數保留在 manifest 與 placenames.json
  - 逐筆出處記錄於 `recordings/external_manifest.json`
- **授權狀態:已取得使用同意(使用者 2026-08-17 確認)**。
  站上僅頁尾「張榮興台灣手語研究室版權所有 All Rights Reserved」、
  無開放宣告,但已另行取得研究室同意本專案使用。同第 1 節,
  屬使用者口頭確認、非本專案獨立查證;書面依據存檔另議。
- **使用限制:同意的是「使用」,不是「公開」。**
  **訓練資料一律不對外公開**——影片、MediaPipe 萃取 JSON、
  `placenames.json` 與詞庫都不散布、不入版控(`.gitignore: recordings/`),
  repo 維持 private。引用須註明出處(張榮興台灣手語研究室,台灣手語地名網)。
  若日後要連同資料集一起發表,需回頭確認同意範圍是否涵蓋散布。

### 規則檔與 few-shot

- `src/signavatar/data/tsl_rules.json` — 語序規則,依據中正大學
  手語語言學研究中心公開文獻與 Fischer (2014) 整理,需聾人顧問驗證。
- `src/signavatar/translate.py` `_STATIC_EXAMPLES` — 取自語料庫
  G2D1P1(備援 few-shot)。

## 建置優先序(開放性 × 有用性,2026-07-05 調查結論)

| 名次 | 來源 | 開放性 | 用途 |
|---|---|---|---|
| 1 | 文化部語料庫(已在用) | 非商業研究明文允許+註明出處 | 詞庫+平行語料主幹 |
| 2 | 中正辭典(已在用) | 可訓練可散布+註明出處 | 詞級主力:3,354 詞條 |
| 3 | 教育部辭典 API | 政府開放宣告(JSON 資料) | 詞條 metadata 15,770 詞;影片先緩 |
| 4 | 線上手語教室 | CC-BY 逐支標示 | 連續會話影片 |
| 5 | 教材資源網 | 未標示授權 | 去函洽談後才用 |
| — | TASLI 新詞網(2026-08-18 已取用) | 已取得同意 | 425 個現代詞條;擴充實用詞彙,非補缺口 |
| — | 地名網(2026-08-17 已取用) | 已取得研究室同意 | 1000 地名詞條;資料不公開、不散布 |

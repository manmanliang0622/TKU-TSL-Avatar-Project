# Web 應用結構(landing → 模式 → viewer)

## 頁面流程

```text
/  (index.html — Landing)
├── 手語生成:/generate.html — 專屬頁:中文輸入 → POST /translate
│      (LLM+規則)→ Composer.build 拼接 → Avatar3D 全螢幕播放;
│      gloss 標籤即時高亮、NMM/來源標記、範例句、變速、模型切換;
│      支援 ?text= 自動生成(詞庫總覽的點擊入口)
├── 詞庫總覽:/corpus.html — 資料儀表板(純前端統計):詞彙數
│      (自然/文法/手動)、平行句、完全可播例句、已萃取單元;
│      可搜尋詞彙與例句,點擊 → generate.html?text=…
├── 內建影片庫:GET /library 列出已分析的 recordings
│      點選 → /viewer.html?rec=<name>.json[&video=<url>]
└── 上傳影片分析:拖放或選檔 → POST /upload
       → 進度畫面(輪詢 /extract/status,顯示 n/m 幀)
       → 分析「完成後」才導向 /viewer.html?rec=…&video=…
       → 失敗停留在 landing 顯示錯誤
```

共用模組 `web/composer.js`(window.Composer):斷詞、片段切取、
交叉過渡(距離感知時長)、NMM 疊加、組合成 recording 物件;
viewer.html 的合成面板與 generate.html 都用它。

viewer.html 保持原功能(骨架/虛擬人/對照/合成/標註/匯出),新增:

- 讀取 `?rec=` 與 `?video=` 決定載入內容(無參數時沿用 server 預設)
- 標註存檔用「目前載入的 recording 名稱」
- header 新增「◂ LIBRARY」返回 landing

## Server API(`src/signavatar/viewer.py`)

| 路由 | 說明 |
|---|---|
| `GET /` | landing(index.html) |
| `GET /library` | 已分析清單:name/label/frames/duration/fps/video url,依 mtime 新→舊;metadata 以 (mtime) 快取避免重複解析大 JSON |
| `GET /videos/<name>` | 供 viewer/PiP 讀 upload_dir 內的影片檔(basename 白名單);server 啟動時 `--video` 指定的檔案也可用其檔名取得 |
| `POST /translate` | `{"text", "llm"?}` → 中文→TSL gloss(LLM via claude CLI + few-shot 平行句 `recordings/tsl_pairs.json`;失敗退規則式);glosses 保證在詞彙庫內 |
| 既有 | /recording.json /video /recordings/<n> /upload /extract/status /status /lexicon /models.json |

## 設計原則

- 上傳的入口在 landing;viewer 內的 UPLOAD 保留(進階用,原地切換)。
- recordings/ 目錄就是「庫」:上傳自動入庫(影片+JSON 同 stem)。
- 視覺沿用 instrument 風格(同色票/字體),landing 是大卡片版面。

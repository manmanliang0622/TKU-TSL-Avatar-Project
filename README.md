# 🤟 淡江大學行政服務：台灣手語雙向轉譯系統 (TKU-TSL-Avatar-Project)

本專案旨在利用 AI 技術實現行政窗口與聽障朋友的無障礙溝通。透過 MediaPipe 提取手勢特徵，並對接到 SMPL-X 標準虛擬人模型，實現高精確度的手語動作重定向。

## 📂 專案架構 (Project Structure)
- `core/`: 核心邏輯（Gemini 翻譯介接、模型載入器）
- `scripts/`: 自動化工具（`csv_to_unity.py` 數據監控與轉換器）
- `refined_data/`: 預處理後的骨架座標數據 (CSV)
- `unity_data/`: 提供給 Unity 讀取的動作腳本 (JSON, 符合 SMPL-X 規格)
- `app.py`: 基於 Streamlit 的前端展示網頁

## 🛠️ 技術棧 (Tech Stack)
- **視覺處理**: MediaPipe Hands / DWPose
- **NLP 翻譯**: Google Gemini 2.5 Flash (針對淡江行政情境優化)
- **3D 驅動**: Unity Engine + SMPL-X Model Standard
- **開發語言**: Python 3.10+ (支援雙 GPU 並行運算)

## 🚀 快速上手 (Quick Start)
1. **建立虛擬環境**: `python -m venv tsl_env`
2. **啟動環境**: `tsl_env\Scripts\activate`
3. **安裝依賴**: `pip install -r requirements.txt`
4. **設定環境變數**: 
   請手動建立 `.env` 檔案並加入以下資訊：
   ```text
   GEMINI_API_KEY=你的金鑰
   HF_TOKEN=你的HuggingFaceToken

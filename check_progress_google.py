import os
import json
from googletrans import Translator

def check_my_progress_automated():
    translator = Translator()
    config_path = 'sign_config.json'
    csv_dir = 'data_library'
    video_dir = 'data/raw_videos'

    if not os.path.exists(config_path):
        print("❌ 錯誤：找不到 sign_config.json")
        return

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    existing_videos = [f.replace('.mp4', '') for f in os.listdir(video_dir) if f.endswith('.mp4')]
    existing_csvs = [f.replace('_features.csv', '') for f in os.listdir(csv_dir) if f.endswith('.csv')]

    completed = []
    video_only = []

    print("🤖 AI 正在翻譯進度清單，請稍候...")

    for key_name, csv_filename in config.items():
        # 取得檔名 (例如 key, perfect)
        eng_name = csv_filename.replace('_features.csv', '').replace('_', ' ')
        
        # --- AI 主動翻譯層 ---
        try:
            # 將底線換成空格，翻譯效果會更好
            translation = translator.translate(eng_name, dest='zh-tw').text
            display_name = f"{translation} ({eng_name})"
        except:
            # 如果網路斷線，就顯示原名
            display_name = eng_name
        
        has_video = eng_name.replace(' ', '_') in existing_videos
        has_csv = eng_name.replace(' ', '_') in existing_csvs
        
        if has_video and has_csv:
            completed.append(display_name)
        elif has_video:
            video_only.append(display_name)

    print(f"\n📊 --- 【Google AI 翻譯版】數據生產線報告 ---")
    print(f"✅ 雙料完成: {len(completed)}")
    print(f"⏳ 待處理 (有影片沒數據): {len(video_only)}")

    if completed:
        print(f"\n🌟 已完成項目:")
        # 每行顯示 3 個，避免畫面太亂
        for i in range(0, len(completed), 3):
            print(", ".join(completed[i:i+3]))
    
    if video_only:
        print(f"\n👉 這些請跑 auto_video_worker.py 轉換:")
        print(", ".join(video_only))

if __name__ == "__main__":
    check_my_progress_automated()
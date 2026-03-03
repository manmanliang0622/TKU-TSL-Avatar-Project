import json
import os

def sync_config_real():
    config_path = 'sign_config.json'
    video_dir = 'data/raw_videos'
    
    # 確保資料夾存在
    if not os.path.exists(video_dir):
        print(f"❌ 找不到影片資料夾: {video_dir}")
        return

    # 1. 直接掃描資料夾內所有的實體影片檔
    video_files = [f for f in os.listdir(video_dir) if f.endswith('.mp4')]
    
    # 2. 重新建立一個乾淨的配置字典 (不再保留舊的殘留項目)
    new_config = {}
    
    for video_name in video_files:
        # 取得檔名 (例如 'apply_for')
        eng_name = video_name.replace('.mp4', '')
        # 設定對應的 CSV 檔名
        csv_name = f"{eng_name}_features.csv"
        # 以英文檔名作為 Key (這會與妳目前的 check_progress_auto 邏輯一致)
        new_config[eng_name] = csv_name

    # 3. 覆蓋寫回 sign_config.json
    with open(config_path, 'w', encoding='utf-8') as f:
        json.dump(new_config, f, ensure_ascii=False, indent=2)
    
    print(f"✅ 同步完成！目前資料夾內實體影片共：{len(new_config)} 組")
    print(f"📢 現在 sign_config.json 已與妳的影片數量完全同步。")

if __name__ == "__main__":
    sync_config_real()
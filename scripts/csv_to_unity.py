import os
import glob
import json
import time
import pandas as pd
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# --- 1. 單一檔案轉換函式 ---
def process_single_csv(file_path, output_dir):
    """
    將精煉後的 CSV 座標數據轉換為 Unity 易讀的 JSON 格式
    """
    base_name = os.path.basename(file_path).replace('.csv', '')
    json_file_name = f"{base_name}.json"
    save_path = os.path.join(output_dir, json_file_name)
    
    try:
        # 增加緩衝時間，確保檔案寫入完成
        time.sleep(0.5)
        
        # 讀取數據
        df = pd.read_csv(file_path)
        
        # 轉換影格數據為字典列表
        frames_data = df.to_dict(orient='records')
        
        # 封裝成 Unity C# 解析類別對應的格式
        unity_format = {
            "clip_name": base_name.replace('_features', ''),
            "total_frames": len(frames_data),
            "fps": 30,
            "frames": frames_data
        }
        
        # 儲存 JSON
        with open(save_path, 'w', encoding='utf-8') as f:
            json.dump(unity_format, f, indent=2, ensure_ascii=False)
            
        print(f"✅ [成功轉換] {json_file_name}")
        
    except Exception as e:
        print(f"❌ [錯誤] 轉換 {base_name} 時發生異常: {e}")

# --- 2. 監控事件處理器 ---
class NewCsvHandler(FileSystemEventHandler):
    def __init__(self, output_dir):
        self.output_dir = output_dir

    def on_created(self, event):
        self._handle_event(event)
    
    def on_modified(self, event):
        # 有些作業系統會觸發 modified 而非 created
        self._handle_event(event)

    def _handle_event(self, event):
        if not event.is_directory and event.src_path.endswith('.csv'):
            # 排除暫存檔
            if not os.path.basename(event.src_path).startswith('~'):
                print(f"👀 偵測到數據變動: {os.path.basename(event.src_path)}")
                process_single_csv(event.src_path, self.output_dir)

# --- 3. 啟動監控主程式 ---
def start_auto_monitor():
    # --- 關鍵修正：路徑自動定位 ---
    # 取得此腳本所在的絕對路徑 (scripts 資料夾)
    current_script_path = os.path.dirname(os.path.abspath(__file__))
    
    # 使用絕對路徑定位 refined_data 與 unity_data
    # 假設這兩個資料夾與 scripts 資料夾同層，或是在其上一層
    root_dir = os.path.abspath(os.path.join(current_script_path, ".."))
    input_dir = os.path.join(root_dir, 'refined_data')
    output_dir = os.path.join(root_dir, 'unity_data')
    
    # 確保資料夾存在
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)
        
    print(f"📂 監控目錄: {input_dir}")
    print(f"📂 輸出目錄: {output_dir}")

    # 1. 啟動時先掃描一次尚未轉換的舊檔案
    print("🔍 正在進行啟動掃描...")
    csv_files = glob.glob(os.path.join(input_dir, '*.csv'))
    
    converted_count = 0
    for file_path in csv_files:
        base_name = os.path.basename(file_path).replace('.csv', '')
        save_path = os.path.join(output_dir, f"{base_name}.json")
        
        if not os.path.exists(save_path):
            process_single_csv(file_path, output_dir)
            converted_count += 1
            
    if converted_count > 0:
        print(f"🔄 掃描完成：已補齊 {converted_count} 個新檔案。")
    else:
        print("✅ 掃描完成：目前所有數據皆已同步。")

    # 2. 啟動即時監控
    event_handler = NewCsvHandler(output_dir)
    observer = Observer()
    observer.schedule(event_handler, input_dir, recursive=False)
    observer.start()
    
    print(f"\n🎮 Unity JSON 轉換器已就位 (雙向同步模式)")
    print(f"💡 只要 refined_data 有新 CSV，我就會自動轉成 Unity JSON")
    print(f"按 Ctrl+C 可以停止。")
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        print("\n🛑 已停止轉換監控。")
    observer.join()

if __name__ == "__main__":
    start_auto_monitor()
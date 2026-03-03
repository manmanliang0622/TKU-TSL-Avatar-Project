import pandas as pd
import numpy as np
import os
import glob
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

def normalize_hand(df, prefix):
    """
    針對特定手 (L 或 R) 進行歸一化：
    1. 平移：以手腕 (第 0 點) 為原點
    2. 縮放：以手腕 (0) 到中指根部 (9) 的距離為 1.0 基準進行縮放
    """
    wrist_x_col = f'{prefix}_0_x'
    wrist_y_col = f'{prefix}_0_y'
    wrist_z_col = f'{prefix}_0_z'
    
    mid_mcp_x_col = f'{prefix}_9_x' 
    mid_mcp_y_col = f'{prefix}_9_y'
    mid_mcp_z_col = f'{prefix}_9_z'

    if wrist_x_col not in df.columns:
        return df
        
    cols_x = [f'{prefix}_{i}_x' for i in range(21)]
    cols_y = [f'{prefix}_{i}_y' for i in range(21)]
    cols_z = [f'{prefix}_{i}_z' for i in range(21)]
    all_cols = cols_x + cols_y + cols_z

    mask = df[wrist_x_col] != 0
    
    if mask.any():
        # 1. 平移歸一化
        df.loc[mask, cols_x] = df.loc[mask, cols_x].sub(df.loc[mask, wrist_x_col], axis=0)
        df.loc[mask, cols_y] = df.loc[mask, cols_y].sub(df.loc[mask, wrist_y_col], axis=0)
        df.loc[mask, cols_z] = df.loc[mask, cols_z].sub(df.loc[mask, wrist_z_col], axis=0)

        # 2. 縮放歸一化
        dist = np.sqrt(
            df.loc[mask, mid_mcp_x_col]**2 + 
            df.loc[mask, mid_mcp_y_col]**2 + 
            df.loc[mask, mid_mcp_z_col]**2
        )
        dist = dist.replace(0, 1.0)
        
        for col in all_cols:
            df.loc[mask, col] = df.loc[mask, col].divide(dist, axis=0)
            
    return df

# --- 新增：獨立的單一檔案處理函式 ---
def process_single_file(file_path, output_dir='refined_data'):
    file_name = os.path.basename(file_path)
    save_path = os.path.join(output_dir, file_name)
    
    try:
        # 稍微等待 0.5 秒，確保系統已經把新檔案完全寫入磁碟再讀取
        time.sleep(0.5)
        df = pd.read_csv(file_path)
        
        df = normalize_hand(df, 'L')
        df = normalize_hand(df, 'R')
        
        df.to_csv(save_path, index=False)
        print(f"✅ 自動精煉完成: {file_name}")
    except Exception as e:
        print(f"❌ 處理 {file_name} 時發生錯誤: {e}")

# --- 新增：Watchdog 監控事件處理器 ---
class NewDataHandler(FileSystemEventHandler):
    def on_created(self, event):
        # 當偵測到新檔案被建立，且是 .csv 檔時觸發
        if not event.is_directory and event.src_path.endswith('.csv'):
            print(f"👀 偵測到新數據加入: {os.path.basename(event.src_path)}")
            process_single_file(event.src_path)

def start_auto_monitor():
    input_dir = 'data_library'
    output_dir = 'refined_data'
    
    if not os.path.exists(input_dir):
        os.makedirs(input_dir)
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        
    # 1. 啟動時先做一次「差異比對」：只處理還沒被精煉過的新檔案
    csv_files = glob.glob(os.path.join(input_dir, '*.csv'))
    pending_files = []
    
    for file_path in csv_files:
        file_name = os.path.basename(file_path)
        save_path = os.path.join(output_dir, file_name)
        # 如果 refined_data 裡面還沒有這個檔案，才加入待處理清單
        if not os.path.exists(save_path):
            pending_files.append(file_path)
            
    if pending_files:
        print(f"🔄 啟動掃描：發現 {len(pending_files)} 個未處理的舊檔案，開始補齊處理...")
        for file_path in pending_files:
            process_single_file(file_path)
    else:
        print("✅ 啟動掃描：所有現有數據皆已精煉完畢！")

    # 2. 啟動 Watchdog 進入背景即時監控模式
    event_handler = NewDataHandler()
    observer = Observer()
    observer.schedule(event_handler, input_dir, recursive=False)
    observer.start()
    
    print(f"\n🔍 系統進入背景監控模式...")
    print(f"👉 請隨時將新的 .csv 檔案丟入「{input_dir}」資料夾中，系統會自動轉換。")
    print(f"按 Ctrl+C 可以停止監控。")
    
    try:
        while True:
            time.sleep(1) # 讓程式持續掛在背景運行
    except KeyboardInterrupt:
        observer.stop()
        print("\n🛑 已停止自動監控。")
    observer.join()

if __name__ == "__main__":
    start_auto_monitor()
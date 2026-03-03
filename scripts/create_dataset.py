import pandas as pd
import numpy as np
import os
import json

def create_dataset():
    # 設定路徑
    input_dir = 'refined_data'
    config_path = 'sign_config.json'
    
    # 1. 載入配置檔
    if not os.path.exists(config_path):
        print(f"❌ 錯誤：找不到 {config_path}")
        return
        
    with open(config_path, 'r', encoding='utf-8') as f:
        sign_config = json.load(f)
        
    X = [] # 用來存放所有的座標序列
    y = [] # 用來存放對應的單字標籤
    
    # 2. 建立標籤對照表 (例如: "學生證" -> 0, "宿舍" -> 1)
    label_map = {name: i for i, name in enumerate(sign_config.keys())}
    
    # 3. 設定統一的時間長度 (Sequence Length)
    # 手語動作快慢不一，我們統一固定為 40 影格 (約 1.3 秒)
    max_seq_length = 40 
    
    print(f"📦 開始打包 126 欄位雙手數據矩陣...")

    for sign_name, file_prefix in sign_config.items():
        # 對接 refined_data 的檔名
        pure_name = file_prefix.replace('_features.csv', '')
        file_path = os.path.join(input_dir, f"{pure_name}_features.csv")
        
        if os.path.exists(file_path):
            try:
                df = pd.read_csv(file_path)
                # 取得 126 欄位的數值 (L_0_x ... R_20_z)
                features = df.values 
                
                # --- 時間序列對齊邏輯 (Padding/Truncate) ---
                if len(features) > max_seq_length:
                    # 如果錄太長，就截斷後面的影格
                    features = features[:max_seq_length]
                else:
                    # 如果錄太短，就在後面補零 (Padding)，確保每個樣本都是 (40, 126)
                    padding = np.zeros((max_seq_length - len(features), 126))
                    features = np.vstack((features, padding))
                
                X.append(features)
                y.append(label_map[sign_name])
                print(f"✅ 已打包: {sign_name} (原長度: {len(df)} 幀)")
            except Exception as e:
                print(f"⚠️ 讀取 {pure_name} 時發生錯誤: {e}")
        else:
            print(f"❌ 找不到精煉後的檔案: {file_path}")

    # 4. 轉換為 Numpy 格式並存檔
    X = np.array(X, dtype='float32')
    y = np.array(y, dtype='int32')
    
    # 儲存特徵與標籤，供訓練模型使用
    np.save('X.npy', X)
    np.save('y.npy', y)
    
    # 儲存標籤映射表，之後辨識程式會用到
    with open('label_map.json', 'w', encoding='utf-8') as f:
        json.dump(label_map, f, ensure_ascii=False, indent=4)
        
    print(f"\n🎉 數據集製作完成！")
    print(f"📊 特徵形狀 (X.shape): {X.shape} (樣本數, 影格長度, 座標數)")
    print(f"🏷️ 標籤數量 (y.shape): {y.shape}")
    print(f"💾 檔案已存為 X.npy, y.npy 與 label_map.json")

if __name__ == "__main__":
    create_dataset()
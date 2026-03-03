import json
import pandas as pd
import os

def load_sign_data(sign_name, config_path='sign_config.json', data_dir='refined_data'):
    """
    根據手語詞彙名稱，從配置檔中查找並讀取對應的「精粹後」CSV 特徵數據。
    
    Args:
        sign_name (str): 手語詞彙名稱 (例如: "dormitory", "apply")
        config_path (str): sign_config.json 的路徑
        data_dir (str): 存放歸一化 CSV 檔案的資料夾路徑 (改為 refined_data)
        
    Returns:
        pd.DataFrame: 包含 63 欄相對座標特徵的數據表，若失敗則返回 None
    """
    
    # 1. 檢查配置檔是否存在
    if not os.path.exists(config_path):
        print(f"❌ 錯誤：找不到配置檔 {config_path}")
        return None

    # 2. 讀取 JSON 配置
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except Exception as e:
        print(f"❌ 錯誤：解析 JSON 失敗 - {e}")
        return None

    # 3. 檢查詞彙是否存在於配置中
    if sign_name not in config:
        print(f"❌ 錯誤：詞彙 '{sign_name}' 未定義。")
        return None

    # 4. 取得對應的 CSV 檔名並檢查「精粹後」檔案是否存在
    csv_filename = config[sign_name]
    csv_path = os.path.join(data_dir, csv_filename)

    if not os.path.exists(csv_path):
        print(f"⚠️ 警告：找不到精粹後的檔案：{csv_path}")
        print("💡 請確認 preprocess_worker.py 是否已完成歸一化轉換。")
        return None

    # 5. 使用 pandas 讀取數據
    try:
        df = pd.read_csv(csv_path)
        print(f"✅ 成功載入 '{sign_name}' 精粹數據：共 {len(df)} 幀。")
        return df
    except Exception as e:
        print(f"❌ 錯誤：讀取 CSV 失敗 - {e}")
        return None

# --- 測試代碼 ---
if __name__ == "__main__":
    print("--- 開始測試【精粹數據】讀取 ---")
    
    # 測試讀取妳目前已經完成的英文標籤詞彙
    # 因為妳目前的 sign_config.json 主要是英文 key，我們先測試英文
    test_word = "dormitory" 
    df = load_sign_data(test_word)
    
    if df is not None:
        print(df.head()) # 顯示前五行看看數據
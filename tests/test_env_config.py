import os
import google.generativeai as genai
from dotenv import load_dotenv

def init_services():
    """
    初始化環境變數與 Gemini 服務
    """
    # 1. 載入 .env 檔案
    load_dotenv()
    
    # 2. 取得 API 金鑰
    api_key = os.getenv("GEMINI_API_KEY")
    
    if not api_key:
        print("❌ 錯誤：在 .env 檔案中找不到 GEMINI_API_KEY，請檢查 .env 內容。")
        return False
        
    # 3. 配置 Gemini API
    try:
        genai.configure(api_key=api_key)
        print("✅ Gemini API 金鑰載入成功！")
        return True
    except Exception as e:
        print(f"❌ Gemini 配置發生嚴重錯誤：{e}")
        return False

def test_gemini_connection():
    """
    測試模型連線與回應
    """
    print("\n🔍 正在偵測可用模型...")
    
    try:
        # 列出所有可用的模型，幫助偵錯 404 問題
        available_models = [m.name for m in genai.list_models() if 'generateContent' in m.supported_generation_methods]
        print(f"📋 妳目前的 API Key 可使用的模型有：{available_models}")

        # 嘗試使用最穩定的名稱格式
        # 優先嘗試 gemini-1.5-flash，若不在清單中則選第一個可用的
        target_model = 'gemini-1.5-flash'
        if f'models/{target_model}' not in available_models:
            target_model = available_models[0].replace('models/', '')
            print(f"⚠️ 找不到指定模型，自動切換至備用模型：{target_model}")

        print(f"🚀 正在嘗試連線至：{target_model}...")
        model = genai.GenerativeModel(target_model)
        
        # 執行簡單測試
        response = model.generate_content("這是一封來自淡江資管系手語專案的測試訊息。如果妳收到了，請回覆：『連線成功，曼璇加油！』")
        
        print("\n✨ --- Gemini 回應內容 ---")
        print(response.text)
        print("--------------------------")
        print("🎉 恭喜！妳的雲端語意層已經完全打通了。")
        
    except Exception as e:
        print(f"❌ 呼叫失敗：{e}")
        print("💡 提示：請檢查妳的網路連線，或確認 API Key 是否有正確開啟 Gemini API 權限。")

if __name__ == "__main__":
    if init_services():
        test_gemini_connection()
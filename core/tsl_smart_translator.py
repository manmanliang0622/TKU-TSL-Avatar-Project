import os
import google.generativeai as genai
from dotenv import load_dotenv

# 1. 初始化
load_dotenv()
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

def translate_tsl_to_formal_chinese(gloss_list):
    """
    將手語詞彙流轉化為正式行政中文
    """
    # 根據妳剛才的測試，我們直接指定最強的 gemini-2.5-flash
    model = genai.GenerativeModel('gemini-2.5-flash')
    
    # 建立 Prompt：模擬妳目前的 300 組行政情境
    prompt = f"""
    妳是一位淡江大學的資深行政人員，精通台灣手語。
    請將以下辨識出的手語詞彙流（TSL Glosses），轉化為一句自然、禮貌且符合台灣行政習慣的中文。
    
    手語詞彙：{' '.join(gloss_list)}
    行政回覆：
    """
    
    try:
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        return f"翻譯失敗：{e}"

# --- 模擬測試 ---
if __name__ == "__main__":
    # 範例一：宿舍申請
    test_1 = ["我", "宿舍", "申請", "完成"]
    print(f"📥 手語輸入: {test_1}")
    print(f"🤖 行政回覆: {translate_tsl_to_formal_chinese(test_1)}")
    
    print("-" * 30)
    
    # 範例二：遺失學生證
    test_2 = ["學生證", "遺失", "如何", "辦理"]
    print(f"📥 手語輸入: {test_2}")
    print(f"🤖 行政回覆: {translate_tsl_to_formal_chinese(test_2)}")
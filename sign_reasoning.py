import os
import torch
import google.generativeai as genai
from dotenv import load_dotenv
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig

# 初始化環境
load_dotenv()
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

def load_taide_local():
    model_id = "taide/Gemma-3-TAIDE-12b-Chat-2602"
    # 4-bit 量化配置，確保妳的顯卡跑得動
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.bfloat16
    )
    tokenizer = AutoTokenizer.from_pretrained(model_id, token=os.getenv("HF_TOKEN"))
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        quantization_config=bnb_config,
        device_map="auto",
        token=os.getenv("HF_TOKEN")
    )
    return model, tokenizer

def run_tsl_pipeline(gloss_input):
    """
    雙模型流水線：
    1. TAIDE 負責將手語詞彙轉化為台灣口語
    2. Gemini 負責將口語潤飾成正式行政回覆
    """
    print(f"📥 原始手語序列: {gloss_input}")

    # --- 第一階段：TAIDE 初步辨識 ---
    # (此處先以 Prompt 模擬，等妳訓練好特徵模型後可接上)
    taide_prompt = f"請將這串台灣手語詞彙轉為口語：{gloss_input}"
    # ... TAIDE 推論邏輯 ...
    taide_output = "我要申請宿舍" # 假設這是 TAIDE 的結果

    # --- 第二階段：Gemini 語意精煉 ---
    gemini_model = genai.GenerativeModel('gemini-1.5-flash')
    final_prompt = f"妳是一位大學櫃檯人員。請將這句話改寫成親切且正式的行政回覆：'{taide_output}'"
    
    response = gemini_model.generate_content(final_prompt)
    
    print("-" * 30)
    print(f"🤖 最終系統回覆：\n{response.text}")

if __name__ == "__main__":
    # 測試
    run_tsl_pipeline("我 宿舍 申請")
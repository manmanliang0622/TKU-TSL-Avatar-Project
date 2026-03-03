import os
import torch
from dotenv import load_dotenv
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig

# 1. 載入環境變數
load_dotenv()
hf_token = os.getenv("HF_TOKEN")

def test_taide_connection():
    # 使用最新的 TAIDE Gemma-3 12b 模型
    model_id = "taide/Gemma-3-TAIDE-12b-Chat-2602"
    
    print(f"🚀 正在載入 TAIDE 模型 (已開啟 CPU/Disk Offload 模式)...")
    
    # 2. 進階量化設定：允許 CPU 卸載 (Offload)
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        llm_int8_enable_fp32_cpu_offload=True  # 👈 關鍵：當顯存不足時允許使用 CPU
    )

    try:
        # 3. 載入 Tokenizer
        tokenizer = AutoTokenizer.from_pretrained(model_id, token=hf_token)
        
        # 4. 載入 Model (加入自動分配與暫存資料夾)
        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            quantization_config=bnb_config,
            device_map="auto",           # 👈 自動分配 GPU/CPU
            token=hf_token,
            offload_folder="offload",    # 👈 當記憶體也不夠時暫存到此資料夾
            low_cpu_mem_usage=True
        )
        
        print("✅ TAIDE 載入成功！")
        
        # 5. 測試手語語意轉化
        input_text = "我 宿舍 申請 完成"
        prompt = f"妳是一位專業的手語翻譯員。請將這段手語詞彙轉成流暢的台灣中文：{input_text}"
        
        messages = [{"role": "user", "content": prompt}]
        templated_prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        
        # 注意：在使用 CPU offload 時，inputs 需要確保在正確的裝置上
        inputs = tokenizer(templated_prompt, return_tensors="pt").to(model.device)
        
        print("🤖 TAIDE 正在思考中 (使用 CPU/GPU 混合運算)...")
        outputs = model.generate(**inputs, max_new_tokens=100)
        
        result = tokenizer.decode(outputs[0], skip_special_tokens=True)
        # 取得模型回答的部分
        response = result.split("assistant")[-1].strip() if "assistant" in result else result
        
        print(f"\n✨ 轉化結果：\n{response}")

    except Exception as e:
        print(f"❌ 執行失敗：{e}")
        print("💡 提示：如果依然顯示記憶體不足，請嘗試關閉 Chrome 或其他佔用顯存的程式。")

if __name__ == "__main__":
    test_taide_connection()
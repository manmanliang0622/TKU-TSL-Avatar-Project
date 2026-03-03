import streamlit as st
import cv2
import numpy as np
import time
import av
import os
import torch
import json
from streamlit_webrtc import webrtc_streamer, WebRtcMode, RTCConfiguration
import mediapipe as mp
from dotenv import load_dotenv

# 載入妳的核心組件 (假設路徑正確)
from core.data_loader import TSLModel 
from core.tsl_smart_translator import translate_tsl_to_formal_chinese

# 1. 頁面基礎設定與環境載入
load_dotenv()
st.set_page_config(
    page_title="淡江大學 TSL 雙向手語轉譯系統",
    page_icon="🤟",
    layout="wide"
)

# 自動偵測 GPU (妳有兩張 GPU，PyTorch 會預設使用第一張)
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# 2. 載入妳上傳的標籤對照表
with open('label_map.json', 'r', encoding='utf-8') as f:
    label_map = json.load(f)
actions = {v: k for k, v in label_map.items()}

# 3. 載入妳訓練好的 PyTorch 模型
@st.cache_resource # 使用快取避免每次重新載入模型
def load_trained_model():
    # 參數需對應妳的訓練設定：126 (手部骨架點 21*3*2)
    model = TSLModel(input_size=126, hidden_size=128, num_layers=2, num_classes=len(actions))
    model.load_state_dict(torch.load('models/tsl_model.pth', map_location=device))
    model.to(device)
    model.eval()
    return model

tsl_ai_model = load_trained_model()

# --- 現代感 CSS (保留妳的原稿) ---
st.markdown("""
    <style>
    .stApp { background-color: #F8FAFC; }
    .main-header {
        background: linear-gradient(135deg, #005696 0%, #00AEEF 100%);
        padding: 2rem; border-radius: 20px; color: white;
        text-align: center; margin-bottom: 2rem;
        box-shadow: 0 10px 30px rgba(0, 86, 150, 0.2);
    }
    .result-card {
        background-color: white; padding: 20px; border-radius: 15px;
        border-left: 6px solid #005696; box-shadow: 0 4px 6px rgba(0,0,0,0.05);
        min-height: 80px; display: flex; align-items: center;
    }
    .empty-placeholder { color: #94A3B8; font-style: italic; }
    .video-placeholder {
        border: 2px dashed #CBD5E1; border-radius: 15px; height: 320px;
        display: flex; align-items: center; justify-content: center;
        background-color: white; margin-top: 10px;
    }
    </style>
    """, unsafe_allow_html=True)

# 4. 初始化 Session State
if 'detected_glosses' not in st.session_state:
    st.session_state.detected_glosses = []
if 'translated_chinese' not in st.session_state:
    st.session_state.translated_chinese = ""
if 'sequence' not in st.session_state:
    st.session_state.sequence = []

# 5. MediaPipe 與 WebRTC 設定
mp_holistic = mp.solutions.holistic
mp_drawing = mp.solutions.drawing_utils
holistic = mp_holistic.Holistic(min_detection_confidence=0.5, min_tracking_confidence=0.5)

# WebRTC 影像處理回呼
def video_frame_callback(frame: av.VideoFrame) -> av.VideoFrame:
    img = frame.to_ndarray(format="bgr24")
    img = cv2.flip(img, 1)
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    results = holistic.process(img_rgb)
    
    # 繪製骨架線條
    if results.left_hand_landmarks:
        mp_drawing.draw_landmarks(img, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS)
    if results.right_hand_landmarks:
        mp_drawing.draw_landmarks(img, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS)

    # 核心：提取特徵並進行 AI 預測
    lh = np.array([[res.x, res.y, res.z] for res in results.left_hand_landmarks.landmark]).flatten() if results.left_hand_landmarks else np.zeros(21*3)
    rh = np.array([[res.x, res.y, res.z] for res in results.right_hand_landmarks.landmark]).flatten() if results.right_hand_landmarks else np.zeros(21*3)
    keypoints = np.concatenate([lh, rh])

    # 存入序列並預測 (取最近 30 影格)
    st.session_state.sequence.append(keypoints)
    st.session_state.sequence = st.session_state.sequence[-30:]

    if len(st.session_state.sequence) == 30:
        input_tensor = torch.FloatTensor(np.expand_dims(st.session_state.sequence, axis=0)).to(device)
        with torch.no_grad():
            res = tsl_ai_model(input_tensor)
            prob = torch.softmax(res, dim=1)
            max_prob, idx = torch.max(prob, dim=1)
            
            if max_prob.item() > 0.85: # 設定信心門檻
                action = actions[idx.item()]
                # 避免重複偵測同一個詞
                if not st.session_state.detected_glosses or action != st.session_state.detected_glosses[-1]:
                    st.session_state.detected_glosses.append(action)
                    # 立即觸發 Gemini 行政翻譯
                    st.session_state.translated_chinese = translate_tsl_to_formal_chinese(st.session_state.detected_glosses)

    return av.VideoFrame.from_ndarray(img, format="bgr24")

# --- UI 介面佈局 (保留妳的原稿) ---
st.markdown("""
    <div class="main-header">
        <h1 style='margin:0; font-size: 2.3rem; font-weight: 800;'>淡江校園窗口與行政服務：台灣手語雙譯系統</h1>
        <p style='margin:10px 0 0 0; opacity: 0.9;'>Tamkang University - AI Sign Language Bidirectional Translation</p>
    </div>
    """, unsafe_allow_html=True)

tab_slr, tab_slp = st.tabs(["👐 手語 -> 中文", "👤 中文 -> 手語"])

with tab_slr:
    col_cam, col_res = st.columns([3, 2])
    with col_cam:
        st.markdown("### 📹 雲端即時影像串流")
        webrtc_streamer(
            key="tsl-scanner",
            mode=WebRtcMode.SENDRECV,
            rtc_configuration={"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]},
            video_frame_callback=video_frame_callback,
            media_stream_constraints={"video": True, "audio": False},
            async_processing=True,
        )
        if st.button("🧹 清除辨識結果"):
            st.session_state.detected_glosses = []
            st.session_state.translated_chinese = ""
            st.rerun()

    with col_res:
        st.markdown("### 🧠 翻譯結果")
        st.write("**● 偵測到的手語詞彙 (Glosses)**")
        gloss_text = " ➔ ".join(st.session_state.detected_glosses)
        if gloss_text:
            st.info(gloss_text)
        else:
            st.markdown('<p class="empty-placeholder">請在鏡頭前比出手語...</p>', unsafe_allow_html=True)
        
        st.write("**● 淡江行政回覆 (自然中文)**")
        if st.session_state.translated_chinese:
            st.markdown(f'<div class="result-card"><h4 style="margin:0;">{st.session_state.translated_chinese}</h4></div>', unsafe_allow_html=True)
        else:
            st.markdown('<div class="result-card"><p class="empty-placeholder">等待模型組句中...</p></div>', unsafe_allow_html=True)

with tab_slp:
    # 這部分邏輯維持不變，未來可對接 Unity JSON 播放器
    col_input, col_avatar = st.columns([2, 3])
    with col_input:
        st.markdown("### ⌨️ 中文文字輸入")
        user_input = st.text_area("請輸入中文內容：", height=150, placeholder="例如：我想申請宿舍。")
        if st.button("🪄 生成手語動作"):
            if user_input:
                st.session_state.video_ready = True # 模擬生成
                st.rerun()
    with col_avatar:
        if st.session_state.get('video_ready', False):
            st.video("https://www.w3schools.com/html/mov_bbb.mp4") # 這裡之後換成妳的 Unity 影片
            st.success("✅ 手語動畫已根據語意生成")
        else:
            st.markdown('<div class="video-placeholder">虛擬人動畫預覽區</div>', unsafe_allow_html=True)

st.markdown("---")
st.markdown("<p style='text-align: center; color: #94A3B8;'>淡江大學 資訊管理學系 大專生計畫 - 曼璇 製作</p>", unsafe_allow_html=True)
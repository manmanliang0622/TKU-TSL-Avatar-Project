import cv2
import mediapipe as mp
import numpy as np
import torch
import torch.nn as nn
import json
import os

# 1. 模型架構 (必須與訓練時一致)
class SignLanguageModel(nn.Module):
    def __init__(self, input_size, hidden_size, num_classes, num_layers=2):
        super(SignLanguageModel, self).__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=0.2)
        self.fc = nn.Linear(hidden_size, num_classes)
        
    def forward(self, x):
        out, _ = self.lstm(x)
        return self.fc(out[:, -1, :])

def quick_normalize(data):
    """
    即時歸一化：平移(手腕為原點) + 縮放(0-9點距離為1)
    """
    # 左手 (0-62 欄位)
    if any(data[0:3]): 
        wrist = np.array(data[0:3])
        # 計算 0 到 9 的距離作為基準
        mid_mcp = np.array(data[9*3 : 9*3+3]) - wrist
        dist = np.linalg.norm(mid_mcp)
        if dist == 0: dist = 1.0
        
        for i in range(21):
            data[i*3 : i*3+3] = (np.array(data[i*3 : i*3+3]) - wrist) / dist
            
    # 右手 (63-125 欄位)
    if any(data[63:66]):
        wrist = np.array(data[63:66])
        mid_mcp = np.array(data[63+9*3 : 63+9*3+3]) - wrist
        dist = np.linalg.norm(mid_mcp)
        if dist == 0: dist = 1.0
        
        for i in range(21):
            start = 63 + i*3
            data[start : start+3] = (np.array(data[start : start+3]) - wrist) / dist
            
    return data

def run_realtime_recognition():
    # 載入設定與模型
    with open('label_map.json', 'r', encoding='utf-8') as f:
        label_map = json.load(f)
    inv_label_map = {v: k for k, v in label_map.items()}
    
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = SignLanguageModel(input_size=126, hidden_size=128, num_classes=len(label_map)).to(device)
    
    if os.path.exists('models/tsl_model.pth'):
        model.load_state_dict(torch.load('models/tsl_model.pth', map_location=device))
        model.eval()
        print(f"✅ 模型載入成功，使用裝置: {device}")
    else:
        print("❌ 找不到模型檔案！")
        return

    # 初始化 MediaPipe
    mp_hands = mp.solutions.hands
    hands = mp_hands.Hands(max_num_hands=2, min_detection_confidence=0.7, min_tracking_confidence=0.5)
    
    # 建立視窗並強制置頂
    win_name = 'TSL Real-time Translation'
    cv2.namedWindow(win_name, cv2.WINDOW_NORMAL)
    cv2.setWindowProperty(win_name, cv2.WND_PROP_TOPMOST, 1)

    sequence = []
    sentence = []
    threshold = 0.7  # 辨識門檻
    
    cap = cv2.VideoCapture(1)
    print("🎬 攝影機啟動，請開始比手語 (按 Q 退出)...")

    while cap.isOpened():
        success, image = cap.read()
        if not success: break

        image = cv2.flip(image, 1) # 鏡像處理，比較符合直覺
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = hands.process(image_rgb)
        
        frame_data = [0.0] * 126
        if results.multi_hand_landmarks and results.multi_handedness:
            for i, hand_landmarks in enumerate(results.multi_hand_landmarks):
                label = results.multi_handedness[i].classification[0].label 
                landmarks = []
                for lm in hand_landmarks.landmark:
                    landmarks.extend([lm.x, lm.y, lm.z])
                
                if label == 'Left': frame_data[0:63] = landmarks
                else: frame_data[63:126] = landmarks

        # 執行即時精煉
        sequence.append(quick_normalize(frame_data))
        sequence = sequence[-40:] # 保持 40 影格

        # 預測邏輯
        if len(sequence) == 40:
            input_tensor = torch.FloatTensor([sequence]).to(device)
            with torch.no_grad():
                res = model(input_tensor)
            prob = torch.softmax(res, dim=1)
            max_prob, pred_idx = torch.max(prob, dim=1)
            
            if max_prob.item() > threshold:
                sign_name = inv_label_map[pred_idx.item()]
                if not sentence or sign_name != sentence[-1]:
                    sentence.append(sign_name)
                    print(f"🤟 辨識中: {sign_name} ({max_prob.item():.2f})")

        # 介面顯示
        display_text = " ".join(sentence[-5:])
        cv2.rectangle(image, (0,0), (640, 40), (245, 117, 16), -1)
        cv2.putText(image, display_text, (10, 30), 
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2, cv2.LINE_AA)
        
        cv2.imshow(win_name, image)
        if cv2.waitKey(1) & 0xFF == ord('q'): break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    run_realtime_recognition()
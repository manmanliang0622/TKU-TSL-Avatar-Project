import cv2
import mediapipe as mp
import pandas as pd
import os
import json
import time
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# 1. 初始化 MediaPipe Hands
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2, 
    min_detection_confidence=0.7,
    min_tracking_confidence=0.5
)

def process_video_to_csv(video_path, output_csv_path):
    """將影片轉換為 126 欄位 CSV"""
    cap = cv2.VideoCapture(video_path)
    all_frames_data = []

    print(f"🎬 偵測到新影片，開始處理: {os.path.basename(video_path)}")

    while cap.isOpened():
        success, image = cap.read()
        if not success: break

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

        all_frames_data.append(frame_data)

    cap.release()
    columns = []
    for side in ['L', 'R']:
        for i in range(21):
            columns.extend([f'{side}_{i}_x', f'{side}_{i}_y', f'{side}_{i}_z'])

    df = pd.DataFrame(all_frames_data, columns=columns)
    df.to_csv(output_csv_path, index=False)
    print(f"✅ 轉換完成: {output_csv_path}")

# 2. 定義檔案監控處理器
class VideoHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory and event.src_path.endswith('.mp4'):
            file_name = os.path.basename(event.src_path)
            pure_name = file_name.replace('.mp4', '')
            output_csv = os.path.join('data_library', f"{pure_name}_features.csv")
            
            # 給系統一點時間完成檔案寫入
            time.sleep(1) 
            process_video_to_csv(event.src_path, output_csv)

def start_monitoring():
    video_dir = 'raw_videos'
    output_dir = 'data_library'

    if not os.path.exists(output_dir): os.makedirs(output_dir)
    if not os.path.exists(video_dir): os.makedirs(video_dir)

    # 啟動監控
    event_handler = VideoHandler()
    observer = Observer()
    observer.schedule(event_handler, video_dir, recursive=False)
    observer.start()
    
    print(f"👀 監控中... 只要把影片丟進 '{video_dir}' 就會自動轉檔！")
    print("按 Ctrl+C 即可停止監控。")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    start_monitoring()
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
import json
import os

# 定義人型連線：包含雙手、肩膀與軀幹
# 手部 21 點標準連線
HAND_CONN = [(0,1),(1,2),(2,3),(3,4),(0,5),(5,6),(6,7),(7,8),(5,9),(9,10),
             (10,11),(11,12),(9,13),(13,14),(14,15),(15,16),(13,17),(17,18),
             (18,19),(19,20),(0,17)]

def visualize_humanoid():
    # 載入妳的中文對照表
    chinese_to_file = {
        "學生證": "students_id_card", "宿舍": "dormitory", 
        "信封": "envelope", "教室": "classroom"
    }
    
    user_input = input("請輸入手語中文名 (例如: 學生證): ").strip()
    target = chinese_to_file.get(user_input, user_input)
    file_path = f"refined_data/{target}_features.csv"

    if not os.path.exists(file_path):
        print(f"❌ 找不到檔案: {file_path}")
        return

    df = pd.read_csv(file_path)
    fig = plt.figure(figsize=(10, 10))
    ax = fig.add_subplot(111, projection='3d')

    def update(frame):
        ax.cla()
        ax.set_title(f"TSL Avatar: {user_input} (人型骨架模式)")
        
        # 設定座標軸 (根據歸一化範圍調整)
        ax.set_xlim3d([-1.5, 1.5]); ax.set_ylim3d([-1.5, 1.5]); ax.set_zlim3d([-1.5, 1.5])
        
        row = df.iloc[frame]

        # --- 繪製邏輯 ---
        # 這裡假設妳的 126 欄位是雙手。
        # 為了模擬「人型」，我們手動加上肩膀點 (這在專業虛擬人驅動中稱為 Fake Torso)
        shoulder_l = [-0.5, 0, 0.5] # 模擬左肩
        shoulder_r = [0.5, 0, 0.5]  # 模擬右肩
        neck = [0, 0, 0.6]          # 模擬脖子

        # 畫出身體架構 (肩到肩, 肩到頸)
        ax.plot([shoulder_l[0], shoulder_r[0]], [shoulder_l[1], shoulder_r[1]], [shoulder_l[2], shoulder_r[2]], 'g-', linewidth=3)
        ax.plot([shoulder_l[0], neck[0]], [shoulder_l[1], neck[1]], [shoulder_l[2], neck[2]], 'g-', linewidth=3)
        ax.plot([shoulder_r[0], neck[0]], [shoulder_r[1], neck[1]], [shoulder_r[2], neck[2]], 'g-', linewidth=3)

        for prefix, color, shoulder in [('L', 'red', shoulder_l), ('R', 'blue', shoulder_r)]:
            pts = {}
            for i in range(21):
                # 這裡要將手腕 (0) 與肩膀連起來，看起來才像手臂
                pts[i] = (row[f'{prefix}_{i}_x'] + shoulder[0], 
                          row[f'{prefix}_{i}_z'] + shoulder[1], 
                          row[f'{prefix}_{i}_y'] + shoulder[2])
            
            # 畫出手部點與骨架
            xs, ys, zs = zip(*pts.values())
            ax.scatter(xs, ys, zs, c=color, s=15)
            
            # 連接手指線段
            for start, end in HAND_CONN:
                p1, p2 = pts[start], pts[end]
                ax.plot([p1[0], p2[0]], [p1[1], p2[1]], [p1[2], p2[2]], c=color, linewidth=2)
            
            # 連接「肩膀」到「手腕」，形成手臂
            wrist = pts[0]
            ax.plot([shoulder[0], wrist[0]], [shoulder[1], wrist[1]], [shoulder[2], wrist[2]], 'k--', linewidth=1)

    ani = FuncAnimation(fig, update, frames=len(df), interval=50)
    plt.show()

if __name__ == "__main__":
    visualize_humanoid()
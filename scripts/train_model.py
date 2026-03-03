import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
import json
import os

# 1. 定義 LSTM 模型架構
class SignLanguageModel(nn.Module):
    def __init__(self, input_size, hidden_size, num_classes, num_layers=2):
        super(SignLanguageModel, self).__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True, dropout=0.2)
        self.fc = nn.Linear(hidden_size, num_classes)
        
    def forward(self, x):
        # x shape: (batch, seq_len, input_size)
        out, _ = self.lstm(x)
        # 只取最後一個影格的輸出進行分類
        out = self.fc(out[:, -1, :])
        return out

def train():
    # 載入數據
    X = np.load('X.npy')
    y = np.load('y.npy')
    
    with open('label_map.json', 'r', encoding='utf-8') as f:
        label_map = json.load(f)
    
    num_classes = len(label_map)
    input_size = 126  # 雙手 21*3*2
    hidden_size = 128
    num_epochs = 50
    batch_size = 32
    learning_rate = 0.001

    # 轉換為 PyTorch Tensor
    X_tensor = torch.from_numpy(X).float()
    y_tensor = torch.from_numpy(y).long()
    
    dataset = TensorDataset(X_tensor, y_tensor)
    train_loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    # 初始化模型、損失函數與優化器
    model = SignLanguageModel(input_size, hidden_size, num_classes)
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=learning_rate)

    print(f"🚀 開始訓練模型 (類別數: {num_classes}, 樣本數: {len(X)})...")

    for epoch in range(num_epochs):
        model.train()
        total_loss = 0
        for batch_X, batch_y in train_loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        
        if (epoch+1) % 10 == 0:
            print(f"Epoch [{epoch+1}/{num_epochs}], Loss: {total_loss/len(train_loader):.4f}")

    # 儲存模型
    if not os.path.exists('models'):
        os.makedirs('models')
    torch.save(model.state_dict(), 'models/tsl_model.pth')
    print("✅ 訓練完成！模型已儲存至 models/tsl_model.pth")

if __name__ == "__main__":
    train()
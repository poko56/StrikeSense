import pandas as pd
import numpy as np
import tensorflow as tf
from tensorflow.keras import layers, models
import binascii

# 1. กำหนดค่าพารามิเตอร์
TIME_STEPS = 50   # ขนาดของ Window ที่ตัดมาวิเคราะห์
STEP_SIZE = 25    # ระยะการเลื่อน Window
FEATURES = 6      # ax, ay, az, gx, gy, gz
NUM_CLASSES = 5   # จำนวนท่าทาง

# 2. ฟังก์ชันจัดเตรียมข้อมูล
def create_windows(data, labels):
    Xs, ys = [], []
    for i in range(0, len(data) - TIME_STEPS, STEP_SIZE):
        Xs.append(data.iloc[i:(i + TIME_STEPS)].values)
        ys.append(labels.iloc[i])
    return np.array(Xs), np.array(ys)

print("กำลังโหลดข้อมูลจาก strike_dataset.csv...")
df = pd.read_csv('strike_dataset.csv')

X_raw = df[['ax', 'ay', 'az', 'gx', 'gy', 'gz']]
y_raw = df['label']
X, y = create_windows(X_raw, y_raw)

# 3. สร้างโมเดล 1D-CNN
model = models.Sequential([
    layers.Input(shape=(TIME_STEPS, FEATURES)),
    layers.Conv1D(filters=32, kernel_size=3, activation='relu'),
    layers.MaxPooling1D(pool_size=2),
    layers.Conv1D(filters=64, kernel_size=3, activation='relu'),
    layers.MaxPooling1D(pool_size=2),
    layers.Flatten(),
    layers.Dense(64, activation='relu'),
    layers.Dropout(0.5),
    layers.Dense(NUM_CLASSES, activation='softmax')
])

model.compile(optimizer='adam', loss='sparse_categorical_crossentropy', metrics=['accuracy'])

# 4. เริ่มเทรน
print("เริ่มการฝึกสอน AI...")
model.fit(X, y, epochs=30, batch_size=32, validation_split=0.2)

# 5. แปลงโมเดลเป็น C Array สำหรับ ESP32
print("กำลังบันทึกไฟล์ AI สำหรับบอร์ด ESP32...")
converter = tf.lite.TFLiteConverter.from_keras_model(model)
converter.optimizations = [tf.lite.Optimize.DEFAULT]
tflite_model = converter.convert()

hex_str = binascii.hexlify(tflite_model).decode('utf-8')
c_array = ', '.join(['0x' + hex_str[i:i+2] for i in range(0, len(hex_str), 2)])

with open('strike_model.h', 'w') as f:
    f.write("#ifndef STRIKE_MODEL_H\n#define STRIKE_MODEL_H\n\n")
    f.write(f"const unsigned char model_tflite[] = {{\n    {c_array}\n}};\n")
    f.write(f"const unsigned int model_tflite_len = {len(tflite_model)};\n\n#endif\n")

print("สำเร็จ! ได้ไฟล์ strike_model.h แล้ว")
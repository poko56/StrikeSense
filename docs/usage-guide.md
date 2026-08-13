# StrikeSense — คู่มือการใช้งาน (เชื่อมต่อ · เก็บข้อมูล · เทรน AI · อัปโมเดล)

คู่มือ end-to-end สำหรับโค้ช/นักพัฒนา ตั้งแต่เปิดเครื่องจนได้โมเดล AI วิ่งบน ESP32

เอกสารที่เกี่ยวข้อง: [firmware-upload-guide](firmware-upload-guide.md) · [code-walkthrough](code-walkthrough.md) · [api](api.md) · [protocol](protocol.md)

---

## 1. การเชื่อมต่อ (ลิงก์เข้าถึง)

| รายการ | ค่า |
|---|---|
| Wi-Fi SSID | **`StrikeSense`** |
| Wi-Fi Password | **`muaythai123`** |
| Dashboard (sensor + AI) | **`https://192.168.4.1`** (Local CA) หรือ **`https://<hostname>`** *(หมายเหตุ: ฟีเจอร์กล้อง Motion Capture ยังไม่เปิดใช้งาน)* |
| WebSocket (IMU stream) | URL เดียวกับ Dashboard โดยเปลี่ยนเป็น `wss://…/ws` |
| REST API base | secure origin เดียวกัน + `/api/…` |

> ถ้าใช้ Let's Encrypt ให้แทน `192.168.4.1` ในตัวอย่างด้านล่างด้วย hostname
> ที่อยู่ใน `/tls/hostname.txt` และไม่ต้องส่ง `--cacert`. IP-address examples
> เป็นของ Local-CA deployment เท่านั้น.

**ขั้นตอน:**
1. เปิด Main Node (ESP32-S3) → ไฟ NeoPixel ติด = AP พร้อม
2. มือถือ/โน้ตบุ๊ก เชื่อม Wi-Fi `StrikeSense`
3. เปิดเบราว์เซอร์ → secure origin ตามตาราง (Local CA ต้องติดตั้ง/trust CA
   certificate ก่อน; Let's Encrypt ไม่ต้อง; ดู
   [motion-capture-https](motion-capture-https.md))
4. เปิด Strike Node (ESP32-C3) ที่ข้อมือ/แข้ง → node จะโผล่ในหน้า Dashboard เมื่อส่งข้อมูลเข้ามา

> HTTP/`ws://` ยังมีไว้สำหรับ service/legacy compatibility และไม่ใช่ secure
> context: อย่าใช้กับ motion capture หรือข้อมูลที่ต้องการเข้ารหัส.

---

## 2. เข้าถึง WSS โดยตรง (สำหรับทำ client เอง / ดีบั๊ก)

WSS ที่ `wss://192.168.4.1/ws` ส่ง **binary frame** (ไม่ใช่ JSON):

```
[ 16-byte header ]
  offset 0  : 0x01            (frame type = IMU)
  offset 1  : slot            (1=L-hand 2=R-hand 3=L-shin 4=R-shin)
  offset 2  : sampleCount (n)
  offset 3  : rssi (int8)
  offset 4  : seq    (uint32 LE)
  offset 8  : recvMs (uint32 LE)
  offset 12 : nodeUs (uint32 LE)
[ n × 12-byte samples ]  — int16 LE ×6: ax,ay,az,gx,gy,gz
```
**สเกลเป็นหน่วยจริง:** accel ÷ 2048 = g · gyro ÷ 16.4 = deg/s

### ทดสอบเร็วๆ ใน Browser Console
```js
const ws = new WebSocket('wss://192.168.4.1/ws');
ws.binaryType = 'arraybuffer';
ws.onmessage = e => {
  const dv = new DataView(e.data);
  if (dv.getUint8(0) !== 0x01) return;
  const n = dv.getUint8(2), slot = dv.getUint8(1);
  const ax = dv.getInt16(16, true) / 2048;   // sample แรก
  console.log(`slot=${slot} n=${n} ax=${ax.toFixed(3)}g`);
};
```

### ทดสอบด้วย CLI
```bash
npm i -g wscat
wscat -c wss://192.168.4.1/ws         # client ต้อง trust CA ของ rig ก่อน
```

---

## 3. เก็บข้อมูลเทรน AI (Data Logger) 🎯

Data Logger อยู่แถบซ้ายของ Dashboard: **"AI TRAINING · DATA LOGGER"**

### ขั้นตอนเก็บข้อมูล (ต่อ 1 ท่า)
1. **เลือกท่า** ใน dropdown "ท่าที่บันทึก" (จัดกลุ่ม หมัด/ศอก/เข่า/เตะ/ถีบ)
2. กด **"เริ่มบันทึก"** (ปุ่มเปลี่ยนเป็นแดง "หยุดบันทึก")
3. ให้นักมวยออก **ท่าเดิมซ้ำๆ** — ดู readout: `ROWS` เพิ่ม, `TIME` เดิน, `LIMB` บอกแขน/ขาที่ออก
4. กด **"หยุดบันทึก"**
5. กด **"↓ CSV"** → ได้ไฟล์ `strike_<label>_<time>.csv`

### เคล็ดลับให้โมเดลแม่น (สำคัญมาก)
- **1 ไฟล์ = 1 ท่า** (label เดียว) — สลับ label แล้ว export แยกไฟล์ จะจัดการง่าย
- เก็บ **อย่างน้อย 30–50 ครั้ง/ท่า** และหลากหลาย (เร็ว/แรง/มุมต่างกัน)
- เปิดเฉพาะ node ของอวัยวะที่กำลังเก็บ (เช่น เก็บ "เตะ" เปิดแค่ node แข้ง) เพื่อ `slot` สะอาด
- เก็บ "ช่วงพัก/ไม่ออกอาวุธ" เป็น class เสริมได้ ถ้าต้องการให้โมเดลแยก "นิ่ง" ออก
- เก็บทั้งซ้ายและขวา (slot ต่างกัน) — โมเดลจะ generalize ดีขึ้น

### CSV ที่ได้
```
ax,ay,az,gx,gy,gz,slot,label
-0.1230,0.9840,0.0210,12.300,-4.100,0.800,3,41   ← 41 = เตะเฉียง, slot 3 = L-shin
```

---

## 4. เทรนโมเดลบนคอมพิวเตอร์ 🧠

ใช้คำสั่งสคริปต์อัตโนมัติรันคำสั่งเดียว หรือใช้ Python สคริปต์โดยตรง:

```bash
# วิธีที่ 1: ใช้ retrain.sh อัตโนมัติ (จะนำเข้า CSV จาก Downloads ให้อัตโนมัติ)
./ml_pipeline/retrain.sh

# วิธีที่ 2: รันผ่าน Python
cd ml_pipeline
pip install -r requirements.txt
python train_model.py --data "./data/*.csv"
```

**ผลลัพธ์:**
- `strike_web_model_fine.json` — **โมเดล TensorFlow.js สำหรับอัปโหลดเข้า แดชบอร์ด / SD Card**
- `strike_model_fine.h` — โมเดล C++ header (สำหรับ C++ fallback / embedded reference)
- `confusion_matrix.png` — ตารางกราฟสรุปว่าโมเดลสับสนท่าไหนกับท่าไหน
- Terminal พิมพ์ **test accuracy** + ประสิทธิภาพแยกตามท่า

---

## 5. อัปโหลดโมเดลเข้าใช้งาน 🔁

โมเดล AI ใน StrikeSense ทำงานแบบ **In-Browser TensorFlow.js 1D-CNN** สามารถเปลี่ยนโมเดลใหม่ได้ทันทีโดย **ไม่ต้อง flash เฟิร์มแวร์ ESP32 ใหม่**:

### วิธีอัปโหลดผ่าน Web Dashboard:
1. เชื่อม Wi-Fi **`StrikeSense`** แล้วเปิด **`https://192.168.4.1`**
2. ไปที่แท็บ **ระบบ** → หัวข้อ **คลังโมเดล AI**
3. กด **"เพิ่มไฟล์โมเดล"** แล้วเลือกไฟล์ `ml_pipeline/strike_web_model_fine.json`
4. ระบบจะบันทึกโมเดลลง SD Card ของ Main Node (`/models/`) และโหลดเข้าเบราว์เซอร์อัตโนมัติ

---

## 6. Flow สรุปทั้งวงจร

```
[เก็บข้อมูล]                [เทรน]                                [ใช้งาน]
Dashboard Logger  ──CSV──▶  train_model.py / retrain.sh  ──.json──▶  อัปเข้า Web Dashboard / SD Card  ──▶  In-Browser TF.js Real-time AI
เลือกท่า→บันทึก→export      1D-CNN Model Export                   บันทึกเก็บใน SD (/models/)                วิเคราะห์ท่าและคำนวณคะแนนสด
```

---

## 7. เช็กสถานะและ API เร็วๆ

```bash
curl --cacert ./strikesense-ca.pem https://192.168.4.1/api/status   # Heap, session status, SD card, WS clients
curl --cacert ./strikesense-ca.pem https://192.168.4.1/api/nodes    # โหนดที่ออนไลน์ + slot, battery, RSSI
curl --cacert ./strikesense-ca.pem https://192.168.4.1/api/models   # รายการโมเดล AI ใน SD card + active model
curl --cacert ./strikesense-ca.pem https://192.168.4.1/api/logs     # Ring buffer logs ล่าสุด
```

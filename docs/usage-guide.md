# StrikeSense — คู่มือการใช้งาน (เชื่อมต่อ · เก็บข้อมูล · เทรน AI · อัปโมเดล)

คู่มือ end-to-end สำหรับโค้ช/นักพัฒนา ตั้งแต่เปิดเครื่องจนได้โมเดล AI วิ่งบน ESP32

เอกสารที่เกี่ยวข้อง: [firmware-upload-guide](firmware-upload-guide.md) · [code-walkthrough](code-walkthrough.md) · [api](api.md) · [protocol](protocol.md)

---

## 1. การเชื่อมต่อ (ลิงก์เข้าถึง)

| รายการ | ค่า |
|---|---|
| Wi-Fi SSID | **`StrikeSense`** |
| Wi-Fi Password | **`muaythai123`** |
| Dashboard | **http://192.168.4.1** |
| WebSocket (IMU stream) | **`ws://192.168.4.1/ws`** |
| REST API base | `http://192.168.4.1/api/…` |

**ขั้นตอน:**
1. เปิด Main Node (ESP32-S3) → ไฟ NeoPixel ติด = AP พร้อม
2. มือถือ/โน้ตบุ๊ก เชื่อม Wi-Fi `StrikeSense`
3. เปิดเบราว์เซอร์ → `http://192.168.4.1`
4. เปิด Strike Node (ESP32-C3) ที่ข้อมือ/แข้ง → node จะโผล่ในหน้า Dashboard เมื่อส่งข้อมูลเข้ามา

---

## 2. เข้าถึง WebSocket โดยตรง (สำหรับทำ client เอง / ดีบั๊ก)

WS ที่ `ws://192.168.4.1/ws` ส่ง **binary frame** (ไม่ใช่ JSON):

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
const ws = new WebSocket('ws://192.168.4.1/ws');
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
wscat -c ws://192.168.4.1/ws          # จะเห็น binary frame ไหลเข้ามา
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

```bash
cd ml_pipeline

# ครั้งแรก: ติดตั้ง dependencies (แนะนำ Python 3.10–3.11)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# วางไฟล์ CSV ทั้งหมดใน ./data/ แล้วเทรน
python train_model.py --data "./data/*.csv"
```

**ผลลัพธ์:**
- `strike_model.h` — โมเดล int8 quantized + metadata (พร้อม flash เข้า ESP32)
- `confusion_matrix.png` — ดูว่าโมเดลสับสนท่าไหนกับท่าไหน
- Terminal พิมพ์ **test accuracy** + จำนวน window ต่อคลาส

### ปรับความละเอียดของโมเดล
แก้ที่หัวไฟล์ `train_model.py`:
```python
LABEL_MODE = "coarse"   # 5 อาวุธหลัก (default, เบา+แม่น, รันบน ESP32)
LABEL_MODE = "fine"     # ~20 ท่าย่อย (ต้องมีข้อมูลเยอะกว่ามาก)
```
> เริ่มที่ `coarse` เสมอ ให้แม่นก่อน แล้วค่อยขยับเป็น `fine` เมื่อ dataset โตพอ

---

## 5. อัปโมเดลกลับเข้า ESP32 🔁

```bash
# 1) ก๊อปโมเดลเข้า firmware
cp ml_pipeline/strike_model.h firmware/main-node/

# 2) flash (ดูรายละเอียด + FQBN ใน firmware-upload-guide.md)
CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
FQBN="esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB,CDCOnBoot=cdc,UploadSpeed=921600"
"$CLI" compile --fqbn "$FQBN" firmware/main-node
"$CLI" upload -p /dev/cu.usbmodem101 --fqbn "$FQBN" firmware/main-node
```

> การต่อ inference จริง (โหลด `strike_model.h` เข้า TFLite Micro + วน buffer ต่อ slot)
> เป็น roadmap ขั้นถัดไป — ดูโครงที่แนะนำใน [code-walkthrough §5](code-walkthrough.md)

---

## 6. Flow สรุปทั้งวงจร

```
[เก็บข้อมูล]                [เทรน]                    [ใช้งาน]
Dashboard Logger  ──CSV──▶  train_model.py  ──.h──▶  flash ESP32  ──▶  โมเดลจำแนกท่า real-time
เลือกท่า→บันทึก→export      1D-CNN + int8            main-node.ino     (roadmap: inference)
```

## 7. เช็กสถานะเร็วๆ
```bash
curl http://192.168.4.1/api/status    # heap, session, sd, ws clients
curl http://192.168.4.1/api/nodes     # node ที่ออนไลน์ + battery + rssi
```

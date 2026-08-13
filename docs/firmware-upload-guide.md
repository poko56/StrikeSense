# StrikeSense — คู่มืออัปโหลดเฟิร์มแวร์ด้วยตนเอง (Main Node ESP32-S3)

เอกสารนี้อธิบาย **2 วิธี** ในการ build + flash เฟิร์มแวร์ Main Node เข้า ESP32-S3
1. **Arduino IDE (GUI)** — ง่ายสำหรับใช้งานทั่วไป
2. **arduino-cli (Terminal)** — เร็ว ทำซ้ำได้ เหมาะกับ workflow นักพัฒนา (วิธีที่สคริปต์ในโปรเจกต์นี้ใช้)

> ทั้งสองวิธีต้องตั้งค่า **Board Settings ให้ตรงกัน** ไม่งั้นบอร์ดจะบูตไม่ขึ้นหรือ serve dashboard ไม่ได้

---

## 0. สิ่งที่ต้องเตรียมครั้งแรก (ทำครั้งเดียว)

### 0.1 Board package
- **esp32 by Espressif Systems v3.x** (โปรเจกต์นี้เทสกับ 3.3.10)

### 0.2 Libraries (Library Manager) — ต้องเป็น fork ที่ถูกต้อง (org **ESP32Async**)
| Library | ผู้เผยแพร่ | เวอร์ชันที่ใช้ |
|---|---|---|
| **Async TCP** | ESP32Async | 3.4.10 |
| **ESP Async WebServer** | ESP32Async | 3.11.2 |
| **ArduinoJson** | Benoit Blanchon | 7.4.3 |
| **Adafruit NeoPixel** | Adafruit | 1.15.5 |

> ⚠️ ระวังของปลอม/fork อื่น เช่น `AsyncTCP` by *dvarrel* หรือ ESPAsyncWebServer เวอร์ชันเก่า — จะ compile ไม่ผ่านหรือ WebSocket มีปัญหา ต้องเลือกผู้เผยแพร่ **ESP32Async** เท่านั้น

### 0.3 Board Settings (สำคัญมาก — ตั้งให้ครบทุกข้อ)
เฟิร์มแวร์ระบุไว้ในหัวไฟล์ [`firmware/main-node/main-node.ino`](../firmware/main-node/main-node.ino):

| Setting | ค่า | เหตุผล |
|---|---|---|
| Board | **ESP32S3 Dev Module** | ตรงกับฮาร์ดแวร์ |
| Flash Size | **8MB (64Mb)** | พื้นที่เก็บโปรแกรม |
| PSRAM | **OPI PSRAM** | บัฟเฟอร์ WebSocket/heap |
| Partition Scheme | **8M with spiffs (3MB APP/1.5MB SPIFFS)** | ให้ APP 3MB พอสำหรับ web server |
| USB CDC On Boot | **Enabled** | ให้ `Serial` ออกทาง USB (debug) |
| Upload Speed | **921600** | อัปโหลดเร็ว |

---

## วิธีที่ 1 — Arduino IDE (GUI)

1. เปิดโฟลเดอร์ `firmware/main-node/` → ดับเบิลคลิก `main-node.ino`
   (Arduino IDE จะเปิดทุกไฟล์ในโฟลเดอร์รวมถึง `dashboard_ui.h` โดยอัตโนมัติ)
2. **Tools → Board → esp32 → ESP32S3 Dev Module**
3. ตั้งค่า **Tools** ให้ตรงตารางข้อ 0.3 ทุกบรรทัด
4. เสียบ ESP32-S3 → **Tools → Port** → เลือกพอร์ต (macOS: `/dev/cu.usbmodem…`)
5. กด **Upload (→)**
6. ถ้าบอร์ดไม่เข้าโหมด download เอง: กดค้าง **BOOT** → แตะ **RESET** → ปล่อย **BOOT** แล้วกด Upload อีกครั้ง

---

## วิธีที่ 2 — arduino-cli (Terminal) ✅ วิธีที่โปรเจกต์นี้ใช้

Arduino IDE 2.x มี `arduino-cli` ฝังอยู่ในตัว ไม่ต้องติดตั้งเพิ่ม:

```bash
# ตั้ง alias ให้เรียกง่าย (macOS)
CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
```

### 2.1 ติดตั้ง core + libraries (ทำครั้งเดียว)
```bash
"$CLI" core install esp32:esp32
"$CLI" lib install "Async TCP" "ESP Async WebServer" "ArduinoJson" "Adafruit NeoPixel"
```

### 2.2 หาพอร์ตอุปกรณ์
```bash
"$CLI" board list
# มองหาบรรทัดที่เป็น "Serial Port (USB)" เช่น /dev/cu.usbmodem101
```

### 2.3 Compile + Upload
FQBN (Fully Qualified Board Name) ที่ encode board settings ข้อ 0.3 ไว้ครบ:

```bash
FQBN="esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB,CDCOnBoot=cdc,UploadSpeed=921600"
PORT="/dev/cu.usbmodem101"

cd firmware        # โฟลเดอร์ที่มี main-node/

# compile ก่อน (จับ error ก่อนแตะอุปกรณ์)
"$CLI" compile --fqbn "$FQBN" main-node

# upload ลงบอร์ด
"$CLI" upload -p "$PORT" --fqbn "$FQBN" main-node
```

สำเร็จเมื่อเห็น:
```
Hash of data verified.
Hard resetting via RTS pin...
```

### 2.4 ดู Serial log (ตรวจว่าบูตจริง)
```bash
"$CLI" monitor -p "$PORT" -c baudrate=115200
```
ควรเห็น:
```
=== StrikeSense Main Node (Arduino IDE build) ===
Build: <วันเวลาที่ build ล่าสุด>     ← ยืนยันว่าเป็นเฟิร์มแวร์ใหม่
[STATS] rx=0 drop=0 ws=0 sess=off sd=... heap=...
```
กด `Ctrl+C` เพื่อออก

---

## 3. Workflow เต็ม: แก้ dashboard → อัปเฟิร์มแวร์

dashboard ถูกฝังเป็น PROGMEM ในไฟล์ `dashboard_ui.h` **ต้อง build ใหม่ทุกครั้งที่แก้ UI**:

```bash
cd dashboard
npm install          # ครั้งแรกครั้งเดียว
npm run build        # vite build → gen dashboard_ui.h อัตโนมัติ
# แล้วค่อย compile + upload ตามข้อ 2.3
```

`npm run build` ทำ 2 อย่าง (ดู [`dashboard/package.json`](../dashboard/package.json)):
1. `vite build` → รวมทุกอย่างเป็น `dist/index.html` ไฟล์เดียว (inline JS/CSS)
2. `node build-cpp.js` → แปลง `dist/index.html` เป็น C-array ใน `firmware/main-node/dashboard_ui.h`

---

## 4. การอัปโหลดเฟิร์มแวร์ Strike Node (ESP32-C3 SuperMini)

Strike Node คือโหนดเซนเซอร์ติดข้อมือ/หน้าแข้ง (ESP32-C3 + BMI160 IMU):

### Board Settings (ESP32-C3):
- **Board**: `ESP32C3 Dev Module`
- **Flash Size**: `4MB`
- **USB CDC On Boot**: `Disabled` (หรือ Enabled ตามชนิด SuperMini)
- **Upload Speed**: `921600`

### การ Compile & Flash ด้วย `arduino-cli`:
```bash
FQBN_C3="esp32:esp32:esp32c3"
PORT_C3="/dev/cu.usbmodem201"

cd firmware
"$CLI" compile --fqbn "$FQBN_C3" strike-node
"$CLI" upload -p "$PORT_C3" --fqbn "$FQBN_C3" strike-node
```

---

## 5. Workflow: เทรน AI → อัปโหลดโมเดลเข้าใช้งาน

```bash
# 1) เก็บข้อมูลจาก dashboard → ได้ไฟล์ strike_*.csv หลายไฟล์ใน ~/Downloads/
# 2) เทรน + export โมเดลเป็น TensorFlow.js JSON
./ml_pipeline/retrain.sh     # ได้ไฟล์ ml_pipeline/strike_web_model_fine.json
```

**การอัปโหลดเข้าใช้งาน (ไม่ต้อง re-flash ESP32):**
1. เปิด Web Dashboard ที่ **`https://192.168.4.1`**
2. ไปที่แท็บ **ระบบ** → **คลังโมเดล AI**
3. กด **"เพิ่มไฟล์โมเดล"** → เลือกไฟล์ `strike_web_model_fine.json`
4. โมเดลจะถูกบันทึกใน SD Card ของ Main Node (`/models/`) และนำมาใช้วิเคราะห์ท่าในเบราว์เซอร์ทันที

---

## 6. Troubleshooting

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `A fatal error occurred: Failed to connect` | บอร์ดไม่เข้า download mode → กดค้าง BOOT + แตะ RESET + ปล่อย BOOT แล้ว upload ใหม่ |
| compile error หา `ESPAsyncWebServer.h` ไม่เจอ | ติดตั้ง lib ผิด fork → ต้องเป็น **ESP32Async** (ข้อ 0.2) |
| บอร์ดบูตแล้ว restart วน (boot loop) | Partition/PSRAM ตั้งผิด → เช็คข้อ 0.3 (โดยเฉพาะ OPI PSRAM + 8M partition) |
| เปิด dashboard แล้วขาว/เก่า | ลืม `npm run build` ก่อน flash → dashboard_ui.h ยังเป็นของเก่า |
| `sd=ERR` ใน serial | ไม่มี SD card เสียบ (การเก็บ log ลง SD ใช้ไม่ได้ แต่ dashboard + WebSocket ทำงานปกติ) |
| Serial ว่างเปล่าตอนอ่านด้วย `cat`/`head` | ESP32-S3 native USB CDC ต้อง assert DTR — ใช้ `arduino-cli monitor` แทน |

---

## 7. เชื่อมต่อใช้งานหลัง flash
1. เชื่อม Wi-Fi: **SSID `StrikeSense` · รหัส `muaythai123`**
2. หลัง provision certificate ตาม [motion-capture-https](motion-capture-https.md)
   ให้เปิดเบราว์เซอร์ → **https://192.168.4.1** สำหรับ Local CA หรือ
   **`https://<hostname>`** สำหรับ Let's Encrypt (ชื่อใน `/tls/hostname.txt`)
   — จำเป็นสำหรับ camera/WSS
3. Data Logger อยู่แถบซ้าย ("AI TRAINING · DATA LOGGER")

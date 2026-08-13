# StrikeSense — Code Walkthrough (เข้าใจโค้ดแบบละเอียด)

เอกสารนี้เดินตาม **เส้นทางของข้อมูล 1 sample** ตั้งแต่เซนเซอร์จนถึงหน้าจอ แล้วต่อด้วย
**Data Logger → ML → Inference** เพื่อให้เห็นภาพว่าโค้ดแต่ละไฟล์ต่อกันอย่างไร

เอกสารอ้างอิงอื่น: [README](../README.md) (ภาพรวม) · [protocol.md](protocol.md) (ESP-NOW) · [api.md](api.md) (REST/WS) · [features.md](features.md) (ฟีเจอร์ UI)

---

## 0. แผนที่ระบบ 3 ส่วน

```
Strike Node (ESP32-C3)        Main Node (ESP32-S3)              Dashboard (Browser)
─────────────────────        ────────────────────              ───────────────────
IMU 400Hz ─┐                  ESP-NOW RX ─┐                     WebSocket ─┐
           │ pack 8 samples              │ queue → loop()                 │ decodeFrame()
           └─ ESP-NOW ──────▶  onRecv() ─┘  ├─ SD logger        ingestBatch()─┤
                                            ├─ WS broadcast ───▶ analyzer ────┤
                                            └─ counters         render / logger
```

- **Strike Node** = [`firmware/strike-node/strike-node.ino`](../firmware/strike-node/strike-node.ino) — อ่าน IMU, แพ็กเป็น packet, ยิง ESP-NOW
- **Main Node** = [`firmware/main-node/main-node.ino`](../firmware/main-node/main-node.ino) — ตัวรวมศูนย์ (ไฟล์เดียว, แบ่งเป็น `namespace`)
- **Dashboard** = [`dashboard/src/*.js`](../dashboard/src) — Vanilla JS แบบ modular
- **สัญญา (contract)** ที่ผูกทุกส่วน = โครงสร้าง packet ใน [`firmware/shared/protocol.h`](../firmware/shared/protocol.h)

---

## 1. ฝั่งเฟิร์มแวร์ Main Node — แบ่งด้วย `namespace`

`main-node.ino` เป็นไฟล์เดียวแต่จัดระเบียบด้วย namespace แต่ละอันคือ "โมดูล" ที่มีหน้าที่ชัดเจน:

| namespace | หน้าที่ | state สำคัญ |
|---|---|---|
| `Session` | จำ node, นับ packet, จับ session start/stop | `g_nodes[]`, `g_stats` |
| `EspNowRx` | รับ ESP-NOW ใน callback → ยัดเข้า FreeRTOS queue | `g_queue` |
| `EspNowTx` | ยิง time-sync + คำสั่งไป node | broadcast peer |
| `SdLogger` | เขียน CSV ลง SD แบบ buffered | `g_buf[16KB]` |
| `StatusLed` | ไฟ NeoPixel บอกสถานะ | state machine |
| `WebServerApp` | HTTP + WebSocket + REST | `g_http`, `g_ws` |

**ทำไมต้องใช้ queue?** — ESP-NOW `onRecv()` รันใน **ISR context** (interrupt) ห้ามทำงานหนัก/ห้าม block
ดังนั้น callback แค่ก๊อปข้อมูลใส่ queue แล้วจบ ส่วนงานหนัก (เขียน SD, ส่ง WS) ไปทำใน `loop()` ปกติ

### 1.1 เส้นทางของ 1 packet ในเฟิร์มแวร์

```c
// (1) ISR: รับ ESP-NOW → ก๊อปเข้า queue เท่านั้น  [EspNowRx::onRecv]
static void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
    if (data[1] == PKT_IMU_BATCH) {
        ImuFrame frame;                              // stack struct
        memcpy(frame.samples, pkt->samples, ...);    // ก๊อป 8 samples
        xQueueSendFromISR(g_queue, &frame, nullptr); // ← ส่งต่อ ไม่ประมวลผลใน ISR
    }
}

// (2) loop(): drain queue → 3 ปลายทาง  [void loop]
while (drained < 32 && EspNowRx::nextFrame(frame, 0)) {
    Session::noteImuFrame(frame.sampleCount);        // นับสถิติ
    if (Session::isActive()) SdLogger::logFrame(frame); // เขียน SD (ถ้ากำลัง record)
    WebServerApp::broadcastImuFrame(frame);          // ส่งเข้า WebSocket ทุก client
}
```

### 1.2 การ broadcast เข้า WebSocket — จุดที่กำหนด "รูปแบบ binary frame"

`WebServerApp::broadcastImuFrame()` แพ็ก frame เป็น binary 16-byte header + N×12-byte samples:

```c
buf[0]=0x01; buf[1]=slot; buf[2]=sampleCount; buf[3]=rssi;
memcpy(buf+4,  &seq, 4);
memcpy(buf+8,  &recvMs, 4);
memcpy(buf+12, &nodeUs, 4);
memcpy(buf+16, samples, sampleCount*12);   // ax,ay,az,gx,gy,gz = int16 ×6
g_ws.binaryAll(buf, 16 + sampleCount*12);
```

> ⚠️ **นี่คือ contract กับ dashboard** — ถ้าแก้ layout นี้ ต้องแก้ `decodeFrame()` ใน `ws.js` ให้ตรงกัน

### 1.3 Dashboard ถูก serve จากไหน

`registerRoutes()` ผูก `/` และ `/index.html` เข้ากับ `DASHBOARD_HTML` (PROGMEM string ใน `dashboard_ui.h`):

```c
auto sendDashboard = [](AsyncWebServerRequest* req) {
    req->send(req->beginResponse_P(200, "text/html", DASHBOARD_HTML));
};
```
`dashboard_ui.h` เป็นไฟล์ที่ **generate อัตโนมัติ** จาก `npm run build` (ห้ามแก้มือ)

---

## 2. ฝั่ง Dashboard — โมดูล Vanilla JS

| ไฟล์ | หน้าที่ |
|---|---|
| [`main.js`](../dashboard/src/main.js) | Entry — ต่อ state ↔ ws ↔ ui ↔ timer ↔ logger ↔ AI classifier เข้าด้วยกัน |
| [`ws.js`](../dashboard/src/ws.js) | ถอด binary WebSocket frame → sample objects + reconnect |
| [`analyzer.js`](../dashboard/src/analyzer.js) | ตรวจจับ "หมัด" จากสัญญาณ (threshold + refractory) |
| [`motioncapture.js`](../dashboard/src/motioncapture.js) | ประมวลผล MediaPipe Pose Landmarker + โหลดโมเดล TensorFlow.js AI |
| [`physics.js`](../dashboard/src/physics.js) | คำนวณฟิสิกส์แรงปะทะ (Live Impact Power, Velocity, Kinetic Energy) |
| [`strikescore.js`](../dashboard/src/strikescore.js) | ประเมินดัชนีคะแนนความแม่นยำและแรงปะทะ (0–100 Strike Score) |
| [`posemath.js`](../dashboard/src/posemath.js) | เวกเตอร์และฟังก์ชันคำนวณเรขาคณิตของข้อต่อร่างกาย 3D |
| [`rigclock.js`](../dashboard/src/rigclock.js) | ตัวซิงก์เวลาความละเอียดสูงระหว่าง IMU และกล้อง MediaPipe |
| [`rigorigin.js`](../dashboard/src/rigorigin.js) | ตัวตั้งพิกัดอ้างอิงของจุดกำเนิดและทิศทางเซนเซอร์ |
| [`state.js`](../dashboard/src/state.js) | store กลาง + pub/sub (`subscribe`/`scheduleRender`) |
| [`ui.js`](../dashboard/src/ui.js) | render DOM จาก state |
| [`timer.js`](../dashboard/src/timer.js) | round timer / boxing stopwatch |
| [`logger.js`](../dashboard/src/logger.js) | **Data Logger** — เก็บ raw IMU + label → CSV |

### 2.1 `decodeFrame()` — ตรงข้ามกับ `broadcastImuFrame()`

```js
// ws.js — อ่าน int16 little-endian แล้วหารด้วย scale ให้เป็นหน่วยจริง
const ACCEL_LSB_PER_G  = 2048;    // ±16g range
const GYRO_LSB_PER_DPS = 16.4;    // ±2000 dps range
samples[i] = {
  ax: dv.getInt16(off,   true) / ACCEL_LSB_PER_G,   // g
  gx: dv.getInt16(off+6, true) / GYRO_LSB_PER_DPS,  // deg/s
  ...
};
logSensorData(samples[i], slot);   // ← ป้อน Data Logger (no-op ถ้าไม่ได้ record)
ingestBatch({ slot, samples, ... }); // ← ป้อน analyzer + state
```

### 2.2 State เป็น pub/sub

`ws`/`analyzer`/`timer` เขียนลง `state` แล้วเรียก `scheduleRender()` → `subscribe(renderAll)` ใน `main.js`
ทำให้ทุกอย่าง render ผ่าน `requestAnimationFrame` loop เดียว (ไม่ render ซ้ำซ้อน)

---

## 3. Data Logger — โหมดเก็บข้อมูลฝึก AI (developer mode)

**เป้าหมาย:** เก็บ raw IMU + label ท่า → CSV → เอาไปเทรนบนคอมพิวเตอร์

### 3.1 การ wire 3 จุด
```
main.js   : initLogger()              // ผูกปุ่ม/ค่า panel ตอน bootstrap
ws.js     : logSensorData(sample,slot)// เรียกทุก sample @400Hz
index.html: <select id="strikeLabel"> // dropdown ท่าแบบจัดกลุ่ม
```

### 3.2 Label เข้ารหัสแบบ "หลักสิบ" (tens-scheme)
```
10-13 หมัด PUNCH   (10 Jab, 11 Cross, 12 Hook, 13 Uppercut)
20-25 ศอก ELBOW    (ตี/ตัด/งัด/พุ่ง/กระทุ้ง/กลับ)
30-33 เข่า KNEE    (ตรง/เฉียง/ตัด/ลอย)
40-44 เตะ KICK     (ตรง/เฉียง/ตัด/กลับ/เหวี่ยงกลับ)
50-52 ถีบ TEEP     (ตรง/ข้าง/กลับหลัง)
```
**กุญแจสำคัญ:** `coarse_class = floor(label/10) - 1` → 0..4 (หมัด/ศอก/เข่า/เตะ/ถีบ)
ทำให้ logger เก็บ **ละเอียด** แต่โมเดลเทรนได้ทั้งแบบ **หยาบ 5 คลาส** และแบบ **ละเอียด ~20 ท่าย่อย**

### 3.3 CSV ที่ได้
```
ax,ay,az,gx,gy,gz,slot,label
-0.1230,0.9840,0.0210,12.300,-4.100,0.800,2,41
                                        │  └ fine label (41 = เตะเฉียง)
                                        └ slot: 0=ว่าง 1=L-hand 2=R-hand 3=L-shin 4=R-shin
```
`slot` มาจาก frame header (บอกว่าอวัยวะไหนออกอาวุธ) ใช้กันไม่ให้ window เทรนข้ามแขน/ขา

---

## 4. ML Pipeline — [`ml_pipeline/train_model.py`](../ml_pipeline/train_model.py)

```
CSV หลายไฟล์ → load_dataset()          (แปะ file_id กันข้ามไฟล์)
             → make_windows()          (sliding window ไม่ข้าม file/slot/class)
             → standardise             (mean/std จาก train เท่านั้น)
             → build_model()           (1D-CNN: Conv×3 → GAP → Dense)
             → evaluate                (accuracy + confusion_matrix.png)
             → export_tfjs_json()      (strike_web_model_fine.json สำหรับเบราว์เซอร์)
             → export_header()         (strike_model_fine.h สำหรับ C++ fallback)
```

---

## 5. การวิเคราะห์โมเดลแบบ In-Browser TensorFlow.js 🧠

ระบบ StrikeSense ใช้สถาปัตยกรรม **In-Browser Machine Learning (1D-CNN + TensorFlow.js)**:

1. **การโหลดโมเดลแบบไดนามิก**:
   - เมื่อเปิดแดชบอร์ด `motioncapture.js` จะดึงไฟล์โมเดลจาก `/api/model` บน Main Node SD Card (`/models/strike_web_model_fine.json`)
   - ผู้ใช้สามารถอัปโหลดโมเดลใหม่ผ่าน Web Dashboard ได้ทันทีโดยไม่ต้อง re-flash ESP32

2. **การทำงานของ AI Engine**:
   - สัญญาณ IMU ความถี่ 400Hz ถูกตัดหน้าต่าง (sliding window 100 samples / 250ms)
   - โมเดล 1D-CNN ทำงานร่วมกับ **Gaussian priors (`physics.js`)** และ **Strike Score Calculator (`strikescore.js`)** ในการจำแนกประเภทท่าและประเมินพลังหมัด/แข้ง

---

## 6. สรุป contract ที่ห้ามหลุด (ถ้าแก้ ต้องแก้ทั้งคู่)

| Contract | ฝั่ง A | ฝั่ง B |
|---|---|---|
| ESP-NOW packet layout | `protocol.h` / strike-node | `onRecv()` main-node |
| WebSocket binary frame | `broadcastImuFrame()` | `decodeFrame()` ws.js |
| IMU scale (2048/16.4) | strike-node config | `ws.js` + `train_model.py` |
| Label tens-scheme | `index.html` optgroup | `logger.js` + `train_model.py` |
| Model JSON Format | `train_model.py` export | `motioncapture.js` + `/api/model` |

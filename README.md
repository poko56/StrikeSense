# StrikeSense

ระบบเซนเซอร์ IoT และวิเคราะห์แรงปะทะสำหรับกีฬามวยไทย แบบ Real-time (IoT Muay Thai Telemetry System)

---

## 📚 ศูนย์รวมเอกสาร (Documentation Index)

| หมวดหมู่ | เอกสาร | คำอธิบาย |
| :--- | :--- | :--- |
| **User Manuals** | 🧠 [คู่มือการเทรนโมเดล AI](docs/%E0%B9%80%E0%B8%97%E0%B8%A3%E0%B8%99%E0%B9%82%E0%B8%A1%E0%B9%80%E0%B8%94%E0%B8%A5.md) | ขั้นตอนการเก็บข้อมูล เทรนโมเดล และอัปโหลดเข้าสู่ระบบ |
| | 📖 [คู่มือการใช้งานระบบ](docs/usage-guide.md) | วิธีการติดตั้ง การเชื่อมต่อ Wi-Fi และการใช้งานแดชบอร์ด |
| | 🔌 [คู่มือการอัปโหลดเฟิร์มแวร์](docs/firmware-upload-guide.md) | ขั้นตอนการแฟลชเฟิร์มแวร์ลง ESP32-S3 และ ESP32-C3 |
| | 🔒 [คู่มือ Motion Capture & HTTPS/WSS](docs/motion-capture-https.md) | การตั้งค่า Secure Origin และใบรับรองความปลอดภัย HTTPS |
| **Technical Specs** | 📡 [Protocol Spec](docs/protocol.md) | โครงสร้างแพ็กเกจข้อมูล ESP-NOW และ WebSocket (400Hz) |
| | 🔗 [API Spec](docs/api.md) | REST / WebSocket APIs สำหรับรับส่งข้อมูลแดชบอร์ด |
| | 🤖 [AI Model Technical Guide](docs/ai-model-guide.md) | สถาปัตยกรรม 1D-CNN และระบบคลาสสิฟายท่าทาง |
| | 💻 [Code Walkthrough](docs/code-walkthrough.md) | อธิบายโครงสร้างซอร์สโค้ด และสถาปัตยกรรมซอฟต์แวร์ |
| **Reports & Briefs** | ✨ [System Features](docs/features.md) | รายละเอียดคุณสมบัติ และเกณฑ์การวัดผล |
| | 📊 [AI Presentation Brief](docs/ai-presentation-brief.md) | ข้อมูลสรุปสเปกโครงการสำหรับนำเสนอ |
| | 🛠️ [HTTPS/WSS Debug Guide](docs/ai-handoff-https-wss-debug.md) | ขั้นตอนและวิธีแก้ไขปัญหาการเชื่อมต่อ |
| | 📄 [Progress Report (HTML)](docs/progress-report.html) / [(PDF)](docs/StrikeSense-Progress-Report.pdf) | รายงานความก้าวหน้าโครงการ StrikeSense |

---

## Architecture

```
┌──────────────┐   ESP-NOW   ┌──────────────┐  WiFi AP   ┌──────────────┐
│  Strike Node │ ──400Hz──▶  │  Main Node   │ ─WebSocket▶│  Dashboard   │
│ ESP32-C3     │             │  ESP32-S3    │            │  (Browser)   │
│  + BMI160    │             │  + SD Card   │            └──────────────┘
└──────────────┘             │              │  ┌─────────────┐
       (×2)                  │              │─▶│  AI Team    │
                             └──────────────┘  │  (PC/Cloud) │
                                               └─────────────┘
```

## Project Structure

```
firmware/
  shared/         # Protocol header shared between nodes
  strike-node/    # ESP32-C3 + BMI160 IMU firmware (400Hz ESP-NOW)
  main-node/      # ESP32-S3 hub firmware + embedded PROGMEM dashboard (dashboard_ui.h)
dashboard/        # Web UI source (Vite + Vanilla JS modular source)
ml_pipeline/      # 1D-CNN training, TF.js export & parity verification
tools/            # Cert setup, MediaPipe asset downloader & simulator scripts
hardware/         # PCB + Enclosure 3D CAD files
docs/             # Full system documentation & technical specs
```

## System Status

| Component | State | Description |
|-----------|-------|-------------|
| Protocol & Shared Headers | ✅ Done | ESP-NOW 400Hz packet protocol, 4 body slots (protocol.h) |
| Main Node Firmware | ✅ Done | ESP32-S3 AP, HTTPS/WSS, SD card logger, REST API, PROGMEM Web Server |
| Strike Node Firmware | ✅ Done | ESP32-C3 + BMI160, I2C 400kHz, battery measurement & deep sleep |
| Web Dashboard UI | ✅ Done | Real-time 4-slot telemetry, MediaPipe 3D Pose, In-browser TF.js AI |
| SD Card Data Logger | ✅ Done | CSV session logging, session manager API & web replay |
| AI Pipeline & Bridge | ✅ Done | 1D-CNN training (`train_model.py`), `retrain.sh`, dynamic SD model storage |
| Custom PCB / Enclosure | ⏳ Active | Hardware enclosure and PCB layout files |

## Quick Start (Build & Flash Firmware)

```bash
# 1. Build Dashboard UI assets into PROGMEM C-header (firmware/main-node/dashboard_ui.h)
cd dashboard
npm install
npm run build

# 2. Compile and flash Main Node firmware using arduino-cli
cd ../firmware
CLI="/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli"
FQBN="esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,PartitionScheme=default_8MB,CDCOnBoot=cdc,UploadSpeed=921600"
"$CLI" compile --fqbn "$FQBN" main-node
"$CLI" upload -p /dev/cu.usbmodem101 --fqbn "$FQBN" main-node
```

เชื่อม Wi‑Fi `StrikeSense` (pwd: `muaythai123`) แล้วเปิด secure origin ตาม
[คู่มือ motion capture / HTTPS](docs/motion-capture-https.md):
`https://192.168.4.1` สำหรับ Local CA หรือ `https://<hostname>` สำหรับ
Let's Encrypt (ชื่อใน `/tls/hostname.txt`). URL นี้จำเป็นสำหรับกล้องโทรศัพท์และ
WSS. หาก rig ยังไม่มี certificate ใช้ HTTP ได้เฉพาะ dashboard legacy (ไม่มี
camera mode และไม่ใช่ transport ที่เข้ารหัส).

## เทรนโมเดลจับท่า

คำสั่งสั้นสำหรับรันเทรนโมเดลใหม่บนคอมพิวเตอร์:

```bash
./ml_pipeline/retrain.sh
```

---

## รายละเอียดโครงการ (Project Details)

### 1. หลักการและเหตุผล (Introduction)
```text
กีฬามวยไทยเป็นศิลปะการต่อสู้ที่ต้องอาศัยความเร็ว ความแม่นยำ และพละกำลัง ในปัจจุบันการฝึกซ้อมยังคงพึ่งพาสัญชาตญาณและประสบการณ์ของ
เทรนเนอร์เป็นหลัก โครงการนี้จึงมีแนวคิดในการนำเทคโนโลยี และปัญญาประดิษฐ์แบบฝังตัว มาพัฒนาระบบสวมใส่อัจฉริยะ (Wearable Device) เพื่อ
ดักจับข้อมูลทางฟิสิกส์ระหว่างการออกอาวุธ ได้แก่ ความเร็ว ความหน่วง และแรงกระแทก โดยแปลงข้อมูลดิบให้เป็นสถิติเชิงตัวเลขที่จับต้องได้
แสดงผลแบบ Real-time เพื่อยกระดับประสิทธิภาพการฝึกซ้อมและการวิเคราะห์สมรรถภาพของนักกีฬา
```

### 2. วัตถุประสงค์ของโครงการ (Objectives)
```
1. เพื่อออกแบบและผลิตชิ้นงานต้นแบบ (Prototype) เซนเซอร์สวมใส่สำหรับนักกีฬามวยไทย
2. เพื่อพัฒนาระบบประมวลผลปัญญาประดิษฐ์ฝังตัว ในการแยกแยะรูปแบบการออกอาวุธ (หมัดตรง, หมัดฮุค, ศอก, เตะ และแทงเข่า)
3. เพื่อพัฒนาระบบรับส่งข้อมูลไร้สายความหน่วงต่ำ (Low-Latency) และหน้ากระดานแสดงผล (Web Dashboard) แบบ Real-time
```

### 3. ภาพรวมสถาปัตยกรรมระบบ (System Overview)
#### ระบบถูกออกแบบมาเพื่อรองรับการเคลื่อนไหวความเร็วสูงในกีฬาต่อสู้ โดยแบ่งการทำงานเป็น 3 ส่วนหลัก:
```
• ชุดเซนเซอร์สวมใส่ : ทำหน้าที่ดักจับข้อมูลทางฟิสิกส์ (ความเร็ว, ความเร่ง, ทิศทาง) ด้วยความถี่สูง และส่งข้อมูลดิบแบบไร้สายทันที เพื่อให้
ตัวอุปกรณ์มีน้ำหนักเบาและตอบสนองไวที่สุด
• ระบบศูนย์กลางประมวลผล : ทำหน้าที่เป็นสมองกลส่วนกลาง รับข้อมูลจากเซนเซอร์ทุกจุดเพื่อนำเข้าสู่โมเดลปัญญาประดิษฐ์ (AI) ในการ
วิเคราะห์รูปแบบการปะทะ คำนวณความแรง และจำแนกประเภทอาวุธ
• ระบบแสดงผล : นำข้อมูลที่ผ่านการวิเคราะห์แล้วมาแสดงผลในรูปแบบกราฟิกและสถิติผ่านเว็บบราวเซอร์
```

### 4. คุณสมบัติเด่นของระบบ (Key Features & Specifications)
```
• ด้านฮาร์ดแวร์ (Hardware Design): อุปกรณ์สวมใส่ถูกออกแบบแผงวงจรให้มีขนาดกะทัดรัด บรรจุในตัวเรือนที่ใช้วัสดุโพลิเมอร์ยืดหยุ่น
ทนทานต่อแรงกระแทก เพื่อความปลอดภัยสูงสุดของผู้สวมใส่และคู่ซ้อม
• ด้านปัญญาประดิษฐ์ (AI & Algorithm): ระบบใช้อัลกอริทึมจำแนกรูปแบบท่าทาง ที่ถูกปรับจูนมาสำหรับกีฬาต่อสู้โดยเฉพาะ เพื่อความ
แม่นยำในการแยกแยะอาวุธ
• ด้านการสื่อสาร (Data Transmission): ใช้โปรโตคอลการรับส่งข้อมูลไร้สายความหน่วงต่ำ ร่วมกับการบริหาร
• จัดการคิวข้อมูลแบบขนาน (Multi-threaded Processing) ทำให้สามารถแสดงผลสถิติบนหน้าจอได้ทันทีโดยไม่เกิดความล่าช้า
```
#### ด้านการวิเคราะห์และแสดงผลข้อมูล (Data Analytics & Insights Dashboard): หน้าจอแสดงผลถูกออกแบบมาเพื่อเปลี่ยนข้อมูลตัวเลขทาง
ฟิสิกส์ให้กลายเป็นสถิติเชิงลึกที่เข้าใจง่ายสำหรับโค้ชและนักกีฬา โดยจะครอบคลุมการแสดงผลข้อมูลดังต่อไปนี้:

##### หน้าจอหลักสำหรับการฝึกซ้อม (Real-time Training Dashboard):
```
• ตัววัดพลังหมัดและหน้าแข้ง (Live Impact Power): แสดงเกจวัดระดับความรุนแรงของการปะทะในรูปแบบเปอร์เซ็นต์ หรือหน่วยดัชนีชี้
วัด (Score) ทันทีเมื่อเกิดการปะทะเป้าหมาย
• ระบบไฟสถานะระบุท่าทาง (Strike Indicator): แสดงสัญลักษณ์หรือกราฟิกรูปท่าทางมวยไทยบนหน้าจอที่จะสว่างขึ้นตามอาวุธที่นักมวย
ออกจริง (เช่น ตัวอักษรคำว่า "KNEE" หรือ "HOOK" จะกะพริบขึ้นมาทันทีเมื่อนักมวยแทงเข่าหรือฮุคเข้าเป้า)
• ตัวพล็อตแนวกราฟความเร็ว (Real-time Velocity Graph): เส้นกราฟความชันที่พลอตสดบนหน้าจอเพื่อแสดงทิศทาง ความเร่ง และ
การทรงตัวของแขนขาในขณะออกอาวุธ
```
##### หน้าจอสรุปผลและสถิติเชิงลึก (Performance & Metrics Analytics):
```
• สรุปอัตราส่วนอาวุธ (Striking Distribution Pie Chart): กราฟวงกลมแสดงสัดส่วนการใช้อาวุธของการซ้อมในรอบนั้นๆ (ตัวอย่าง: ใช้
หมัด 40%, เตะ 30%, เข่า 30%) ช่วยให้โค้ชวิเคราะห์ได้ว่านักมวยใช้ร่างกายสมดุลหรือไม่ หรือติดพฤติกรรมการออกอาวุธแบบใดแบบหนึ่ง
มากเกินไป
• ตัวนับจำนวนครั้งรวมแยกประเภท (Strike Counter): กล่องตัวเลขดิจิทัลขนาดใหญ่สรุปยอดรวมการออกอาวุธ เช่น หมัดตรง: 52 ครั้ง,
หมัดฮุค: 18 ครั้ง, เตะ: 35 ครั้ง, แทงเข่า: 20 ครั้ง
• ดัชนีคะแนนพละกำลังสูงสุด (Peak Power Record): บันทึกสถิติ "ที่สุดของการซ้อม" เช่น อาวุธที่รุนแรงที่สุดในรอบวัน (Max Impact)
เกิดขึ้นในนาทีที่เท่าไหร่ และเป็นอาวุธประเภทใด
• ตัววัดความเสถียรและความทนทาน (Stamina & Consistency Tracker): แสดงกราฟเปรียบเทียบความแรงตั้งแต่หมัดแรกจนถึงหมัด
สุดท้าย เพื่อวิเคราะห์ว่าเมื่อเวลาผ่านไป นักมวยแรงตกหรือไม่ หรือยังคงรักษาความรุนแรงของการปะทะได้สม่ำเสมอเพียงใด
```

### 5. ขอบเขตการดำเนินงาน (Scope of Work) - Phase 1
สำหรับการพัฒนาในเฟสที่ 1 (Proof of Concept) จะครอบคลุมปริมาณงานดังต่อไปนี้:
```
• ผลิตชุดเซนเซอร์สวมใส่: จำนวน 2 ชุด (สามารถกำหนดจุดติดตั้งได้ เช่น มือและหน้าแข้ง)
• ผลิตระบบศูนย์กลางประมวลผล: จำนวน 1 ชุด
```

### 6. รายการส่งมอบ (Deliverables)
```
1. ชิ้นงานฮาร์ดแวร์ต้นแบบ (อุปกรณ์สวมใส่ 2 ชุด และ ตัวรับสัญญาณ 1 ชุด)
2. สิทธิ์การเข้าใช้งานระบบหน้าจอแสดงผล (Web Dashboard) ตลอดช่วงระยะเวลาการทดสอบ
```

### 7. เงื่อนไขและข้อจำกัดของโครงการต้นแบบ (Terms & Conditions)
```
• ด้านความแม่นยำ: ชิ้นงานเป็นเวอร์ชันทดสอบแนวคิด (Proof of Concept) ความแม่นยำในการจำแนกท่าทางด้วย AI จะอยู่ในเกณฑ์เฉลี่ย
80-85% ภายใต้สภาวะการควบคุมการทดสอบ
• การปรับแก้ชิ้นงาน: ครอบคลุมการปรับแก้ไขการออกแบบโครงสร้างภายนอกของตัวอุปกรณ์ (Enclosure Design) สูงสุดจำนวน 2 ครั้ง
• สิทธิบัตรและทรัพย์สินทางปัญญา (Intellectual Property): การส่งมอบนี้ครอบคลุมเฉพาะชิ้นงานต้นแบบทางกายภาพและสิทธิ์การใช้
งานแพลตฟอร์มเท่านั้น ไม่รวมถึงการส่งมอบซอร์สโค้ด (Source Code), อัลกอริทึมวิเคราะห์ข้อมูล (AI Model), รูปแบบลายวงจร
อิเล็กทรอนิกส์ (PCB Gerber) และไฟล์พิมพ์เขียวสามมิติ (3D CAD) หากมีความประสงค์นำไปใช้ในการผลิตเชิงพาณิชย์ จะต้องมีการทำ
ข้อตกลงและประเมินมูลค่าลิขสิทธิ์เพิ่มเติมในเฟสถัดไป
```

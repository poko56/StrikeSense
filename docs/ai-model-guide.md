# AI Model — เทรน → อัปโหลดเข้าแดชบอร์ด → ตรวจจับท่าเรียลไทม์

> **คู่มือขั้นตอนการใช้งาน (User Manual)** → อ่าน [เทรนโมเดล.md](./เทรนโมเดล.md)
> เอกสารนี้เน้นรายละเอียดเชิงเทคนิค ส่วนคู่มือเน้นการปฏิบัติงานขั้นตอนการเทรน

เอกสารนี้อธิบายวิธีนำโมเดล AI ที่เทรนเสร็จแล้วมา "เสียบ" เข้าแดชบอร์ด StrikeSense
เพื่อให้ระบบตรวจจับท่ามวยแบบเรียลไทม์

โมเดลรัน **ในเบราว์เซอร์** (in-browser 1D-CNN) — ผู้ใช้อัปโหลดไฟล์โมเดลตอนใช้งาน
ไม่ต้องฝังลง ESP32 และเปลี่ยนโมเดลใหม่ได้โดยไม่ต้อง flash เฟิร์มแวร์ซ้ำ

```
Data Logger (dashboard)  ──►  strike_*.csv
      │  เก็บ raw IMU 400Hz + ป้ายท่า
      ▼
ml_pipeline/train_model.py  ──►  strike_web_model_fine.json   (โมเดลสำหรับเบราว์เซอร์)
      │                     └─►  strike_model_fine.h          (ทางเลือก: ฝังบน C++)
      ▼
แดชบอร์ด → แท็บระบบ → "คลังโมเดล AI" → อัปโหลด .json → บันทึกลง SD Card (/models/)
      ▼
ทายท่าอัตโนมัติทุกครั้งที่ออกอาวุธ (โชว์ท่า + % ความมั่นใจ + Strike Score)
```

## 1. เก็บข้อมูล (Data Logger)

1. เปิด Developer mode ในแดชบอร์ด (แท็บ **ระบบ** → เปิด โหมดนักพัฒนา)
2. ที่การ์ด **AI TRAINING · DATA LOGGER** เลือกท่าที่จะบันทึก → กด **เริ่มบันทึก** → ออกอาวุธ → **หยุด**
3. กด **↓ ส่งออกทั้งหมด** เพื่อดาวน์โหลด CSV
4. นำไฟล์ไปวางใน `ml_pipeline/data/` (สคริปต์ `retrain.sh` ย้ายเข้าให้อัตโนมัติ)

## 2. เทรนโมเดล

```bash
# เทรนอัตโนมัติด้วย retrain.sh
./ml_pipeline/retrain.sh

# หรือรัน train_model.py โดยตรง
cd ml_pipeline
pip install -r requirements.txt
python train_model.py --data "./data/*.csv"
```

ตัวเลือกความละเอียดของคลาสด้วย `--mode`:

| โหมด | คลาส | เหมาะกับ |
|------|------|----------|
| `coarse` (ค่าเริ่มต้น) | 5 อาวุธ (หมัด/ศอก/เข่า/เตะ/ถีบ) | ข้อมูลไม่มาก แม่นและเสถียร |
| `coarse_lr` | 10 คลาส = 5 อาวุธ × ซ้าย-ขวา | ต้องเก็บครบซ้าย-ขวา |
| `fine` | ~20 ท่าย่อย | ต้องมี dataset ใหญ่ |

ผลลัพธ์ที่ได้:
- **`strike_web_model_fine.json`** ← ไฟล์ที่อัปโหลดเข้าแดชบอร์ด (ข้อ 3)
- `strike_model_fine.h` ← ทางเลือก C++ header สำหรับ embedded C++ reference
- `confusion_matrix.png` ← ดูว่าโมเดลสับสนท่าไหนบ้าง

> เปลี่ยนขนาดหน้าต่าง/ความลึกโมเดลได้ที่หัวไฟล์ `train_model.py` (`TIME_STEPS`, `build_model`)
> — รัน `python verify_web_model.py` เพื่อยืนยันว่า inference ฝั่งเบราว์เซอร์ยังตรงกับ Keras

## 3. อัปโหลดเข้าแดชบอร์ดและ SD Card

1. เปิดแดชบอร์ด → แท็บ **ระบบ** → หัวข้อ **คลังโมเดล AI**
2. กด **"เพิ่มไฟล์โมเดล"** → เลือก `strike_web_model_fine.json`
3. ไฟล์จะถูกสตรีมส่งไปยัง Main Node และบันทึกเก็บใน SD Card (`/models/strike_web_model_fine.json`)
4. ระบบเปิด **"เปิดตรวจจับท่าด้วย AI"** ให้อัตโนมัติ และโหลดโมเดลเข้าเบราว์เซอร์
5. เมื่อออกอาวุธ — ระบบจะวิเคราะห์ท่าผ่าน 1D-CNN + Physics engine สดๆ บนหน้าจอ

## วิธีทำงานภายใน (สรุป)

- IMU ดิบ 400Hz เข้ามาทาง WebSocket → เก็บเป็น ring buffer ต่อโหนด (ค่าดิบ ตรงกับตอนเทรน)
- เมื่อ detector จับได้ว่ามีการออกอาวุธ → ตัดหน้าต่าง `TIME_STEPS` ตัวอย่างล่าสุด → normalize ด้วย mean/std จากตอนเทรน → รันผ่าน 1D-CNN ในเบราว์เซอร์ (`dashboard/src/motioncapture.js`)
- ทำงานร่วมกับ `physics.js` (Gaussian priors) และ `strikescore.js` (ประเมินคะแนนแรงปะทะ)
- โมเดลทำงานแบบ offline ได้เต็มรูปแบบ และทดสอบความถูกต้องกับ Keras ระดับ 1e-6 ด้วย `verify_web_model.py`

## หมายเหตุ: แดชบอร์ดฝังอยู่ในเฟิร์มแวร์

ตัวแดชบอร์ดถูก build แล้วฝังเป็น `firmware/main-node/dashboard_ui.h` (PROGMEM)
ดังนั้นเมื่อแก้โค้ดแดชบอร์ดต้อง rebuild + flash Main Node ใหม่:

```bash
cd dashboard && npm run build      # สร้าง dist + regenerate dashboard_ui.h
# แล้ว flash ตาม docs/firmware-upload-guide.md
```

ส่วน **ไฟล์โมเดล (.json)** ไม่ได้ฝังในเฟิร์มแวร์ — อัปโหลดตอน runtime จึงเปลี่ยนโมเดลได้โดยไม่ต้อง flash

// =============================================================================
// BMI160 Sensor Test — Strike Node (ESP32-C3)
// เป้าหมาย: แยก sensor ออกจาก ESP-NOW/WiFi/timer ทั้งหมด เพื่อพิสูจน์ว่า
//   BMI160 ต่อสายถูก + อ่านค่า accel/gyro ได้จริง (polling ล้วน ไม่มีอะไรมา block)
//
// ── วิธีใช้ผ่าน Arduino IDE ──────────────────────────────────────────────
//   Board  : "ESP32C3 Dev Module"
//   ⭐ USB CDC On Boot : Enabled   ← สำคัญมาก! ไม่งั้น Serial ไม่ออก USB
//   Upload Speed : 921600 (หรือ 115200 ถ้าอัพไม่ผ่าน)
//   จากนั้น Upload → เปิด Serial Monitor ตั้ง baud 115200
//
// ── การอ่านผล ──
//   • เจอ BMI160  → เห็นบรรทัด "A[g] ... G[dps] ..." ไหลต่อเนื่อง ~10 Hz
//     วางนิ่งแกนที่ตั้งฉากพื้นควรอ่านได้ ~+1.00 g, gyro ใกล้ 0
//     เขย่า/ตี → ตัวเลขเด้งแรง มีป้าย "<< MOVE"
//   • ไม่เจอ       → "CHIP_ID = 0x.." ไม่ใช่ 0xD1 + "ไม่พบ BMI160"
//
// Wiring (ตามที่ firmware หลักใช้):
//   BMI160 VCC -> 3V3, GND -> GND, SDA -> GPIO8, SCL -> GPIO9
//   (โมดูล GY-BMI160 มี pull-up ในตัว; ถ้าใช้ชิปเปล่าให้ต่อ 4.7k จาก SDA/SCL -> 3V3)
//   SDO/ADDR: ต่อ GND = addr 0x68 · ต่อ 3V3 = addr 0x69
// =============================================================================

#include <Arduino.h>
#include <Wire.h>

#define I2C_SDA_PIN 8
#define I2C_SCL_PIN 9
#define I2C_FREQ    100000   // ลดจาก 400k → 100k แก้บิตเพี้ยน (สายหลวม/pull-up อ่อน/rise-time ช้า)
#define LED_PIN     2

// BMI160 registers
#define BMI160_REG_CHIPID   0x00
#define BMI160_REG_ERR      0x02
#define BMI160_REG_PMU_STAT 0x03
#define BMI160_REG_DATA     0x0C   // GYR_X_L (อ่าน 12 ไบต์: gyro XYZ แล้ว accel XYZ)
#define BMI160_REG_STATUS   0x1B
#define BMI160_REG_ACC_CONF 0x40
#define BMI160_REG_ACC_RANG 0x41
#define BMI160_REG_GYR_CONF 0x42
#define BMI160_REG_GYR_RANG 0x43
#define BMI160_REG_PMU_CMD  0x7E

// scale factors (ให้ตรงกับ protocol หลัก: ±16g, ±2000dps)
#define ACCEL_LSB_PER_G   2048.0f
#define GYRO_LSB_PER_DPS  16.4f

static uint8_t g_addr    = 0x69;   // setup จะ auto-detect
static uint8_t g_sda     = I2C_SDA_PIN;
static uint8_t g_scl     = I2C_SCL_PIN;
static bool    g_hasBmi  = false;

// ---- I2C helpers ----
static bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(g_addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static uint8_t readReg(uint8_t reg) {
  Wire.beginTransmission(g_addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  Wire.requestFrom((uint8_t)g_addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}

static bool readBurst(uint8_t reg, uint8_t* buf, uint8_t n) {
  Wire.beginTransmission(g_addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  uint8_t got = Wire.requestFrom((uint8_t)g_addr, n);
  if (got != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

// ---- I2C bus scanner ----
static void scanBus() {
  Serial.println("[I2C] กำลังสแกนบัส...");
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("[I2C]   พบอุปกรณ์ที่ 0x%02X\n", a);
      found++;
    }
  }
  if (found == 0)
    Serial.println("[I2C]   ❌ ไม่พบอะไรเลย → เช็คสาย VCC/GND/SDA(8)/SCL(9) + pull-up");
  else
    Serial.printf("[I2C]   เจอทั้งหมด %d ตัว (BMI160 = 0x68 หรือ 0x69)\n", found);
}

// ---- init BMI160 ----
static bool initBmi(uint8_t addr) {
  g_addr = addr;
  // retry เผื่อสัมผัสไม่แน่นตอน boot (อ่านครั้งแรกอาจได้ 0x00)
  uint8_t id = 0;
  for (int r = 0; r < 8; r++) {
    id = readReg(BMI160_REG_CHIPID);
    if (id == 0xD1 || id == 0xD8 || id == 0xD9) break;
    delay(25);
  }
  Serial.printf("[BMI] addr 0x%02X → CHIP_ID = 0x%02X (0xD1=BMI160 · 0xD8=BMX160)\n", addr, id);
  // ยอมรับ 0xD1(BMI160)/0xD8(BMX160)/0xD9 → register accel/gyro เหมือนกัน อ่านได้เลย
  if (id != 0xD1 && id != 0xD8 && id != 0xD9) return false;
  if (id != 0xD1) Serial.printf("[BMI] ℹ ตรวจพบชิป id=0x%02X (BMX160/รุ่นใกล้เคียง) — อ่าน accel/gyro ต่อได้\n", id);

  // Power up: accel normal (0x11), gyro normal (0x15)
  writeReg(BMI160_REG_PMU_CMD, 0x11); delay(10);
  writeReg(BMI160_REG_PMU_CMD, 0x15); delay(60);

  // ODR 100Hz, normal filter (พอสำหรับ test polling)
  writeReg(BMI160_REG_ACC_CONF, 0x28);
  writeReg(BMI160_REG_GYR_CONF, 0x28);
  // Range: accel ±16g (0x0C), gyro ±2000dps (0x00)
  writeReg(BMI160_REG_ACC_RANG, 0x0C);
  writeReg(BMI160_REG_GYR_RANG, 0x00);
  delay(10);

  uint8_t pmu = readReg(BMI160_REG_PMU_STAT);
  uint8_t err = readReg(BMI160_REG_ERR);
  Serial.printf("[BMI] PMU_STATUS = 0x%02X (accel+gyro normal ≈ bit ตั้ง), ERR = 0x%02X\n", pmu, err);
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1500);   // ให้ USB CDC enumerate ทัน ก่อน print (สำคัญบน C3)
  Serial.println("\n\n=== BMI160 Sensor Test (ESP32-C3) ===");
  Serial.printf("Build: %s %s\n", __DATE__, __TIME__);
  Serial.printf("I2C: SDA=GPIO%d SCL=GPIO%d @ %d Hz\n", I2C_SDA_PIN, I2C_SCL_PIN, I2C_FREQ);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);

  // auto-detect: ลองทั้ง 2 การจับคู่ขา (เผื่อ PCB สลับ SDA/SCL) × ทั้ง 2 address
  //   combo A: SDA=8, SCL=9   ·   combo B: SDA=9, SCL=8
  struct Pins { uint8_t sda, scl; };
  Pins combos[] = { {8, 9}, {9, 8} };

  for (auto& c : combos) {
    Serial.printf("\n[TRY] SDA=GPIO%u  SCL=GPIO%u ...\n", c.sda, c.scl);
    Wire.end();
    Wire.begin(c.sda, c.scl, I2C_FREQ);
    Wire.setTimeOut(50);
    delay(20);
    scanBus();
    if (initBmi(0x69) || initBmi(0x68)) {
      g_sda = c.sda; g_scl = c.scl; g_hasBmi = true;
      break;
    }
  }

  if (g_hasBmi)
    Serial.printf("\n[BMI] ✅ เจอ! addr=0x%02X  SDA=GPIO%u  SCL=GPIO%u — เริ่มอ่านค่า (10 Hz)\n\n",
                  g_addr, g_sda, g_scl);
  else
    Serial.println("\n[BMI] ❌ ไม่พบ BMI160 ทั้ง 2 การจับคู่ขา → เช็ค: CS ต่อ 3V3? มีไฟเข้าโมดูล? SCL routed?\n");
}

void loop() {
  static uint32_t lastMs = 0;
  uint32_t now = millis();
  if (now - lastMs < 100) return;   // ~10 Hz
  lastMs = now;

  if (!g_hasBmi) {
    digitalWrite(LED_PIN, (now / 500) & 1);      // ไฟกะพริบช้า = ไม่เจอเซนเซอร์
    // สแกน I2C ซ้ำทุก 2 วิ (ลองทั้ง 2 คู่ขา) → เห็นชัดว่ามีอุปกรณ์ตอบบัสไหม
    static uint32_t lastDiag = 0;
    if (now - lastDiag >= 2000) {
      lastDiag = now;
      Serial.println("\n──────── I2C LIVE DIAG ────────");
      const uint8_t pairs[2][2] = {{8,9},{9,8}};
      for (int p = 0; p < 2; p++) {
        Wire.end();
        Wire.begin(pairs[p][0], pairs[p][1], I2C_FREQ);
        Wire.setTimeOut(50);
        delay(10);
        int found = 0;
        Serial.printf("[SDA=%u SCL=%u] ", pairs[p][0], pairs[p][1]);
        for (uint8_t a = 1; a < 127; a++) {
          Wire.beginTransmission(a);
          if (Wire.endTransmission() == 0) { Serial.printf("0x%02X ", a); found++; }
        }
        if (found == 0) Serial.print("ไม่เจออุปกรณ์เลย");
        // ลองอ่าน CHIP_ID ที่ 0x68/0x69 ตรงๆ
        for (uint8_t addr : {0x68, 0x69}) {
          g_addr = addr;
          uint8_t id = readReg(BMI160_REG_CHIPID);
          Serial.printf(" | 0x%02X:id=0x%02X", addr, id);
        }
        Serial.println();
      }
      Serial.println("→ เจอ 0x68/0x69 + id=0xD1 = สำเร็จ · ไม่เจอเลย = SCL/ไฟ/สายขาด · id!=0xD1 = สายหลวม/รบกวน");
    }
    return;
  }

  uint8_t raw[12];
  if (!readBurst(BMI160_REG_DATA, raw, 12)) {
    digitalWrite(LED_PIN, (now / 120) & 1);      // กะพริบถี่ = I2C error
    Serial.println("[BMI] ⚠️ อ่านไม่สำเร็จ (I2C error) — เช็คสาย/ไฟเลี้ยง");
    return;
  }

  // layout จาก 0x0C: gyro XYZ (6) แล้ว accel XYZ (6), little-endian int16
  int16_t gx = (int16_t)(raw[0]  | (raw[1]  << 8));
  int16_t gy = (int16_t)(raw[2]  | (raw[3]  << 8));
  int16_t gz = (int16_t)(raw[4]  | (raw[5]  << 8));
  int16_t ax = (int16_t)(raw[6]  | (raw[7]  << 8));
  int16_t ay = (int16_t)(raw[8]  | (raw[9]  << 8));
  int16_t az = (int16_t)(raw[10] | (raw[11] << 8));

  float axg = ax / ACCEL_LSB_PER_G, ayg = ay / ACCEL_LSB_PER_G, azg = az / ACCEL_LSB_PER_G;
  float gxd = gx / GYRO_LSB_PER_DPS, gyd = gy / GYRO_LSB_PER_DPS, gzd = gz / GYRO_LSB_PER_DPS;
  float amag = sqrtf(axg*axg + ayg*ayg + azg*azg);
  float gmag = sqrtf(gxd*gxd + gyd*gyd + gzd*gzd);

  bool moving = (amag > 1.30f) || (amag < 0.70f) || (gmag > 60.0f);
  digitalWrite(LED_PIN, (now / 100) & 1);        // toggle ทุกอ่าน = heartbeat ว่ากำลังอ่านอยู่

  Serial.printf("A[g] %+6.2f %+6.2f %+6.2f |a|=%4.2f   G[dps] %+8.1f %+8.1f %+8.1f  %s\n",
                axg, ayg, azg, amag, gxd, gyd, gzd, moving ? "<< MOVE" : "");
}

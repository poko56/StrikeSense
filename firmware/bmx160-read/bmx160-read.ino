// =============================================================================
// BMX160 / BMI160 — Sensor Value Reader (ESP32-C3)
// อ่านค่า accel/gyro แบบสะอาด + เช็คความถูกต้องของ I2C อัตโนมัติ
//
// ── Arduino IDE ──  Board: ESP32C3 Dev Module · USB CDC On Boot: Enabled · Upload
// ── Serial Monitor 115200 ──
//
// รองรับทั้ง BMI160 (id 0xD1) และ BMX160 (id 0xD8) — register accel/gyro เหมือนกัน
// วางนิ่ง: แกนที่ตั้งฉากพื้น ≈ ±1.00 g, gyro ≈ 0 · เขย่า: ค่าเด้งแรง
//
// ⚠ ถ้าเห็น "[!] ค่าเพี้ยน (ทุกแกนเท่ากัน)" = I2C ยังไม่ดี → ใส่ pull-up 4.7k ที่ SDA/SCL→3.3V
// =============================================================================

#include <Arduino.h>
#include <Wire.h>

#define SDA_PIN   8
#define SCL_PIN   9
#define I2C_HZ    100000          // 100kHz (ค่ามาตรฐานหลังใส่ pull-up แล้ว)

// registers (BMI160/BMX160 เหมือนกัน)
#define REG_CHIPID   0x00
#define REG_ERR      0x02
#define REG_PMU      0x03
#define REG_DATA     0x0C         // GYR_X_L: อ่าน 12 ไบต์ = gyro XYZ + accel XYZ
#define REG_ACC_CONF 0x40
#define REG_ACC_RNG  0x41
#define REG_GYR_CONF 0x42
#define REG_GYR_RNG  0x43
#define REG_CMD      0x7E

#define ACC_LSB_G    2048.0f      // ±16g
#define GYR_LSB_DPS  16.4f        // ±2000dps

static uint8_t addr = 0x69;

static bool wr(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr); Wire.write(reg); Wire.write(val);
  return Wire.endTransmission() == 0;
}
static uint8_t rd(uint8_t reg) {
  Wire.beginTransmission(addr); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  Wire.requestFrom((uint8_t)addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}
static bool rdBurst(uint8_t reg, uint8_t* b, uint8_t n) {
  Wire.beginTransmission(addr); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)addr, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) b[i] = Wire.read();
  return true;
}

static uint8_t detectChip() {          // คืน chip id ที่หา 0xD1/0xD8 เจอ (retry กันสัมผัสไม่แน่น)
  for (uint8_t a : {0x69, 0x68}) {
    addr = a;
    for (int r = 0; r < 10; r++) {
      uint8_t id = rd(REG_CHIPID);
      if (id == 0xD1 || id == 0xD8) return id;
      delay(20);
    }
  }
  return 0;
}

static void initSensor() {
  wr(REG_CMD, 0xB6); delay(100);       // soft reset
  wr(REG_CMD, 0x11); delay(10);        // accel normal mode
  wr(REG_CMD, 0x15); delay(80);        // gyro normal mode
  wr(REG_ACC_CONF, 0x28);              // accel 100Hz, normal filter
  wr(REG_GYR_CONF, 0x28);              // gyro 100Hz, normal filter
  wr(REG_ACC_RNG, 0x0C);               // ±16g
  wr(REG_GYR_RNG, 0x00);               // ±2000dps
  delay(20);
}

bool ok = false;

void setup() {
  Serial.begin(115200);
  delay(600);
  Serial.println("\n=== BMX160/BMI160 Reader ===");
  Serial.printf("I2C SDA=GPIO%d SCL=GPIO%d @ %d Hz\n", SDA_PIN, SCL_PIN, I2C_HZ);

  Wire.begin(SDA_PIN, SCL_PIN, I2C_HZ);
  Wire.setTimeOut(50);

  uint8_t id = detectChip();
  if (!id) {
    Serial.println("[X] ไม่พบเซนเซอร์ — เช็ค SDA/SCL/VCC/GND + pull-up 4.7k");
    return;
  }
  Serial.printf("[OK] พบชิปที่ 0x%02X · CHIP_ID=0x%02X (%s)\n",
                addr, id, id == 0xD8 ? "BMX160" : "BMI160");
  initSensor();
  uint8_t pmu = rd(REG_PMU), err = rd(REG_ERR);
  Serial.printf("[OK] PMU_STATUS=0x%02X ERR=0x%02X → เริ่มอ่านค่า (วางนิ่งควรได้ ~1g แกนตั้งฉากพื้น)\n\n", pmu, err);
  ok = true;
}

void loop() {
  if (!ok) {                              // ยังไม่เจอ → ลอง detect ซ้ำ + รายงานทุก 1 วิ
    static uint32_t lastTry = 0;
    if (millis() - lastTry >= 1000) {
      lastTry = millis();
      uint8_t id = detectChip();
      if (id) {
        Serial.printf("[OK] เจอชิป CHIP_ID=0x%02X @ addr 0x%02X → init...\n", id, addr);
        initSensor();
        uint8_t pmu = rd(REG_PMU);
        Serial.printf("[OK] PMU=0x%02X เริ่มอ่านค่า\n", pmu);
        ok = true;
      } else {
        Serial.println("[X] ยังไม่เจอ (0x68/0x69 ไม่ ACK) — เช็คสาย SDA/SCL/GND/VDD + pull-up→3.3V");
      }
    }
    return;
  }

  static uint32_t last = 0;
  if (millis() - last < 120) return;   // ~8 Hz
  last = millis();

  uint8_t raw[12];
  if (!rdBurst(REG_DATA, raw, 12)) {
    Serial.println("[!] อ่านไม่สำเร็จ (I2C error) — สายหลวม/pull-up อ่อน");
    return;
  }
  int16_t gx = raw[0]  | (raw[1]  << 8), gy = raw[2] | (raw[3] << 8), gz = raw[4]  | (raw[5]  << 8);
  int16_t ax = raw[6]  | (raw[7]  << 8), ay = raw[8] | (raw[9] << 8), az = raw[10] | (raw[11] << 8);

  // เช็คค่าเพี้ยน: ทุกแกนเท่ากันเป๊ะ = burst read พัง (สัญญาณไม่ดี)
  if (ax == ay && ay == az && gx == gy && gy == gz) {
    Serial.printf("[!] ค่าเพี้ยน (ทุกแกนเท่ากัน raw=%d) → I2C ไม่นิ่ง: ใส่ pull-up 4.7k / ย้ำขา\n", ax);
    return;
  }

  Serial.printf("A[g] %+6.2f %+6.2f %+6.2f |a|=%4.2f   G[dps] %+8.1f %+8.1f %+8.1f\n",
                ax/ACC_LSB_G, ay/ACC_LSB_G, az/ACC_LSB_G,
                sqrtf((ax*ax + ay*ay + (float)az*az))/ACC_LSB_G,
                gx/GYR_LSB_DPS, gy/GYR_LSB_DPS, gz/GYR_LSB_DPS);
}

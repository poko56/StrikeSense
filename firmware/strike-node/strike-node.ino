#include "../shared/protocol.h"
#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_now.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <esp_sleep.h>   // deep sleep + GPIO wakeup สำหรับปุ่ม power

// --- Configuration ---
#define I2C_SDA_PIN 8
#define I2C_SCL_PIN 9
#define I2C_FREQ 400000

#define BMI160_ADDR 0x69 // Default for DFRobot/Bosch, could be 0x68
#define LED_PIN 2

// ─────────────────────────────────────────────────────────────
// FEATURE FLAGS — เปิดเป็น 1 "เฉพาะเมื่อต่อวงจรขานั้นจริงแล้ว"
//   ⚠ ถ้าเปิดทั้งที่ยังไม่ต่อวงจร ขาจะลอย (floating) → อ่านค่ามั่ว
//      โดยเฉพาะ charge-detect: ขาลอยอาจอ่าน HIGH เอง → node หลับทันที
//      อาการ "เชื่อมแปบเดียวแล้วหลุด" = ขา GPIO5 ลอยแล้วเข้าใจว่ากำลังชาร์จ
// ─────────────────────────────────────────────────────────────
#define ENABLE_CHARGE_DETECT  0   // 0 = โหมด A (ตื่นตลอด · dashboard โชว์ชาร์จจากเทรนด์แรงดัน · แบตพึ่ง protection IC ของ TP4056) · 1 = pause/sleep ตอนชาร์จ (GPIO5 ต่อแล้วทุกบอร์ด แต่ต้อง validate ให้อ่านนิ่งก่อน)
#define ENABLE_BATTERY        1   // 1 = อ่านแบตจริงจาก GPIO4 · 0 = ส่ง 100% ตายตัว

// ⚠ แยกออกจาก ENABLE_BATTERY โดยตั้งใจ!
// การ "อ่านค่าแบตมาโชว์" ปลอดภัยเสมอ แต่การ "ตัดไฟเข้า deep sleep" อันตราย:
// ถ้ายังไม่ได้ต่อ divider ที่ GPIO4 ขาจะลอย อ่านได้ค่ามั่วต่ำๆ แล้วโหนดจะหลับถาวร
// (ไม่มี wake source เมื่อ ENABLE_CHARGE_DETECT=0) = ต้องถอดแบตมาเสียบใหม่ทุกตัว
// เปิดเป็น 1 ได้ต่อเมื่อวัดแล้วว่าค่าแบตที่อ่านได้ตรงกับมัลติมิเตอร์จริง
#define ENABLE_LOW_BATT_CUTOFF 0

// ช่วงแรงดันที่ "เป็นไปได้จริง" สำหรับ Li-ion ผ่าน divider /2
// อ่านได้นอกช่วงนี้ = ยังไม่ได้ต่อ divider / ขาลอย → รายงานว่าอ่านไม่ได้ ไม่เดาเป็น %
// (ต่ำกว่า 2.7V เป็นไปไม่ได้ตอนบอร์ดยังทำงานอยู่ เพราะ ESP32-C3 ดับไปก่อนแล้ว)
#define BAT_PLAUSIBLE_MIN_V  2.70f
#define BAT_PLAUSIBLE_MAX_V  4.60f

// กำลังส่ง ESP-NOW (หน่วย 0.25 dBm) — ปรับที่เดียวจบ ดูคำอธิบายที่จุดเรียกใช้
#define ESPNOW_TX_POWER  68
// พิมพ์ค่าแบตทุกกี่มิลลิวินาที — เดิมพิมพ์ทุก 1 วิ กินเวลา loop เปล่าๆ
#define BATT_LOG_MS      10000

// โหมดตอนชาร์จ:  1 = ดับจริง (deep sleep, ตื่นตอนถอดสาย)  ·  0 = pause (หยุดส่งแต่ไม่หลับ)
// ⚠ deep sleep: USB/COM จะหลุดตอนหลับ (ปกติ) → ทดสอบด้วยแบต ดูผลผ่าน dashboard
// ⚠ ต้องแก้ฮาร์ดแวร์ให้ IN+ คายประจุเร็ว (divider 10k/15k) ไม่งั้น "ถอดแล้วไม่ตื่น"
#define CHARGE_DEEP_SLEEP     0   // 0 = pause (ไม่หลับ USB ไม่หลุด เหมาะ dev) · 1 = deep sleep (เฉพาะใช้แบตจริง)

// --- Battery ADC ---
// วงจร: BAT+ ─ R1(100kΩ) ─ GPIO4 ─ R2(100kΩ) ─ GND   (+ cap 100nF จาก GPIO4 → GND กัน noise)
// Vout = Vbatt / 2  →  Vbatt=4.2V จะได้ 2.1V เข้า ADC (ปลอดภัยต่อชิป 3.3V)
// ── เลือกขาวัดแบตอัตโนมัติ ─────────────────────────────────────────
// บอร์ดชุดนี้ต่อวงจรวัดแบตไม่เหมือนกันทุกตัว (บางตัวต่อ GPIO4 บางตัวยังไม่ต่อ
// บางตัวย้ายไปขาอื่น) การล็อกขาเดียวในเฟิร์มแวร์จึงต้องแยก build ต่อบอร์ด
// แทนที่จะทำแบบนั้น ให้เฟิร์มแวร์ไล่หาขาที่ "อ่านแล้วสมเหตุสมผลจริง" เอง
//
// ⚠ ใช้ได้เฉพาะ ADC1 เท่านั้น = GPIO0–GPIO4 บน ESP32-C3
//   (ADC2 อ่านไม่ได้เลยเมื่อเปิด WiFi — ขา GPIO5 จึงใช้ไม่ได้)
//   ตัด GPIO2 ออกเพราะเป็นขา LED · GPIO8/9 เป็น I2C ของ BMI160
//   เรียง GPIO4 ไว้แรกเพื่อให้บอร์ดที่ต่อไว้เดิมทำงานเหมือนเดิม
#define BAT_PIN_CANDIDATES  { 4, 1, 0 }   // ⚠ ตัด GPIO3 ออก — สงวนไว้เป็นขา motion INT (MOTION_INT_PIN)

#define BAT_RESCAN_MS       30000   // ยังหาไม่เจอ → ไล่หาใหม่ทุก 30 วิ (เผื่อเพิ่งเสียบแบต)

static const uint8_t BAT_PINS[] = BAT_PIN_CANDIDATES;
static const size_t  BAT_PIN_N  = sizeof(BAT_PINS) / sizeof(BAT_PINS[0]);
static int8_t   g_batPin       = -1;    // -1 = ยังหาไม่เจอ
static uint32_t g_batScanMs    = 0;
#define BAT_DIV_RATIO  2.0f   // R1=R2 → แรงดันถูกหารสอง ต้องคูณกลับ
#define BAT_SAMPLES    8      // จำนวน ADC reads ที่เฉลี่ยต่อครั้ง (ลด noise)
#define BAT_EMA_ALPHA  0.2f   // น้ำหนัก smoothing (ยิ่งน้อยยิ่งนิ่ง 0.2 = นิ่งปานกลาง)

// ตัดไฟกันแบตเสื่อม (over-discharge protection ฝั่ง firmware) — ทำงานเมื่อ ENABLE_BATTERY=1
#define LOW_BATT_CUTOFF_V  3.30f   // แบตต่ำกว่านี้ (V) = ตัดไฟเข้า deep sleep
#define LOW_BATT_HOLD_MS   5000    // ต้องต่ำต่อเนื่องเท่านี้ (ms) ถึงตัด — กัน TX spike หลอก

// --- Charge detect แบบ IN+ sense (auto power-off ตอนเสียบสายชาร์จ) ---
// ตรวจว่ามีไฟ 5V เข้า IN+ ของ TP4056 หรือไม่ (= เสียบสาย/คาแท่นชาร์จอยู่)
// ต้องมี voltage divider กันไฟ 5V:  IN+ ─R1(100kΩ)─ GPIO5 ─R2(150kΩ)─ GND
//   เสียบสาย → GPIO5 ≈ 3.0V (HIGH ชัดเจน) · ถอดสาย → ~0V (LOW)
// ⚠ R2=150kΩ (ไม่ใช่ 100k) เพื่อให้ได้ 3.0V ไม่ใช่ 2.5V ที่ก้ำกึ่งกับ threshold
// ⚠ ต้องใช้ GPIO0–GPIO5 เท่านั้น! เพราะ ESP32-C3 ปลุกจาก deep sleep ได้เฉพาะขากลุ่มนี้
//   (ถ้าใช้ GPIO10 จะ "ถอดสายแล้วไม่ตื่นเอง" เพราะปลุกไม่ได้)
// ⚠ ใช้ INPUT ธรรมดา (ไม่เปิด pull-up) เพราะ divider เป็นตัวกำหนดระดับเอง
#define CHG_SENSE_PIN  5      // GPIO5 (wake-capable · รับจากจุดกลาง divider ของ IN+)
#define CHG_HOLD_MS    1500   // เห็นไฟเข้าต่อเนื่องเท่านี้ (ms) ถึงจะดับ (กัน noise/แวบ)

// BMI160 Registers
#define BMI160_REG_CHIPID 0x00
#define BMI160_REG_PMU_CMD 0x7E
#define BMI160_REG_ACC_CONF 0x40
#define BMI160_REG_GYR_CONF 0x42
#define BMI160_REG_ACC_RANG 0x41
#define BMI160_REG_GYR_RANG 0x43
#define BMI160_REG_DATA 0x0C // GYR_X_L

// ── Wake-on-motion (Phase 1) ────────────────────────────────
// BMX160 มี any-motion interrupt ในตัว → ใช้ปลุก ESP32 ตอนหลับ
//   step 1a (MOTION_DEEP_SLEEP=0): config + อ่าน INT_STATUS ทาง I2C มาพิมพ์
//        ยืนยันว่าเซนเซอร์จับการเคลื่อนไหวได้ — ยังไม่ต้องต่อสาย INT1 · ไม่หลับ (ปลอดภัย)
//   step 1b (MOTION_DEEP_SLEEP=1): ต่อสาย INT1 → GPIO3 แล้วเปิด deep sleep + wake
#define ENABLE_MOTION_WAKE  1      // 1 = เปิด any-motion detect
#define MOTION_DEEP_SLEEP   1      // 0 = แค่ตรวจ+พิมพ์ (เช็ก INT1) · 1 = หลับจริง (production)
#define MOTION_INT_PIN      3      // GPIO3 (wake-capable) รับ INT1 จาก BMX160
#define MOTION_IDLE_MS      300000 // นิ่งเกินเท่านี้ (ms) → หลับ · 300000 = 5 นาที (production · กันหลับกลางยก/พักคอมโบ)
#define MOTION_THRESH       0x08   // any-motion threshold · ±16g: 1 LSB≈31mg → 0x08≈250mg (ปรับได้)
#define MOTION_DUR          0x00   // จำนวน sample เกิน threshold ก่อนยิง (bits1:0 · 0=1 sample ไวสุด)
#define MOTION_VERBOSE      0      // 1 = พิมพ์ GPIO3/I2C ทุกวินาที (สำหรับเช็ก INT1 โหนดใหม่) · production=0

// BMX160/BMI160 interrupt registers (สำหรับ any-motion)
#define BMX_REG_INT_STATUS0  0x1C  // bit2 = any-motion
#define BMX_REG_INT_EN0      0x50  // bit0-2 = anymotion x/y/z enable
#define BMX_REG_INT_OUT_CTRL 0x53  // INT1 output/level/mode
#define BMX_REG_INT_LATCH    0x54  // latch mode
#define BMX_REG_INT_MAP0     0x55  // bit2 = map anymotion → INT1
#define BMX_REG_INT_MAP2     0x57  // bit2 = map anymotion → INT2
#define BMX_REG_INT_MOTION0  0x5F  // anymotion duration (bits1:0)
#define BMX_REG_INT_MOTION1  0x60  // anymotion threshold (8-bit)

uint32_t lastMotionMs = 0;   // เวลาตรวจพบการเคลื่อนไหวล่าสุด (feeds idle-sleep ตอน step 1b)
volatile bool g_intSeenHigh = false;  // fast-poll: GPIO3(INT) เคยขึ้น HIGH ในรอบล่าสุดไหม

// --- State ---
// ใช้ Broadcast MAC (FF:FF:FF:FF:FF:FF) เพื่อแก้ปัญหา MAC ของฝั่ง AP ไม่ตรงกับ STA
uint8_t targetAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
esp_now_peer_info_t peerInfo;

ImuBatchPacket txPacket;
uint8_t sampleIndex = 0;
uint32_t packetSequence = 0;
uint32_t lastStatusMs = 0;
uint16_t lostPackets = 0;

// ส่ง IMU ออกจาก loop() (main task) แทนใน timer callback (stack เล็ก → แครช)
// timer เก็บข้อมูลครบ 1 packet → copy ลง buffer นี้ + ตั้ง flag → loop ส่ง
volatile bool   imuTxReady = false;
ImuBatchPacket  imuTxBuf;

esp_timer_handle_t sampleTimer;
SemaphoreHandle_t i2cMutex;
bool hasSensor = false;

// ── สั่ง "ระบุตัวเครื่อง" จาก Main Node ──
// ทำเป็น non-blocking: เดิมใช้ delay(50) + return ในลูป ทำให้ระหว่างกะพริบ
// โหนดหยุดส่ง IMU ไป 1 วินาทีเต็ม และแพ็กเก็ตที่ timer เตรียมไว้ถูกทิ้ง
#define IDENTIFY_MS        5000   // กะพริบนานพอให้เดินไปหาตัวเจอ
#define IDENTIFY_PERIOD_MS  120   // ครึ่งคาบ → ~4 ครั้ง/วินาที เห็นชัดว่าต่างจากไฟปกติ (1 ครั้ง/วินาที)
volatile uint32_t identifyUntilMs = 0;
uint32_t identifyLastToggleMs = 0;
bool     identifyLedOn = false;

volatile bool needsRestart = false;

// ──────────────────────────────────────────────────────────
// Self-heal watchdogs — สำหรับอาการ "บอร์ดติด/เชื่อมต่อได้ แต่ไม่ส่งข้อมูล"
//   • link watchdog : esp_now_send ล้มเหลวติดกันนานๆ → ตั้ง peer ใหม่ → ยังไม่หาย → รีบูตเอง
//   • sensor watchdog: อ่าน BMI160 ไม่ได้เลยเป็นช่วงยาว → init เซนเซอร์ใหม่ → ยังไม่หาย → รีบูตเอง
// ทั้งคู่ทำงานเองโดยไม่ต้องรอคำสั่งจาก Main Node (เผื่อกรณีที่รับคำสั่งไม่ได้ด้วย)
// ──────────────────────────────────────────────────────────
#define LINK_RECOVER_MS   5000    // ส่งไม่สำเร็จต่อเนื่องเท่านี้ → ตั้ง peer ใหม่
#define LINK_REBOOT_MS   20000    // ยังไม่หายอีก → รีบูต
#define SENSOR_RECOVER_MS 3000    // อ่าน IMU ไม่ได้เลยเท่านี้ → init BMI160 ใหม่
#define SENSOR_REBOOT_MS 15000    // ยังไม่หายอีก → รีบูต

// ⚠ จำกัดจำนวนรีบูต! ถ้าเซนเซอร์เสียจริง การรีบูตไม่รู้จบจะทำให้โหนด
// "หายไปเลย" จาก dashboard — แย่กว่าปล่อยให้ออนไลน์แล้วโชว์ธงว่าเซนเซอร์เสีย
// ครบโควตาแล้วจะหยุดรีบูต แต่ยังพยายาม init เซนเซอร์ใหม่เรื่อยๆ และรายงานขึ้น dashboard
#define WDT_MAX_REBOOTS      3
#define WDT_HEALTHY_RESET_MS 60000   // ทำงานปกติต่อเนื่องเท่านี้ → คืนโควตารีบูตให้ใหม่

// ตัวนับต้องอยู่รอดข้าม ESP.restart() ไม่งั้นโควตาจะกลับเป็น 0 ทุกครั้งที่บูต
// แล้ววนรีบูตไม่รู้จบเหมือนไม่มีลิมิตเลย (เจอจริงตอนทดสอบ: ขึ้น "(1/3)" ซ้ำๆ ทุกรอบ)
// ⚠ ต้องใช้ RTC_NOINIT_ATTR ไม่ใช่ RTC_DATA_ATTR — เพราะ .rtc.data ถูกโหลดค่าเริ่มต้น
//    จาก image ใหม่ทุกครั้งที่บูต ส่วน .rtc.noinit ไม่ถูกแตะ
// ค่าเริ่มต้นตอน power-on เป็นขยะ จึงต้องมี magic ตรวจความถูกต้อง
#define WDT_RTC_MAGIC 0x5751DEAD
RTC_NOINIT_ATTR uint32_t g_wdtMagic;
RTC_NOINIT_ATTR uint8_t  g_sensorReboots;
RTC_NOINIT_ATTR uint8_t  g_linkReboots;

// ตัวนับวินิจฉัย I2C — ใช้หาว่าเซนเซอร์อ่านพลาดจริงแค่ไหน แทนการเดา
volatile uint32_t g_i2cOk = 0, g_i2cFail = 0, g_i2cBusy = 0;

volatile uint32_t lastTxOkMs     = 0;   // ส่ง ESP-NOW สำเร็จครั้งล่าสุด
volatile uint32_t lastImuReadMs  = 0;   // อ่าน BMI160 ครบ 12 ไบต์ครั้งล่าสุด
uint32_t lastLinkRecoverMs   = 0;
uint32_t lastSensorRecoverMs = 0;
uint32_t sensorHealthySinceMs = 0;
uint32_t linkHealthySinceMs   = 0;

// รายงานสถานะสุขภาพขึ้น Main Node ผ่านฟิลด์ reserved ของ NodeStatusPacket
// (เฟิร์มแวร์เก่าส่ง 0 = ไม่มี fault → เข้ากันได้ทั้งสองทาง ไม่ต้องขึ้นเวอร์ชัน protocol)
#define NODE_FLAG_SENSOR_FAULT 0x0001
#define NODE_FLAG_LINK_FAULT   0x0002
#define NODE_FLAG_BATT_UNWIRED 0x0004   // อ่านแรงดันแบตไม่ได้ (ยังไม่ต่อ divider / ขาลอย)
// bit 4-15 = แรงดันแบต หน่วย 4 mV (0–16380 mV) — ให้ dashboard โชว์เป็นโวลต์ได้
#define NODE_BATT_MV_SHIFT     4
volatile uint16_t g_healthFlags = 0;

// --- BMI160 Helpers ---
void writeBmi160(uint8_t reg, uint8_t val) {
  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  Wire.beginTransmission(BMI160_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
  xSemaphoreGive(i2cMutex);
}

uint8_t readBmi160(uint8_t reg) {
  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  Wire.beginTransmission(BMI160_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)BMI160_ADDR, (uint8_t)1);
  uint8_t val = Wire.available() ? Wire.read() : 0;
  xSemaphoreGive(i2cMutex);
  return val;
}

bool initBMI160() {
  // retry อ่าน CHIP_ID กันสัมผัส/บัสยังไม่นิ่งตอน boot
  uint8_t chipId = 0;
  for (int r = 0; r < 8; r++) {
    chipId = readBmi160(BMI160_REG_CHIPID);
    if (chipId == 0xD1 || chipId == 0xD8) break;   // 0xD1=BMI160 · 0xD8=BMX160
    delay(25);
  }
  // โมดูลที่ใช้จริงเป็น BMX160 (id 0xD8) — register accel/gyro เหมือน BMI160 ทุกอย่าง
  if (chipId != 0xD1 && chipId != 0xD8) {
    Serial.printf("IMU not found! CHIP_ID: 0x%02X (want 0xD1/0xD8)\n", chipId);
    return false;
  }
  Serial.printf("IMU OK: CHIP_ID=0x%02X (%s)\n", chipId, chipId == 0xD8 ? "BMX160" : "BMI160");

  // Soft reset ก่อน แล้วรอให้ชิปพร้อม (เคลียร์สถานะค้าง)
  writeBmi160(BMI160_REG_PMU_CMD, 0xB6);
  delay(100);

  // ⚠ อย่าใส่ softreset (PMU_CMD 0xB6) ตรงนี้ — ลองแล้ววัดผลจริงบนโหนดตัวที่ 4:
  //   ไม่มี softreset = พลาดครั้งเดียวตอนบูตแรกแล้วทำงานปกติยาว
  //   มี  softreset   = อ่านเซนเซอร์ไม่ได้ "ทุกครั้ง" จนวนรีบูต
  // แม้จะเป็นท่ามาตรฐานตาม datasheet แต่กับบอร์ดชุดนี้ทำให้แย่ลงชัดเจน

  // Power up Accel and Gyro (Normal mode)
  writeBmi160(BMI160_REG_PMU_CMD, 0x11); // Accel normal
  delay(10);
  writeBmi160(BMI160_REG_PMU_CMD, 0x15); // Gyro normal
  delay(80);                             // gyro start-up ใช้เวลาถึง ~80 ms (เดิมรอ 50 ms สั้นไป)

  // Config Accel: 800Hz ODR, Normal (0x0B)
  writeBmi160(BMI160_REG_ACC_CONF, 0x2B);
  // Config Gyro: 800Hz ODR, Normal (0x0B)
  writeBmi160(BMI160_REG_GYR_CONF, 0x2B);

  // Range Accel: ±16g (0x0C)
  writeBmi160(BMI160_REG_ACC_RANG, 0x0C);
  // Range Gyro: ±2000 dps (0x00)
  writeBmi160(BMI160_REG_GYR_RANG, 0x00);

  // ยืนยันว่าทั้ง accel และ gyro เข้าโหมด normal จริง (PMU_STATUS 0x03: acc=bit5:4, gyr=bit3:2)
  // แค่เตือน ไม่ return false — ปล่อยให้ watchdog จัดการ ดีกว่าตกไปโหมด mock เงียบๆ
  const uint8_t pmu = readBmi160(0x03);
  const bool accOk = ((pmu >> 4) & 0x03) == 0x01;
  const bool gyrOk = ((pmu >> 2) & 0x03) == 0x01;
  if (!accOk || !gyrOk) {
    Serial.printf("[BMI160] เตือน: PMU_STATUS=0x%02X (acc=%d gyr=%d) ยังไม่เข้าโหมด normal\n",
                  pmu, (int)accOk, (int)gyrOk);
  }
  return true;
}

// ── ตั้งค่า BMX160 any-motion interrupt ──
// เรียกหลัง initBMI160 (ตอน timer 400Hz ยังไม่เริ่ม = ไม่มีใครแย่ง I2C)
void configureAnyMotion() {
  writeBmi160(BMX_REG_INT_MOTION1, MOTION_THRESH);       // threshold
  writeBmi160(BMX_REG_INT_MOTION0, MOTION_DUR & 0x03);   // duration
  writeBmi160(BMX_REG_INT_EN0,     0x07);                // เปิด anymotion x/y/z
  // map anymotion → ทั้ง INT1 และ INT2 (กันโมดูลสลับ label INT1/INT2)
  writeBmi160(BMX_REG_INT_MAP0,    0x04);                // INT1
  writeBmi160(BMX_REG_INT_MAP2,    0x04);                // INT2
  // เปิด output ทั้ง INT1(0x0A) + INT2(0xA0) · push-pull active-high
  writeBmi160(BMX_REG_INT_OUT_CTRL, 0xAA);
  // latch ชั่วคราว ~1.28s (0x0D) เพื่อให้ INT_STATUS/pin ค้างพอให้ loop (poll ทุก 1s) อ่านทัน
  writeBmi160(BMX_REG_INT_LATCH,   0x0D);
  // readback ยืนยัน config ติดจริง (ควรได้ OUT_CTRL=0xAA MAP0=0x04 MAP2=0x04)
  uint8_t oc = readBmi160(BMX_REG_INT_OUT_CTRL);
  uint8_t m0 = readBmi160(BMX_REG_INT_MAP0);
  uint8_t m2 = readBmi160(BMX_REG_INT_MAP2);
  uint8_t en = readBmi160(BMX_REG_INT_EN0);
  uint8_t t1 = readBmi160(BMX_REG_INT_MOTION1);
  uint8_t pmu = readBmi160(0x03);  // PMU_STATUS: accel/gyro โหมด
  Serial.printf("[MOTION] readback EN0=0x%02X(ควร07) THR=0x%02X(ควร08) OUT_CTRL=0x%02X MAP0=0x%02X MAP2=0x%02X PMU=0x%02X\n",
                en, t1, oc, m0, m2, pmu);
}

// ── เข้า deep sleep แบบ wake-on-motion ──
// นิ่งเกิน MOTION_IDLE_MS → suspend gyro (ตัดตัวกินหลัก) → deep sleep · ปลุกด้วย GPIO3 HIGH (INT ตอนขยับ)
void enterMotionSleep() {
  Serial.println("[MOTION] 💤 นิ่งเกิน timeout → deep sleep (ขยับเพื่อปลุก)");
  Serial.flush();
  esp_timer_stop(sampleTimer);              // หยุด 400Hz timer ก่อนแตะ I2C
  writeBmi160(BMI160_REG_PMU_CMD, 0x14);    // gyro suspend (~900µA → µA) · anymotion เป็น accel ไม่กระทบ
  delay(50);
  // accel ยัง normal ไว้ (การันตี anymotion) · anymotion INT config ยังอยู่จาก configureAnyMotion
  digitalWrite(LED_PIN, LOW);
  esp_deep_sleep_enable_gpio_wakeup(1ULL << MOTION_INT_PIN, ESP_GPIO_WAKEUP_GPIO_HIGH);
  esp_deep_sleep_start();                    // ตื่นเมื่อ GPIO3=HIGH (ขยับ) → boot ใหม่ผ่าน setup()
}

// --- ESP-NOW Callbacks ---
void onDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  if (status == ESP_NOW_SEND_SUCCESS) {
    lastTxOkMs = millis();      // feeds the link watchdog in loop()
  } else {
    lostPackets++;
    // ห้าม Serial.print ที่นี่! callback นี้รันบน WiFi task — ถ้าไม่มีใครอ่าน USB
    // การพิมพ์จะบล็อกจนวิทยุค้างและยิ่งส่งไม่ออกหนักกว่าเดิม
  }
}

// ⚠ ลายเซ็นต้องตรงกับ esp32 core 3.x (เดิม cast จาก uint8_t* ซึ่งบังเอิญใช้ได้
//    เพราะ data/len อยู่ตำแหน่งเดิม แต่เป็น undefined behavior)
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len < 2 || data[0] != STRIKESENSE_PROTOCOL_VERSION) return;
  switch (data[1]) {
    case PKT_CMD_IDENTIFY:
      // 5 วินาที กะพริบถี่ — เดิม 1 วินาทีสั้นเกินจนหาตัวไม่ทัน
      identifyUntilMs = millis() + IDENTIFY_MS;
      break;
    case PKT_CMD_RESTART:
      needsRestart = true;
      break;
  }
}

// --- High Speed Timer Interrupt ---
void IRAM_ATTR sampleTimerCallback(void *arg) {
  if (sampleIndex == 0) {
    txPacket.firstTimestampUs = (uint32_t)esp_timer_get_time();
  }

  if (hasSensor) {
    // ⚠ ต้องใช้ xSemaphoreTake ธรรมดา ไม่ใช่ ...FromISR
    //   callback นี้ถูก dispatch แบบ ESP_TIMER_TASK = รันใน "task" ไม่ใช่ ISR
    //   การเรียก API ตระกูล FromISR จาก task จะไปยุ่งกับ interrupt mask ผิดวิธี
    //   และ FromISR ใช้กับ mutex (xSemaphoreCreateMutex) ไม่ได้อยู่แล้วเพราะเรื่อง
    //   priority inheritance → เป็นต้นเหตุที่ I2C ค้างเป็นช่วงๆ แบบเดาไม่ถูก
    //   timeout = 0 เพื่อไม่ให้ timer task ค้างรอ: อ่านไม่ทันรอบนี้ก็ข้ามไปรอบหน้า
    if (xSemaphoreTake(i2cMutex, 0) == pdTRUE) {
      Wire.beginTransmission(BMI160_ADDR);
      Wire.write(
          BMI160_REG_DATA); // Read 12 bytes from 0x0C (GyroX..Z, AccelX..Z)
      Wire.endTransmission(false);
      const uint8_t got = Wire.requestFrom((uint8_t)BMI160_ADDR, (uint8_t)12);

      if (got == 12) g_i2cOk++; else g_i2cFail++;   // วัดอัตราสำเร็จจริง
      if (Wire.available() == 12) {
        // Read Gyro (X, Y, Z)
        txPacket.samples[sampleIndex].gx = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].gy = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].gz = Wire.read() | (Wire.read() << 8);

        // Read Accel (X, Y, Z)
        txPacket.samples[sampleIndex].ax = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].ay = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].az = Wire.read() | (Wire.read() << 8);

        lastImuReadMs = millis();   // feeds the sensor watchdog in loop()
      }
      xSemaphoreGive(i2cMutex);
    } else {
      g_i2cBusy++;      // mutex ไม่ว่าง = มีคนอื่นถือบัสอยู่
    }
  } else {
    // Mock data for testing when sensor is not connected
    txPacket.samples[sampleIndex].gx = 0;
    txPacket.samples[sampleIndex].gy = 0;
    txPacket.samples[sampleIndex].gz = 0;
    txPacket.samples[sampleIndex].ax = 0;
    txPacket.samples[sampleIndex].ay = 0;
    txPacket.samples[sampleIndex].az = 2048; // 1G on Z axis
  }

  sampleIndex++;

  // Packet is full → copy to TX buffer + set flag (ห้ามเรียก esp_now_send ที่นี่!
  // มันจะรันใน esp_timer task ที่ stack เล็ก → WiFi stack ทำงาน → stack overflow → แครช)
  if (sampleIndex >= IMU_SAMPLES_PER_PACKET) {
    txPacket.sampleCount = IMU_SAMPLES_PER_PACKET;
    txPacket.seq = packetSequence++;

    if (!imuTxReady) {                 // ถ้า loop ยังส่งตัวเก่าไม่ทัน ก็ข้าม (กัน overwrite)
      memcpy(&imuTxBuf, &txPacket, sizeof(ImuBatchPacket));
      imuTxReady = true;
    } else {
      lostPackets++;                   // นับว่า drop เพราะ loop ส่งไม่ทัน
    }
    sampleIndex = 0;
  }
}

// ──────────────────────────────────────────────────────────
// Battery measurement
//   อ่าน ADC (calibrated) → Vbatt → % ตาม Li-ion discharge curve → EMA smooth
// ──────────────────────────────────────────────────────────

// Li-ion discharge curve (open-circuit voltage → %). เรียงจากเต็ม→หมด
// อ้างอิงเซลล์ 18650 / LiPo ทั่วไป ที่โหลดเบา
struct BatPoint { float v; uint8_t pct; };
static const BatPoint BAT_CURVE[] = {
  {4.20f, 100}, {4.10f, 95}, {4.00f, 85}, {3.90f, 75},
  {3.85f, 65}, {3.80f, 55}, {3.75f, 45}, {3.70f, 35},
  {3.65f, 25}, {3.60f, 18}, {3.50f, 10}, {3.40f, 5},
  {3.30f, 2},  {3.00f, 0},
};
static const int BAT_CURVE_N = sizeof(BAT_CURVE) / sizeof(BAT_CURVE[0]);

static float    g_battEma      = -1.0f; // -1 = ยังไม่ได้ seed
static uint32_t lowBattSinceMs = 0;     // เวลาที่แบตเริ่มต่ำ (0 = ปกติ)

// อ่านแรงดันแบตจากขาที่ระบุ (V) — analogReadMilliVolts ชดเชย ADC nonlinearity จาก eFuse
static float readVoltageOn(uint8_t pin) {
  uint32_t mv = 0;
  for (int i = 0; i < BAT_SAMPLES; i++) mv += analogReadMilliVolts(pin);
  mv /= BAT_SAMPLES;
  return (mv / 1000.0f) * BAT_DIV_RATIO; // Vout → Vbatt
}

// ทดสอบว่าขานี้ต่อ divider จริงหรือลอยอยู่ — ใช้วิธี "คายประจุแล้ววัด"
//
// ⚠ ดูค่าว่าอยู่ในช่วงสมเหตุสมผลอย่างเดียว "ไม่พอ" — วัดจริงบนบอร์ดชุดนี้แล้วเจอว่า
// ขาที่ลอยอยู่ค้างประจุอ่านได้ 4.2-4.4V นิ่งๆ ได้หลายนาที (เหมือนแบตเต็ม)
// ดังนั้นเกณฑ์ "ค่านิ่ง" ก็หลอกได้เหมือนกัน
//
// วิธีที่แยกออกจริง: ดึงขาลง GND ชั่วครู่ให้ประจุที่ค้างระบายทิ้ง แล้วปล่อยเป็น input
//   • ต่อ divider จริง → อิมพีแดนซ์ต่ำ (~50kΩ) ดันแรงดันกลับขึ้นมาทันที
//   • ขาลอย         → ไม่มีอะไรดันกลับ ค้างอยู่ใกล้ 0V
static bool probeBatPin(uint8_t pin, float& outV) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);           // คายประจุที่ค้างอยู่ทิ้ง
  delayMicroseconds(300);
  pinMode(pin, INPUT);
  analogSetPinAttenuation(pin, ADC_11db);
  delayMicroseconds(500);           // ให้ divider ดันแรงดันกลับ (RC ~ 50k×100nF ถ้ามี cap)
  outV = readVoltageOn(pin);
  return outV >= BAT_PLAUSIBLE_MIN_V && outV <= BAT_PLAUSIBLE_MAX_V;
}

// ไล่หาขาที่ต่อแบตอยู่จริง คืน true ถ้าเจอ
static bool findBatPin() {
  for (size_t i = 0; i < BAT_PIN_N; i++) {
    float v;
    if (probeBatPin(BAT_PINS[i], v)) {
      g_batPin = (int8_t)BAT_PINS[i];
      Serial.printf("[BATT] พบวงจรวัดแบตที่ GPIO%u (%.3f V)\n", BAT_PINS[i], v);
      return true;
    }
  }
  g_batPin = -1;
  return false;
}

// อ่านแรงดันแบตจากขาที่เลือกไว้ (V) · 0 = ยังไม่พบขาที่ต่ออยู่
float readBatteryVoltage() {
  if (g_batPin < 0) {
    // ยังไม่เจอ — ไล่หาใหม่เป็นระยะ เผื่อผู้ใช้เพิ่งเสียบแบต/บัดกรีสายเสร็จ
    if (millis() - g_batScanMs < BAT_RESCAN_MS) return 0.0f;
    g_batScanMs = millis();
    if (!findBatPin()) return 0.0f;
  }
  return readVoltageOn((uint8_t)g_batPin);
}

// แปลงแรงดัน → % โดย interpolate บน curve
uint8_t voltageToPct(float v) {
  if (v >= BAT_CURVE[0].v)             return 100;
  if (v <= BAT_CURVE[BAT_CURVE_N - 1].v) return 0;
  for (int i = 0; i < BAT_CURVE_N - 1; i++) {
    float vHi = BAT_CURVE[i].v, vLo = BAT_CURVE[i + 1].v;
    if (v <= vHi && v > vLo) {
      float t = (v - vLo) / (vHi - vLo); // 0..1 ภายในช่วง
      return (uint8_t)(BAT_CURVE[i + 1].pct + t * (BAT_CURVE[i].pct - BAT_CURVE[i + 1].pct) + 0.5f);
    }
  }
  return 0;
}

// อ่านแบต + ตรวจว่าวงจรต่อจริงหรือยัง
// คืนค่า % และเซ็ต g_battWired/g_battEma ให้ผู้เรียกใช้ต่อ
static bool g_battWired = false;

// ทดสอบขาที่กำลังใช้อยู่ซ้ำเป็นระยะ — เผื่อแบตถูกถอดออกระหว่างทาง
static bool batterySenseWired() {
  if (g_batPin < 0) return false;
  float v;
  return probeBatPin((uint8_t)g_batPin, v);
}

uint8_t readBatteryPct() {
  float v = readBatteryVoltage();

  // นอกช่วงที่เป็นไปได้ = ไม่ต้องเช็คต่อ ตัดจบเลย
  // อยู่ในช่วง = ยังต้องพิสูจน์ว่าไม่ใช่ขาลอยที่ค้างประจุ (ทดสอบทุก ~10 วิ ไม่เปลืองเวลา)
  static uint32_t lastProbeMs = 0;
  static bool     probedWired = false;
  if (v >= BAT_PLAUSIBLE_MIN_V && v <= BAT_PLAUSIBLE_MAX_V) {
    if (lastProbeMs == 0 || (int32_t)(millis() - lastProbeMs) > 10000) {
      lastProbeMs = millis();
      probedWired = batterySenseWired();
      if (probedWired) v = readBatteryVoltage();   // อ่านใหม่หลังทดสอบ
    }
    if (!probedWired) v = 0.0f;                    // ขาลอยที่ค้างประจุ → ถือว่าอ่านไม่ได้
  }

  // ขาลอย/ยังไม่ต่อ divider → ค่าจะหลุดช่วงที่เป็นไปได้ อย่าเดาเป็น % มั่ว
  if (v < BAT_PLAUSIBLE_MIN_V || v > BAT_PLAUSIBLE_MAX_V) {
    if (g_batPin >= 0) {
      // เคยเจอขาแล้วแต่ตอนนี้อ่านไม่ได้ = ถอดแบต/สายหลุด → กลับไปไล่หาใหม่
      Serial.printf("[BATT] GPIO%d อ่านไม่ได้แล้ว (%.2f V) — จะไล่หาขาใหม่\n", g_batPin, v);
      g_batPin    = -1;
      g_batScanMs = millis();
    }
    g_battWired = false;
    g_battEma   = -1.0f;      // ล้าง EMA ไว้ seed ใหม่เมื่อต่อวงจรแล้ว
    return 0;
  }
  g_battWired = true;

  // EMA smoothing — ครั้งแรก seed ด้วยค่าจริงเลย
  if (g_battEma < 0.0f) g_battEma = v;
  else                  g_battEma = g_battEma * (1.0f - BAT_EMA_ALPHA) + v * BAT_EMA_ALPHA;
  return voltageToPct(g_battEma);
}

// ──────────────────────────────────────────────────────────
// Deep sleep helper
// ──────────────────────────────────────────────────────────
// แกนกลาง: กระพริบ LED → เข้า deep sleep
// wakeMask = บิตของ GPIO ที่จะใช้ปลุก · mode = ปลุกตอน LOW หรือ HIGH
// หมายเหตุ: ESP32-C3 ปลุกจาก deep sleep ได้เฉพาะ GPIO0–GPIO5 เท่านั้น
void enterDeepSleep(uint64_t wakeMask, esp_deepsleep_gpio_wake_up_mode_t mode) {
  Serial.flush();

  // กระพริบ LED 3 ครั้ง บอกว่ากำลังปิด
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, HIGH); delay(120);
    digitalWrite(LED_PIN, LOW);  delay(120);
  }
  delay(50);

  if (wakeMask) esp_deep_sleep_enable_gpio_wakeup(wakeMask, mode);
  esp_deep_sleep_start();   // ไฟดับจนกว่าจะมีขาใน mask เข้าสู่ระดับที่ตั้ง → boot ใหม่ผ่าน setup()
}

// ดับตอนชาร์จ — ตื่นด้วย 2 ทาง:
//   1) timer 3 วิ (ชัวร์เสมอ) → ตื่นมาเช็คว่าถอดสายยัง · ยังเสียบ→หลับต่อ · ถอด→ทำงาน
//   2) GPIO5 LOW (ถอดสาย) → ตื่นทันที (โบนัส ถ้า divider คายเร็วพอ)
// ใช้ timer เป็นหลักเพราะ GPIO-level wake บน C3 เปราะ (IN+ คายประจุช้า → ไม่ปลุก)
void powerOffForCharging() {
  Serial.println("[PWR] Charging -> sleep (ตื่นเช็คทุก 3 วิ + ถอดสาย)");
  esp_sleep_enable_timer_wakeup(3000000ULL);   // ปลุกทุก 3 วินาที (รับประกันตื่นเสมอ)
  enterDeepSleep(1ULL << CHG_SENSE_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
}

// ตัดไฟกันแบตเสื่อม (over-discharge) — แบตต่ำเกิน → deep sleep
// ตื่นเมื่อ "เสียบสายชาร์จ" (GPIO5 = HIGH) เพื่อให้กลับมาทำงานหลังชาร์จ
void powerOffLowBattery() {
  Serial.println("[PWR] LOW BATTERY -> deep sleep (กันแบตเสื่อม · เสียบชาร์จเพื่อปลุก)");
#if ENABLE_CHARGE_DETECT
  enterDeepSleep(1ULL << CHG_SENSE_PIN, ESP_GPIO_WAKEUP_GPIO_HIGH);
#else
  enterDeepSleep(0, ESP_GPIO_WAKEUP_GPIO_LOW); // ไม่มี wake source → หลับจนกว่าจะ power-cycle
#endif
}

// ──────────────────────────────────────────────────────────
// Charge detection (IN+ sense) — โหมดเลือกได้ที่ CHARGE_DEEP_SLEEP
//   1 = ดับจริง (deep sleep · ตื่นตอนถอดสาย)
//   0 = pause (หยุดส่งข้อมูล แต่ไม่หลับ · USB ไม่หลุด)
// ──────────────────────────────────────────────────────────
static uint32_t chgSinceMs   = 0;
static bool     chgWasActive = false;
volatile bool   g_charging   = false;   // true = กำลังชาร์จ → loop หยุดส่งข้อมูล

bool isPluggedIn() {
  return digitalRead(CHG_SENSE_PIN) == HIGH;   // มีไฟ 5V เข้า IN+ → divider ดัน HIGH
}

void checkCharging() {
  if (isPluggedIn()) {
    if (!chgWasActive) {
      chgSinceMs   = millis();
      chgWasActive = true;
    } else if (!g_charging && millis() - chgSinceMs >= CHG_HOLD_MS) {
      g_charging = true;
      Serial.println("[PWR] Charging -> PAUSE (หยุดส่งข้อมูล จนกว่าจะถอดสาย)");
    }
  } else {
    chgWasActive = false;
    if (g_charging) {
      g_charging = false;
      Serial.println("[PWR] Unplugged -> RESUME (กลับมาทำงาน)");
    }
  }
}

// ──────────────────────────────────────────────────────────
// กู้เซนเซอร์แบบปลอดภัย
//
// ⚠ เวอร์ชันก่อนหน้าเรียก Wire.end()/Wire.begin()/initBMI160() ตรงๆ จาก loop
//   "ขณะที่ timer 400Hz ยังอ่าน I2C อยู่" ผลคือ:
//     • รื้อ I2C peripheral ทิ้งกลางคัน → บัสค้าง → เซนเซอร์เงียบยิ่งกว่าเดิม
//       แล้ว watchdog ก็ยิงซ้ำ กลายเป็นวงจรที่ตัวกู้เป็นคนทำพังเอง
//       (= อาการ "⚠ เซนเซอร์ไม่ตอบสนอง ขึ้นบ่อย" หลังอัปเดตเฟิร์มแวร์)
//     • initBMI160() มี delay รวม ~90ms → บล็อก loop → ESP-NOW ไม่ได้ส่ง
//       และแพ็กเก็ต IMU ที่ timer เตรียมไว้ถูกทิ้ง = สัญญาณขาดเป็นช่วงๆ
//   จึงต้องหยุด timer ก่อนเสมอ แล้วค่อยแตะ I2C
// ──────────────────────────────────────────────────────────
void reinitSensorSafely() {
  esp_timer_stop(sampleTimer);          // ตัดผู้ใช้ I2C อีกทางออกก่อน

  xSemaphoreTake(i2cMutex, portMAX_DELAY);
  Wire.end();
  delay(5);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_FREQ);
  xSemaphoreGive(i2cMutex);

  hasSensor = initBMI160();             // ใช้ mutex ภายในเอง ตอนนี้ไม่มีคนแย่ง

  sampleIndex   = 0;                    // ทิ้งแพ็กเก็ตที่ค้างครึ่งๆ กลางๆ
  imuTxReady    = false;
  lastImuReadMs = millis();             // ให้เวลาตั้งตัวใหม่ ไม่ให้ watchdog ยิงซ้ำทันที

  esp_timer_start_periodic(sampleTimer, STRIKESENSE_SAMPLE_PERIOD_US);
}

// ──────────────────────────────────────────────────────────
// Watchdogs — เรียกทุก 1 วินาทีจาก loop()
// ──────────────────────────────────────────────────────────
// ⚠ ต้องเทียบเวลาแบบ "signed" เสมอ!
// lastTxOkMs / lastImuReadMs ถูกเขียนโดย task อื่น (send callback, timer 400Hz)
// ส่วน now อ่านมาตั้งแต่ต้น loop() → ค่าที่เขียนทีหลังอาจ "ล้ำหน้า" now ไป 1-2 ms
// ถ้าลบแบบ unsigned: 3161 - 3162 = -1 → วนกลับเป็น 4294967295 → มากกว่า threshold
// ทันที → watchdog ยิงมั่วทั้งที่ทุกอย่างปกติ (วัดได้จริง: อ่าน I2C สำเร็จ 400/400
// แต่ยังขึ้น "BMI160 เงียบ" ทุก 3 วินาที และ link watchdog ก็รีบูตตัวเองด้วยเหตุนี้)
static inline int32_t msSince(uint32_t now, uint32_t past) {
  return (int32_t)(now - past);
}

void checkLinkWatchdog(uint32_t now) {
  if (msSince(now, lastTxOkMs) < (int32_t)LINK_RECOVER_MS) {   // ยังส่งออกได้อยู่ = ปกติ
    g_healthFlags &= ~NODE_FLAG_LINK_FAULT;
    if (!linkHealthySinceMs) linkHealthySinceMs = now;
    else if (msSince(now, linkHealthySinceMs) > (int32_t)WDT_HEALTHY_RESET_MS) g_linkReboots = 0;
    return;
  }
  linkHealthySinceMs = 0;
  g_healthFlags |= NODE_FLAG_LINK_FAULT;             // โชว์ใน dashboard

  // ขั้นที่ 1: ตั้ง peer + channel ใหม่ (แก้ peer เสีย/ช่องสัญญาณเพี้ยน) — ทำซ้ำได้เรื่อยๆ
  if (msSince(now, lastLinkRecoverMs) >= (int32_t)LINK_RECOVER_MS) {
    lastLinkRecoverMs = now;
    Serial.println("[WDT] link เงียบ -> ตั้ง ESP-NOW peer + channel ใหม่");
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_channel(STRIKESENSE_ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
    esp_wifi_set_promiscuous(false);
    if (esp_now_is_peer_exist(targetAddress)) esp_now_del_peer(targetAddress);
    memcpy(peerInfo.peer_addr, targetAddress, 6);
    peerInfo.channel = STRIKESENSE_ESPNOW_CHANNEL;
    peerInfo.encrypt = false;
    esp_now_add_peer(&peerInfo);
  }

  // ⚠ ตั้งใจไม่รีบูตเพราะ link เงียบ
  // "ส่งไม่ออก" เกิดจาก Main Node ปิดอยู่ได้ง่ายๆ ซึ่งเป็นเรื่องปกติ (ปิดเครื่องพัก/ชาร์จ)
  // การรีบูตไม่ได้ช่วยให้ตัวแม่กลับมา แค่ทำให้โหนดทุกตัวรีบูตพร้อมกันทุก 20 วิ
  // เปล่าๆ — ทดสอบจริงแล้วเจอ (ขึ้น link=1/3 ทั้งที่ฮาร์ดแวร์ปกติดี)
  // การตั้ง peer/channel ใหม่ข้างบนคือสิ่งเดียวที่ช่วยได้จริง ทำพอแล้ว
}

void checkSensorWatchdog(uint32_t now) {
  if (!hasSensor) return;                              // โหมด mock — ไม่ต้องเฝ้า
  if (msSince(now, lastImuReadMs) < (int32_t)SENSOR_RECOVER_MS) {   // ยังอ่านได้ = ปกติ
    g_healthFlags &= ~NODE_FLAG_SENSOR_FAULT;
    if (!sensorHealthySinceMs) sensorHealthySinceMs = now;
    else if (msSince(now, sensorHealthySinceMs) > (int32_t)WDT_HEALTHY_RESET_MS) g_sensorReboots = 0;
    return;
  }
  sensorHealthySinceMs = 0;
  g_healthFlags |= NODE_FLAG_SENSOR_FAULT;             // โชว์ใน dashboard

  // ขั้นที่ 1: init เซนเซอร์ใหม่ (ต้องหยุด timer ก่อน — ดู reinitSensorSafely)
  if (msSince(now, lastSensorRecoverMs) >= (int32_t)SENSOR_RECOVER_MS) {
    lastSensorRecoverMs = now;
    Serial.printf("[WDT] BMI160 เงียบ %lu ms (now=%lu last=%lu) -> init ใหม่\n",
                  (unsigned long)(now - lastImuReadMs),
                  (unsigned long)now, (unsigned long)lastImuReadMs);
    reinitSensorSafely();
  }

  // ขั้นที่ 2: ยังไม่หาย -> รีบูต แต่ไม่เกินโควตา
  // ครบโควตาแล้วจะ "ไม่รีบูตอีก" โดยตั้งใจ: โหนดยังออนไลน์ ส่ง status ต่อ และติดธง
  // sensorFault ให้เห็นใน dashboard — ดีกว่าหายไปทั้งตัวเพราะวนรีบูตไม่รู้จบ
  if (msSince(now, lastImuReadMs) >= (int32_t)SENSOR_REBOOT_MS && g_sensorReboots < WDT_MAX_REBOOTS) {
    g_sensorReboots++;
    Serial.printf("[WDT] BMI160 ไม่ตอบสนอง -> รีบูตตัวเอง (%u/%u)\n",
                  g_sensorReboots, WDT_MAX_REBOOTS);
    Serial.flush();
    ESP.restart();
  }
}

void setup() {
#if ENABLE_CHARGE_DETECT && CHARGE_DEEP_SLEEP
  // ตื่นมาแล้วยังชาร์จอยู่? → หลับต่อทันที (ไม่ init WiFi/Serial = ไม่โผล่ใน dashboard + ไม่เปลืองบูต)
  pinMode(CHG_SENSE_PIN, INPUT);
  if (digitalRead(CHG_SENSE_PIN) == HIGH) {
    esp_sleep_enable_timer_wakeup(3000000ULL);
    esp_deep_sleep_enable_gpio_wakeup(1ULL << CHG_SENSE_PIN, ESP_GPIO_WAKEUP_GPIO_LOW);
    esp_deep_sleep_start();
  }
#endif

  Serial.begin(115200);
  // อย่าให้บรรทัด log บล็อก loop เมื่อไม่มีใครเปิด Serial monitor อยู่
  // (USB-CDC จะรอ host อ่าน → ค้างเป็นวินาที → ส่งข้อมูลไม่ทัน/หลุด)
  Serial.setTxTimeoutMs(0);
  delay(1000);

  Serial.println("\n=== Strike Node Starting ===");

  // คืนโควตารีบูตเมื่อ "เสียบไฟใหม่จริงๆ" เท่านั้น (หรือค่าใน RTC เป็นขยะตอน cold boot)
  // ถ้าตื่นมาจาก software reset ให้เก็บตัวนับเดิมไว้ — นั่นคือหัวใจของการกันวนรีบูต
  const esp_reset_reason_t rr = esp_reset_reason();
  if (g_wdtMagic != WDT_RTC_MAGIC || rr == ESP_RST_POWERON) {
    g_wdtMagic      = WDT_RTC_MAGIC;
    g_sensorReboots = 0;
    g_linkReboots   = 0;
  }
  Serial.printf("[WDT] reset_reason=%d · โควตารีบูตที่ใช้ไป sensor=%u/%u link=%u/%u\n",
                (int)rr, g_sensorReboots, WDT_MAX_REBOOTS, g_linkReboots, WDT_MAX_REBOOTS);

  // รายงานสาเหตุที่บูต (ตื่นจาก sleep vs เสียบไฟ/รีเซ็ต)
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_GPIO)
    Serial.println("[PWR] Woke from sleep (ถอดสายชาร์จ)");
  else
    Serial.println("[PWR] Cold boot (power/reset)");

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH); // On

#if ENABLE_CHARGE_DETECT
  // Charge-detect pin (IN+ sense) — INPUT ธรรมดา (ไม่เปิด pull-up, ให้ divider กำหนดระดับ)
  pinMode(CHG_SENSE_PIN, INPUT);
#endif

#if ENABLE_BATTERY
  // Battery ADC setup
  analogReadResolution(12);                          // 12-bit → 0–4095
  // attenuation ตั้งให้ทีละขาตอน probe (ADC_11db = ช่วง 0–2.45V พอสำหรับ Vout สูงสุด 2.1V)
  findBatPin();                                      // ไล่หาขาที่ต่อวงจรวัดแบตไว้
#endif

  // Setup Packet Header
  memset(&txPacket, 0, sizeof(ImuBatchPacket));
  txPacket.version = STRIKESENSE_PROTOCOL_VERSION;
  txPacket.type = PKT_IMU_BATCH;
  txPacket.samplePeriodUs = STRIKESENSE_SAMPLE_PERIOD_US;

  i2cMutex = xSemaphoreCreateMutex();

  // Setup I2C
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_FREQ);

  // I2C scanner — สแกนหาอุปกรณ์บนบัส (ช่วย debug ตอนหา BMI160 ไม่เจอ)
  Serial.println("[I2C] Scanning bus...");
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("[I2C]  พบอุปกรณ์ที่ 0x%02X\n", addr);
      found++;
    }
  }
  if (found == 0)
    Serial.println("[I2C]  ไม่พบอะไรเลย! → เช็คสาย: CS→3V3, SDA→8, SCL→9, VCC→3V3, pull-up");
  else
    Serial.printf("[I2C]  เจอทั้งหมด %d ตัว (BMI160 ควรเป็น 0x68 หรือ 0x69)\n", found);

  if (!initBMI160()) {
    Serial.println("BMI160 Init Failed! Bypassing for testing.");
    hasSensor = false;
  } else {
    Serial.println("BMI160 Initialized!");
    hasSensor = true;
  }

#if ENABLE_MOTION_WAKE
  pinMode(MOTION_INT_PIN, INPUT);        // รับ INT1
  if (hasSensor) configureAnyMotion();
  // วินิจฉัยขา GPIO3: สาย INT ถึงจริงไหม (ตอนบูตยังนิ่ง INT ควร idle-low)
  pinMode(MOTION_INT_PIN, INPUT_PULLUP);   delayMicroseconds(400);
  bool _pu = digitalRead(MOTION_INT_PIN);
  pinMode(MOTION_INT_PIN, INPUT_PULLDOWN); delayMicroseconds(400);
  bool _pd = digitalRead(MOTION_INT_PIN);
  pinMode(MOTION_INT_PIN, INPUT);
  Serial.printf("[MOTION] GPIO3 probe: pullup=%d pulldown=%d → %s\n", _pu, _pd,
                (_pu && !_pd) ? "ลอย (สายไม่ถึงขา INT!)"
              : (!_pu && !_pd) ? "ถูกดึงต่ำ (สายต่อ INT idle-low OK)"
              : "ถูกดันสูง");
  lastMotionMs = millis();
#endif

  // Setup WiFi & ESP-NOW
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  // ⭐ ปิด WiFi power save — สำคัญมาก!
  // ค่าเริ่มต้น STA จะเปิด modem sleep → วิทยุหลับเป็นช่วงๆ → ESP-NOW "ติดๆดับๆ"
  esp_wifi_set_ps(WIFI_PS_NONE);

  // TX power — หน่วย 0.25dBm · 84=21dBm(สุด/กินไฟ) · 68=17dBm · 60=15dBm · 52=13dBm
  // ขยับจาก 60→68 (+2dB ≈ กำลังส่ง 1.6 เท่า) เพื่อระยะและความนิ่งของสัญญาณที่ดีขึ้น
  // ⚠ ถ้าเจอโหนดรีบูตเองบ่อยตอนขยับแรงๆ = ไฟตก ให้ลดกลับเป็น 60
  esp_wifi_set_max_tx_power(ESPNOW_TX_POWER);

  // บังคับ Channel ให้ตรงกับตัวแม่ (1) โดยไม่ต้องเสียเวลาต่อ WiFi ให้ยุ่งยากและเสี่ยงค้าง
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(STRIKESENSE_ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);

  String mac = WiFi.macAddress();
  Serial.printf(">> MY MAC ADDRESS: %s <<\n", mac.c_str());
  Serial.printf(">> ESP-NOW CHANNEL: %d <<\n", STRIKESENSE_ESPNOW_CHANNEL);

  if (esp_now_init() != ESP_OK) {
    Serial.println("Error initializing ESP-NOW");
    return;
  }
  esp_now_register_send_cb((esp_now_send_cb_t)onDataSent);
  esp_now_register_recv_cb(onDataRecv);   // ลายเซ็นตรงแล้ว ไม่ต้อง cast

  // Register peer
  memcpy(peerInfo.peer_addr, targetAddress, 6);
  peerInfo.channel = STRIKESENSE_ESPNOW_CHANNEL;
  peerInfo.encrypt = false;
  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add peer");
    return;
  }

  // Send Hello Packet
  NodeHelloPacket hello;
  memset(&hello, 0, sizeof(hello));
  hello.version = STRIKESENSE_PROTOCOL_VERSION;
  hello.type = PKT_NODE_HELLO;
  hello.firmwareMajor = 0;
  hello.firmwareMinor = 1;
  WiFi.macAddress(hello.macAddr);
  esp_now_send(targetAddress, (uint8_t *)&hello, sizeof(hello));

  // Seed the watchdogs so a slow first packet doesn't look like a dead link.
  lastTxOkMs    = millis();
  lastImuReadMs = millis();

  // Setup 400Hz Timer
  const esp_timer_create_args_t timer_args = {
      .callback = &sampleTimerCallback,
      .arg = NULL,
      .dispatch_method = ESP_TIMER_TASK, // Execute in task context (allows I2C)
      .name = "sample_timer"};
  esp_timer_create(&timer_args, &sampleTimer);
  // 400Hz = 2500 us
  esp_timer_start_periodic(sampleTimer, STRIKESENSE_SAMPLE_PERIOD_US);

  Serial.println("Strike Node Ready! Sampling at 400Hz.");
}

void loop() {
  uint32_t now = millis();

#if ENABLE_CHARGE_DETECT
  // ตรวจการชาร์จ
  checkCharging();
  if (g_charging) {
  #if CHARGE_DEEP_SLEEP
    // ดับจริง — เข้า deep sleep · ตื่นเองเมื่อ GPIO5 = LOW (ถอดสาย)
    powerOffForCharging();
  #else
    // pause — หยุดส่งข้อมูล แต่ไม่หลับ (USB ไม่หลุด)
    imuTxReady = false;
    digitalWrite(LED_PIN, (millis() / 500) % 2); // กระพริบช้าๆ บอกว่ากำลังชาร์จ
    delay(20);
    return;
  #endif
  }
#endif

  if (needsRestart) {
    delay(500);
    ESP.restart();
  }

  // ระบุตัวเครื่อง — กะพริบถี่แบบไม่บล็อก ข้อมูล IMU ยังไหลต่อตามปกติ
  const bool identifying = (int32_t)(identifyUntilMs - now) > 0;
  if (identifying && now - identifyLastToggleMs >= IDENTIFY_PERIOD_MS) {
    identifyLastToggleMs = now;
    identifyLedOn = !identifyLedOn;
    digitalWrite(LED_PIN, identifyLedOn);
  }

  // ส่ง IMU batch ที่ timer เตรียมไว้ — ส่งจาก main task (stack ใหญ่ ปลอดภัย)
  if (imuTxReady) {
    esp_now_send(targetAddress, (uint8_t *)&imuTxBuf, sizeof(ImuBatchPacket));
    imuTxReady = false;
  }

  // Send Status Packet every 1 second
  if (now - lastStatusMs > 1000) {
    lastStatusMs = now;

    NodeStatusPacket st;
    memset(&st, 0, sizeof(st));
    st.version = STRIKESENSE_PROTOCOL_VERSION;
    st.type = PKT_NODE_STATUS;
    uint16_t battMv = 0;
#if ENABLE_BATTERY
    st.batteryPct = readBatteryPct(); // ADC (ขาที่ตรวจเจออัตโนมัติ) ผ่าน voltage divider
    if (g_battWired) {
      g_healthFlags &= ~NODE_FLAG_BATT_UNWIRED;
      battMv = (uint16_t)(g_battEma * 1000.0f + 0.5f);
    } else {
      g_healthFlags |= NODE_FLAG_BATT_UNWIRED;
      st.batteryPct = 0;              // 0% + ธง = "อ่านไม่ได้" ไม่ใช่ "แบตหมด"
    }
#else
    st.batteryPct = 100;              // hardcode (ยังไม่เปิดอ่านแบต)
#endif
    st.rssi = 0;         // Not available on TX only
    st.uptimeMs = now;
    st.lostPackets = lostPackets;
    // bit0 sensor fault · bit1 link fault · bit2 batt unwired · bit4-15 แรงดัน (mV/4)
    st.reserved = (uint16_t)(g_healthFlags & 0x000F)
                | (uint16_t)((battMv / 4) << NODE_BATT_MV_SHIFT);

    esp_now_send(targetAddress, (uint8_t *)&st, sizeof(st));

    // เฝ้าดูตัวเอง: ถ้าส่งไม่ออก หรือเซนเซอร์เงียบ ให้กู้คืน/รีบูตเองโดยไม่ต้องรอคน
    checkLinkWatchdog(now);
    checkSensorWatchdog(now);

#if ENABLE_BATTERY
    // อัตราการอ่าน IMU ต่อวินาที — ปกติต้องได้ ~400 ok / 0 fail
    // พิมพ์เฉพาะตอนผิดปกติ (เงียบ = สุขภาพดี) จะได้ไม่กิน serial เปล่าๆ
    if (g_i2cFail || g_i2cBusy || (hasSensor && g_i2cOk < 350)) {
      Serial.printf("[I2C] ok=%lu fail=%lu busy=%lu (ต่อวินาที · ปกติควรได้ ~400)\n",
                    (unsigned long)g_i2cOk, (unsigned long)g_i2cFail, (unsigned long)g_i2cBusy);
    }
    g_i2cOk = g_i2cFail = g_i2cBusy = 0;

    static uint32_t lastBattLogMs = 0;
    if (now - lastBattLogMs >= BATT_LOG_MS) {
      lastBattLogMs = now;
      if (g_battWired) Serial.printf("[BATT] %.3f V  ->  %u%%\n", g_battEma, st.batteryPct);
      else             Serial.printf("[BATT] อ่านไม่ได้ — ไม่พบวงจรวัดแบตที่ขา ADC ใดเลย (ลอง GPIO %d,%d,%d)\n",
                                     BAT_PINS[0], BAT_PINS[1], BAT_PINS[2]);
    }

  #if ENABLE_LOW_BATT_CUTOFF
    // ตัดไฟกันแบตเสื่อม — ทำเฉพาะเมื่อวงจรต่อจริงเท่านั้น ไม่งั้นขาลอยจะสั่งหลับถาวร
    if (g_battWired && g_battEma > 0.0f && g_battEma < LOW_BATT_CUTOFF_V) {
      if (lowBattSinceMs == 0) lowBattSinceMs = now;
      else if (now - lowBattSinceMs >= LOW_BATT_HOLD_MS) powerOffLowBattery();
    } else {
      lowBattSinceMs = 0;
    }
  #endif
#endif

#if ENABLE_CHARGE_DETECT
    // DEBUG: ดูสถานะขา charge-sense ทุกวินาที (เสียบสายควรเป็น HIGH)
    Serial.printf("[CHG] GPIO%d = %s\n", CHG_SENSE_PIN,
                  digitalRead(CHG_SENSE_PIN) ? "HIGH (เสียบอยู่)" : "LOW (ถอด/ลอย)");
#endif

#if ENABLE_MOTION_WAKE
    // ติดตามการเคลื่อนไหว (I2C any-motion + fast-poll GPIO3) → นิ่งเกิน timeout = หลับ
    {
      bool i2cMotion = hasSensor && (readBmi160(BMX_REG_INT_STATUS0) & 0x04);
      if (i2cMotion || g_intSeenHigh) lastMotionMs = now;
#if MOTION_VERBOSE
      Serial.printf("[MOTION] GPIO3 high-in-1s=%d (now=%s)  I2C=%s | az=%d ax=%d ay=%d\n",
                    g_intSeenHigh ? 1 : 0,
                    (digitalRead(MOTION_INT_PIN) == HIGH) ? "HIGH" : "low",
                    i2cMotion ? "motion" : "-",
                    txPacket.samples[0].az, txPacket.samples[0].ax, txPacket.samples[0].ay);
#endif
      g_intSeenHigh = false;
#if MOTION_DEEP_SLEEP
      if (hasSensor && (uint32_t)msSince(now, lastMotionMs) > MOTION_IDLE_MS)
        enterMotionSleep();
#endif
    }
#endif

    // ไฟหัวใจ 1 ครั้ง/วินาที — เว้นไว้ตอนกำลังกะพริบระบุตัว ไม่งั้นจะไปแย่งจังหวะกัน
    if (!identifying) digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }

#if ENABLE_MOTION_WAKE
  if (digitalRead(MOTION_INT_PIN) == HIGH) g_intSeenHigh = true;   // fast-poll จับ pulse INT (~ทุก 1ms)
#endif

  delay(1);   // เร็วพอ service IMU buffer (50 packet/s) · ปล่อย CPU ให้ WiFi/idle ทำงาน
}
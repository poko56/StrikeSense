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
#define ENABLE_CHARGE_DETECT  0   // 1 = เปิดตรวจชาร์จ (GPIO5 ต่อ divider จาก IN+ แล้ว) · 0 = ปิด (dev/ยังไม่ต่อ GPIO5)
#define ENABLE_BATTERY        0   // 1 = อ่านแบตจริง (GPIO4 ต่อ divider แล้ว) · 0 = ส่ง 100% เหมือนโค้ดเดิม

// โหมดตอนชาร์จ:  1 = ดับจริง (deep sleep, ตื่นตอนถอดสาย)  ·  0 = pause (หยุดส่งแต่ไม่หลับ)
// ⚠ deep sleep: USB/COM จะหลุดตอนหลับ (ปกติ) → ทดสอบด้วยแบต ดูผลผ่าน dashboard
// ⚠ ต้องแก้ฮาร์ดแวร์ให้ IN+ คายประจุเร็ว (divider 10k/15k) ไม่งั้น "ถอดแล้วไม่ตื่น"
#define CHARGE_DEEP_SLEEP     0   // 0 = pause (ไม่หลับ USB ไม่หลุด เหมาะ dev) · 1 = deep sleep (เฉพาะใช้แบตจริง)

// --- Battery ADC ---
// วงจร: BAT+ ─ R1(100kΩ) ─ GPIO4 ─ R2(100kΩ) ─ GND   (+ cap 100nF จาก GPIO4 → GND กัน noise)
// Vout = Vbatt / 2  →  Vbatt=4.2V จะได้ 2.1V เข้า ADC (ปลอดภัยต่อชิป 3.3V)
#define BAT_PIN        4      // GPIO4 (เปลี่ยนได้ถ้าต่อขาอื่นที่เป็น ADC)
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

volatile int identifyBlinkCount = 0;
volatile bool needsRestart = false;

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
  uint8_t chipId = readBmi160(BMI160_REG_CHIPID);
  if (chipId != 0xD1) {
    Serial.printf("BMI160 not found! CHIP_ID: 0x%02X\n", chipId);
    return false;
  }

  // Power up Accel and Gyro (Normal mode)
  writeBmi160(BMI160_REG_PMU_CMD, 0x11); // Accel normal
  delay(5);
  writeBmi160(BMI160_REG_PMU_CMD, 0x15); // Gyro normal
  delay(50);

  // Config Accel: 800Hz ODR, Normal (0x0B)
  writeBmi160(BMI160_REG_ACC_CONF, 0x2B);
  // Config Gyro: 800Hz ODR, Normal (0x0B)
  writeBmi160(BMI160_REG_GYR_CONF, 0x2B);

  // Range Accel: ±16g (0x0C)
  writeBmi160(BMI160_REG_ACC_RANG, 0x0C);
  // Range Gyro: ±2000 dps (0x00)
  writeBmi160(BMI160_REG_GYR_RANG, 0x00);

  return true;
}

// --- ESP-NOW Callbacks ---
void onDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
    lostPackets++;
    Serial.println("[DEBUG TX] Send Failed!");
  }
}

void onDataRecv(const uint8_t *mac_addr, const uint8_t *data, int len) {
  if (len < 2 || data[0] != STRIKESENSE_PROTOCOL_VERSION) return;
  switch (data[1]) {
    case PKT_CMD_IDENTIFY:
      identifyBlinkCount = 20; // 20 toggles = 10 blinks
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
    if (xSemaphoreTakeFromISR(i2cMutex, NULL) == pdTRUE) {
      Wire.beginTransmission(BMI160_ADDR);
      Wire.write(
          BMI160_REG_DATA); // Read 12 bytes from 0x0C (GyroX..Z, AccelX..Z)
      Wire.endTransmission(false);
      Wire.requestFrom((uint8_t)BMI160_ADDR, (uint8_t)12);

      if (Wire.available() == 12) {
        // Read Gyro (X, Y, Z)
        txPacket.samples[sampleIndex].gx = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].gy = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].gz = Wire.read() | (Wire.read() << 8);

        // Read Accel (X, Y, Z)
        txPacket.samples[sampleIndex].ax = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].ay = Wire.read() | (Wire.read() << 8);
        txPacket.samples[sampleIndex].az = Wire.read() | (Wire.read() << 8);
      }
      xSemaphoreGiveFromISR(i2cMutex, NULL);
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

// อ่านแรงดันแบตจริง (V) — ใช้ analogReadMilliVolts ซึ่งชดเชย ADC nonlinearity จาก eFuse
float readBatteryVoltage() {
  uint32_t mv = 0;
  for (int i = 0; i < BAT_SAMPLES; i++) mv += analogReadMilliVolts(BAT_PIN);
  mv /= BAT_SAMPLES;
  return (mv / 1000.0f) * BAT_DIV_RATIO; // Vout → Vbatt
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

uint8_t readBatteryPct() {
  float v = readBatteryVoltage();
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
  delay(1000);

  Serial.println("\n=== Strike Node Starting ===");

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
  analogSetPinAttenuation(BAT_PIN, ADC_11db);        // ช่วง 0–2.45V (เพียงพอสำหรับ Vout สูงสุด 2.1V)
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

  // Setup WiFi & ESP-NOW
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  // ⭐ ปิด WiFi power save — สำคัญมาก!
  // ค่าเริ่มต้น STA จะเปิด modem sleep → วิทยุหลับเป็นช่วงๆ → ESP-NOW "ติดๆดับๆ"
  esp_wifi_set_ps(WIFI_PS_NONE);

  // TX power = 60 (15dBm) — สมดุลระหว่างกำลังส่ง vs ไฟกระชาก
  // หน่วย 0.25dBm · 84=21dBm(สุด/กินไฟ) · 60=15dBm(ปลอดภัย) · 52=13dBm(ประหยัด)
  // ถ้าไฟเลี้ยงนิ่ง (มี cap 470µF) เพิ่มเป็น 84 ได้
  esp_wifi_set_max_tx_power(60);

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
  esp_now_register_recv_cb((esp_now_recv_cb_t)onDataRecv);

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

  if (identifyBlinkCount > 0) {
    digitalWrite(LED_PIN, identifyBlinkCount % 2);
    identifyBlinkCount--;
    delay(50);
    return; // Skip normal loop to blink fast
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
#if ENABLE_BATTERY
    st.batteryPct = readBatteryPct(); // ADC GPIO4 via voltage divider
#else
    st.batteryPct = 100;              // hardcode เหมือนโค้ดเดิม (ยังไม่ต่อ divider)
#endif
    st.rssi = 0;         // Not available on TX only
    st.uptimeMs = now;
    st.lostPackets = lostPackets;

    esp_now_send(targetAddress, (uint8_t *)&st, sizeof(st));

#if ENABLE_BATTERY
    Serial.printf("[BATT] %.3f V  ->  %u%%\n", g_battEma, st.batteryPct);
    // ตัดไฟกันแบตเสื่อม: แบตต่ำกว่า cutoff ต่อเนื่อง LOW_BATT_HOLD_MS → deep sleep
    if (g_battEma > 0.0f && g_battEma < LOW_BATT_CUTOFF_V) {
      if (lowBattSinceMs == 0) lowBattSinceMs = now;
      else if (now - lowBattSinceMs >= LOW_BATT_HOLD_MS) powerOffLowBattery();
    } else {
      lowBattSinceMs = 0;
    }
#endif

#if ENABLE_CHARGE_DETECT
    // DEBUG: ดูสถานะขา charge-sense ทุกวินาที (เสียบสายควรเป็น HIGH)
    Serial.printf("[CHG] GPIO%d = %s\n", CHG_SENSE_PIN,
                  digitalRead(CHG_SENSE_PIN) ? "HIGH (เสียบอยู่)" : "LOW (ถอด/ลอย)");
#endif

    // Blink LED
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }

  delay(1);   // เร็วพอ service IMU buffer (50 packet/s) · ปล่อย CPU ให้ WiFi/idle ทำงาน
}
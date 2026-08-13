// =============================================================================
// AP ALIVE TEST — ESP32-C3
// พิสูจน์ว่าบอร์ดรันโค้ดจริงไหม + เจอ BMI160 ไหม โดย "ไม่ต้องใช้ serial เลย"
// วิธี: ตรวจ BMI160 → เอาผลไปตั้งเป็นชื่อ WiFi AP → สแกน WiFi ด้วยมือถืออ่านชื่อ
//
// ── Arduino IDE ──  Board: ESP32C3 Dev Module · Upload
// ── อ่านผล: สแกน WiFi ด้วยมือถือ หา SSID ที่ขึ้นต้น "SS-C3-" ──
//   SS-C3-OK-SDA8SCL9-idD1   = ✅ บอร์ดรัน + เจอ BMI160 (แถมบอกคู่ขา+chip id)
//   SS-C3-NOBMI-bus0         = บอร์ดรัน แต่ไม่เจอ BMI (bus0 = ไม่มีอุปกรณ์ I2C เลย)
//   ไม่เห็น AP เลย            = บอร์ดไม่ได้รันโค้ด (ค้าง download / บอร์ดเสีย)
//
//   AP เป็นเน็ตเปิด (ไม่มีรหัส) แค่ดูชื่อพอ ไม่ต้องต่อ
// =============================================================================

#include <WiFi.h>
#include <Wire.h>

#define LED_PIN 8
#define I2C_FREQ 400000
#define REG_CHIPID 0x00

static uint8_t readChipId(uint8_t addr) {
  Wire.beginTransmission(addr);
  Wire.write(REG_CHIPID);
  if (Wire.endTransmission(false) != 0) return 0;
  Wire.requestFrom((uint8_t)addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}

static int scanCount() {
  int n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) n++;
  }
  return n;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(500);

  char ssid[33] = "SS-C3-NOBMI-bus0";
  bool found = false;

  // ลองทั้ง 2 คู่ขา (8/9 และ 9/8) × 2 address (0x69/0x68)
  const uint8_t pins[2][2] = {{8, 9}, {9, 8}};
  for (int p = 0; p < 2 && !found; p++) {
    Wire.end();
    Wire.begin(pins[p][0], pins[p][1], I2C_FREQ);
    Wire.setTimeOut(50);
    delay(20);
    int nbus = scanCount();
    for (uint8_t addr : {0x69, 0x68}) {
      uint8_t id = readChipId(addr);
      if (id == 0xD1) {
        snprintf(ssid, sizeof(ssid), "SS-C3-OK-SDA%dSCL%d-idD1", pins[p][0], pins[p][1]);
        found = true;
        break;
      }
    }
    if (!found) {
      // ยังไม่เจอ — อัปเดตชื่อให้บอกจำนวนอุปกรณ์บนบัส (คู่ขาล่าสุด)
      snprintf(ssid, sizeof(ssid), "SS-C3-NOBMI-bus%d", nbus);
    }
  }

  Serial.printf("SSID = %s\n", ssid);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(ssid);          // เน็ตเปิด ไม่มีรหัส
  Serial.printf("AP up: %s  IP=%s\n", ssid, WiFi.softAPIP().toString().c_str());
}

void loop() {
  // LED กะพริบเร็ว = บอร์ดยังรันอยู่ (สัญญาณเสริมนอกจาก AP)
  digitalWrite(LED_PIN, (millis() / 200) & 1);
  delay(20);
}

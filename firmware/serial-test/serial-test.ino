// =============================================================================
// SERIAL TEST — โค้ดโง่ๆ ที่สุด ไม่มี I2C/WiFi/ESP-NOW เลย
// เป้าหมาย: พิสูจน์ว่า ESP32-C3 print ออก serial ได้ไหม
//
// ── Arduino IDE ──
//   Board: "ESP32C3 Dev Module"
//   USB CDC On Boot: Enabled   ← สำคัญ
//   Upload → เปิด Serial Monitor 115200
//
// ── อ่านผล ──
//   • เห็น "hello 0, hello 1, ..." ไหลทุกครึ่งวิ = serial ใช้ได้! ✅
//   • serial เงียบ แต่ LED บนบอร์ดกะพริบ = โค้ดรัน แต่ USB CDC มีปัญหา
//   • serial เงียบ + LED ก็ไม่กะพริบ = บอร์ดไม่ได้รันโค้ด (ค้าง download?)
// =============================================================================

#include <Arduino.h>

#define LED_PIN 8   // LED ในตัวของ ESP32-C3 SuperMini อยู่ GPIO8

uint32_t n = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  delay(2000);                 // ให้ USB enumerate ทัน
  Serial.println();
  Serial.println("=== SERIAL TEST START ===");
  Serial.println("ถ้าเห็นบรรทัดนี้ = serial ใช้ได้แล้ว!");
}

void loop() {
  digitalWrite(LED_PIN, n & 1);          // LED กะพริบ = โค้ดกำลังรัน (ดูได้แม้ serial เงียบ)
  Serial.print("hello ");
  Serial.println(n);
  n++;
  delay(500);
}

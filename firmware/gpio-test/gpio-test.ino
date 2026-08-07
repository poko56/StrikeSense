// GPIO8/9 line test — ไม่ใช้ I2C เลย
// ปล่อย 2 ขาเป็น INPUT (ลอย) → ให้ pull-up ภายนอกดึงขึ้น → อ่านว่าขึ้น 1 ไหม
//   ถ้าได้ 1 1 = สายว่าง+pull-up ทำงาน (ปัญหาเดิมคือบัส I2C ค้าง)
//   ถ้า SCL(9)=0 = มีอะไรกด SCL ลงต่ำจริง (ชิปเสีย/สายผิด)
#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  delay(600);
  Serial.println("\n=== GPIO8/9 LINE TEST (no I2C) ===");
  pinMode(8, INPUT);   // SDA
  pinMode(9, INPUT);   // SCL
}

void loop() {
  static uint32_t t = 0;
  if (millis() - t < 500) return;
  t = millis();
  Serial.printf("SDA(GPIO8)=%d   SCL(GPIO9)=%d   (ปกติควรได้ 1 1)\n",
                digitalRead(8), digitalRead(9));
}

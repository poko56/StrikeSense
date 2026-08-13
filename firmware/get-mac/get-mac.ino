#include <Arduino.h>
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  
  // รอให้ Serial พร้อม (สำหรับบอร์ดบางรุ่น)
  delay(2000); 

  Serial.println("\n==================================");
  Serial.println("   MAC Address Finder Tool");
  Serial.println("==================================");

  // เปิดใช้งาน WiFi เพื่อดึง MAC Address
  WiFi.mode(WIFI_MODE_STA);
  
  // ดึงค่า MAC Address ของบอร์ดนี้
  String mac = WiFi.macAddress();
  
  Serial.print(">> Your MAC Address is: ");
  Serial.println(mac);
  
  // ถ้าต้องการฟอร์แมตสำหรับเอาไปใส่ในโค้ด C++ ({0xAA, 0xBB, ...})
  uint8_t baseMac[6];
  WiFi.macAddress(baseMac);
  
  Serial.print(">> C++ Array Format:  {");
  for (int i = 0; i < 6; i++) {
    Serial.printf("0x%02X", baseMac[i]);
    if (i < 5) Serial.print(", ");
  }
  Serial.println("}");
  Serial.println("==================================\n");
}

void loop() {
  // พิมพ์เตือนทุกๆ 5 วินาที เผื่อผู้ใช้เปิด Serial Monitor ช้า
  delay(5000);
  Serial.print("MAC Address: ");
  Serial.println(WiFi.macAddress());
}

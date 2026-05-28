#include "../shared/protocol.h"
#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_now.h>
#include <esp_timer.h>
#include <esp_wifi.h>

// --- Configuration ---
#define I2C_SDA_PIN 8
#define I2C_SCL_PIN 9
#define I2C_FREQ 400000

#define BMI160_ADDR 0x69 // Default for DFRobot/Bosch, could be 0x68
#define LED_PIN 2

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

  // Packet is full, send via ESP-NOW
  if (sampleIndex >= IMU_SAMPLES_PER_PACKET) {
    txPacket.sampleCount = IMU_SAMPLES_PER_PACKET;
    txPacket.seq = packetSequence++;

    esp_now_send(targetAddress, (uint8_t *)&txPacket, sizeof(ImuBatchPacket));
    sampleIndex = 0;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n=== Strike Node Starting ===");

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH); // On

  // Setup Packet Header
  memset(&txPacket, 0, sizeof(ImuBatchPacket));
  txPacket.version = STRIKESENSE_PROTOCOL_VERSION;
  txPacket.type = PKT_IMU_BATCH;
  txPacket.samplePeriodUs = STRIKESENSE_SAMPLE_PERIOD_US;

  i2cMutex = xSemaphoreCreateMutex();

  // Setup I2C
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_FREQ);
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

  // Send Status Packet every 1 second
  if (now - lastStatusMs > 1000) {
    lastStatusMs = now;

    NodeStatusPacket st;
    memset(&st, 0, sizeof(st));
    st.version = STRIKESENSE_PROTOCOL_VERSION;
    st.type = PKT_NODE_STATUS;
    st.batteryPct = 100; // TODO: Implement battery reading
    st.rssi = 0;         // Not available on TX only
    st.uptimeMs = now;
    st.lostPackets = lostPackets;

    esp_now_send(targetAddress, (uint8_t *)&st, sizeof(st));

    // Blink LED
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }

  delay(10);
}
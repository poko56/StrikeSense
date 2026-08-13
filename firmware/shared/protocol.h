#pragma once
#include <stdint.h>
#include <stddef.h>

// StrikeSense ESP-NOW Protocol
// Shared between Strike Node (ESP32-C3) and Main Node (ESP32-S3)

#define STRIKESENSE_PROTOCOL_VERSION 1
#define STRIKESENSE_ESPNOW_CHANNEL   1
#define STRIKESENSE_SAMPLE_RATE_HZ   400
#define STRIKESENSE_SAMPLE_PERIOD_US 2500   // 1_000_000 / 400
#define IMU_SAMPLES_PER_PACKET       8      // 8 samples = 20ms window per packet

// Logical slot assigned to each Strike Node (mapped by Main Node).
// Node firmware itself is identity-less; Main Node maps MAC -> slot via Web UI.
enum NodeSlot : uint8_t {
    SLOT_UNASSIGNED = 0,
    SLOT_LEFT_HAND  = 1,
    SLOT_RIGHT_HAND = 2,
    SLOT_LEFT_SHIN  = 3,
    SLOT_RIGHT_SHIN = 4,
};

enum PacketType : uint8_t {
    PKT_IMU_BATCH   = 0x01,   // Strike -> Main : IMU sample batch
    PKT_NODE_HELLO  = 0x02,   // Strike -> Main : Announce on boot
    PKT_NODE_STATUS = 0x03,   // Strike -> Main : Periodic battery/uptime
    PKT_TIME_SYNC   = 0x80,   // Main -> Strike : Broadcast reference timestamp
    PKT_CMD_CONFIG    = 0x81,   // Main -> Strike : Update sample rate / sensor cfg
    PKT_CMD_IDENTIFY  = 0x82,   // Main -> Strike : Blink LED
    PKT_CMD_CALIBRATE = 0x83,   // Main -> Strike : Capture baseline offset
    PKT_CMD_RESTART   = 0x84,   // Main -> Strike : Reboot
};

// ---------- Raw sensor sample (12 bytes) ----------
// BMI160 raw int16 values. Conversion done at consumer side.
//   Accel: LSB = 1/2048 g  (range ±16g)
//   Gyro : LSB = 1/16.4 dps (range ±2000 dps)
typedef struct __attribute__((packed)) {
    int16_t ax, ay, az;
    int16_t gx, gy, gz;
} ImuSample;

// ---------- Strike Node -> Main Node ----------

// IMU batch packet : ~110 bytes total
typedef struct __attribute__((packed)) {
    uint8_t  version;           // STRIKESENSE_PROTOCOL_VERSION
    uint8_t  type;              // PKT_IMU_BATCH
    uint8_t  reserved;          // Padding for alignment
    uint8_t  sampleCount;       // <= IMU_SAMPLES_PER_PACKET
    uint32_t seq;               // Monotonic packet sequence (for loss detection)
    uint32_t firstTimestampUs;  // Strike Node local microseconds at first sample
    uint16_t samplePeriodUs;    // Period between samples (== STRIKESENSE_SAMPLE_PERIOD_US)
    uint16_t reserved2;
    ImuSample samples[IMU_SAMPLES_PER_PACKET];
} ImuBatchPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;              // PKT_NODE_HELLO
    uint8_t  firmwareMajor;
    uint8_t  firmwareMinor;
    uint8_t  macAddr[6];        // Self MAC for Main Node mapping UI
} NodeHelloPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;              // PKT_NODE_STATUS
    uint8_t  batteryPct;        // 0-100
    int8_t   rssi;              // ESP-NOW RX RSSI at last packet
    uint32_t uptimeMs;
    uint16_t lostPackets;       // Local counter
    uint16_t reserved;
} NodeStatusPacket;

// ---------- Main Node -> Strike Node ----------

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;              // PKT_TIME_SYNC
    uint8_t  reserved[2];
    uint32_t mainNodeTimestampMs;
} TimeSyncPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;              // PKT_CMD_CONFIG
    uint8_t  newSampleRateHz;   // 0 = keep current
    uint8_t  accelRangeG;       // 2/4/8/16, 0 = keep
    uint8_t  gyroRangeDps;      // 125/250/500/1000/2000 (encoded), 0 = keep
    uint8_t  reserved[3];
} ConfigCommandPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;
} SimpleCommandPacket;

// ---------- Helpers ----------

static inline bool isValidProtocolHeader(const uint8_t* data, size_t len) {
    return len >= 2 && data[0] == STRIKESENSE_PROTOCOL_VERSION;
}

# StrikeSense ESP-NOW Protocol — v1

ใช้ระหว่าง **Strike Node (ESP32-C3)** และ **Main Node (ESP32-S3)** ผ่าน ESP-NOW
ช่อง 1 (`STRIKESENSE_ESPNOW_CHANNEL`) เท่ากับ WiFi AP channel เพื่อไม่ให้เกิด channel switching

ดู `firmware/shared/protocol.h` สำหรับ definition จริง

## Bandwidth Budget

| Item | Value |
|------|-------|
| Sample rate | 400 Hz |
| Bytes/sample | 12 (6 axes × int16) |
| Samples/packet | 8 (= 20 ms window) |
| Packets/sec/Node | 50 |
| Payload/Node | ~5.5 KB/s = **44 kbps** |
| 2 Nodes total | **88 kbps** |

→ ESP-NOW practical limit ~250 kbps ในสภาวะดี → **มี headroom พอสมควร**

## Packet Types

| Type | Direction | Size | Purpose |
|------|-----------|------|---------|
| `PKT_IMU_BATCH` (0x01) | Strike → Main | 112 B | ส่ง 8 samples ของ IMU |
| `PKT_NODE_HELLO` (0x02) | Strike → Main | 10 B | Announce ตอน boot |
| `PKT_NODE_STATUS` (0x03) | Strike → Main | 12 B | Battery + uptime ทุก 5s |
| `PKT_TIME_SYNC` (0x80) | Main → Strike | 8 B | Sync timestamp |
| `PKT_CMD_CONFIG` (0x81) | Main → Strike | 8 B | Update config |

## IMU Batch Packet Layout (112 bytes)

```
offset  size  field
   0    1     version    (= 1)
   1    1     type       (= 0x01)
   2    1     reserved
   3    1     sampleCount  (≤ 8)
   4    4     seq        (uint32, packet sequence)
   8    4     firstTimestampUs (uint32, node local µs)
  12    2     samplePeriodUs   (= 2500)
  14    2     reserved2
  16   96     samples[8]  (ImuSample × 8, 12 B each)
```

### ImuSample (12 bytes, little-endian)
- `int16_t ax, ay, az` — accel raw, LSB = 1/2048 g (±16 g range)
- `int16_t gx, gy, gz` — gyro raw, LSB = 1/16.4 dps (±2000 dps range)

## Node Identity

Strike Node firmware ไม่ embed slot ลงตัว — Main Node เป็นผู้ map MAC → slot ผ่าน Web UI
`SLOT_UNASSIGNED` (0) เป็น default จนกว่า user จะกำหนดบน dashboard

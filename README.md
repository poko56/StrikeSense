# StrikeSense

ระบบเซนเซอร์ IoT สำหรับวัดและวิเคราะห์การออกอาวุธในกีฬามวยไทย แบบ Real-time

## Architecture

```
┌──────────────┐   ESP-NOW   ┌──────────────┐  WiFi AP   ┌──────────────┐
│  Strike Node │ ──400Hz──▶  │  Main Node   │ ─WebSocket▶│  Dashboard   │
│ ESP32-C3     │             │  ESP32-S3    │            │  (Browser)   │
│  + BMI160    │             │  + SD Card   │            └──────────────┘
└──────────────┘             │              │  ┌─────────────┐
       (×2)                  │              │─▶│  AI Team    │
                             └──────────────┘  │  (PC/Cloud) │
                                               └─────────────┘
```

## Project Structure

```
firmware/
  shared/         # Protocol header shared between nodes
  strike-node/    # ESP32-C3 + BMI160 firmware
  main-node/      # ESP32-S3 hub firmware + bundled dashboard (LittleFS)
dashboard/        # Web UI source (mirror of firmware/main-node/data)
tools/simulator/  # Fake Strike Node for testing without hardware
hardware/         # PCB + Enclosure files
docs/             # Protocol & API specs
```

## Status (Sprint S2 — Main Node Skeleton)

| Component | State |
|-----------|-------|
| Repo + Protocol | ✅ done |
| Main Node firmware skeleton | ✅ basic |
| Dashboard mockup | ✅ basic |
| Strike Node firmware | ⏳ blocked on BMI160 hardware |
| SD logger | ⏳ TODO |
| AI bridge | ⏳ TODO |
| Custom PCB | ⏳ TODO |

## Quick Start (Main Node)

```bash
cd firmware/main-node
pio run -t upload          # flash firmware
pio run -t uploadfs        # upload dashboard to LittleFS
pio device monitor
```

จากนั้นเชื่อม WiFi `StrikeSense` (pwd: `muaythai123`) แล้วเปิด http://192.168.4.1

## Docs

- [Protocol spec](docs/protocol.md)
- [API spec](docs/api.md)

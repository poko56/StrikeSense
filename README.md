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

เชื่อม Wi‑Fi `StrikeSense` (pwd: `muaythai123`) แล้วเปิด secure origin ตาม
[คู่มือ motion capture / HTTPS](docs/motion-capture-https.md):
`https://192.168.4.1` สำหรับ Local CA หรือ `https://<hostname>` สำหรับ
Let's Encrypt (ชื่อใน `/tls/hostname.txt`). URL นี้จำเป็นสำหรับกล้องโทรศัพท์และ
WSS. หาก rig ยังไม่มี certificate ใช้ HTTP ได้เฉพาะ dashboard legacy (ไม่มี
camera mode และไม่ใช่ transport ที่เข้ารหัส).

## Docs

- [Protocol spec](docs/protocol.md)
- [API spec](docs/api.md)
- [Motion capture + HTTPS/WSS](docs/motion-capture-https.md)

## เทรนโมเดลจับท่า

พาทำตั้งแต่ศูนย์ (เก็บข้อมูล → เทรน → อัปกลับเข้าเครื่อง):
[docs/เทรนโมเดล-มือใหม่.md](docs/%E0%B9%80%E0%B8%97%E0%B8%A3%E0%B8%99%E0%B9%82%E0%B8%A1%E0%B9%80%E0%B8%94%E0%B8%A5-%E0%B8%A1%E0%B8%B7%E0%B8%AD%E0%B9%83%E0%B8%AB%E0%B8%A1%E0%B9%88.md)

```bash
./ml_pipeline/retrain.sh
```

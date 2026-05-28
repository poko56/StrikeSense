# StrikeSense Main Node API

Base URL: `http://192.168.4.1` (Main Node AP IP, SSID `StrikeSense`)

## REST Endpoints

### `GET /api/status` — system + session snapshot
```json
{
  "uptimeMs": 123456,
  "heap":     180000,
  "psram":    8200000,
  "rx":       42180,
  "dropped":  3,
  "wsClients": 2,
  "session": {
    "active":     true,
    "id":         "1738291201",
    "startedAt":  100000,
    "durationMs": 23456,
    "packets":    1900,
    "samples":    15200
  },
  "sd": {
    "ready":  true,
    "cardMB": 14800,
    "usedMB": 12,
    "rows":   15200,
    "bytes":  1024000
  }
}
```

### `GET /api/nodes` — connected Strike Nodes
```json
[
  {
    "mac":           "AA:BB:CC:DD:EE:01",
    "slot":          1,
    "rssi":          -45,
    "lastSeenMs":    12300,
    "ageMs":         200,
    "batteryPct":    87,
    "nodeUptimeMs":  100000,
    "firmware":      256,
    "packetsRx":     5000,
    "lastSeq":       5000,
    "seqGaps":       2
  }
]
```
Slot values: `0=Unassigned, 1=LeftHand, 2=RightHand, 3=LeftShin, 4=RightShin`

### `POST /api/nodes/assign`
```json
{ "mac": "AA:BB:CC:DD:EE:01", "slot": 1 }
```

### `POST /api/session/start`
```json
{ "athlete": "demo" }
```
→
```json
{ "sessionId": "1738291201", "sdLogging": true }
```

### `POST /api/session/stop`
→ `{ "ok": true }`

### `GET /api/sessions` — list recorded sessions on SD
```json
[ { "id": "1738291201", "bytes": 1024000, "modTime": 1738291500 } ]
```

### `GET /api/sessions/{id}` — download CSV
- Content-Type: `text/csv`
- Content-Disposition: attachment
- Body: see CSV format below

### `DELETE /api/sessions/{id}` — remove a session file
→ `{ "ok": true }`

---

## WebSocket Stream (`/ws`)

Binary frames pushed by Main Node every time a Strike Node IMU batch arrives.

### Frame Format (16-byte header + 12 B × N samples)
```
offset  size  field
   0    1     msgType        (= 0x01 IMU_BATCH)
   1    1     slot           (NodeSlot)
   2    1     sampleCount    (1..8)
   3    1     rssi           (int8 dBm)
   4    4     seq            (uint32 LE — Strike Node sequence)
   8    4     recvTimestampMs (uint32 LE — Main Node millis)
  12    4     nodeTimestampUs (uint32 LE — Strike Node micros at first sample)
  16   12*N   samples        (int16 LE × 6 axes × N)
```

### Sample Decoding (JS)
```js
const ACCEL_LSB_PER_G  = 2048;
const GYRO_LSB_PER_DPS = 16.4;
for (let i = 0; i < sampleCount; i++) {
  const off = 16 + i*12;
  const ax = dv.getInt16(off,    true) / ACCEL_LSB_PER_G;
  // ...
}
```

### Sample Decoding (Python)
```python
import struct
header = struct.unpack('<BBBbIII', buf[:16])
msg, slot, n, rssi, seq, t_recv_ms, t_node_us = header
for i in range(n):
    ax,ay,az,gx,gy,gz = struct.unpack('<hhhhhh', buf[16+i*12 : 28+i*12])
    accel_g = (ax/2048, ay/2048, az/2048)
    gyro_dps = (gx/16.4, gy/16.4, gz/16.4)
```

---

## CSV Session Format

```
# StrikeSense session
# id=1738291201
# athlete=demo
# sample_rate_hz=400
# accel_scale=2048 lsb_per_g
# gyro_scale=16.4 lsb_per_dps
# columns: t_ms,slot,seq,sample_idx,ax,ay,az,gx,gy,gz
t_ms,slot,seq,sample_idx,ax,ay,az,gx,gy,gz
12,1,1,0,123,-456,16384,12,34,-78
14,1,1,1,125,-450,16380,11,30,-80
...
```

- `t_ms` — milliseconds since session start
- `slot` — body location (0..4)
- `seq` — Strike Node packet sequence (groups of 8 sample_idx)
- `ax..gz` — **raw int16** from BMI160 (apply scale factors above)

---

## AI Team Interface — two ways to consume data

### 1. Live API (real-time inference)
Connect to `ws://192.168.4.1/ws`, decode each binary frame, feed model.
Use during training-floor sessions for instant feedback.

### 2. Offline Export (training corpus)
```bash
# List sessions
curl http://192.168.4.1/api/sessions

# Download one session
curl -O http://192.168.4.1/api/sessions/1738291201
```
Use for model training, evaluation, and replay.

# StrikeSense — Feature Catalog

> สรุปฟีเจอร์ทั้งหมดของ Web Dashboard (เวอร์ชันปัจจุบัน · v0.2)
> Dashboard ฝัง PROGMEM อยู่ใน Main Node firmware · เปิดผ่าน `http://192.168.4.1`
> Dev mode: `cd dashboard && npm run dev` → `http://localhost:5173/?demo=1`

---

## ภาพรวม

Dashboard เป็น Single-Page App (Vite · vanilla JS · no framework) ที่:
1. รับ IMU แบบ binary 400 Hz จาก Strike Nodes ผ่าน WebSocket
2. ตรวจจับหมัด/เตะแบบ real-time ด้วย heuristic (threshold + refractory)
3. คำนวณ performance metrics และแสดงผลแบบ visual
4. คุม session recording, รอบ (round), markers
5. เรียก REST API ของ Main Node เพื่อ list/download/delete sessions

**Design**: "Fight Card" — ฟอนต์ Bebas Neue + IBM Plex Mono, สี ink/paper + accent แดง Muay Thai, hairline borders, asymmetric 3-rail layout — ไม่ใช่ generic glass-morphism dashboard

---

## 1 · Live Monitoring

| ฟีเจอร์ | รายละเอียด | ที่อยู่ |
|---------|-----------|--------|
| Connection pill | LIVE WS / OFFLINE / DEMO MODE — สีเขียว/แดง/น้ำเงิน | Topbar |
| Live IMU stream | ax, ay, az, gx, gy, gz ที่ 400 Hz แปลงเป็น g/°·s⁻¹ แล้ว | WebSocket frame |
| Sample rate วัดจริง | Hz วัดสด ทุก 1 วินาที | System tab |
| Bandwidth | kbps WS payload จริง | System tab |
| Sample latency check | recvTimestampMs ใน header เปรียบ wall clock | (เห็นใน packet) |
| RSSI ต่อ node | dBm + bar graph 4 ขั้น | Sensors tab |
| Battery % ต่อ node | bar + warning เมื่อ <20% | Sensors tab |
| WS clients ออนไลน์ | จำนวน clients ที่ดู dashboard | System tab |
| Uptime / Heap / PSRAM | จาก `/api/status` polling 1.5s | Topbar + System |

## 2 · Strike Detection & Analysis

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| Threshold detector | \|a\| > `thresholdG` (default 3.0g, ปรับได้ live) |
| Per-slot refractory | กันนับซ้ำ — default 250ms ปรับได้ |
| Heuristic classification | jab / cross / hook / uppercut / elbow / kick / roundhouse / knee / push |
| Per-strike data | id, slot, type, peakG, peakDps, recoverMs, sessionMs, round |
| Force histogram | 4 ช่วง: 1-3g / 3-5g / 5-10g / 10+g |
| Strike distribution | นับตาม type — bar graph เรียงจากมาก→น้อย |
| Sparkline ต่อ slot | canvas waveform 3 วินาทีล่าสุด พร้อมเส้น threshold |

## 3 · Body Diagram (Hit Zones)

| โหมด | รายละเอียด |
|------|-----------|
| **LIVE** | 4 zones (LH/RH/LS/RS) เปลี่ยนสีตามสถานะ: dim → assigned → live (cyan) → hit (flash แดง 250ms) |
| **HEATMAP** | สีแดงเข้ม 5 ระดับ ตามจำนวนหมัดสะสมต่อ slot |
| Click-to-assign | คลิก zone → assign node ว่างไปที่ slot นั้น (POST `/api/nodes/assign`) |
| Belt | แถบแดง muay thai ที่เอว — ไม่ใช่ interactive |

## 4 · Round Timer (Boxing Style)

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| Circular dial | SVG ring แสดง progress ของ phase ปัจจุบัน + tick countdown |
| Presets | 3×3 / 5×3 / 3×2 / 12×3 / Stopwatch (free) / Custom |
| Phases | idle → work → rest → work → ... → done — สลับอัตโนมัติ |
| Auto-rec | checkbox: เริ่ม REC ทุกครั้งที่เข้า work, หยุดเมื่อ done |
| Manual controls | RESET, SKIP, click dial = start |
| Stopwatch mode | นับขึ้น ไม่มีรอบ/พัก — สำหรับ shadow / freestyle |
| Visual rest indicator | สี dial เปลี่ยนเป็น amber ตอน rest |

## 5 · Session Recording

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| REC button | ปุ่มแดงใหญ่ใต้ dial — toggle start/stop |
| Athlete name | input + datalist เก็บ 10 ชื่อล่าสุด |
| Drill type | shadow / pad / bag / spar / free |
| Session timer | นับเวลาตั้งแต่เริ่ม (anchor จาก backend durationMs) |
| Coach markers | ปุ่ม `+ MARKER` (หรือกด M) ใส่ note timestamped |
| REC pill | บน topbar — STANDBY / REC LIVE / REST |
| SD logging status | warning toast ถ้า SD card ไม่พร้อม |

## 6 · Performance Metrics

| Metric | หน่วย | คำนวณจาก |
|--------|------|---------|
| **Peak G** | g | max ของ peak |
| **Avg G** | g | mean ของ peakG |
| **Strikes** | count | จำนวน strike |
| **SPM** (Strikes Per Minute) | /min | strikes / minutes since start |
| **Time-on-target** | % | % ของ 30s ล่าสุดที่ rms > threshold·0.25 |
| **Work** | kJ | Σ 0.5·m·v² (mass: arm 4kg / leg 12kg) |
| **Asymmetry L:R** | ratio + bar | leftCount / (left+right) |
| **Fatigue Index** | % + label | (first half avg - second half avg) / first |
| **Power CV** | % | std/mean ของ peakG (consistency) |
| **Session duration** | hh:mm:ss | wall - startedAtMs |

## 7 · Round-by-Round Summary

| ข้อมูลต่อยก | รายละเอียด |
|------------|-----------|
| Strikes | จำนวนหมัดในยกนั้น |
| Peak G | peak ของยก |
| Avg G | average ของยก |
| Fatigue % | decay ภายในยก (first half vs second half) |
| Asymmetry | L vs R ในยก |
| Current row | highlight ยกที่กำลัง work อยู่ (สีแดงอ่อน) |

## 8 · Session Timeline Strip

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| Horizontal strip | span = ระยะเวลา session (อย่างน้อย 60s) |
| Strike dots | แท่งแนวตั้ง สีตาม slot, ความสูงตาม peakG |
| Marker triangles | สีทอง — แสดง coach markers |
| Click strike → modal | เปิด detail modal ของหมัดนั้น + neighbours |
| Axis labels | 0:00 / mid / end |

## 9 · Strike Log

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| Columns | #, Time, Round, Slot, Type, Peak·g, ω·°/s, Recovery·ms |
| Filter chips | ALL / LH / RH / LS / RS (กดเลข 1-4 ก็ได้) |
| Newest flash | row ล่าสุดมี animation รัศมีแดง 1 วิ |
| Click → detail modal | drill-down รายตัว |
| Slot tag | สีแยก 4 slots (cyan/orange/green/purple) |
| Clear button | ล้าง log + reset counters |
| Max 80 rows displayed | rolling buffer 500 ใน state |

## 10 · Strike Detail Modal

| ข้อมูล | รายละเอียด |
|--------|-----------|
| Peak G, ω | ใหญ่เด่น |
| Slot | full name |
| Round | R1, R2, ... |
| Session time | hh:mm:ss ของหมัด |
| Recovery | ms ตั้งแต่หมัดก่อน |
| Neighbours | หมัด ±3 ใน slot เดียวกัน |

## 11 · Training Goals

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| Target strikes | ตั้งจำนวนหมัด (default 100) |
| Target peak G | peak ต่ำสุดที่ต้องทำ (default 8g) |
| Target SPM | (เก็บไว้, ใช้ขยายต่อ) |
| Progress bars | 2 แท่ง — strikes vs target, peak vs target |
| Goal status | %, "keep going", หรือ "✓ COMPLETED at hh:mm" |
| Auto-detect completion | log activity feed + lock until reset |

## 12 · Coach Markers

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| Add marker | ปุ่ม `+ MARKER` หรือกด M — prompt note |
| Display | บน timeline (triangle ทอง) + list ใน Sensors tab |
| Delete marker | ปุ่ม ✕ ในรายการ |
| Auto-label | "Round X · note" ถ้าไม่ใส่ |
| Session-relative time | hh:mm:ss นับจากเริ่ม session |

## 13 · Activity Feed

| Event | สี | ตัวอย่าง |
|-------|----|---------|
| REC start/stop | แดง | "▶ Recording started · 1738291201" |
| Round transition | แดง | "🥊 Round 2 · WORK" |
| Marker added | ทอง | "📍 Round 1 · note @ 45.2s" |
| Goal completed | เขียว | "🏆 Goal reached · 100 strikes" |
| Battery warning | amber | "🪫 Battery low: EE:01 18%" |
| Slot assign | แดง | "📍 EE:01 → Right Hand" |
| Relative time | — | "5s", "2m", "1h" |
| Cap 20 entries | — | rolling buffer |

## 14 · Sensors Management

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| Node card list | สด: เขียว | นิ่ง (>3s): แดง opacity 65% |
| MAC | full address |
| Slot dropdown | เปลี่ยน live → POST `/api/nodes/assign` |
| Signal | bar graph 4 ขั้น + dBm |
| Battery | bar (เขียว/amber/แดง) + % |
| RX / Gaps / FW | packets received, seq gaps, firmware version |
| Markers panel | (ใน tab เดียวกัน) |

## 15 · Session Library

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| List sessions | GET `/api/sessions` polling 8s |
| Search | filter by id substring |
| Stats summary | total count, total size, SD used/cap |
| Download CSV | `<a download>` → GET `/api/sessions/{id}` |
| Preview (VIEW) | modal: id, size, date, ปุ่ม download |
| Delete | confirm → DELETE `/api/sessions/{id}` |
| Compare 2 sessions | checkbox + COMPARE button → modal (id/size/date diff) |
| Sort | mod time descending |

## 16 · System & Diagnostics

| Section | รายละเอียด |
|---------|-----------|
| **Main Node** | IP, SSID, uptime, heap free, PSRAM free, WS clients |
| **ESP-NOW** | packets RX, dropped, sample rate Hz, bandwidth kbps |
| **Detection tuning** | slider threshold (1.5-10g), refractory (100-800ms) — บันทึก localStorage |
| **SD card** | progress bar + used/free MB, สีเปลี่ยนตาม % (>70 amber, >90 red) |
| **About** | build stamp, browser UA, dashboard version |

## 17 · UI Modes

| Mode | กดที่ | บันทึก |
|------|-------|--------|
| Theme dark/light | ◐ icon หรือ T | localStorage |
| Body live/heatmap | seg button หรือ H | localStorage |
| Fullscreen | ⛶ icon หรือ F | runtime + Fullscreen API |
| Stopwatch mode | MODE dropdown | localStorage |

## 18 · Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Space** | REC start/stop |
| **R** | Reset round timer |
| **S** | Skip phase |
| **M** | Add coach marker |
| **F** | Toggle fullscreen presentation |
| **H** | Toggle body heatmap |
| **T** | Toggle theme |
| **0** | Filter strike log: all slots |
| **1**–**4** | Filter strike log: slot 1-4 |
| **Esc** | Close modal |
| **?** หรือ **/** | Show shortcuts modal |

## 19 · Persistence (localStorage)

| Key | Value |
|-----|-------|
| `ss:theme` | 'dark' \| 'light' |
| `ss:tuning` | { thresholdG, refractoryMs } |
| `ss:goals` | { targetStrikes, targetPeakG, targetSpm } |
| `ss:athlete` | last athlete name |
| `ss:athleteHistory` | array of 10 recent names → datalist |
| `ss:drill` | last drill type |
| `ss:preset` | last round preset |
| `ss:modes` | { bodyHeatmap, stopwatch } |

## 20 · Demo / Simulator Mode

เปิด `?demo=1` ใน URL:
- สร้าง 4 fake nodes (LH/RH/LS/RS, battery 18-92%)
- 3 fake sessions ใน library
- Baseline noise ทุก 1 วินาที + strike สุ่มทุก 1.1 วินาที (peak 3.5-13g)
- API ทั้งหมด stub ด้วย demoApi
- ใช้ดูว่า UI ทำงานอย่างไรโดยไม่ต้องเสียบบอร์ด

---

## เทคโนโลยี

| Layer | ใช้ |
|-------|-----|
| Build | Vite 8 + `vite-plugin-singlefile` → ผลลัพธ์ 1 ไฟล์ HTML 88KB / gzip 24.5KB |
| Bundle to firmware | `dashboard/build-cpp.js` → `firmware/main-node/dashboard_ui.h` (PROGMEM string) |
| Frontend | Vanilla JS modules · no framework · ES2022 |
| Charts | SVG inline + Canvas 2D (sparklines) — ไม่ใช้ Chart.js/uPlot ใน build จริง |
| Modal | native `<dialog>` |
| Styling | Plain CSS · CSS variables theming · no SASS/Tailwind |
| Fonts | Bebas Neue, IBM Plex Mono, Inter (Google Fonts) |
| Storage | `localStorage` ตรงๆ (ผ่าน `persist.js` wrapper) |

### File structure

```
dashboard/
├── index.html              entry HTML (semantic + IDs ตรง JS)
├── style.css               design system "Fight Card" + light theme + fullscreen
├── build-cpp.js            post-build: ฝัง dist เข้า firmware header
├── vite.config.js          singleFile plugin
└── src/
    ├── main.js             entry — wires modules + persistence + keyboard
    ├── state.js            central state + subscribe / scheduleRender
    ├── api.js              REST wrapper (BASE = 192.168.4.1 บน localhost)
    ├── ws.js               binary frame decoder + reconnect backoff
    ├── analyzer.js         strike detect + metrics + per-round + markers
    ├── timer.js            round state machine + stopwatch
    ├── ui.js               render functions + DOM event wiring + modals
    ├── modal.js            native <dialog> helper
    ├── persist.js          localStorage wrapper
    └── demo.js             simulator + demoApi override
```

### REST endpoints used

| Method | Path | ใช้ทำอะไร |
|--------|------|----------|
| GET | `/api/status` | poll system + session snapshot (1.5s) |
| GET | `/api/nodes` | poll connected Strike Nodes (2s) |
| POST | `/api/nodes/assign` | assign slot {mac, slot} |
| POST | `/api/session/start` | start REC {athlete} → {sessionId, sdLogging} |
| POST | `/api/session/stop` | stop REC |
| GET | `/api/sessions` | list SD recordings (8s) |
| GET | `/api/sessions/{id}` | download CSV (text/csv attachment) |
| DELETE | `/api/sessions/{id}` | remove SD recording |
| WS | `/ws` | binary IMU frames (16 B header + 12 B × N samples) |

---

## ไม่รวม (intentionally skipped)

| ที่ตัด | เหตุผล |
|--------|--------|
| AI live classification / form score | จะใช้โมเดลจาก AI team ภายหลัง |
| Audio (bell, voice, beep) | user ระบุไม่ทำ |
| Identify LED blink / Restart node remote | ต้องเพิ่ม firmware endpoint ก่อน |
| OTA firmware update | ต้อง firmware support |
| Strike contact duration จริง | ต้องการ segment tracker ใน firmware |
| Polar chart / FFT / 3D trajectory | over-engineered สำหรับการใช้งานจริง |
| Multi-Main-Node management | scope สำหรับ 1 hub |
| Heart-rate sensor integration | ต้องการ external hardware |
| ระบบ multi-athlete พร้อมกัน | scope = 1 athlete per session |

---

## เวอร์ชัน

- **v0.1** — โครงสร้างพื้นฐาน · Premiere Pro-style UI · core polling + WS + REC
- **v0.2 (ปัจจุบัน)** — Rewrite "Fight Card" design · 16+ ฟีเจอร์ round 2:
  body diagram + heatmap, round timer, sparklines, markers, timeline strip,
  goals, per-round table, activity feed, compare, modals, persistence,
  keyboard, theme, fullscreen, stopwatch, demo mode

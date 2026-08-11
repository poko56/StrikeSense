# Motion capture over HTTPS / WSS

เอกสารนี้อธิบายการเตรียมโทรศัพท์และ SD card สำหรับ motion capture ของ
StrikeSense โดยกล้องโทรศัพท์จะประมวลผล MediaPipe ในเบราว์เซอร์และรวมผลกับ
IMU ผ่าน WebSocket ที่เข้ารหัสแล้ว

## Canonical address / URL หลัก

1. เชื่อมต่อ Wi-Fi ของ rig ตามปกติ
2. ถ้าใช้ Local CA ให้เปิด **`https://192.168.4.1/`** เป็น URL หลัก
3. ถ้าใช้ public CA/Let's Encrypt ให้เปิด **`https://<rig-hostname>/`**
   เช่น `https://rig.example.com/` — ห้ามเปิดด้วย IP address
4. Live IMU ใช้ WSS ของ URL เดียวกับ dashboard อัตโนมัติ

อย่าเปิด `http://192.168.4.1` เมื่อต้องใช้กล้อง: HTTP ไม่ใช่ secure context
และเบราว์เซอร์จะปฏิเสธ `getUserMedia()` หรือ WSS ที่ปะปนกับ HTTP ได้

> Server certificate ของ default setup ต้องมี SAN `IP:192.168.4.1`.
> จะใส่ `DNS:strikesense.local` เพิ่มได้ แต่ใช้ชื่อนี้เป็น URL ได้ต่อเมื่อ
> ทดสอบแล้วว่า DNS ของ AP ไม่ชนกับ `.local`/mDNS ของโทรศัพท์.

สำหรับ certificate ของ public CA ชื่อที่เปิดใน browser ต้องตรงกับ DNS SAN
ใน certificate เสมอ; certificate ของ `rig.example.com` จะไม่ใช้ได้กับ
`https://192.168.4.1/`.

## Trust the certificate / ความน่าเชื่อถือของ certificate

เลือกหนึ่งวิธีต่อไปนี้ก่อนเปิด camera mode:

| ทางเลือก | เหมาะกับ | สิ่งที่ต้องทำ |
| --- | --- | --- |
| **Local CA (แนะนำสำหรับ rig offline)** | ยิม/ทีมที่ใช้โทรศัพท์ชุดเดิม | สร้าง CA ภายใน, เซ็น server cert ที่มี SAN `IP:192.168.4.1`, แล้วติดตั้ง **CA certificate สาธารณะ** และเปิด trust บนโทรศัพท์แต่ละเครื่องหนึ่งครั้ง |
| **Public DNS + public CA** | มีโดเมนที่ควบคุมและ provisioning ผ่านอินเทอร์เน็ตได้ | ออก certificate จาก CA สาธารณะให้ hostname ที่เป็นเจ้าของ, ตั้ง AP DNS ให้ hostname นั้นชี้มาที่ rig, ใช้ hostname นั้นเป็น URL หลักของ deployment นั้น, และจัดการ renewal อย่างปลอดภัย |

ข้อสำคัญ:

- ห้ามใช้ self-signed certificate เป็นวิธีใช้งานปกติ: หน้าเตือน/การข้าม
  warning ไม่ใช่ workflow ที่เชื่อถือได้สำหรับกล้องบนมือถือ
- Local CA private key เป็นความลับระดับสูง: เก็บนอก rig, อย่าแจก, และอย่า
  ใส่ใน SD card
- Public CA จะไม่ออก certificate ให้ private address `192.168.4.1`; default
  IP URL จึงต้องใช้ Local CA. อย่าเปิด URL แบบ IP ด้วย certificate ที่ออกให้
  hostname เพราะ SAN จะไม่ตรง
- Firmware รุ่นนี้อ่าน certificate chain และ private key จาก SD ตอน boot ที่
  `/tls/server-cert.pem` และ `/tls/server-key.pem`, ส่งให้ TLS server แล้วล้าง
  buffer ชั่วคราวใน RAM. ทั้งสองไฟล์ต้อง **ไม่** อยู่ใต้ static route หรือ
  `/mocap/`; static server ไม่มี route ที่อนุญาตให้อ่าน `/tls/*`.
- SD ถอดออกได้ ดังนั้น private key ใน implementation นี้เสี่ยงต่อ physical
  access. สำหรับ rig production ให้ย้าย key ไปยัง flash/provisioned secure
  storage (และเปิด flash encryption/secure boot หาก threat model ต้องการ)
  ก่อนนำไปใช้ในพื้นที่ที่ไม่เชื่อถือ.
- บน iPhone/iPad ให้ติดตั้ง profile ของ CA แล้วเปิด Full Trust สำหรับ
  certificate นั้น; Android/managed browser อาจมี policy ที่ห้าม user CA
  ดังนั้นทดสอบกับโทรศัพท์จริงก่อนใช้งาน
- HTTP captive portal ช่วยพาไปยัง URL ได้เท่านั้น; มันไม่ทำให้ certificate
  ที่ไม่ trusted กลายเป็น trusted

### Let's Encrypt via DNS-01 / ใช้ public certificate โดยไม่ต้องลง CA บนมือถือ

วิธีนี้เหมาะเมื่อมี domain จริงที่ควบคุมได้ เช่น `rig.example.com` และต้องการ
ให้ iPhone/Android เชื่อถือ certificate โดยไม่ติดตั้ง CA profile เพิ่ม. ต้องมี
เพียงสิ่งต่อไปนี้:

1. DNS hostname ที่เป็นของคุณและใช้กับ rig เพียงตัวเดียว
2. สิทธิ์แก้ DNS ของ zone นั้น หรือ DNS API token ที่จำกัดสิทธิ์ให้สร้าง TXT
   record สำหรับ ACME เท่านั้น
3. คอมพิวเตอร์/CI ที่ต่ออินเทอร์เน็ตเพื่อออกและ renew certificate; rig ที่อยู่
   บน AP ภายในไม่ต้องเปิด public port หรือมี public IP

ใช้ **DNS-01** กับ ACME client ของ DNS provider นั้น. ACME client จะให้สร้าง
TXT record ใต้ `_acme-challenge.rig.example.com` บน **authoritative public DNS**;
อย่าชี้ A/AAAA record สาธารณะมาที่ rig และอย่าใช้ HTTP-01 กับ `192.168.4.1`.
หลัง validation แล้ว AP DNS ของ rig จะตอบ `rig.example.com` เป็น `192.168.4.1`
ขณะที่โทรศัพท์ต่อ Wi-Fi ของ rig อยู่ จึงเชื่อมต่อ TLS ด้วยชื่อที่ certificate
รับรองได้โดยไม่เผย rig สู่อินเทอร์เน็ต.

อย่าส่ง DNS API token, ACME account key, หรือ `privkey.pem` ผ่าน chat และอย่า
เก็บไว้ใน repository/SD card นอกเหนือจาก private key ของ certificate ที่ rig
ต้องใช้. ให้จำกัด DNS token เป็น zone/record ที่จำเป็น, เก็บไว้ใน secret store
ของเครื่องออก certificate, และตั้ง automated renewal ตามคู่มือของ provider.
ทำ dry run/rehearsal กับ ACME staging environment ก่อนออก production
certificate หาก client รองรับ.

หลัง ACME client ออก certificate แล้ว ให้ใช้ `fullchain.pem` (leaf +
intermediate chain) และ `privkey.pem` จากเครื่องนั้น. Script ด้านล่างไม่ติดต่อ
Let's Encrypt และไม่อ่าน credential ใด ๆ; มันตรวจอายุ, certificate/key pair,
และ DNS hostname ก่อนคัดลอก. Public-CA deployment ต้องใส่ `--hostname`:

```bash
./tools/install-letsencrypt-cert.sh --dry-run --hostname rig.example.com \
  /Volumes/STRIKESENSE \
  /path/to/fullchain.pem \
  /path/to/privkey.pem

./tools/install-letsencrypt-cert.sh --hostname rig.example.com \
  /Volumes/STRIKESENSE \
  /path/to/fullchain.pem \
  /path/to/privkey.pem
```

Script จะเขียนเฉพาะ `/tls/server-cert.pem`, `/tls/server-key.pem`, และ
`/tls/hostname.txt`; ปฏิเสธ SD root/โฟลเดอร์ project/home ที่เสี่ยง, symlink,
key ที่เข้ารหัส, certificate หมดอายุ, pair ที่ไม่ตรงกัน และ hostname ที่ไม่อยู่
ใน certificate. `--dry-run` ไม่เขียนไฟล์เลย. Script ตรวจ format/pair/อายุ/SAN
แต่ไม่ได้ยืนยัน issuer หรือออก certificate แทน ACME client. ปิด rig ก่อนถอด/ใส่ SD card,
eject การ์ดอย่างปลอดภัย, boot rig ใหม่ แล้วเปิด `https://rig.example.com/`.
Script เตือนเมื่อ certificate เหลืออายุน้อยกว่า 14 วัน; อย่ารอให้หมดอายุ และ
ทำ renewal + copy ลง SD ก่อนวันหมดอายุทุกครั้ง.

รายละเอียด DNS-01 และข้อจำกัดของ challenge ดูที่
[Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/).

### TLS files on SD / ไฟล์ TLS บนการ์ด

หลังออก certificate แล้ว ให้คัดลอก full chain (leaf certificate ตามด้วย
intermediate certificate ถ้ามี) และ leaf private key ของ rig ลง SD ดังนี้
(อย่าคัดลอก **Local CA private key** ลง rig):

```text
/tls/server-cert.pem
/tls/server-key.pem
/tls/hostname.txt       # public CA only: exact canonical DNS hostname
```

เก็บ private key นี้ให้พ้นจากผู้ที่ไม่ควรเข้าถึงการ์ด และอย่า commit ไฟล์ PEM
เข้าที่เก็บโค้ด. Firmware จะไม่เปิด HTTPS หากไฟล์ certificate/key ใดไฟล์หนึ่งหายหรืออ่านไม่ได้;
ในกรณีนั้น HTTP legacy ยังเปิด dashboard ได้โดยไม่มีกล้อง. เมื่อ HTTPS เริ่ม
สำเร็จ request HTTP จะถูก redirect ไป URL secure ที่ตั้งค่าไว้ (IP สำหรับ Local
CA หรือ hostname สำหรับ public CA) เพื่อไม่ให้เปิด camera-ineligible dashboard
โดยไม่ตั้งใจ.

## SD card asset layout

Motion capture นี้ pin ที่ **`@mediapipe/tasks-vision` 0.10.35**.  Firmware
ต้อง serve เฉพาะไฟล์ allowlist ด้านล่างแบบ read-only ที่ URL เดียวกับ path
บนการ์ด; ห้าม expose ทั้ง SD card เพราะมี `/sessions` และ `/models` อยู่แล้ว.

```text
/mocap/mediapipe/0.10.35/
├── wasm/
│   ├── vision_wasm_internal.js
│   ├── vision_wasm_internal.wasm
│   ├── vision_wasm_nosimd_internal.js
│   └── vision_wasm_nosimd_internal.wasm
└── models/
    └── pose_landmarker_lite.task
```

The dashboard should use:

```js
FilesetResolver.forVisionTasks('/mocap/mediapipe/0.10.35/wasm')
// modelAssetPath:
// '/mocap/mediapipe/0.10.35/models/pose_landmarker_lite.task'
```

MediaPipe chooses the SIMD pair where available and falls back to the `nosimd`
pair.  Do not delete the fallback files.  The unused `vision_wasm_module_*`
pair is intentionally not installed.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `wasm/vision_wasm_internal.js` | 322,044 | `e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c` |
| `wasm/vision_wasm_internal.wasm` | 11,153,617 | `6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc` |
| `wasm/vision_wasm_nosimd_internal.js` | 321,847 | `438d1fe8ff7f4d946025bc211c291543c037d8a3785ed4eee60f1f521b236296` |
| `wasm/vision_wasm_nosimd_internal.wasm` | 10,481,398 | `8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31` |
| `models/pose_landmarker_lite.task` | 5,777,746 | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |

Total is about 26.8 MiB.  Static responses need these MIME/cache headers:

- `.wasm` → `application/wasm`
- `.js` → `text/javascript`
- `.task` → `application/octet-stream`
- Versioned assets → `Cache-Control: public, max-age=31536000, immutable`
- Add `X-Content-Type-Options: nosniff`; return 404 (not dashboard HTML) for
  any unknown `/mocap/` path.

## Install assets / ติดตั้ง asset

Insert the SD card in a computer, identify its **mounted root**, then run:

```bash
./tools/install-mediapipe-assets.sh /Volumes/STRIKESENSE
```

The script requires an explicit existing directory, refuses `/` and the home
directory, rejects symlinked destination paths, downloads only HTTPS sources,
verifies SHA-256, and writes only beneath the supplied root at
`mocap/mediapipe/0.10.35/`. It never creates, copies, or changes certificates,
session CSVs, AI models, or any other SD paths. Safely eject the card after it
finishes.

## Operational safety / ข้อควรระวังในการใช้งาน

- First load is large. Wait for MediaPipe to finish caching before starting a
  scored session; serving tens of MiB from SD competes with the rig radio.
- Native TLS is sized for **one active phone** (at most three TLS sockets).
  Close other rig tabs while loading MediaPipe. Large asset/API downloads can
  briefly delay WSS; the firmware drops excess live batches instead of letting
  a backlog make force feedback stale.
- Keep camera and IMU on the same trusted HTTPS origin. An HTTPS page calling
  old `http://` APIs or `ws://` is mixed content and browsers block it.
- Asset version and JavaScript package version must match. Upgrade by adding a
  new versioned directory and changing the dashboard path, not by silently
  replacing files in a cached version.
- `Δ≈… ms` in the camera panel is a **timing estimate**. The dashboard maps the
  Main Node receive timestamp to the browser's monotonic clock and uses the
  video frame's expected display time, but it does not measure camera exposure
  latency or the exact peak sample within an IMU batch (about 20 ms uncertainty).
  Use an externally calibrated hardware trigger/high-speed camera for
  biomechanics-grade timing; do not treat this display as one.
- A matched frame whose required joint is occluded reports no angle rather than
  inventing a value. Reframe the full body before interpreting left/right form.
- A trusted certificate protects the Wi-Fi transport, not physical SD access.
  Treat recordings and any removable card as sensitive training data.

MediaPipe model source: [Pose Landmarker for web](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js).

// =============================================================================
// StrikeSense Main Node — single-file Arduino IDE sketch
// Target board : "ESP32S3 Dev Module"
// Settings     : Flash 8MB, PSRAM "OPI PSRAM", Partition "8M with spiffs (3MB
// APP)"
//                USB CDC On Boot: Enabled, Upload Speed 921600
//
// Required libraries (Library Manager):
//   - ESP Async WebServer  (mathieucarbou fork, v3.3+)
//   - Async TCP            (mathieucarbou fork)
//   - ArduinoJson          (Benoit Blanchon, v7.x)
//   - Adafruit NeoPixel
//
// Required board package:
//   - esp32 by Espressif Systems v3.1.x  (Boards Manager)
//
// Pipeline:
//   Strike Nodes (ESP-NOW) -> RX callback -> queue
//      -> main loop drains -> SD CSV logger + WebSocket broadcast + counters
//   Dashboard is embedded as PROGMEM HTML (no LittleFS upload required).
// =============================================================================

#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_https_server.h>
#include <ESPAsyncWebServer.h>
#include <Preferences.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <DNSServer.h> // captive portal — จับ DNS ทุกโดเมน → AP IP
#include <esp_now.h>
#include <esp_wifi.h>
#include <time.h>

// esp_http_server and ESPAsyncWebServer both name their method enums HTTP_GET,
// etc.  Include the native header first (which tells ESPAsyncWebServer not to
// import its names globally), retain native constants under explicit names, and
// preserve the existing Async route source below with these narrow aliases.
static constexpr httpd_method_t IDF_HTTP_DELETE =
    static_cast<httpd_method_t>(HTTP_DELETE);
static constexpr httpd_method_t IDF_HTTP_GET = static_cast<httpd_method_t>(HTTP_GET);
static constexpr httpd_method_t IDF_HTTP_POST =
    static_cast<httpd_method_t>(HTTP_POST);
#define HTTP_DELETE AsyncWebRequestMethod::HTTP_DELETE
#define HTTP_GET AsyncWebRequestMethod::HTTP_GET
#define HTTP_POST AsyncWebRequestMethod::HTTP_POST

// ============================================================
//  CONFIG
// ============================================================
#define AP_SSID "StrikeSense"
#define AP_PASSWORD "muaythai123" // >= 8 chars
#define AP_CHANNEL 1              // MUST match STRIKESENSE_ESPNOW_CHANNEL
// TLS consumes roughly 50 KiB of scarce internal RAM per browser.  This rig's
// secure transport is intentionally one-coach-at-a-time: a second phone can
// otherwise consume the WSS/API pair and make both dashboards flap offline.
#define AP_MAX_CLIENTS 1

#define HTTP_PORT 80
#define HTTPS_PORT 443
#define WS_PATH "/ws"

// TLS material is deliberately provisioned on the SD card, never compiled into
// firmware or checked into source control.  The leaf certificate must contain
// a SAN for the address/name the phone opens.  With a public certificate use a
// DNS name in HTTPS_HOST_PATH; without it the legacy Local-CA IP setup remains
// available at 192.168.4.1.
#define HTTPS_CERT_PATH "/tls/server-cert.pem"
#define HTTPS_KEY_PATH "/tls/server-key.pem"
#define HTTPS_HOST_PATH "/tls/hostname.txt"
#define HTTPS_DEFAULT_HOST "192.168.4.1"

// Upper bound on live-stream clients. Only a backstop, NOT the zombie defence —
// see WebServerApp::loop(). Keep it well above the real client count: a phone
// routinely holds two pages at once (the captive-portal mini browser plus the
// real one), and each reconnect briefly adds another. A cap of 2 was tried and
// became a reconnect engine of its own: 2 legitimate pages + 1 reconnect tripped
// the cap every time, so cleanupClients() closed a *live* page, which reconnected,
// which tripped it again — 154 connections in two minutes.
#define MAX_WS_CLIENTS 6

#define SD_CS_PIN 10
#define SD_MOSI_PIN 11
#define SD_SCK_PIN 12
#define SD_MISO_PIN 13

// 4 Strike Nodes × 50 packets/s = 200 frames/s. 96 slots ≈ 0.5 s of headroom so
// a slow SD flush or a busy WiFi task never costs us samples. ~11 KB of heap.
#define IMU_QUEUE_SIZE 96
#define STATUS_LED_PIN 48

// Per-packet RX logging. Leave OFF: at 115200 baud one line per packet costs
// more serial bandwidth than exists once a second node joins, and the print
// happens in the ESP-NOW callback (WiFi task) — it blocks the radio and drops
// frames.
#define DEBUG_ESPNOW_RX 0

// ============================================================
//  PROTOCOL (shared with Strike Node firmware)
// ============================================================
#define STRIKESENSE_PROTOCOL_VERSION 1
#define STRIKESENSE_ESPNOW_CHANNEL 1
#define STRIKESENSE_SAMPLE_RATE_HZ 400
#define STRIKESENSE_SAMPLE_PERIOD_US 2500 // 1_000_000 / 400
#define IMU_SAMPLES_PER_PACKET 8

enum NodeSlot : uint8_t {
  SLOT_UNASSIGNED = 0,
  SLOT_LEFT_HAND = 1,
  SLOT_RIGHT_HAND = 2,
  SLOT_LEFT_SHIN = 3,
  SLOT_RIGHT_SHIN = 4,
};

enum PacketType : uint8_t {
  PKT_IMU_BATCH = 0x01,
  PKT_NODE_HELLO = 0x02,
  PKT_NODE_STATUS = 0x03,
  PKT_TIME_SYNC = 0x80,
  PKT_CMD_CONFIG = 0x81,
  PKT_CMD_IDENTIFY = 0x82,
  PKT_CMD_CALIBRATE = 0x83,
  PKT_CMD_RESTART = 0x84,
};

typedef struct __attribute__((packed)) {
  int16_t ax, ay, az;
  int16_t gx, gy, gz;
} ImuSample;

typedef struct __attribute__((packed)) {
  uint8_t version;
  uint8_t type;
  uint8_t reserved;
  uint8_t sampleCount;
  uint32_t seq;
  uint32_t firstTimestampUs;
  uint16_t samplePeriodUs;
  uint16_t reserved2;
  ImuSample samples[IMU_SAMPLES_PER_PACKET];
} ImuBatchPacket;

typedef struct __attribute__((packed)) {
  uint8_t version;
  uint8_t type;
  uint8_t firmwareMajor;
  uint8_t firmwareMinor;
  uint8_t macAddr[6];
} NodeHelloPacket;

typedef struct __attribute__((packed)) {
  uint8_t version;
  uint8_t type;
  uint8_t batteryPct;
  int8_t rssi;
  uint32_t uptimeMs;
  uint16_t lostPackets;
  uint16_t reserved;
} NodeStatusPacket;

typedef struct __attribute__((packed)) {
  uint8_t version;
  uint8_t type;
  uint8_t reserved[2];
  uint32_t mainNodeTimestampMs;
} TimeSyncPacket;

typedef struct __attribute__((packed)) {
  uint8_t version;
  uint8_t type;
  uint8_t newSampleRateHz;
  uint8_t accelRangeG;
  uint8_t gyroRangeDps;
  uint8_t reserved[3];
} ConfigCommandPacket;

typedef struct __attribute__((packed)) {
  uint8_t version;
  uint8_t type;
} SimpleCommandPacket;

// ============================================================
//  SHARED STRUCTS
// ============================================================
struct NodeMapping {
  uint8_t mac[6];
  NodeSlot slot;
  int8_t lastRssi;
  uint32_t lastSeenMs;
  uint8_t batteryPct;
  uint32_t nodeUptimeMs;
  uint16_t firmwareVersion;
  uint32_t packetsRx;
  uint32_t lastSeq;
  uint32_t seqGaps;
  float peakG; // most-recent frame peak |accel| (g) — powers shake-to-assign
  uint32_t lastImuMs; // when peakG was last updated
  bool active;
  bool everSeen; // false = restored from NVS, hasn't transmitted yet this boot
  uint16_t healthFlags; // from the node's status packet: bit0 sensor fault,
                        // bit1 link fault

  // Charge detection by voltage trend. There is no charge-sense wire fitted,
  // but a battery that is charging climbs and one in use falls — comparing the
  // reading against one taken CHARGE_WINDOW_MS ago tells the two apart without
  // any extra hardware.
  uint16_t battMv;    // latest reported millivolts (0 = node doesn't report)
  uint16_t battRefMv; // reading at the start of the current comparison window
  uint32_t battRefMs;
  int16_t battTrendMv; // signed change over the last completed window
  int8_t chargeState;  // +1 charging, -1 discharging, 0 unknown/steady
};

// Self-reported node health, packed into NodeStatusPacket.reserved by the
// Strike Node. Older node firmware sends 0, which reads as "healthy, no
// voltage" — so mixing firmware versions is safe and needs no protocol version
// bump.
//   bit0     sensor fault
//   bit1     link fault
//   bit2     battery sense not wired (reading is meaningless)
//   bit4-15  battery millivolts / 4
#define NODE_FLAG_SENSOR_FAULT 0x0001
#define NODE_FLAG_LINK_FAULT 0x0002
#define NODE_FLAG_BATT_UNWIRED 0x0004
#define NODE_BATT_MV_SHIFT 4

struct SessionStats {
  uint32_t startedAtMs;
  uint32_t endedAtMs;
  uint32_t totalImuPackets;
  uint32_t totalImuSamples;
  bool active;
};

struct ImuFrame {
  uint8_t mac[6];
  NodeSlot slot;
  int8_t rssi;
  uint32_t recvTimestampMs;
  uint32_t nodeTimestampUs;
  uint32_t seq;
  uint8_t sampleCount;
  ImuSample samples[IMU_SAMPLES_PER_PACKET];
};

// ============================================================
//  DIAGNOSTIC LOG  (dev mode)
// ============================================================
// A ring of recent events the dashboard can pull over /api/logs. Serial only
// helps with a laptop attached, which is exactly when problems DON'T happen —
// this is the same information, readable from the phone that is in the room.
// Written from three different tasks (WiFi/ESP-NOW, AsyncTCP, loop), so the
// ring is guarded; formatting happens outside the lock to keep it short.
namespace DiagLog {
static constexpr size_t CAP = 96;
static constexpr size_t MSG_LEN = 92;

struct Entry {
  uint32_t seq;
  uint32_t ms;
  char cat[10];
  char msg[MSG_LEN];
};

static Entry g_ring[CAP];
static size_t g_head = 0;  // next write slot
static uint32_t g_seq = 0; // monotonic, lets the client fetch deltas
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static bool g_echoSerial = true;

void add(const char *cat, const char *fmt, ...) {
  char msg[MSG_LEN];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);

  const uint32_t nowMs = millis();
  taskENTER_CRITICAL(&g_mux);
  Entry &e = g_ring[g_head];
  e.seq = ++g_seq;
  e.ms = nowMs;
  strncpy(e.cat, cat, sizeof(e.cat) - 1);
  e.cat[sizeof(e.cat) - 1] = 0;
  memcpy(e.msg, msg, sizeof(e.msg));
  e.msg[sizeof(e.msg) - 1] = 0;
  g_head = (g_head + 1) % CAP;
  taskEXIT_CRITICAL(&g_mux);

  if (g_echoSerial)
    Serial.printf("[%s] %s\n", cat, msg);
}

uint32_t lastSeq() {
  taskENTER_CRITICAL(&g_mux);
  uint32_t s = g_seq;
  taskEXIT_CRITICAL(&g_mux);
  return s;
}

// Copies entries newer than `sinceSeq` (oldest first) into `out`.
size_t collect(Entry *out, size_t maxCount, uint32_t sinceSeq) {
  size_t n = 0;
  taskENTER_CRITICAL(&g_mux);
  for (size_t i = 0; i < CAP && n < maxCount; ++i) {
    const Entry &e = g_ring[(g_head + i) % CAP]; // oldest → newest
    if (e.seq > sinceSeq)
      out[n++] = e;
  }
  taskEXIT_CRITICAL(&g_mux);
  return n;
}
} // namespace DiagLog

#define DLOG(cat, ...) DiagLog::add(cat, __VA_ARGS__)

// ============================================================
//  EMBEDDED DASHBOARD (Premiere-Pro workspace, served from "/")
// ============================================================
#include "dashboard_ui.h"

// ============================================================
//  SESSION MODULE
// ============================================================
namespace Session {
static constexpr size_t MAX_NODES = 8;
static NodeMapping g_nodes[MAX_NODES];
static SessionStats g_stats = {};
static char g_sessionId[32] = "";
static char g_athleteName[32] = "";

// The node table is written from the ESP-NOW receive callback (WiFi task) and
// read from the HTTP/WS task. With a single node the overlap was rare enough to
// go unnoticed; with four it is constant, and an un-guarded read hands the
// dashboard a half-updated record. Every touch now runs under this spinlock.
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;

// Slot assignments live in NVS so a reboot, a power cut, or a flat battery does
// not throw away the shake-to-assign pairing. Wiped by the factory reset.
static Preferences g_prefs;
static bool g_prefsOk = false;
static bool g_setupDone = false;
static constexpr const char *NVS_NS = "strikesense";

typedef struct __attribute__((packed)) {
  uint8_t mac[6];
  uint8_t slot;
} PersistedNode;

static bool macEquals(const uint8_t *a, const uint8_t *b) {
  for (int i = 0; i < 6; ++i)
    if (a[i] != b[i])
      return false;
  return true;
}
static int findNode(const uint8_t *mac) {
  for (size_t i = 0; i < MAX_NODES; ++i) {
    if (g_nodes[i].active && macEquals(g_nodes[i].mac, mac))
      return (int)i;
  }
  return -1;
}
static int findFreeSlot() {
  for (size_t i = 0; i < MAX_NODES; ++i)
    if (!g_nodes[i].active)
      return (int)i;
  // Table full: evict an entry that was restored from NVS but has not shown up
  // this boot, so a genuinely new sensor can still join a full-looking rig.
  for (size_t i = 0; i < MAX_NODES; ++i)
    if (!g_nodes[i].everSeen)
      return (int)i;
  return -1;
}

// NVS writes must happen outside the spinlock — snapshot first, then persist.
static void saveMappings() {
  if (!g_prefsOk)
    return;
  PersistedNode buf[MAX_NODES];
  size_t n = 0;
  taskENTER_CRITICAL(&g_mux);
  for (size_t i = 0; i < MAX_NODES; ++i) {
    if (!g_nodes[i].active)
      continue;
    memcpy(buf[n].mac, g_nodes[i].mac, 6);
    buf[n].slot = (uint8_t)g_nodes[i].slot;
    n++;
  }
  taskEXIT_CRITICAL(&g_mux);
  if (n)
    g_prefs.putBytes("nodes", buf, n * sizeof(PersistedNode));
  else
    g_prefs.remove("nodes");
}

static void loadMappings() {
  g_prefsOk = g_prefs.begin(NVS_NS, false);
  if (!g_prefsOk) {
    DLOG("NVS", "เปิด NVS ไม่ได้ — การจับคู่จะหายเมื่อรีบูต");
    return;
  }
  g_setupDone = g_prefs.getBool("setup", false);

  PersistedNode buf[MAX_NODES];
  size_t len = g_prefs.getBytesLength("nodes");
  if (len == 0 || len > sizeof(buf) || (len % sizeof(PersistedNode)) != 0)
    return;
  g_prefs.getBytes("nodes", buf, len);
  const size_t n = len / sizeof(PersistedNode);
  for (size_t i = 0; i < n && i < MAX_NODES; ++i) {
    g_nodes[i] = {};
    memcpy(g_nodes[i].mac, buf[i].mac, 6);
    g_nodes[i].slot = (NodeSlot)buf[i].slot;
    g_nodes[i].active = true;
    g_nodes[i].everSeen = false; // shows as offline until it transmits
  }
  DLOG("NVS", "กู้คืนการจับคู่ %u ตัว · setupDone=%d", (unsigned)n, (int)g_setupDone);
}

void begin() {
  for (auto &n : g_nodes)
    n = {};
  g_stats = {};
  loadMappings();
}

bool setupDone() { return g_setupDone; }
void setSetupDone(bool done) {
  g_setupDone = done;
  if (g_prefsOk)
    g_prefs.putBool("setup", done);
}

// "Brand new device": drop every pairing and re-arm the first-run wizard.
void factoryResetMemory() {
  taskENTER_CRITICAL(&g_mux);
  for (auto &n : g_nodes)
    n = {};
  taskEXIT_CRITICAL(&g_mux);
  g_setupDone = false;
  if (g_prefsOk)
    g_prefs.clear();
}

bool start(const char *athleteName) {
  if (g_stats.active)
    return false;
  g_stats = {};
  g_stats.active = true;
  g_stats.startedAtMs = millis();
  strncpy(g_athleteName, athleteName ? athleteName : "anonymous",
          sizeof(g_athleteName) - 1);
  snprintf(g_sessionId, sizeof(g_sessionId), "%lu",
           (unsigned long)g_stats.startedAtMs);
  return true;
}

bool stop() {
  if (!g_stats.active)
    return false;
  g_stats.active = false;
  g_stats.endedAtMs = millis();
  return true;
}

bool isActive() { return g_stats.active; }
const SessionStats &stats() { return g_stats; }
const char *currentSessionId() { return g_sessionId; }

// Returns true when the node was not in the table before (i.e. a genuinely new
// sensor just joined) so the caller can log it once instead of per packet.
bool rememberNode(const uint8_t *mac, int8_t rssi) {
  bool isNew = false;
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx < 0) {
    idx = findFreeSlot();
    if (idx >= 0) {
      g_nodes[idx] = {};
      memcpy(g_nodes[idx].mac, mac, 6);
      g_nodes[idx].slot = SLOT_UNASSIGNED;
      g_nodes[idx].active = true;
      isNew = true;
    }
  } else if (!g_nodes[idx].everSeen) {
    isNew = true; // restored from NVS, first packet this boot
  }
  if (idx >= 0) {
    g_nodes[idx].lastRssi = rssi;
    g_nodes[idx].lastSeenMs = millis();
    g_nodes[idx].everSeen = true;
  }
  taskEXIT_CRITICAL(&g_mux);
  return isNew;
}

// Live per-node activity (peak |accel|, g) — drives shake-to-assign in the
// first-run setup wizard so we can tell which physical node is being shaken.
void noteActivity(const uint8_t *mac, float peakG) {
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx >= 0) {
    g_nodes[idx].peakG = peakG;
    g_nodes[idx].lastImuMs = millis();
  }
  taskEXIT_CRITICAL(&g_mux);
}

void countImuPacket(const uint8_t *mac, uint32_t seq) {
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx >= 0) {
    g_nodes[idx].packetsRx++;
    if (g_nodes[idx].lastSeq != 0 && seq > g_nodes[idx].lastSeq + 1) {
      g_nodes[idx].seqGaps += (seq - g_nodes[idx].lastSeq - 1);
    }
    g_nodes[idx].lastSeq = seq;
  }
  taskEXIT_CRITICAL(&g_mux);
}

// Voltage must move by more than the ADC's own noise before we call it a
// trend — a couple of mV of jitter must not flicker the charging icon.
static constexpr uint32_t CHARGE_WINDOW_MS = 20000;
static constexpr int16_t CHARGE_DELTA_MV = 15;

void updateNodeStatus(const uint8_t *mac, uint8_t batteryPct, uint32_t uptimeMs,
                      uint16_t healthFlags, uint16_t battMv) {
  int8_t prevCharge = 0, newCharge = 0;
  int16_t trend = 0;
  bool changed = false;
  char macStr[18] = "";

  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx >= 0) {
    NodeMapping &n = g_nodes[idx];
    n.batteryPct = batteryPct;
    n.nodeUptimeMs = uptimeMs;
    n.healthFlags = healthFlags;
    n.battMv = battMv;

    if (battMv == 0) { // node isn't reporting volts
      n.chargeState = 0;
      n.battRefMs = 0;
      n.battTrendMv = 0;
    } else if (n.battRefMs == 0) {
      n.battRefMv = battMv;
      n.battRefMs = millis();
    } else if (millis() - n.battRefMs >= CHARGE_WINDOW_MS) {
      trend = (int16_t)battMv - (int16_t)n.battRefMv;
      prevCharge = n.chargeState;
      newCharge = (trend >= CHARGE_DELTA_MV)    ? 1
                  : (trend <= -CHARGE_DELTA_MV) ? -1
                                                : 0;
      n.battTrendMv = trend;
      n.chargeState = newCharge;
      n.battRefMv = battMv;
      n.battRefMs = millis();
      changed = (prevCharge != newCharge);
      if (changed) {
        snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
      }
    }
  }
  taskEXIT_CRITICAL(&g_mux);

  if (changed) { // log outside the lock
    DLOG("BATT", "%s %s (%+d mV/%lus, %u mV)", macStr + 12,
         newCharge > 0   ? "กำลังชาร์จ"
         : newCharge < 0 ? "กำลังใช้ไฟ"
                         : "นิ่ง",
         (int)trend, (unsigned long)(CHARGE_WINDOW_MS / 1000), battMv);
  }
}

void updateNodeHello(const uint8_t *mac, uint8_t fwMajor, uint8_t fwMinor) {
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx >= 0)
    g_nodes[idx].firmwareVersion = ((uint16_t)fwMajor << 8) | fwMinor;
  taskEXIT_CRITICAL(&g_mux);
}

void noteImuFrame(uint8_t sampleCount) {
  if (!g_stats.active)
    return;
  g_stats.totalImuPackets++;
  g_stats.totalImuSamples += sampleCount;
}

bool assignSlot(const uint8_t *mac, NodeSlot slot) {
  bool ok = false;
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx >= 0) {
    // One limb, one sensor. Whoever held this slot before is bumped back to
    // UNASSIGNED: the dashboard keys live data, calibration and strike
    // detection by slot, so two nodes sharing a slot silently merge into one
    // bogus limb. This is what broke setups with more than one device.
    if (slot != SLOT_UNASSIGNED) {
      for (size_t i = 0; i < MAX_NODES; ++i) {
        if ((int)i != idx && g_nodes[i].active && g_nodes[i].slot == slot) {
          g_nodes[i].slot = SLOT_UNASSIGNED;
        }
      }
    }
    g_nodes[idx].slot = slot;
    ok = true;
  }
  taskEXIT_CRITICAL(&g_mux);
  if (ok)
    saveMappings();
  return ok;
}

NodeSlot lookupSlot(const uint8_t *mac) {
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  NodeSlot s = idx < 0 ? SLOT_UNASSIGNED : g_nodes[idx].slot;
  taskEXIT_CRITICAL(&g_mux);
  return s;
}

size_t listNodes(NodeMapping *out, size_t maxCount) {
  size_t n = 0;
  taskENTER_CRITICAL(&g_mux);
  for (size_t i = 0; i < MAX_NODES && n < maxCount; ++i) {
    if (g_nodes[i].active)
      out[n++] = g_nodes[i];
  }
  taskEXIT_CRITICAL(&g_mux);
  return n;
}

// Cheap "how many sensors are talking to us" probe for the status LED and the
// stats line — avoids copying the whole table every loop pass just to look at
// one timestamp.
size_t liveNodeCount(uint32_t withinMs) {
  size_t live = 0;
  const uint32_t now = millis();
  taskENTER_CRITICAL(&g_mux);
  for (size_t i = 0; i < MAX_NODES; ++i) {
    if (g_nodes[i].active && g_nodes[i].everSeen &&
        (now - g_nodes[i].lastSeenMs) < withinMs)
      live++;
  }
  taskEXIT_CRITICAL(&g_mux);
  return live;
}
bool anyNodeFresh(uint32_t withinMs) { return liveNodeCount(withinMs) > 0; }

// A dropped node is NO LONGER deleted — it stays in the list (the dashboard
// shows it as offline via ageMs) and keeps its slot assignment, so when the
// signal returns it reconnects to the same limb with zero re-setup. Removal is
// now explicit only (forgetNode / the "ลืมอุปกรณ์" button).
void cleanStaleNodes() { /* intentionally keeps nodes across signal loss */ }

bool forgetNode(const uint8_t *mac) {
  bool ok = false;
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx >= 0) {
    g_nodes[idx] = {};
    ok = true;
  } // free the slot entirely
  taskEXIT_CRITICAL(&g_mux);
  if (ok)
    saveMappings();
  return ok;
}

// Wipe the link bookkeeping for one node but keep its identity and its limb.
// Used by "reset the link": stale sequence numbers make every packet after a
// node reboot look like a gap, and the counters then read as a broken link
// even though data is flowing again.
bool resetNodeStats(const uint8_t *mac) {
  bool ok = false;
  taskENTER_CRITICAL(&g_mux);
  int idx = findNode(mac);
  if (idx >= 0) {
    g_nodes[idx].packetsRx = 0;
    g_nodes[idx].lastSeq = 0;
    g_nodes[idx].seqGaps = 0;
    g_nodes[idx].peakG = 0;
    g_nodes[idx].lastImuMs = 0;
    g_nodes[idx].everSeen = false; // "offline until it talks again"
    g_nodes[idx].lastSeenMs = 0;
    ok = true;
  }
  taskEXIT_CRITICAL(&g_mux);
  return ok;
}
} // namespace Session

// ============================================================
//  ESP-NOW RX MODULE
// ============================================================
namespace EspNowRx {
static QueueHandle_t g_queue = nullptr;
static volatile uint32_t g_received = 0;
static volatile uint32_t g_dropped = 0;

// A node that just joined, published for the loop to log once (never print from
// inside this callback — see DEBUG_ESPNOW_RX).
static volatile bool g_newNodeFlag = false;
static uint8_t g_newNodeMac[6] = {0};

static void onRecv(const esp_now_recv_info_t *info, const uint8_t *data,
                   int len) {
  if (!g_queue)
    return;
  if (len < 2 || data[0] != STRIKESENSE_PROTOCOL_VERSION)
    return;

  const uint8_t *mac = info->src_addr;
  const int8_t rssi = info->rx_ctrl ? info->rx_ctrl->rssi : 0;

#if DEBUG_ESPNOW_RX
  Serial.printf(
      "[RX] %d B from %02X:%02X:%02X:%02X:%02X:%02X type=0x%02X rssi=%d\n", len,
      mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], data[1], rssi);
#endif

  // This runs in the WiFi task. Anything slow here (a Serial.printf costs ~8 ms
  // at 115200 baud once the TX buffer fills) stalls the radio and drops the
  // *other* nodes' packets — the single biggest reason a 2-node rig behaved
  // worse than a 1-node rig. Keep it to bookkeeping + a queue push.
  if (Session::rememberNode(mac, rssi)) {
    if (!g_newNodeFlag) {
      memcpy(g_newNodeMac, mac, 6);
      g_newNodeFlag = true;
    }
  }

  switch (data[1]) {
  case PKT_IMU_BATCH: {
    if (len < (int)sizeof(ImuBatchPacket))
      return;
    const auto *pkt = reinterpret_cast<const ImuBatchPacket *>(data);
    Session::countImuPacket(mac, pkt->seq);

    ImuFrame frame;
    memcpy(frame.mac, mac, 6);
    frame.slot = Session::lookupSlot(mac);
    frame.rssi = rssi;
    frame.recvTimestampMs = millis();
    frame.nodeTimestampUs = pkt->firstTimestampUs;
    frame.seq = pkt->seq;
    frame.sampleCount = pkt->sampleCount;
    memcpy(frame.samples, pkt->samples, sizeof(frame.samples));

    if (xQueueSendFromISR(g_queue, &frame, nullptr) != pdTRUE) {
      g_dropped++;
    }
    g_received++;
    break;
  }
  case PKT_NODE_HELLO: {
    if (len < (int)sizeof(NodeHelloPacket))
      return;
    const auto *pkt = reinterpret_cast<const NodeHelloPacket *>(data);
    Session::updateNodeHello(mac, pkt->firmwareMajor, pkt->firmwareMinor);
    break;
  }
  case PKT_NODE_STATUS: {
    if (len < (int)sizeof(NodeStatusPacket))
      return;
    const auto *pkt = reinterpret_cast<const NodeStatusPacket *>(data);
    Session::updateNodeStatus(
        mac, pkt->batteryPct, pkt->uptimeMs, pkt->reserved & 0x000F,
        (uint16_t)((pkt->reserved >> NODE_BATT_MV_SHIFT) * 4));
    break;
  }
  default:
    break;
  }
}

bool begin() {
  g_queue = xQueueCreate(IMU_QUEUE_SIZE, sizeof(ImuFrame));
  if (!g_queue)
    return false;
  if (esp_now_init() != ESP_OK)
    return false;
  esp_now_register_recv_cb(onRecv);
  esp_wifi_set_channel(STRIKESENSE_ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  return true;
}

// Tear the ESP-NOW stack down and bring it back up, keeping the queue and the
// node table. The recovery path for "the nodes are powered and in range but
// nothing arrives" — a wedged radio, or a channel that drifted off 1.
// NOTE: esp_now_deinit() drops every peer, so the caller must re-run
// EspNowTx::begin() afterwards.
bool restartRadio() {
  esp_now_unregister_recv_cb();
  esp_now_deinit();
  delay(20);
  if (esp_now_init() != ESP_OK)
    return false;
  if (esp_now_register_recv_cb(onRecv) != ESP_OK)
    return false;
  esp_wifi_set_channel(STRIKESENSE_ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  xQueueReset(g_queue);
  return true;
}

bool nextFrame(ImuFrame &out, TickType_t waitTicks = 0) {
  if (!g_queue)
    return false;
  return xQueueReceive(g_queue, &out, waitTicks) == pdTRUE;
}

// เปิด/ปิดการรับ ESP-NOW · ปิดตอนไม่มีคนดู → ปล่อย CPU/คิวให้หน้าเว็บโหลด
// (Strike Node ยังส่งอยู่ แต่ Main ไม่ประมวลผล = ลดภาระ · เปิดคืนเมื่อมีคนต่อ dashboard/record)
static bool g_rxEnabled = true;
void setEnabled(bool on) {
  if (on == g_rxEnabled)
    return;
  g_rxEnabled = on;
  if (on) {
    esp_now_register_recv_cb(onRecv);
  } else {
    esp_now_unregister_recv_cb();
    xQueueReset(g_queue); // ทิ้งเฟรมค้างในคิว
  }
}
bool isEnabled() { return g_rxEnabled; }

uint32_t packetsReceived() { return g_received; }
uint32_t packetsDropped() { return g_dropped; }

// Drains the "new node joined" notice set by the RX callback, so the logging
// happens on the loop task where blocking on Serial is harmless.
bool takeNewNodeNotice(uint8_t out[6]) {
  if (!g_newNodeFlag)
    return false;
  memcpy(out, g_newNodeMac, 6);
  g_newNodeFlag = false;
  return true;
}
} // namespace EspNowRx

// ============================================================
//  ESP-NOW TX MODULE
// ============================================================
namespace EspNowTx {
static constexpr uint8_t BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF,
                                             0xFF, 0xFF, 0xFF};
static constexpr uint32_t SYNC_INTERVAL_MS = 5000;
static bool g_ready = false;
static uint32_t g_lastSyncMs = 0;

static bool ensurePeer(const uint8_t mac[6]) {
  if (esp_now_is_peer_exist(mac))
    return true;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = STRIKESENSE_ESPNOW_CHANNEL;
  peer.encrypt = false;
  return esp_now_add_peer(&peer) == ESP_OK;
}

bool begin() {
  g_ready = ensurePeer(BROADCAST_MAC);
  return g_ready;
}

bool broadcastTimeSync() {
  if (!g_ready)
    return false;
  TimeSyncPacket pkt = {};
  pkt.version = STRIKESENSE_PROTOCOL_VERSION;
  pkt.type = PKT_TIME_SYNC;
  pkt.mainNodeTimestampMs = millis();
  return esp_now_send(BROADCAST_MAC, (const uint8_t *)&pkt, sizeof(pkt)) ==
         ESP_OK;
}

bool sendConfig(const uint8_t mac[6], uint8_t sampleRateHz, uint8_t accelG,
                uint8_t gyroDps) {
  if (!ensurePeer(mac))
    return false;
  ConfigCommandPacket pkt = {};
  pkt.version = STRIKESENSE_PROTOCOL_VERSION;
  pkt.type = PKT_CMD_CONFIG;
  pkt.newSampleRateHz = sampleRateHz;
  pkt.accelRangeG = accelG;
  pkt.gyroRangeDps = gyroDps;
  return esp_now_send(mac, (const uint8_t *)&pkt, sizeof(pkt)) == ESP_OK;
}

bool sendCommand(const uint8_t mac[6], uint8_t cmdType) {
  if (!ensurePeer(mac))
    return false;
  SimpleCommandPacket pkt = {};
  pkt.version = STRIKESENSE_PROTOCOL_VERSION;
  pkt.type = cmdType;
  return esp_now_send(mac, (const uint8_t *)&pkt, sizeof(pkt)) == ESP_OK;
}

// Drop and re-add the unicast peer. A peer entry that went bad (wrong channel
// after a WiFi event, or a half-registered entry) makes every command to that
// node fail silently while broadcasts still arrive — which looks exactly like
// "the node is connected but does nothing".
bool resetPeer(const uint8_t mac[6]) {
  if (esp_now_is_peer_exist(mac))
    esp_now_del_peer(mac);
  return ensurePeer(mac);
}

void tick() {
  const uint32_t now = millis();
  if (now - g_lastSyncMs >= SYNC_INTERVAL_MS) {
    g_lastSyncMs = now;
    broadcastTimeSync();
  }
}
} // namespace EspNowTx

// ============================================================
//  SD LOGGER MODULE  (buffered CSV writer)
// ============================================================
namespace SdLogger {
static SPIClass g_spi(FSPI);
static bool g_ready = false;
static bool g_sessionOpen = false;
static File g_file;
static char g_currentId[24] = "";

static constexpr size_t WRITE_BUF_SIZE = 16 * 1024;
static char g_buf[WRITE_BUF_SIZE];
static size_t g_bufLen = 0;
static uint32_t g_lastFlushMs = 0;
static constexpr uint32_t BUFFER_FLUSH_MS = 500;

static uint32_t g_rowsWritten = 0;
static uint32_t g_bytesWritten = 0;
static uint32_t g_sessionStartMs = 0;

struct SessionEntry {
  char id[24];
  uint32_t sizeBytes;
  uint32_t modTime;
};

static void ensureDir(const char *path) {
  if (!SD.exists(path))
    SD.mkdir(path);
}

static void writeHeader(const char *athleteName) {
  size_t n = snprintf(g_buf + g_bufLen, WRITE_BUF_SIZE - g_bufLen,
                      "# StrikeSense session\n"
                      "# id=%s\n"
                      "# athlete=%s\n"
                      "# sample_rate_hz=400\n"
                      "# accel_scale=2048 lsb_per_g\n"
                      "# gyro_scale=16.4 lsb_per_dps\n"
                      "# columns: t_ms,slot,seq,sample_idx,ax,ay,az,gx,gy,gz\n"
                      "t_ms,slot,seq,sample_idx,ax,ay,az,gx,gy,gz\n",
                      g_currentId, athleteName ? athleteName : "anonymous");
  if (n > 0)
    g_bufLen += n;
}

static void flushBufferToCard() {
  if (!g_sessionOpen || g_bufLen == 0)
    return;
  size_t w = g_file.write((const uint8_t *)g_buf, g_bufLen);
  g_bytesWritten += w;
  g_bufLen = 0;
  g_file.flush();
  g_lastFlushMs = millis();
}

static void appendRow(uint32_t tMs, const ImuFrame &f, size_t sampleIdx,
                      const ImuSample &s) {
  if (g_bufLen + 96 >= WRITE_BUF_SIZE)
    flushBufferToCard();
  int n = snprintf(g_buf + g_bufLen, WRITE_BUF_SIZE - g_bufLen,
                   "%lu,%u,%lu,%u,%d,%d,%d,%d,%d,%d\n", (unsigned long)tMs,
                   (unsigned)f.slot, (unsigned long)f.seq, (unsigned)sampleIdx,
                   s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
  if (n > 0)
    g_bufLen += (size_t)n;
  g_rowsWritten++;
}

uint64_t cardSizeMB() {
  return g_ready ? SD.cardSize() / (1024ULL * 1024ULL) : 0;
}
uint64_t usedMB() { return g_ready ? SD.usedBytes() / (1024ULL * 1024ULL) : 0; }

bool begin() {
  g_spi.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
  bool mounted = false;
  for (int attempt = 1; attempt <= 3; ++attempt) {
    if (SD.begin(SD_CS_PIN, g_spi, 4000000)) {
      mounted = true;
      break;
    }
    DLOG("SD", "mount ครั้งที่ %d ไม่สำเร็จ — รอลอง...", attempt);
    SD.end();
    delay(500);
  }
  if (!mounted) {
    DLOG("SD", "mount ไม่สำเร็จหลังลอง 3 ครั้ง");
    g_ready = false;
    return false;
  }
  if (SD.cardType() == CARD_NONE) {
    DLOG("SD", "ไม่พบการ์ด");
    g_ready = false;
    return false;
  }
  ensureDir("/sessions");
  g_ready = true;
  Serial.printf("[SD] OK, %llu MB used of %llu MB\n",
                (unsigned long long)usedMB(), (unsigned long long)cardSizeMB());
  return true;
}

bool isReady() { return g_ready; }

bool openSession(const char *sessionId, const char *athleteName) {
  if (!g_ready || g_sessionOpen)
    return false;
  char path[64];
  snprintf(path, sizeof(path), "/sessions/%s.csv", sessionId);
  g_file = SD.open(path, FILE_WRITE);
  if (!g_file) {
    Serial.printf("[SD] failed to open %s\n", path);
    return false;
  }
  strncpy(g_currentId, sessionId, sizeof(g_currentId) - 1);
  g_currentId[sizeof(g_currentId) - 1] = 0;
  g_sessionOpen = true;
  g_bufLen = 0;
  g_rowsWritten = 0;
  g_bytesWritten = 0;
  g_sessionStartMs = millis();
  writeHeader(athleteName);
  flushBufferToCard();
  DLOG("SD", "เปิดไฟล์เซสชัน %s", path);
  return true;
}

void logFrame(const ImuFrame &frame) {
  if (!g_sessionOpen)
    return;
  const uint32_t sessionTimeMs = millis() - g_sessionStartMs;
  for (size_t i = 0; i < frame.sampleCount; ++i) {
    appendRow(sessionTimeMs, frame, i, frame.samples[i]);
  }
  const uint32_t now = millis();
  if (now - g_lastFlushMs >= BUFFER_FLUSH_MS ||
      g_bufLen > (WRITE_BUF_SIZE * 3 / 4)) {
    flushBufferToCard();
  }
}

void flush() { flushBufferToCard(); }

// Called every loop pass. The old code called flush() unconditionally here,
// which wrote + fsync'd whatever was in the buffer on *every* iteration — the
// 16 KB buffer never got to do its job and the card saw thousands of tiny
// writes a second. Only flush when the buffer has actually aged out.
void tick() {
  if (!g_sessionOpen || g_bufLen == 0)
    return;
  if (millis() - g_lastFlushMs >= BUFFER_FLUSH_MS)
    flushBufferToCard();
}

void closeSession() {
  if (!g_sessionOpen)
    return;
  flushBufferToCard();
  g_file.close();
  g_sessionOpen = false;
  Serial.printf("[SD] session closed: %s (%lu rows, %lu bytes)\n", g_currentId,
                (unsigned long)g_rowsWritten, (unsigned long)g_bytesWritten);
}

uint32_t rowsWritten() { return g_rowsWritten; }
uint32_t bytesWritten() { return g_bytesWritten; }

size_t listSessions(SessionEntry *out, size_t maxCount) {
  if (!g_ready)
    return 0;
  File dir = SD.open("/sessions");
  if (!dir || !dir.isDirectory())
    return 0;
  size_t n = 0;
  File f;
  while ((f = dir.openNextFile()) && n < maxCount) {
    if (!f.isDirectory()) {
      const char *name = f.name();
      strncpy(out[n].id, name, sizeof(out[n].id) - 1);
      out[n].id[sizeof(out[n].id) - 1] = 0;
      size_t L = strlen(out[n].id);
      if (L > 4 && strcmp(out[n].id + L - 4, ".csv") == 0)
        out[n].id[L - 4] = 0;
      out[n].sizeBytes = f.size();
      out[n].modTime = f.getLastWrite();
      n++;
    }
    f.close();
  }
  dir.close();
  return n;
}

bool deleteSession(const char *id) {
  if (!g_ready)
    return false;
  char path[64];
  snprintf(path, sizeof(path), "/sessions/%s.csv", id);
  return SD.remove(path);
}

// Factory reset: empty /sessions. Returns how many files were removed.
uint32_t wipeAllSessions() {
  if (!g_ready)
    return 0;
  closeSession();
  File dir = SD.open("/sessions");
  if (!dir || !dir.isDirectory())
    return 0;
  uint32_t removed = 0;
  char path[80];
  File f;
  while ((f = dir.openNextFile())) {
    const bool isDir = f.isDirectory();
    const char *name = f.name();
    // File::name() is the bare name on ESP32 core 3.x, but tolerate a full
    // path so this can't silently delete nothing after a core bump.
    if (name[0] == '/')
      snprintf(path, sizeof(path), "%s", name);
    else
      snprintf(path, sizeof(path), "/sessions/%s", name);
    f.close();
    if (!isDir && SD.remove(path))
      removed++;
  }
  dir.close();
  return removed;
}

const char *sessionPath(const char *id, char *out, size_t n) {
  snprintf(out, n, "/sessions/%s.csv", id);
  return out;
}
} // namespace SdLogger

// ============================================================
//  STATUS LED MODULE
// ============================================================
namespace StatusLed {
enum State { BOOT, AP_UP, NODE_LINK, RECORDING, SD_ERROR };

static Adafruit_NeoPixel g_pixel(1, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
static State g_state = BOOT;
static uint32_t g_lastTickMs = 0;
static float g_phase = 0;

static void setColor(uint8_t r, uint8_t g, uint8_t b) {
  g_pixel.setPixelColor(0, g_pixel.Color(r, g, b));
  g_pixel.show();
}

void begin() {
  g_pixel.begin();
  g_pixel.setBrightness(40);
  setColor(40, 40, 40);
}

void setState(State s) {
  if (g_state == s)
    return;
  g_state = s;
}

void tick() {
  const uint32_t now = millis();
  if (now - g_lastTickMs < 40)
    return;
  g_lastTickMs = now;
  g_phase += 0.05f;
  const float pulse = (sinf(g_phase) + 1.0f) * 0.5f;

  switch (g_state) {
  case BOOT:
    setColor(40, 40, 40);
    break;
  case AP_UP:
    setColor(0, 30, 60);
    break;
  case NODE_LINK: {
    uint8_t b = (uint8_t)(80 + pulse * 80);
    setColor(0, b, 60);
    break;
  }
  case RECORDING: {
    uint8_t b = (uint8_t)(60 + pulse * 180);
    setColor(b, 0, 0);
    break;
  }
  case SD_ERROR:
    setColor(((now / 200) & 1) ? 255 : 0, 0, 0);
    break;
  }
}
} // namespace StatusLed

// ============================================================
//  WEB SERVER MODULE  (HTTP + WebSocket + REST API)
// ============================================================
namespace WebServerApp {
static AsyncWebServer g_http(HTTP_PORT);
static AsyncWebSocket g_ws(WS_PATH);
static DNSServer g_dns; // captive portal DNS
static uint32_t g_wsDropped =
    0; // frames dropped by backpressure (see broadcastImuFrame)

static const char *MODEL_PATH = "/model.json"; // legacy single model — migrated into the library on boot
static const char *MODELS_DIR = "/models";     // AI model library (many models, one active)
static const char *MODELS_ACTIVE = "/models/_active.txt"; // holds the active model's filename

// Set by POST /api/factory-reset; the loop reboots once the response is on the
// wire (rebooting from inside the handler kills the socket before the phone
// ever sees the reply).
static volatile uint32_t g_rebootAtMs = 0;

// While this is in the future the IMU stream is held back so an HTTP response
// (above all the 49 KB dashboard) can get through. See sendDashboard().
// Generous: a 49 KB document over a busy SoftAP can take a couple of seconds,
// and onDisconnect() ends the window early as soon as it actually lands, so the
// full duration is only ever spent when the transfer really is slow.
static constexpr uint32_t STREAM_QUIET_MS = 4000;
static volatile uint32_t g_streamQuietUntilMs = 0;
static uint32_t g_quietDrops = 0;

// How long every client may reject every batch before the whole set is dropped
// as wedged. Well above any normal congestion blip on a SoftAP.
static constexpr uint32_t WS_WEDGED_MS = 8000;
static uint32_t g_allDiscardSinceMs = 0;


// Tracks a document response from start to delivery. If onDisconnect never
// fires, the response stalled — the exact failure the user reports as a page
// that spins forever — and that fact gets written to the log instead of being
// invisible.
// A session download runs far longer than a page load, so its quiet window is
// renewed while it is in flight rather than being a single fixed timeout.
static constexpr uint32_t DOWNLOAD_QUIET_MS = 5000;
static volatile bool g_downloadActive = false;

static volatile uint32_t g_pageStartMs = 0;
static volatile bool g_pagePending = false;
static uint32_t g_pageOk = 0;
static uint32_t g_pageStalled = 0;

// ── Native HTTPS/WSS front end ─────────────────────────────────────────────
// ESPAsyncWebServer is intentionally left on port 80: its AsyncTCP transport
// in this build has no server-side TLS support.  esp_https_server is the
// Espressif-native TLS listener on :443.  It serves the same embedded UI and
// relays the existing REST handlers through a deliberately bounded loopback
// proxy, so the two transports cannot silently diverge.
static httpd_handle_t g_https = nullptr;
// Optional canonical DNS name read from HTTPS_HOST_PATH.  It affects only
// redirects/logging; TLS identity remains entirely the certificate SAN.
static String g_httpsCanonicalHost = HTTPS_DEFAULT_HOST;
// `max_open_sockets` is the number of *client sessions*.  ESP-IDF allocates
// its three listen/control sockets separately.  Keep exactly two TLS clients:
// one long-lived WSS stream and one serialized REST request.  More sessions
// exhaust the Main Node's internal heap during TLS handshakes.
static constexpr size_t HTTPS_MAX_OPEN_SOCKETS = 2; // WSS + one HTTPS request
static constexpr size_t HTTPS_MAX_URI_HANDLERS = 8;
static constexpr size_t HTTPS_PEM_MAX_BYTES = 16 * 1024;
static constexpr size_t HTTPS_WS_SNAPSHOT_MAX = 2048;
static constexpr size_t HTTPS_PROXY_URI_MAX = 768;
// API headers are small and bounded.  Keeping this modest is important because
// TLS itself needs internal RAM for every active client.
static constexpr size_t HTTPS_PROXY_HEADER_MAX = 2048;
static constexpr size_t HTTPS_PROXY_IO_BYTES = 2048;
static constexpr size_t HTTPS_PROXY_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
static constexpr uint32_t HTTPS_PROXY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
static constexpr uint32_t HTTPS_PROXY_TIMEOUT_MS = 8000;

// Native HTTPD runs URI handlers serially on its own task.  Keep the two large
// proxy header buffers out of that task's stack: together with response parser
// locals and the 2 KiB stream buffer, stack-local 4 KiB headers could overflow
// the 12 KiB HTTPS task during an ordinary /api/status response.
struct HttpsProxyScratch {
  char requestHead[HTTPS_PROXY_HEADER_MAX];
  char responseHead[HTTPS_PROXY_HEADER_MAX];
  uint8_t io[HTTPS_PROXY_IO_BYTES];
};
// The Main Node requires OPI PSRAM.  Keep streaming scratch there so a request
// cannot steal the internal heap needed for two simultaneous TLS sessions.
static EXT_RAM_BSS_ATTR HttpsProxyScratch g_httpsProxyScratch;

// These are the only SD files exposed by the HTTPS listener.  The cards used
// on rigs may contain sessions and private TLS material; never turn this into
// a general SD file server.
static const char *const HTTPS_MOCAP_ASSETS[] = {
    "/mocap/mediapipe/0.10.35/wasm/vision_wasm_internal.js",
    "/mocap/mediapipe/0.10.35/wasm/vision_wasm_internal.wasm",
    "/mocap/mediapipe/0.10.35/wasm/vision_wasm_nosimd_internal.js",
    "/mocap/mediapipe/0.10.35/wasm/vision_wasm_nosimd_internal.wasm",
    "/mocap/mediapipe/0.10.35/models/pose_landmarker_lite.task",
};
static constexpr size_t HTTPS_MOCAP_ASSET_COUNT =
    sizeof(HTTPS_MOCAP_ASSETS) / sizeof(HTTPS_MOCAP_ASSETS[0]);

static volatile uint8_t g_httpsWsClients = 0;
static volatile bool g_httpsWsTxPending = false;
static uint32_t g_httpsWsDropped = 0;
static portMUX_TYPE g_httpsWsMux = portMUX_INITIALIZER_UNLOCKED;

struct HttpsWsSnapshot {
  size_t len;
  uint8_t data[HTTPS_WS_SNAPSHOT_MAX];
};

static bool httpsExpired(uint32_t deadlineMs) {
  return (int32_t)(millis() - deadlineMs) >= 0;
}

static void httpsSetWsClients(uint8_t count) {
  taskENTER_CRITICAL(&g_httpsWsMux);
  g_httpsWsClients = count;
  taskEXIT_CRITICAL(&g_httpsWsMux);
}

static size_t httpsWsClientCount() {
  taskENTER_CRITICAL(&g_httpsWsMux);
  const uint8_t count = g_httpsWsClients;
  taskEXIT_CRITICAL(&g_httpsWsMux);
  return count;
}

static void httpsNoteWsDrop() {
  taskENTER_CRITICAL(&g_httpsWsMux);
  ++g_httpsWsDropped;
  taskEXIT_CRITICAL(&g_httpsWsMux);
}

static uint32_t httpsWsDroppedCount() {
  taskENTER_CRITICAL(&g_httpsWsMux);
  const uint32_t count = g_httpsWsDropped;
  taskEXIT_CRITICAL(&g_httpsWsMux);
  return count;
}

static bool httpsWsHasClients() {
  return g_https != nullptr && httpsWsClientCount() != 0;
}

// How many of the two TLS client sockets are occupied right now.
//
// Printed with every [STATS] line because it is the one number that tells the
// Offline bug apart from a radio problem: `tls=2/2 ws=0` means REST held both
// slots and the WebSocket handshake had nowhere to land, while `tls=0/2 ws=0`
// means the phone never reached the listener at all.
static size_t httpsSessionCount() {
  if (!g_https)
    return 0;
  int fds[HTTPS_MAX_OPEN_SOCKETS] = {};
  size_t fdCount = HTTPS_MAX_OPEN_SOCKETS;
  if (httpd_get_client_list(g_https, &fdCount, fds) != ESP_OK)
    return 0;
  return fdCount;
}

static void httpsCommonHeaders(httpd_req_t *req) {
  httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
  httpd_resp_set_hdr(req, "X-StrikeSense-Secure-Mode",
                     "https-wss-loopback-proxy");
}

// `Connection: close` is only a request to the browser; native HTTPD otherwise
// keeps the TLS session alive until that browser later sends another packet.
// This rig has exactly two TLS client slots, so actively schedule the close
// after each one-shot document/API/asset response.  The close is queued on the
// HTTPD task and therefore runs only after the handler has finished sending.
static void httpsCloseAfterResponse(httpd_req_t *req) {
  if (!g_https || !req)
    return;
  const int fd = httpd_req_to_sockfd(req);
  if (fd < 0)
    return;
  const esp_err_t err = httpd_sess_trigger_close(g_https, fd);
  if (err != ESP_OK)
    Serial.printf("[HTTPS] close fd=%d failed: 0x%lx\n", fd,
                  (unsigned long)err);
}

// One line per secure request: which socket served it and how full the pool was
// when it arrived.  Written because "the badge says Offline" cannot otherwise be
// told apart from "the phone is serving a cached dashboard and never asked us
// for anything".
static void httpsLogRequest(httpd_req_t *req, const char *what) {
  if (!req)
    return;
  Serial.printf("[HTTPS] fd=%d %s tls=%u/%u iheap=%lu\n",
                httpd_req_to_sockfd(req), what,
                (unsigned)httpsSessionCount(),
                (unsigned)HTTPS_MAX_OPEN_SOCKETS,
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}

// Keep the live stream at the head of the server's least-recently-used list.
//
// A server-push WebSocket receives nothing, so ESP-IDF's LRU bookkeeping ages
// it as if it were idle — which is why LRU eviction was switched off earlier in
// this debug, after it kept choosing the stream and causing an Offline/Live
// loop.  Marking the socket used on every push inverts that: the stream becomes
// the newest entry and the eviction candidate is always a REST session instead.
static void httpsTouchWsSession(int fd) {
  if (g_https && fd >= 0)
    httpd_sess_update_lru_counter(g_https, fd);
}

static esp_err_t httpsReply(httpd_req_t *req, const char *status,
                            const char *body) {
  // Every proxy failure ends here. Without this line a 502 is visible only as a
  // toast on the phone ("invalid legacy HTTP response"), with no way to tell
  // whether the legacy server refused the connection, timed out, or simply had
  // no memory left to build the response.
  if (status && status[0] == '5')
    Serial.printf("[HTTPS] %s uri=%s %s tls=%u/%u iheap=%lu\n", status,
                  req && req->uri ? req->uri : "?", body ? body : "",
                  (unsigned)httpsSessionCount(),
                  (unsigned)HTTPS_MAX_OPEN_SOCKETS,
                  (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
  httpd_resp_set_status(req, status);
  httpd_resp_set_type(req, "application/json; charset=utf-8");
  httpd_resp_set_hdr(req, "Connection", "close");
  httpsCommonHeaders(req);
  const esp_err_t err = httpd_resp_send(req, body, HTTPD_RESP_USE_STRLEN);
  httpsCloseAfterResponse(req);
  return err;
}

static bool httpsHeaderValueSafe(const char *value) {
  if (!value)
    return false;
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(value);
       *p; ++p) {
    // Response/header injection is never worth supporting.  The proxy only
    // relays ordinary printable HTTP field values from the local legacy server.
    if (*p < 0x20 || *p > 0x7e)
      return false;
  }
  return true;
}

static bool httpsCopyHeaderValue(char *dst, size_t dstSize, const char *src) {
  if (!dst || dstSize == 0 || !src)
    return false;
  const size_t n = strlen(src);
  if (n >= dstSize || !httpsHeaderValueSafe(src))
    return false;
  memcpy(dst, src, n + 1);
  return true;
}

static bool httpsHeaderNameIs(const char *name, const char *expected) {
  while (*name && *expected) {
    char a = *name++;
    char b = *expected++;
    if (a >= 'A' && a <= 'Z')
      a = char(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z')
      b = char(b - 'A' + 'a');
    if (a != b)
      return false;
  }
  return *name == 0 && *expected == 0;
}

static char *httpsTrimHeaderValue(char *value) {
  while (*value == ' ' || *value == '\t')
    ++value;
  char *end = value + strlen(value);
  while (end > value && (end[-1] == ' ' || end[-1] == '\t'))
    --end;
  *end = 0;
  return value;
}

static bool httpsParseContentLength(const char *value, uint32_t *out) {
  if (!value || !*value || !out)
    return false;
  uint64_t parsed = 0;
  for (const char *p = value; *p; ++p) {
    if (*p < '0' || *p > '9')
      return false;
    parsed = parsed * 10 + (uint32_t)(*p - '0');
    if (parsed > UINT32_MAX)
      return false;
  }
  *out = (uint32_t)parsed;
  return true;
}

static bool httpsAppend(char *dst, size_t dstSize, size_t *used,
                        const char *text) {
  if (!dst || !used || !text)
    return false;
  const size_t n = strlen(text);
  if (*used + n >= dstSize)
    return false;
  memcpy(dst + *used, text, n);
  *used += n;
  dst[*used] = 0;
  return true;
}

static bool httpsAppendForwardedHeader(char *dst, size_t dstSize, size_t *used,
                                       const char *name, const char *value) {
  if (!value || !value[0])
    return true;
  return httpsAppend(dst, dstSize, used, name) &&
         httpsAppend(dst, dstSize, used, ": ") &&
         httpsAppend(dst, dstSize, used, value) &&
         httpsAppend(dst, dstSize, used, "\r\n");
}

static bool httpsRawSendAll(httpd_req_t *req, const uint8_t *data,
                            size_t dataLen) {
  while (dataLen) {
    const int sent = httpd_send(req, reinterpret_cast<const char *>(data),
                                dataLen);
    if (sent <= 0)
      return false;
    data += sent;
    dataLen -= (size_t)sent;
  }
  return true;
}

static bool httpsClientWriteAll(WiFiClient &client, const uint8_t *data,
                                size_t dataLen, uint32_t deadlineMs) {
  while (dataLen) {
    if (httpsExpired(deadlineMs))
      return false;
    const size_t written = client.write(data, dataLen);
    if (written == 0) {
      delay(1);
      continue;
    }
    data += written;
    dataLen -= written;
  }
  return true;
}

static bool httpsReadUpstreamByte(WiFiClient &client, char *out,
                                  uint32_t deadlineMs) {
  while (!client.available()) {
    if (!client.connected() || httpsExpired(deadlineMs))
      return false;
    delay(1);
  }
  const int byteRead = client.read();
  if (byteRead < 0)
    return false;
  *out = (char)byteRead;
  return true;
}

static bool httpsReadUpstreamLine(WiFiClient &client, char *out,
                                  size_t outSize, uint32_t deadlineMs) {
  if (!out || outSize < 2)
    return false;
  size_t n = 0;
  for (;;) {
    char c = 0;
    if (!httpsReadUpstreamByte(client, &c, deadlineMs))
      return false;
    if (c == '\n') {
      out[n] = 0;
      return true;
    }
    if (c == '\r')
      continue;
    if ((unsigned char)c < 0x20 || (unsigned char)c > 0x7e || n + 1 >= outSize)
      return false;
    out[n++] = c;
  }
}

static bool httpsBuildProxyUri(httpd_req_t *req, char *out, size_t outSize) {
  if (!req || !out || outSize < 8)
    return false;
  const size_t rawLen = strnlen(req->uri, outSize);
  if (rawLen == 0 || rawLen >= outSize)
    return false;
  memcpy(out, req->uri, rawLen + 1);

  // ESP-IDF versions differ on whether req->uri retains the query string.
  // Preserve it if present; otherwise obtain it from the dedicated API.
  if (!strchr(out, '?')) {
    const size_t queryLen = httpd_req_get_url_query_len(req);
    if (queryLen) {
      if (rawLen + queryLen + 2 > outSize)
        return false;
      out[rawLen] = '?';
      if (httpd_req_get_url_query_str(req, out + rawLen + 1,
                                      outSize - rawLen - 1) != ESP_OK)
        return false;
    }
  }
  if ((strncmp(out, "/api/", 5) != 0 && strcmp(out, "/api") != 0))
    return false;
  // A URI is interpolated into the loopback HTTP request line, so it is stricter
  // than a safe header value: no whitespace/control character can be allowed.
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(out);
       *p; ++p) {
    if (*p <= 0x20 || *p > 0x7e)
      return false;
  }
  return true;
}

static bool httpsGetRequestHeader(httpd_req_t *req, const char *name,
                                  char *out, size_t outSize) {
  if (!out || outSize == 0)
    return false;
  out[0] = 0;
  const size_t valueLen = httpd_req_get_hdr_value_len(req, name);
  if (valueLen == 0)
    return true;
  if (valueLen >= outSize ||
      httpd_req_get_hdr_value_str(req, name, out, outSize) != ESP_OK)
    return false;
  return httpsHeaderValueSafe(out);
}

static bool httpsConnectLegacy(WiFiClient &upstream) {
  // Some Arduino core builds do not expose 127.0.0.1 through esp-netif.  Try
  // loopback first, then the rig AP address; neither target is client supplied.
  if (upstream.connect(IPAddress(127, 0, 0, 1), HTTP_PORT, 1200))
    return true;
  upstream.stop();
  return upstream.connect(WiFi.softAPIP(), HTTP_PORT, 1200);
}

static bool httpsSendRequestBody(httpd_req_t *req, WiFiClient &upstream,
                                 uint32_t deadlineMs) {
  uint8_t *io = g_httpsProxyScratch.io;
  size_t remaining = req->content_len;
  while (remaining) {
    if (httpsExpired(deadlineMs))
      return false;
    const size_t want = remaining < sizeof(io) ? remaining : sizeof(io);
    const int received = httpd_req_recv(req, reinterpret_cast<char *>(io), want);
    if (received == HTTPD_SOCK_ERR_TIMEOUT)
      continue;
    if (received <= 0)
      return false;
    if (!httpsClientWriteAll(upstream, io, (size_t)received, deadlineMs))
      return false;
    remaining -= (size_t)received;
  }
  return true;
}

static bool httpsSendUpstreamBody(httpd_req_t *req, WiFiClient &upstream,
                                  uint32_t remaining,
                                  uint32_t deadlineMs) {
  uint8_t *io = g_httpsProxyScratch.io;
  while (remaining) {
    if (httpsExpired(deadlineMs))
      return false;
    int available = upstream.available();
    if (available <= 0) {
      if (!upstream.connected())
        return false;
      delay(1);
      continue;
    }
    size_t want = remaining < sizeof(io) ? remaining : sizeof(io);
    if ((size_t)available < want)
      want = (size_t)available;
    const int received = upstream.read(io, want);
    if (received <= 0)
      return false;
    if (!httpsRawSendAll(req, io, (size_t)received))
      return false;
    remaining -= (uint32_t)received;
  }
  return true;
}

static esp_err_t httpsDashboardHandler(httpd_req_t *req) {
  // Log the path, not just "dashboard": `/` and `/new` are the same document
  // but not the same cache entry, and which one a phone actually asked for is
  // the difference between a fresh build and a stale one.
  httpsLogRequest(req, req->uri);
  const uint32_t startedMs = millis();
  g_streamQuietUntilMs = startedMs + STREAM_QUIET_MS;
  g_pageStartMs = startedMs;
  g_pagePending = true;

  httpd_resp_set_type(req, "text/html; charset=utf-8");
  httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache, no-store, must-revalidate");
  httpd_resp_set_hdr(req, "Connection", "close");
  httpsCommonHeaders(req);
  const esp_err_t err = httpd_resp_send(
      req, reinterpret_cast<const char *>(DASHBOARD_HTML_GZ),
      DASHBOARD_HTML_GZ_LEN);
  httpsCloseAfterResponse(req);
  g_streamQuietUntilMs = 0;
  g_pagePending = false;
  if (err == ESP_OK)
    ++g_pageOk;
  else
    ++g_pageStalled;
  DLOG("HTTPS", "dashboard %s in %lu ms", err == ESP_OK ? "sent" : "failed",
       (unsigned long)(millis() - startedMs));
  return err;
}

static bool httpsMocapAssetAllowed(const char *path) {
  for (size_t i = 0; i < HTTPS_MOCAP_ASSET_COUNT; ++i) {
    if (strcmp(path, HTTPS_MOCAP_ASSETS[i]) == 0)
      return true;
  }
  return false;
}

static const char *httpsMocapContentType(const char *path) {
  if (strstr(path, ".js"))
    return "text/javascript; charset=utf-8";
  if (strstr(path, ".wasm"))
    return "application/wasm";
  return "application/octet-stream"; // MediaPipe .task
}

static esp_err_t httpsMocapAssetHandler(httpd_req_t *req) {
  httpsLogRequest(req, "mocap asset");
  // Query variations are not an additional public surface: the exact five
  // manifest paths above are all that can be read from SD through HTTPS.
  if (httpd_req_get_url_query_len(req) != 0 ||
      !httpsMocapAssetAllowed(req->uri))
    return httpsReply(req, "404 Not Found", "{\"error\":\"mocap asset not found\"}");
  if (!SdLogger::isReady())
    return httpsReply(req, "503 Service Unavailable", "{\"error\":\"sd unavailable\"}");

  File asset = SD.open(req->uri, FILE_READ);
  if (!asset || asset.isDirectory()) {
    if (asset)
      asset.close();
    return httpsReply(req, "404 Not Found", "{\"error\":\"mocap asset missing\"}");
  }

  httpd_resp_set_type(req, httpsMocapContentType(req->uri));
  httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000, immutable");
  // A MediaPipe asset is a complete one-shot transfer.  Release the scarce TLS
  // client slot as soon as it finishes instead of leaving it idle beside WSS.
  httpd_resp_set_hdr(req, "Connection", "close");
  httpsCommonHeaders(req);
  uint8_t io[HTTPS_PROXY_IO_BYTES];
  esp_err_t err = ESP_OK;
  while (asset.available()) {
    const size_t got = asset.read(io, sizeof(io));
    if (got == 0) {
      err = ESP_FAIL;
      break;
    }
    err = httpd_resp_send_chunk(req, reinterpret_cast<const char *>(io), got);
    if (err != ESP_OK)
      break;
  }
  asset.close();
  if (err == ESP_OK)
    err = httpd_resp_send_chunk(req, nullptr, 0);
  httpsCloseAfterResponse(req);
  return err;
}

static esp_err_t httpsSecureStatusHandler(httpd_req_t *req) {
  // `build` is the stamp of the dashboard this firmware has embedded. A phone
  // that cached the page before a flash keeps running the old JavaScript and
  // cannot tell — the document itself is what is stale. Naming the served build
  // in a few dozen bytes of JSON lets the page notice without re-downloading
  // 400 KB over TLS to find out.
  static const char STATUS[] =
      "{\"https\":true,\"wss\":true,\"build\":\"" DASHBOARD_BUILD_ID "\","
      "\"apiProxy\":{\"mode\":\"loopback\","
      "\"methods\":[\"GET\",\"POST\",\"DELETE\"],\"requestMaxBytes\":2097152,"
      "\"responseMaxBytes\":8388608,\"chunkedUpstream\":\"rejected\"},"
      "\"mocapAssets\":\"strict-sd-allowlist\",\"certificatePath\":\"/tls/server-cert.pem\"}";
  // Only a dashboard carrying the build-stamp check asks for this. Its presence
  // in the log is therefore proof that the phone is running the current build,
  // which no other request can establish.
  httpsLogRequest(req, "secure-status (fresh build)");
  httpd_resp_set_type(req, "application/json; charset=utf-8");
  httpd_resp_set_hdr(req, "Connection", "close");
  httpsCommonHeaders(req);
  const esp_err_t err = httpd_resp_send(req, STATUS, sizeof(STATUS) - 1);
  httpsCloseAfterResponse(req);
  return err;
}

static esp_err_t httpsWsHandler(httpd_req_t *req) {
  if (req->method == IDF_HTTP_GET) {
    // The native server completes the upgrade before this callback.  A precise
    // count is refreshed in the queued sender; setting one here ensures the
    // first IMU batch is not lost between handshake and that refresh.
    httpsSetWsClients(1);
    httpsLogRequest(req, "ws upgrade");
    httpsTouchWsSession(httpd_req_to_sockfd(req));
    return ESP_OK;
  }

  // Dashboard telemetry is server-push only.  Consume small client messages so
  // a browser ping/text frame cannot wedge the session; close oversized input.
  httpd_ws_frame_t frame = {};
  esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
  if (err != ESP_OK || frame.len > 256)
    return ESP_FAIL;
  if (frame.len) {
    uint8_t discard[256];
    frame.payload = discard;
    err = httpd_ws_recv_frame(req, &frame, sizeof(discard));
  }
  return err;
}

static void httpsWsSendWork(void *arg) {
  HttpsWsSnapshot *snapshot = static_cast<HttpsWsSnapshot *>(arg);
  uint8_t wsCount = 0;
  if (g_https && snapshot) {
    int fds[HTTPS_MAX_OPEN_SOCKETS] = {};
    size_t fdCount = HTTPS_MAX_OPEN_SOCKETS;
    if (httpd_get_client_list(g_https, &fdCount, fds) == ESP_OK) {
      httpd_ws_frame_t frame = {};
      frame.type = HTTPD_WS_TYPE_BINARY;
      frame.payload = snapshot->data;
      frame.len = snapshot->len;
      for (size_t i = 0; i < fdCount; ++i) {
        if (httpd_ws_get_fd_info(g_https, fds[i]) !=
            HTTPD_WS_CLIENT_WEBSOCKET)
          continue;
        ++wsCount;
        httpsTouchWsSession(fds[i]);
        if (httpd_ws_send_frame_async(g_https, fds[i], &frame) != ESP_OK)
          httpsNoteWsDrop();
      }
    }
  }
  taskENTER_CRITICAL(&g_httpsWsMux);
  g_httpsWsClients = wsCount;
  g_httpsWsTxPending = false;
  taskEXIT_CRITICAL(&g_httpsWsMux);
  free(snapshot);
}

static void queueHttpsWsBatch(const uint8_t *data, size_t dataLen) {
  if (!httpsWsHasClients() || !data || dataLen == 0 ||
      dataLen > HTTPS_WS_SNAPSHOT_MAX)
    return;
  if (ESP.getFreeHeap() < 48 * 1024) {
    httpsNoteWsDrop();
    return;
  }

  HttpsWsSnapshot *snapshot =
      static_cast<HttpsWsSnapshot *>(malloc(sizeof(HttpsWsSnapshot)));
  if (!snapshot) {
    httpsNoteWsDrop();
    return;
  }
  snapshot->len = dataLen;
  memcpy(snapshot->data, data, dataLen);

  bool queueIt = false;
  taskENTER_CRITICAL(&g_httpsWsMux);
  if (!g_httpsWsTxPending) {
    g_httpsWsTxPending = true;
    queueIt = true;
  }
  taskEXIT_CRITICAL(&g_httpsWsMux);
  if (!queueIt) {
    free(snapshot); // coalesce rather than retaining an ever-growing backlog
    httpsNoteWsDrop();
    return;
  }

  if (httpd_queue_work(g_https, httpsWsSendWork, snapshot) != ESP_OK) {
    taskENTER_CRITICAL(&g_httpsWsMux);
    g_httpsWsTxPending = false;
    taskEXIT_CRITICAL(&g_httpsWsMux);
    free(snapshot);
    httpsNoteWsDrop();
  }
}

// Below this the rig is one TLS handshake away from an allocation failure, and
// a Guru Meditation was seen at comparable pressure earlier in this debug.
static constexpr size_t HTTPS_PROXY_MIN_INTERNAL_HEAP = 32 * 1024;

static esp_err_t httpsProxyHandler(httpd_req_t *req) {
  httpsLogRequest(req, req->uri);
  // Serving /api/model streams the whole trained network (~140 KB) up from SD
  // through the legacy server, and internal heap was measured falling to about
  // 22 KiB while it ran. Refuse it while memory is that tight rather than take
  // the rig down: the dashboard treats a failed model read as "not available"
  // and falls back to its own cached copy.
  if (heap_caps_get_free_size(MALLOC_CAP_INTERNAL) < HTTPS_PROXY_MIN_INTERNAL_HEAP) {
    Serial.printf("[HTTPS] %s refused: internal heap %lu below floor\n", req->uri,
                  (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    return httpsReply(req, "503 Service Unavailable",
                      "{\"error\":\"rig memory low, retry shortly\"}");
  }
  const char *method = nullptr;
  if (req->method == IDF_HTTP_GET)
    method = "GET";
  else if (req->method == IDF_HTTP_POST)
    method = "POST";
  else if (req->method == IDF_HTTP_DELETE)
    method = "DELETE";
  else
    return httpsReply(req, "405 Method Not Allowed",
                      "{\"error\":\"HTTPS proxy supports GET, POST, DELETE\"}");

  if (req->content_len > HTTPS_PROXY_MAX_REQUEST_BYTES)
    return httpsReply(req, "413 Payload Too Large",
                      "{\"error\":\"HTTPS proxy request limit is 2 MiB\"}");
  if (httpd_req_get_hdr_value_len(req, "Transfer-Encoding") != 0)
    return httpsReply(req, "400 Bad Request",
                      "{\"error\":\"chunked request bodies are unsupported\"}");

  char uri[HTTPS_PROXY_URI_MAX] = {};
  if (!httpsBuildProxyUri(req, uri, sizeof(uri)))
    return httpsReply(req, "400 Bad Request", "{\"error\":\"invalid API URI\"}");
  char contentType[160] = {};
  if (!httpsGetRequestHeader(req, "Content-Type", contentType,
                             sizeof(contentType)))
    return httpsReply(req, "431 Request Header Fields Too Large",
                      "{\"error\":\"unsupported Content-Type header\"}");

  WiFiClient upstream;
  if (!httpsConnectLegacy(upstream))
    return httpsReply(req, "502 Bad Gateway",
                      "{\"error\":\"legacy HTTP server unavailable\"}");
  upstream.setTimeout(2);
  const uint32_t deadlineMs = millis() + HTTPS_PROXY_TIMEOUT_MS;

  char *requestHead = g_httpsProxyScratch.requestHead;
  const int requestHeadLen = snprintf(
      requestHead, HTTPS_PROXY_HEADER_MAX,
      "%s %s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n"
      "Content-Length: %lu\r\n%s%s\r\n",
      method, uri, (unsigned long)req->content_len,
      contentType[0] ? "Content-Type: " : "", contentType[0] ? contentType : "");
  if (requestHeadLen <= 0 || (size_t)requestHeadLen >= HTTPS_PROXY_HEADER_MAX ||
      !httpsClientWriteAll(upstream,
                           reinterpret_cast<const uint8_t *>(requestHead),
                           (size_t)requestHeadLen, deadlineMs) ||
      !httpsSendRequestBody(req, upstream, deadlineMs)) {
    upstream.stop();
    return httpsReply(req, "504 Gateway Timeout",
                      "{\"error\":\"legacy HTTP request timed out\"}");
  }

  char line[512] = {};
  if (!httpsReadUpstreamLine(upstream, line, sizeof(line), deadlineMs)) {
    upstream.stop();
    return httpsReply(req, "502 Bad Gateway",
                      "{\"error\":\"invalid legacy HTTP response\"}");
  }
  const char *statusStart = strchr(line, ' ');
  if (!statusStart || strncmp(line, "HTTP/1.", 7) != 0 ||
      statusStart[1] < '0' || statusStart[1] > '9' ||
      statusStart[2] < '0' || statusStart[2] > '9' ||
      statusStart[3] < '0' || statusStart[3] > '9' ||
      (statusStart[4] && statusStart[4] != ' ') ||
      !httpsHeaderValueSafe(statusStart + 1)) {
    upstream.stop();
    return httpsReply(req, "502 Bad Gateway",
                      "{\"error\":\"unsupported legacy status line\"}");
  }
  const uint16_t statusCode = (uint16_t)((statusStart[1] - '0') * 100 +
                                         (statusStart[2] - '0') * 10 +
                                         (statusStart[3] - '0'));
  char status[96] = {};
  if (!httpsCopyHeaderValue(status, sizeof(status), statusStart + 1)) {
    upstream.stop();
    return httpsReply(req, "502 Bad Gateway",
                      "{\"error\":\"legacy status is too long\"}");
  }

  bool sawContentLength = false;
  bool sawTransferEncoding = false;
  uint32_t responseLength = 0;
  size_t headerBytes = 0;
  char responseType[160] = "application/octet-stream";
  char contentEncoding[96] = {};
  char contentDisposition[192] = {};
  char cacheControl[160] = {};
  char etag[128] = {};
  char lastModified[96] = {};
  for (;;) {
    if (!httpsReadUpstreamLine(upstream, line, sizeof(line), deadlineMs)) {
      upstream.stop();
      return httpsReply(req, "502 Bad Gateway",
                        "{\"error\":\"truncated legacy response headers\"}");
    }
    headerBytes += strlen(line) + 2;
    if (headerBytes > HTTPS_PROXY_HEADER_MAX) {
      upstream.stop();
      return httpsReply(req, "502 Bad Gateway",
                        "{\"error\":\"legacy response headers too large\"}");
    }
    if (!line[0])
      break;
    char *colon = strchr(line, ':');
    if (!colon) {
      upstream.stop();
      return httpsReply(req, "502 Bad Gateway",
                        "{\"error\":\"malformed legacy response header\"}");
    }
    *colon = 0;
    char *value = httpsTrimHeaderValue(colon + 1);
    if (!httpsHeaderValueSafe(value)) {
      upstream.stop();
      return httpsReply(req, "502 Bad Gateway",
                        "{\"error\":\"unsafe legacy response header\"}");
    }
    if (httpsHeaderNameIs(line, "Content-Length")) {
      uint32_t parsedLength = 0;
      if (!httpsParseContentLength(value, &parsedLength) ||
          (sawContentLength && parsedLength != responseLength)) {
        upstream.stop();
        return httpsReply(req, "502 Bad Gateway",
                          "{\"error\":\"invalid legacy Content-Length\"}");
      }
      responseLength = parsedLength;
      sawContentLength = true;
    } else if (httpsHeaderNameIs(line, "Transfer-Encoding")) {
      sawTransferEncoding = true;
    } else if (httpsHeaderNameIs(line, "Content-Type")) {
      if (!httpsCopyHeaderValue(responseType, sizeof(responseType), value))
        sawTransferEncoding = true; // force a clean error before bytes are sent
    } else if (httpsHeaderNameIs(line, "Content-Encoding")) {
      if (!httpsCopyHeaderValue(contentEncoding, sizeof(contentEncoding), value))
        sawTransferEncoding = true;
    } else if (httpsHeaderNameIs(line, "Content-Disposition")) {
      if (!httpsCopyHeaderValue(contentDisposition, sizeof(contentDisposition),
                                value))
        sawTransferEncoding = true;
    } else if (httpsHeaderNameIs(line, "Cache-Control")) {
      if (!httpsCopyHeaderValue(cacheControl, sizeof(cacheControl), value))
        sawTransferEncoding = true;
    } else if (httpsHeaderNameIs(line, "ETag")) {
      if (!httpsCopyHeaderValue(etag, sizeof(etag), value))
        sawTransferEncoding = true;
    } else if (httpsHeaderNameIs(line, "Last-Modified")) {
      if (!httpsCopyHeaderValue(lastModified, sizeof(lastModified), value))
        sawTransferEncoding = true;
    }
  }

  const bool noBodyStatus = (statusCode >= 100 && statusCode < 200) ||
                            statusCode == 204 || statusCode == 304;
  if (sawTransferEncoding || (!sawContentLength && !noBodyStatus) ||
      responseLength > HTTPS_PROXY_MAX_RESPONSE_BYTES) {
    upstream.stop();
    return httpsReply(req, "502 Bad Gateway",
                      "{\"error\":\"legacy response needs fixed Content-Length and is limited to 8 MiB\"}");
  }
  if (noBodyStatus)
    responseLength = 0;

  // Use raw httpd_send() only after the full upstream header has been validated.
  // It lets the HTTPS response retain the legacy Content-Length while the body
  // streams in bounded chunks, rather than silently converting it to chunked.
  char *responseHead = g_httpsProxyScratch.responseHead;
  size_t responseHeadLen = 0;
  bool headersOk =
      httpsAppend(responseHead, HTTPS_PROXY_HEADER_MAX, &responseHeadLen,
                  "HTTP/1.1 ") &&
      httpsAppend(responseHead, HTTPS_PROXY_HEADER_MAX, &responseHeadLen, status) &&
      httpsAppend(responseHead, HTTPS_PROXY_HEADER_MAX, &responseHeadLen, "\r\n") &&
      httpsAppend(responseHead, HTTPS_PROXY_HEADER_MAX, &responseHeadLen,
                  "Content-Type: ") &&
      httpsAppend(responseHead, HTTPS_PROXY_HEADER_MAX, &responseHeadLen,
                  responseType);
  char contentLengthLine[40] = {};
  snprintf(contentLengthLine, sizeof(contentLengthLine), "\r\nContent-Length: %lu\r\n",
           (unsigned long)responseLength);
  headersOk = headersOk &&
              httpsAppend(responseHead, HTTPS_PROXY_HEADER_MAX, &responseHeadLen,
                          contentLengthLine) &&
              httpsAppendForwardedHeader(responseHead, HTTPS_PROXY_HEADER_MAX,
                                          &responseHeadLen, "Content-Encoding",
                                          contentEncoding) &&
              httpsAppendForwardedHeader(responseHead, HTTPS_PROXY_HEADER_MAX,
                                          &responseHeadLen, "Content-Disposition",
                                          contentDisposition) &&
              httpsAppendForwardedHeader(responseHead, HTTPS_PROXY_HEADER_MAX,
                                          &responseHeadLen, "Cache-Control",
                                          cacheControl) &&
              httpsAppendForwardedHeader(responseHead, HTTPS_PROXY_HEADER_MAX,
                                          &responseHeadLen, "ETag", etag) &&
              httpsAppendForwardedHeader(responseHead, HTTPS_PROXY_HEADER_MAX,
                                          &responseHeadLen, "Last-Modified",
                                          lastModified) &&
              httpsAppend(responseHead, HTTPS_PROXY_HEADER_MAX, &responseHeadLen,
                          "Connection: close\r\nX-Content-Type-Options: nosniff\r\n"
                          "X-StrikeSense-Secure-Mode: https-wss-loopback-proxy\r\n\r\n");
  if (!headersOk ||
      !httpsRawSendAll(req, reinterpret_cast<const uint8_t *>(responseHead),
                       responseHeadLen)) {
    upstream.stop();
    return ESP_FAIL;
  }
  const bool bodyOk =
      httpsSendUpstreamBody(req, upstream, responseLength, deadlineMs);
  upstream.stop();
  httpsCloseAfterResponse(req);
  return bodyOk ? ESP_OK : ESP_FAIL; // close rather than fabricate a partial body
}

static uint8_t *httpsLoadPemFromSd(const char *path, size_t *pemLen) {
  if (pemLen)
    *pemLen = 0;
  if (!SdLogger::isReady())
    return nullptr;
  File pem = SD.open(path, FILE_READ);
  if (!pem || pem.isDirectory()) {
    if (pem)
      pem.close();
    return nullptr;
  }
  const size_t bytes = pem.size();
  if (bytes == 0 || bytes > HTTPS_PEM_MAX_BYTES) {
    pem.close();
    return nullptr;
  }
  uint8_t *contents = static_cast<uint8_t *>(malloc(bytes + 1));
  if (!contents) {
    pem.close();
    return nullptr;
  }
  size_t offset = 0;
  while (offset < bytes) {
    const size_t got = pem.read(contents + offset, bytes - offset);
    if (got == 0)
      break;
    offset += got;
  }
  pem.close();
  if (offset != bytes) {
    free(contents);
    return nullptr;
  }
  contents[bytes] = 0; // PEM parser accepts the terminating NUL in the length
  if (pemLen)
    *pemLen = bytes + 1;
  return contents;
}

// The hostname file is deliberately a narrow, non-secret setting.  Validate it
// before using it in a Location header: an SD card must never be able to inject
// header syntax or redirect a connected phone to an arbitrary URL.
static bool httpsIsDnsHostname(const String &host) {
  const size_t length = host.length();
  if (length == 0 || length > 253 || host.endsWith("."))
    return false;

  size_t labelLength = 0;
  for (size_t i = 0; i < length; ++i) {
    const char c = host[i];
    if (c == '.') {
      if (labelLength == 0 || labelLength > 63 || host[i - 1] == '-')
        return false;
      labelLength = 0;
      continue;
    }
    const bool alpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    const bool digit = c >= '0' && c <= '9';
    if (!(alpha || digit || c == '-') || labelLength == 0 && c == '-')
      return false;
    ++labelLength;
  }
  return labelLength > 0 && labelLength <= 63 && host[length - 1] != '-';
}

static bool httpsLoadCanonicalHost() {
  g_httpsCanonicalHost = HTTPS_DEFAULT_HOST;
  if (!SdLogger::isReady() || !SD.exists(HTTPS_HOST_PATH))
    return true; // Local-CA/IP deployment stays compatible without this file.

  File file = SD.open(HTTPS_HOST_PATH, FILE_READ);
  if (!file || file.isDirectory()) {
    if (file)
      file.close();
    return false;
  }
  const size_t bytes = file.size();
  if (bytes == 0 || bytes > 255) {
    file.close();
    return false;
  }
  String host;
  host.reserve(bytes);
  while (file.available())
    host += static_cast<char>(file.read());
  file.close();
  host.trim(); // Permit the conventional final newline, but nothing internal.
  if (!httpsIsDnsHostname(host))
    return false;
  host.toLowerCase();
  g_httpsCanonicalHost = host;
  return true;
}

static String httpsCanonicalUrl() {
  return String("https://") + g_httpsCanonicalHost + "/";
}

static bool httpsRegisterRoute(const char *uri, httpd_method_t method,
                               esp_err_t (*handler)(httpd_req_t *),
                               bool websocket = false) {
  httpd_uri_t route = {};
  route.uri = uri;
  route.method = method;
  route.handler = handler;
  route.is_websocket = websocket;
  const esp_err_t err = httpd_register_uri_handler(g_https, &route);
  if (err != ESP_OK) {
    Serial.printf("[HTTPS] route %s failed: 0x%lx\n", uri,
                  (unsigned long)err);
    return false;
  }
  return true;
}

// The precompiled Arduino IDF is built with CONFIG_LOG_MAXIMUM_LEVEL=1, so
// every ESP_LOGW/ESP_LOGI inside esp_http_server is compiled out and cannot be
// restored with esp_log_level_set(). A request the server rejects before it
// reaches a URI handler — a 404, a header that does not fit, an unsupported
// method — therefore leaves no trace at all. These handlers put that trace
// back, which is the only way to tell "the WebSocket upgrade was refused" apart
// from "the phone never sent one".
static esp_err_t httpsErrorHandler(httpd_req_t *req, httpd_err_code_t error) {
  Serial.printf("[HTTPS] rejected code=%d uri=%s tls=%u/%u iheap=%lu\n",
                (int)error, req && req->uri ? req->uri : "?",
                (unsigned)httpsSessionCount(),
                (unsigned)HTTPS_MAX_OPEN_SOCKETS,
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
  httpd_resp_send_err(req, error, nullptr);
  return ESP_FAIL; // same as the stock handler: the socket is done
}

static void httpsRegisterErrorLogging() {
  static const httpd_err_code_t CODES[] = {
      HTTPD_500_INTERNAL_SERVER_ERROR, HTTPD_501_METHOD_NOT_IMPLEMENTED,
      HTTPD_505_VERSION_NOT_SUPPORTED, HTTPD_400_BAD_REQUEST,
      HTTPD_404_NOT_FOUND,             HTTPD_405_METHOD_NOT_ALLOWED,
      HTTPD_408_REQ_TIMEOUT,           HTTPD_414_URI_TOO_LONG,
      HTTPD_431_REQ_HDR_FIELDS_TOO_LARGE,
  };
  for (httpd_err_code_t code : CODES)
    httpd_register_err_handler(g_https, code, httpsErrorHandler);
}

static bool httpsRegisterRoutes() {
  return httpsRegisterRoute("/", IDF_HTTP_GET, httpsDashboardHandler) &&
         httpsRegisterRoute("/index.html", IDF_HTTP_GET, httpsDashboardHandler) &&
         // Same document, a URL no phone has ever cached.
         //
         // `/` was served for a day with `Cache-Control: public, max-age=86400`
         // by an earlier build, so a phone that loaded it then keeps running
         // that JavaScript without asking the rig anything — no server-side
         // header can reach a cache entry the browser never revalidates. A
         // different path is a different cache key, so this one always comes
         // from the rig. Once loaded, checkFreshness() handles later flashes.
         httpsRegisterRoute("/new", IDF_HTTP_GET, httpsDashboardHandler) &&
         httpsRegisterRoute("/mocap/*", IDF_HTTP_GET, httpsMocapAssetHandler) &&
         httpsRegisterRoute("/api/secure-status", IDF_HTTP_GET,
                            httpsSecureStatusHandler) &&
         httpsRegisterRoute("/api/*", (httpd_method_t)HTTP_ANY,
                            httpsProxyHandler) &&
         httpsRegisterRoute(WS_PATH, IDF_HTTP_GET, httpsWsHandler, true);
}

static bool beginHttps() {
  if (!SdLogger::isReady()) {
    Serial.println("[HTTPS] disabled: SD is unavailable (TLS PEM files are on SD)");
    return false;
  }
  if (!httpsLoadCanonicalHost()) {
    Serial.printf("[HTTPS] disabled: %s must contain one valid DNS hostname\n",
                  HTTPS_HOST_PATH);
    return false;
  }

  size_t certLen = 0;
  size_t keyLen = 0;
  uint8_t *cert = httpsLoadPemFromSd(HTTPS_CERT_PATH, &certLen);
  uint8_t *key = httpsLoadPemFromSd(HTTPS_KEY_PATH, &keyLen);
  if (!cert || !key) {
    free(cert);
    free(key);
    Serial.printf("[HTTPS] disabled: add PEM cert %s and key %s on SD\n",
                  HTTPS_CERT_PATH, HTTPS_KEY_PATH);
    return false;
  }

  httpd_ssl_config_t config = HTTPD_SSL_CONFIG_DEFAULT();
  config.httpd.max_open_sockets = HTTPS_MAX_OPEN_SOCKETS;
  config.httpd.max_uri_handlers = HTTPS_MAX_URI_HANDLERS;
  config.httpd.max_resp_headers = 8;
  config.httpd.stack_size = 12288;
  config.httpd.recv_wait_timeout = 2;
  config.httpd.send_wait_timeout = 2;
  // A full pool must never be able to lock the live stream out permanently.
  //
  // With eviction off, two REST sessions that outlived their responses held
  // both slots for as long as the phone stayed on the page (`tls=2/2 ws=0` in
  // [STATS]) and no WebSocket handshake could ever land.  Eviction is back on,
  // and the stream is protected instead by httpsTouchWsSession(): every pushed
  // IMU batch marks that socket as the most recently used, so the victim is
  // always a REST session.
  config.httpd.lru_purge_enable = true;
  config.httpd.uri_match_fn = httpd_uri_match_wildcard;
  // Wrong-SNI/background probes must not hold one of the two TLS slots for the
  // 10-second ESP-IDF default handshake timeout.
  config.tls_handshake_timeout_ms = 4000;
  config.port_secure = HTTPS_PORT;
  config.servercert = cert;
  config.servercert_len = certLen;
  config.prvtkey_pem = key;
  config.prvtkey_len = keyLen;

  const esp_err_t startErr = httpd_ssl_start(&g_https, &config);
  // esp_https_server copies both PEM buffers into its TLS context during start.
  // Keeping the key in a global buffer would only prolong its lifetime in RAM.
  free(cert);
  free(key);
  if (startErr != ESP_OK || !g_https) {
    g_https = nullptr;
    Serial.printf("[HTTPS] disabled: TLS server start failed (0x%lx)\n",
                  (unsigned long)startErr);
    return false;
  }
  httpsRegisterErrorLogging();
  if (!httpsRegisterRoutes()) {
    httpd_ssl_stop(g_https);
    g_https = nullptr;
    Serial.println("[HTTPS] disabled: native route registration failed");
    return false;
  }

  Serial.printf("[HTTPS] Listening on %s (cert SAN must match)\n",
                httpsCanonicalUrl().c_str());
  return true;
}

static void macToStr(const uint8_t *m, char *buf, size_t n) {
  snprintf(buf, n, "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3],
           m[4], m[5]);
}

static bool parseMac(const char *s, uint8_t *out) {
  unsigned int v[6];
  if (sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4],
             &v[5]) != 6)
    return false;
  for (int i = 0; i < 6; ++i)
    out[i] = (uint8_t)v[i];
  return true;
}

static void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
                      AwsEventType type, void *, uint8_t *, size_t) {
  if (type == WS_EVT_CONNECT) {
    // NO same-IP eviction here — it created a self-sustaining reconnect loop.
    //
    // The idea was: one phone = one IP on the SoftAP, so any other socket from
    // this IP must be one the device abandoned on refresh. But every ordinary
    // reconnect has a moment where both sockets exist, because closing is a round
    // trip. Evicting there meant:
    //     client dials B  ->  firmware closes A  ->  A's onclose reaches the page
    //     ->  page reconnects  ->  C  ->  firmware closes B  ->  ...
    // Measured on the rig: 269 connections in 109 s, every one logging
    // "closed 1 stale", every close arriving at the browser as code 1005. The
    // connection indicator flickered the whole time.
    //
    // Nothing is needed in its place: the page closes its own socket on pagehide,
    // and AsyncWebSocket reaps dead clients through its own disconnect path.
    const IPAddress ip = client->remoteIP();
    // Server-side keep-alive ping is OFF, deliberately.
    //
    // It used to be 5 s. The library only pings while a client's send queue is
    // empty — which is precisely the window this firmware creates on purpose: the
    // stream is muted for 4 s during a page load (and for the length of a session
    // download). So every visit hit ping-at-5-s while the radio was busiest with
    // ESP-NOW, the ping's TCP segment went unacked past AsyncTCP's ack timeout,
    // _onTimeout() closed the socket, and the freshly loaded page bounced
    // connected/offline. That is the flicker on entering the dashboard.
    //
    // Nothing is lost: the browser reconnects on visibility/online changes and
    // runs its own stall watchdog, so a phone that walked away comes back on its
    // own terms rather than being policed from here.
    client->keepAlivePeriod(0);
    DLOG("WS", "เชื่อมต่อ #%u จาก %s (รวม %u)", client->id(),
         ip.toString().c_str(), (unsigned)server->count());
  } else if (type == WS_EVT_DISCONNECT) {
    DLOG("WS", "ตัดการเชื่อมต่อ #%u (เหลือ %u)", client->id(),
         (unsigned)server->count());
  } else if (type == WS_EVT_ERROR) {
    DLOG("WS", "ผิดพลาด #%u", client->id());
  }
}

// ── AI model library on SD (/models) ────────────────────────────────────────
// Sanitize a client-supplied filename to a safe FAT name: keep [A-Za-z0-9._-],
// force a .json suffix, cap the length. Blocks path traversal from the name.
static String modelSanitize(const String &raw) {
  String s;
  for (size_t i = 0; i < raw.length() && s.length() < 48; i++) {
    const char c = raw[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')
      s += c;
    else
      s += '_';
  }
  if (s.length() == 0)
    s = "model";
  if (!s.endsWith(".json"))
    s += ".json";
  return s;
}

static String modelFullPath(const String &name) {
  return String(MODELS_DIR) + "/" + name;
}

static String modelActiveName() {
  if (!SdLogger::isReady() || !SD.exists(MODELS_ACTIVE))
    return String("");
  File f = SD.open(MODELS_ACTIVE, FILE_READ);
  if (!f)
    return String("");
  String n = f.readStringUntil('\n');
  f.close();
  n.trim();
  return n;
}

static void modelSetActive(const String &name) {
  if (!SdLogger::isReady())
    return;
  SD.mkdir(MODELS_DIR);
  if (SD.exists(MODELS_ACTIVE))
    SD.remove(MODELS_ACTIVE);
  File f = SD.open(MODELS_ACTIVE, FILE_WRITE);
  if (f) {
    f.print(name);
    f.close();
  }
}

// First model file name in the library, or "" if empty (used to re-pick an
// active model after a delete, and to empty the library on factory reset).
static String modelFirstInLibrary() {
  String first = "";
  if (!SdLogger::isReady())
    return first;
  File dir = SD.open(MODELS_DIR);
  if (dir && dir.isDirectory()) {
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      String n = f.name();
      const int slash = n.lastIndexOf('/');
      if (slash >= 0)
        n = n.substring(slash + 1);
      const bool isDir = f.isDirectory();
      f.close();
      if (!isDir && n.endsWith(".json")) {
        first = n;
        break;
      }
    }
  }
  if (dir)
    dir.close();
  return first;
}

// One-time migration: fold a pre-library /model.json into the library so an
// already-uploaded model survives the firmware update.
static void modelsMigrateLegacy() {
  if (!SdLogger::isReady())
    return;
  SD.mkdir(MODELS_DIR);
  if (SD.exists(MODEL_PATH) && modelActiveName().length() == 0) {
    const String dst = modelFullPath("model.json");
    if (!SD.exists(dst.c_str()))
      SD.rename(MODEL_PATH, dst.c_str());
    else
      SD.remove(MODEL_PATH);
    modelSetActive("model.json");
    DLOG("MODEL", "ย้ายโมเดลเดิม → คลัง (/models/model.json)");
  }
}

static void registerRoutes() {
  // ---- Embedded dashboard (gzip-compressed → fast first paint on mobile) ----
  auto sendDashboard = [](AsyncWebServerRequest *req) {
    // Once a trusted TLS listener is provisioned, keep an old bookmark or a
    // captive-portal browser from silently loading the camera-ineligible HTTP
    // dashboard. The HTTP API remains as the bounded HTTPS proxy's loopback
    // backend; this redirect only controls the human entry page.
    if (g_https) {
      req->redirect(httpsCanonicalUrl());
      return;
    }
    // A page load has to win against the live stream, or it never lands.
    //
    // On a browser refresh the OLD page is still alive while this request is
    // in flight — the browser does not fire pagehide (and so does not close
    // its socket) until the response headers arrive. So the rig was trying to
    // push ~80 WebSocket messages/s at the outgoing page while also pushing a
    // 49 KB document to the incoming one, over one SoftAP radio. AsyncTCP
    // starved, the GET was never answered, and the browser sat on "loading"
    // forever — while pressing Stop brought the old page right back, because
    // that page had been working the whole time.
    //
    // Two things fix it, both here:
    //   1. Close any WebSocket from this same IP. A device asking for the
    //      document is by definition replacing the page that owns that
    //      socket, so it is dead weight already.
    //   2. Hold the stream quiet for a moment so the document gets the radio
    //      to itself. Losing a second of live IMU during a page load costs
    //      nothing; losing the page load costs everything.
    const IPAddress ip = req->client()->remoteIP();
    const uint32_t t0 = millis();

    // ⚠ ห้ามปิด WebSocket ของหน้าเก่าตรงนี้ (เคยทำแล้วยิ่งแย่)
    // หน้าเก่ายังมีชีวิตอยู่ระหว่างรอเอกสาร พอ socket ถูกปิด JS ของมันจะ
    // reconnect ทุก 400ms ทันที → เกิดพายุการเชื่อมต่อใหม่ซ้อนเข้ามา
    // "ระหว่าง" ที่กำลังโหลดหน้า ซึ่งแย่กว่าปล่อยให้ socket เดิมเงียบๆ
    // แค่หยุดป้อนข้อมูลก็พอ — หน้าเก่าจะปิด socket เองตอน pagehide
    g_streamQuietUntilMs = t0 + STREAM_QUIET_MS;
    g_pageStartMs = t0;
    g_pagePending = true;

    DLOG("HTTP", "ขอหน้าเว็บจาก %s (%u ws, %u โหนด, heap %lu)",
         ip.toString().c_str(), (unsigned)g_ws.count(),
         (unsigned)Session::liveNodeCount(3000),
         (unsigned long)ESP.getFreeHeap());

    AsyncWebServerResponse *resp = req->beginResponse_P(
        200, "text/html", DASHBOARD_HTML_GZ, DASHBOARD_HTML_GZ_LEN);
    resp->addHeader("Content-Encoding", "gzip");
    // Never let the phone reuse a stale dashboard across a firmware flash. The old
    // "max-age=86400" cached the whole single-file UI for a day, so after an update
    // the browser kept serving the OLD dashboard — the reported "flashed but the UI
    // is broken / buttons do nothing." The document is a tiny gzip blob on a local
    // AP; re-validating every load is cheap and always correct.
    resp->addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    // Don't let the browser reuse a keep-alive socket for this: the polling
    // connections have been sitting idle behind a saturated radio and a
    // half-stuck one turns into a page load that never completes. A fresh
    // connection per document also frees it (and fires onDisconnect) the
    // instant the transfer is done.
    resp->addHeader("Connection", "close");
    // Resume the stream the moment the document is actually delivered
    // instead of always burning the whole quiet window.
    req->onDisconnect([t0]() {
      g_streamQuietUntilMs = 0;
      g_pagePending = false;
      g_pageOk++;
      DLOG("HTTP", "ส่งหน้าเว็บเสร็จใน %lu ms (%u B) ✓",
           (unsigned long)(millis() - t0), (unsigned)DASHBOARD_HTML_GZ_LEN);
    });
    req->send(resp);
  };
  g_http.on("/", HTTP_GET, sendDashboard);
  g_http.on("/index.html", HTTP_GET, sendDashboard);

  // ---- GET /api/status ----
  g_http.on("/api/status", HTTP_GET, [](AsyncWebServerRequest *req) {
    JsonDocument doc;
    doc["uptimeMs"] = millis();
    doc["heap"] = ESP.getFreeHeap();
    doc["minHeap"] = ESP.getMinFreeHeap();
    doc["psram"] = ESP.getFreePsram();
    doc["rx"] = EspNowRx::packetsReceived();
    doc["dropped"] = EspNowRx::packetsDropped();
    doc["wsClients"] = g_ws.count() + httpsWsClientCount();
    doc["wsDropped"] = g_wsDropped + httpsWsDroppedCount();
    doc["quietDrops"] = g_quietDrops; // batches yielded to a page load
    doc["logSeq"] = DiagLog::lastSeq();
    JsonObject secure = doc["secure"].to<JsonObject>();
    secure["https"] = g_https != nullptr;
    secure["wssClients"] = httpsWsClientCount();
    secure["apiProxy"] =
        "loopback GET/POST/DELETE; fixed Content-Length; response max 8 MiB";
    // false = this rig has never been through the setup wizard (fresh, or
    // just factory-reset). Any phone that connects opens the wizard itself.
    doc["setupDone"] = Session::setupDone();

    JsonObject sess = doc["session"].to<JsonObject>();
    const auto &s = Session::stats();
    sess["active"] = s.active;
    sess["id"] = Session::currentSessionId();
    sess["startedAt"] = s.startedAtMs;
    sess["durationMs"] =
        s.active ? (millis() - s.startedAtMs) : (s.endedAtMs - s.startedAtMs);
    sess["packets"] = s.totalImuPackets;
    sess["samples"] = s.totalImuSamples;

    JsonObject sd = doc["sd"].to<JsonObject>();
    sd["ready"] = SdLogger::isReady();
    sd["cardMB"] = (uint32_t)SdLogger::cardSizeMB();
    sd["usedMB"] = (uint32_t)SdLogger::usedMB();
    sd["rows"] = SdLogger::rowsWritten();
    sd["bytes"] = SdLogger::bytesWritten();

    String out;
    serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  // ---- GET /api/nodes ----
  g_http.on("/api/nodes", HTTP_GET, [](AsyncWebServerRequest *req) {
    NodeMapping nodes[Session::MAX_NODES];
    size_t n = Session::listNodes(nodes, Session::MAX_NODES);
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    const uint32_t nowMs = millis();
    for (size_t i = 0; i < n; ++i) {
      char macStr[18];
      macToStr(nodes[i].mac, macStr, sizeof(macStr));
      JsonObject o = arr.add<JsonObject>();
      o["mac"] = macStr;
      o["slot"] = (int)nodes[i].slot;
      o["rssi"] = nodes[i].lastRssi;
      o["lastSeenMs"] = nodes[i].lastSeenMs;
      // A node restored from NVS has never transmitted this boot; report a
      // huge age so the dashboard shows it as offline instead of "fresh"
      // (millis() is near zero right after a reboot).
      o["ageMs"] =
          nodes[i].everSeen ? (nowMs - nodes[i].lastSeenMs) : 86400000UL;
      o["paired"] = !nodes[i].everSeen;
      // The node's own verdict on its hardware — surfaces the case where a
      // sensor is dead but the radio is fine, which otherwise just looks
      // like "connected, no data".
      o["sensorFault"] = (nodes[i].healthFlags & NODE_FLAG_SENSOR_FAULT) != 0;
      o["linkFault"] = (nodes[i].healthFlags & NODE_FLAG_LINK_FAULT) != 0;
      // battery: 0 mV means "not reported" (older node firmware), while
      // battUnwired means "reported, but the divider isn't fitted" — the
      // dashboard must not draw those two as a flat 0 %.
      o["battUnwired"] = (nodes[i].healthFlags & NODE_FLAG_BATT_UNWIRED) != 0;
      o["battMv"] = nodes[i].battMv;
      o["charging"] = nodes[i].chargeState > 0;
      o["battTrendMv"] = nodes[i].battTrendMv;
      o["batteryPct"] = nodes[i].batteryPct;
      o["nodeUptimeMs"] = nodes[i].nodeUptimeMs;
      o["firmware"] = nodes[i].firmwareVersion;
      o["packetsRx"] = nodes[i].packetsRx;
      o["lastSeq"] = nodes[i].lastSeq;
      o["seqGaps"] = nodes[i].seqGaps;
      // live shake activity (g) — only if fresh, else 0 so a stale node
      // never looks "shaken" in the setup wizard
      o["peakG"] = (nodes[i].everSeen && nowMs - nodes[i].lastImuMs < 1000)
                       ? nodes[i].peakG
                       : 0.0f;
    }
    String out;
    serializeJson(arr, out);
    req->send(200, "application/json", out);
  });

  // ---- POST /api/nodes/assign ----
  g_http.on(
      "/api/nodes/assign", HTTP_POST, [](AsyncWebServerRequest *) {}, nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        if (deserializeJson(doc, data, len)) {
          req->send(400, "application/json", "{\"error\":\"bad json\"}");
          return;
        }
        uint8_t mac[6];
        if (!parseMac(doc["mac"] | "", mac)) {
          req->send(400, "application/json", "{\"error\":\"bad mac\"}");
          return;
        }
        NodeSlot slot = (NodeSlot)(int)(doc["slot"] | 0);
        bool ok = Session::assignSlot(mac, slot);
        req->send(ok ? 200 : 404, "application/json",
                  ok ? "{\"ok\":true}" : "{\"error\":\"unknown node\"}");
      });

  // ---- POST /api/nodes/forget (explicit removal — drops persist otherwise)
  // ----
  g_http.on(
      "/api/nodes/forget", HTTP_POST, [](AsyncWebServerRequest *) {}, nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        if (deserializeJson(doc, data, len)) {
          req->send(400, "application/json", "{\"error\":\"bad json\"}");
          return;
        }
        uint8_t mac[6];
        if (!parseMac(doc["mac"] | "", mac)) {
          req->send(400, "application/json", "{\"error\":\"bad mac\"}");
          return;
        }
        bool ok = Session::forgetNode(mac);
        req->send(ok ? 200 : 404, "application/json",
                  ok ? "{\"ok\":true}" : "{\"error\":\"unknown node\"}");
      });

  // ---- POST /api/nodes/identify ----
  g_http.on(
      "/api/nodes/identify", HTTP_POST, [](AsyncWebServerRequest *) {}, nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        if (deserializeJson(doc, data, len)) {
          req->send(400, "application/json", "{\"error\":\"bad json\"}");
          return;
        }
        uint8_t mac[6];
        if (!parseMac(doc["mac"] | "", mac)) {
          req->send(400, "application/json", "{\"error\":\"bad mac\"}");
          return;
        }
        bool ok = EspNowTx::sendCommand(mac, PKT_CMD_IDENTIFY);
        req->send(ok ? 200 : 500, "application/json",
                  ok ? "{\"ok\":true}" : "{\"error\":\"tx failed\"}");
      });

  // ---- POST /api/nodes/restart ----
  g_http.on(
      "/api/nodes/restart", HTTP_POST, [](AsyncWebServerRequest *) {}, nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        if (deserializeJson(doc, data, len)) {
          req->send(400, "application/json", "{\"error\":\"bad json\"}");
          return;
        }
        uint8_t mac[6];
        if (!parseMac(doc["mac"] | "", mac)) {
          req->send(400, "application/json", "{\"error\":\"bad mac\"}");
          return;
        }
        bool ok = EspNowTx::sendCommand(mac, PKT_CMD_RESTART);
        req->send(ok ? 200 : 500, "application/json",
                  ok ? "{\"ok\":true}" : "{\"error\":\"tx failed\"}");
      });

  // ---- POST /api/session/start ----
  g_http.on(
      "/api/session/start", HTTP_POST, [](AsyncWebServerRequest *) {}, nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        deserializeJson(doc, data, len);
        const char *athlete = doc["athlete"] | "anonymous";
        if (!Session::start(athlete)) {
          // Hand back the id of the run that is already going. A second
          // phone (or a reloaded tab) can then adopt it and show a running
          // clock instead of a dead "start failed" toast.
          JsonDocument busy;
          busy["error"] = "already active";
          busy["sessionId"] = Session::currentSessionId();
          String out;
          serializeJson(busy, out);
          req->send(409, "application/json", out);
          return;
        }
        bool sdOk = SdLogger::openSession(Session::currentSessionId(), athlete);
        JsonDocument res;
        res["sessionId"] = Session::currentSessionId();
        res["sdLogging"] = sdOk;
        if (!sdOk)
          res["warning"] = "SD logging unavailable";
        String out;
        serializeJson(res, out);
        req->send(200, "application/json", out);
      });

  // ---- POST /api/session/stop ----
  g_http.on("/api/session/stop", HTTP_POST, [](AsyncWebServerRequest *req) {
    SdLogger::closeSession();
    bool ok = Session::stop();
    req->send(ok ? 200 : 409, "application/json",
              ok ? "{\"ok\":true}" : "{\"error\":\"not active\"}");
  });

  // ---- GET /api/sessions ----
  g_http.on("/api/sessions", HTTP_GET, [](AsyncWebServerRequest *req) {
    SdLogger::SessionEntry entries[32];
    size_t n = SdLogger::listSessions(entries, 32);
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (size_t i = 0; i < n; ++i) {
      JsonObject o = arr.add<JsonObject>();
      o["id"] = entries[i].id;
      o["bytes"] = entries[i].sizeBytes;
      o["modTime"] = entries[i].modTime;
    }
    String out;
    serializeJson(arr, out);
    req->send(200, "application/json", out);
  });

  // ---- GET /api/session/download?id=… (CSV, also feeds the replay view) ----
  g_http.on("/api/session/download", HTTP_GET, [](AsyncWebServerRequest *req) {
    if (!req->hasParam("id")) {
      req->send(400, "application/json", "{\"error\":\"missing id\"}");
      return;
    }
    String id = req->getParam("id")->value();
    char path[64];
    SdLogger::sessionPath(id.c_str(), path, sizeof(path));
    if (!SD.exists(path)) {
      req->send(404, "application/json", "{\"error\":\"not found\"}");
      return;
    }

    // A recording is megabytes (400 Hz × 4 limbs ≈ 3.8 MB/min) read off an
    // SPI card and pushed over the same radio the nodes are transmitting
    // on. Left alone it crawls. Standing the live pipeline down for the
    // duration is the difference between "review yesterday's session" and
    // "watch a progress bar" — and nobody is training while they watch a
    // replay, so there is nothing to lose.
    const uint32_t t0 = millis();
    g_streamQuietUntilMs = t0 + DOWNLOAD_QUIET_MS;
    g_downloadActive = true;
    DLOG("HTTP", "ดาวน์โหลดเซสชัน %s (%u ws) — หยุดสตรีมสดชั่วคราว", id.c_str(),
         (unsigned)g_ws.count());

    // Not an attachment: the replay view fetches this, and Safari treats a
    // Content-Disposition download as a navigation and cancels the fetch.
    AsyncWebServerResponse *resp =
        req->beginResponse(SD, path, "text/csv", false);
    req->onDisconnect([t0]() {
      g_downloadActive = false;
      g_streamQuietUntilMs = 0;
      DLOG("HTTP", "ดาวน์โหลดเซสชันเสร็จใน %lu ms",
           (unsigned long)(millis() - t0));
    });
    req->send(resp);
  });

  // ---- DELETE /api/sessions/{id} ----
  g_http.on("/api/session/delete", HTTP_DELETE, [](AsyncWebServerRequest *req) {
    if (!req->hasParam("id")) {
      req->send(400, "application/json", "{\"error\":\"missing id\"}");
      return;
    }
    String id = req->getParam("id")->value();
    bool ok = SdLogger::deleteSession(id.c_str());
    req->send(ok ? 200 : 404, "application/json",
              ok ? "{\"ok\":true}" : "{\"error\":\"not found\"}");
  });

  // ---- GET /api/logs?since=N ----
  // Dev-mode diagnostics: everything the rig noticed, pullable from the phone.
  g_http.on("/api/logs", HTTP_GET, [](AsyncWebServerRequest *req) {
    uint32_t since = 0;
    if (req->hasParam("since"))
      since = strtoul(req->getParam("since")->value().c_str(), nullptr, 10);

    static DiagLog::Entry entries[DiagLog::CAP];
    const size_t n = DiagLog::collect(entries, DiagLog::CAP, since);

    JsonDocument doc;
    doc["lastSeq"] = DiagLog::lastSeq();
    doc["uptimeMs"] = millis();
    JsonArray arr = doc["entries"].to<JsonArray>();
    for (size_t i = 0; i < n; ++i) {
      JsonObject o = arr.add<JsonObject>();
      o["seq"] = entries[i].seq;
      o["ms"] = entries[i].ms;
      o["cat"] = entries[i].cat;
      o["msg"] = entries[i].msg;
    }
    String out;
    serializeJson(doc, out);
    req->send(200, "application/json", out);
  });

  // ---- POST /api/nodes/link-reset ----
  // Recovery for "the node is online but no data arrives": re-register the
  // ESP-NOW peer, clear the stale sequence bookkeeping, and re-broadcast a
  // time sync so the node re-aligns. Keeps the limb assignment.
  g_http.on(
      "/api/nodes/link-reset", HTTP_POST, [](AsyncWebServerRequest *) {},
      nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        if (deserializeJson(doc, data, len)) {
          req->send(400, "application/json", "{\"error\":\"bad json\"}");
          return;
        }
        uint8_t mac[6];
        if (!parseMac(doc["mac"] | "", mac)) {
          req->send(400, "application/json", "{\"error\":\"bad mac\"}");
          return;
        }
        const bool known = Session::resetNodeStats(mac);
        const bool peer = EspNowTx::resetPeer(mac);
        EspNowTx::broadcastTimeSync();
        JsonDocument res;
        res["ok"] = known && peer;
        res["known"] = known;
        res["peer"] = peer;
        String out;
        serializeJson(res, out);
        req->send(known ? 200 : 404, "application/json", out);
      });

  // ---- POST /api/system/radio-restart ----
  // Re-initialise ESP-NOW on the Main Node without dropping the AP, the
  // dashboard or the session. For when the radio itself is wedged.
  g_http.on("/api/system/radio-restart", HTTP_POST,
            [](AsyncWebServerRequest *req) {
              const bool rx = EspNowRx::restartRadio();
              const bool tx = EspNowTx::begin(); // deinit dropped every peer
              EspNowTx::broadcastTimeSync();
              JsonDocument res;
              res["ok"] = rx && tx;
              res["rx"] = rx;
              res["tx"] = tx;
              String out;
              serializeJson(res, out);
              DLOG("ESPNOW", "รีสตาร์ทวิทยุ rx=%d tx=%d", (int)rx, (int)tx);
              req->send(rx && tx ? 200 : 500, "application/json", out);
            });

  // ---- POST /api/system/reboot ----
  g_http.on("/api/system/reboot", HTTP_POST, [](AsyncWebServerRequest *req) {
    SdLogger::closeSession();
    Session::stop();
    req->send(200, "application/json", "{\"ok\":true,\"rebootInMs\":600}");
    g_rebootAtMs = millis() + 600;
  });

  // ---- POST /api/setup/done  {"done":true} ----
  // The wizard reports back once the user has finished (or deliberately
  // skipped) pairing, so the rig stops opening it on every phone that joins.
  g_http.on(
      "/api/setup/done", HTTP_POST, [](AsyncWebServerRequest *) {}, nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        deserializeJson(doc, data, len);
        Session::setSetupDone(doc["done"] | true);
        req->send(200, "application/json", "{\"ok\":true}");
      });

  // ---- POST /api/factory-reset  {"wipeSessions":bool,"wipeModel":bool} ----
  // Puts the rig back to out-of-the-box state: pairings gone, wizard re-armed,
  // and optionally the recordings and the AI model erased. Reboots afterwards.
  g_http.on(
      "/api/factory-reset", HTTP_POST, [](AsyncWebServerRequest *) {}, nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t,
         size_t) {
        JsonDocument doc;
        deserializeJson(doc, data, len);
        const bool wipeSessions = doc["wipeSessions"] | false;
        const bool wipeModel = doc["wipeModel"] | false;

        SdLogger::closeSession();
        Session::stop();

        uint32_t removed = wipeSessions ? SdLogger::wipeAllSessions() : 0;
        bool modelGone = false;
        if (wipeModel && SdLogger::isReady()) {
          if (SD.exists(MODEL_PATH) && SD.remove(MODEL_PATH))
            modelGone = true;
          // empty the whole library one file per pass (safe vs remove-in-scan)
          for (int guard = 0; guard < 64; guard++) {
            const String n = modelFirstInLibrary();
            if (n.length() == 0)
              break;
            if (SD.remove(modelFullPath(n).c_str()))
              modelGone = true;
          }
          modelSetActive("");
        }
        Session::factoryResetMemory();

        JsonDocument res;
        res["ok"] = true;
        res["sessionsRemoved"] = removed;
        res["modelRemoved"] = modelGone;
        res["rebootInMs"] = 800;
        String out;
        serializeJson(res, out);
        req->send(200, "application/json", out);

        DLOG("SYS", "factory reset — ลบไฟล์ %lu · model=%d",
             (unsigned long)removed, (int)modelGone);
        g_rebootAtMs = millis() + 800; // loop() reboots once the reply is sent
      });

  // ════════ AI MODEL on SD card ════════
  // Upload once → stored on the card → any phone that connects auto-loads it
  // and runs gesture inference in-browser. No model = normal detection only.

  // ---- GET /api/model → the ACTIVE model (kept for the dashboard auto-load) --
  g_http.on("/api/model", HTTP_GET, [](AsyncWebServerRequest *req) {
    const String active = modelActiveName();
    const String path = modelFullPath(active);
    if (!SdLogger::isReady() || active.length() == 0 ||
        !SD.exists(path.c_str())) {
      req->send(404, "application/json", "{\"error\":\"no model\"}");
      return;
    }
    AsyncWebServerResponse *resp =
        req->beginResponse(SD, path, "application/json");
    resp->addHeader("Cache-Control", "no-store");
    req->send(resp);
  });

  // ---- GET /api/models → list the library + which one is active ----
  g_http.on("/api/models", HTTP_GET, [](AsyncWebServerRequest *req) {
    if (!SdLogger::isReady()) {
      req->send(200, "application/json", "{\"active\":\"\",\"models\":[]}");
      return;
    }
    const String active = modelActiveName();
    String out = "{\"active\":\"" + active + "\",\"models\":[";
    File dir = SD.open(MODELS_DIR);
    bool first = true;
    if (dir && dir.isDirectory()) {
      for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
        String name = f.name();
        const int slash = name.lastIndexOf('/');
        if (slash >= 0)
          name = name.substring(slash + 1);
        const bool isDir = f.isDirectory();
        const uint32_t sz = (uint32_t)f.size();
        f.close();
        if (isDir || !name.endsWith(".json"))
          continue;
        if (!first)
          out += ",";
        first = false;
        out += "{\"name\":\"" + name + "\",\"size\":" + String(sz) + "}";
      }
    }
    if (dir)
      dir.close();
    out += "]}";
    req->send(200, "application/json", out);
  });

  // ---- POST /api/models?name=X → stream an uploaded model into the library ---
  // The freshly uploaded model becomes active (matches the old upload=use flow).
  static File s_modelUp;
  static bool s_modelUpOk = false;
  static String s_modelUpName;
  g_http.on(
      "/api/models", HTTP_POST,
      [](AsyncWebServerRequest *req) {
        if (s_modelUpOk && s_modelUpName.length())
          modelSetActive(s_modelUpName);
        req->send(s_modelUpOk ? 200 : 500, "application/json",
                  s_modelUpOk ? "{\"ok\":true}"
                              : "{\"error\":\"sd write failed\"}");
      },
      nullptr,
      [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t index,
         size_t total) {
        if (index == 0) { // first chunk → (re)open the file
          s_modelUpOk = false;
          if (!SdLogger::isReady())
            return;
          SD.mkdir(MODELS_DIR);
          s_modelUpName = modelSanitize(req->hasParam("name")
                                            ? req->getParam("name")->value()
                                            : String("model.json"));
          const String path = modelFullPath(s_modelUpName);
          if (SD.exists(path.c_str()))
            SD.remove(path.c_str());
          s_modelUp = SD.open(path.c_str(), FILE_WRITE);
          if (!s_modelUp)
            return;
        }
        if (s_modelUp)
          s_modelUp.write(data, len);
        if (index + len >= total) { // last chunk → close + verify size
          if (s_modelUp) {
            s_modelUp.flush();
            s_modelUpOk = (s_modelUp.size() == total && total > 0);
            s_modelUp.close();
          }
          DLOG("MODEL", "อัปโหลด %s %s (%u ไบต์)", s_modelUpName.c_str(),
               s_modelUpOk ? "สำเร็จ" : "ล้มเหลว", (unsigned)total);
        }
      });

  // ---- POST /api/models/activate?name=X → make X the active model ----
  g_http.on("/api/models/activate", HTTP_POST,
            [](AsyncWebServerRequest *req) {
              if (!SdLogger::isReady() || !req->hasParam("name")) {
                req->send(400, "application/json", "{\"error\":\"bad request\"}");
                return;
              }
              const String name = modelSanitize(req->getParam("name")->value());
              if (!SD.exists(modelFullPath(name).c_str())) {
                req->send(404, "application/json", "{\"error\":\"not found\"}");
                return;
              }
              modelSetActive(name);
              DLOG("MODEL", "เลือกใช้โมเดล %s", name.c_str());
              req->send(200, "application/json", "{\"ok\":true}");
            });

  // ---- DELETE /api/models?name=X → remove one model from the library ----
  g_http.on("/api/models", HTTP_DELETE, [](AsyncWebServerRequest *req) {
    if (!SdLogger::isReady() || !req->hasParam("name")) {
      req->send(400, "application/json", "{\"error\":\"bad request\"}");
      return;
    }
    const String name = modelSanitize(req->getParam("name")->value());
    const String path = modelFullPath(name);
    if (SD.exists(path.c_str()))
      SD.remove(path.c_str());
    if (modelActiveName() == name) // removed the active one → pick another
      modelSetActive(modelFirstInLibrary());
    DLOG("MODEL", "ลบโมเดล %s", name.c_str());
    req->send(200, "application/json", "{\"ok\":true}");
  });

  // ---- DELETE /api/model → deactivate (clear active, keep files) ----
  g_http.on("/api/model", HTTP_DELETE, [](AsyncWebServerRequest *req) {
    modelSetActive("");
    req->send(200, "application/json", "{\"ok\":true}");
  });

  // Captive-portal probes (Apple/Android/Windows): answer "online" so the phone
  // VALIDATES the SoftAP and routes traffic to us. We used to redirect these to
  // force a sign-in popup, but then the phone re-checked connectivity every few
  // seconds — background traffic that jittered the live stream — and some phones
  // parked the network as "no internet" (the original slow/never load). Success
  // stops the re-checks and makes routing reliable. Trade-off: no auto popup —
  // open the canonical URL in a browser (HTTPS once TLS is provisioned; HTTP
  // otherwise). DNS + onNotFound still redirect arbitrary HTTP URLs.
  auto appleSuccess = [](AsyncWebServerRequest *req) {
    req->send(
        200, "text/html",
        "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
  };
  g_http.on("/hotspot-detect.html", HTTP_GET, appleSuccess);       // iOS/macOS
  g_http.on("/library/test/success.html", HTTP_GET, appleSuccess); // iOS/macOS
  g_http.on("/generate_204", HTTP_GET,                             // Android
            [](AsyncWebServerRequest *req) { req->send(204); });
  g_http.on("/gen_204", HTTP_GET,
            [](AsyncWebServerRequest *req) { req->send(204); });
  g_http.on("/connecttest.txt", HTTP_GET, // Windows
            [](AsyncWebServerRequest *req) {
              req->send(200, "text/plain", "Microsoft Connect Test");
            });
  g_http.on("/ncsi.txt", HTTP_GET, [](AsyncWebServerRequest *req) {
    req->send(200, "text/plain", "Microsoft NCSI");
  });

  // Any other unknown host/path (a domain typed in the browser, resolved to us
  // by the DNS catch-all) → the canonical dashboard URL. HTTP itself cannot
  // redirect an arbitrary HTTPS hostname, but it can prevent an accidental
  // downgrade after TLS has been provisioned.
  g_http.onNotFound([](AsyncWebServerRequest *req) {
    if (g_https)
      req->redirect(httpsCanonicalUrl());
    else
      req->redirect("http://192.168.4.1/");
  });
}

bool begin() {
  // ใช้ WIFI_AP_STA เพื่อแก้บั๊กรับ ESP-NOW Broadcast ไม่เข้าในบางบอร์ด (ESP32-S3/C3)
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD, AP_CHANNEL, 0, AP_MAX_CLIENTS);
  WiFi.setSleep(false); // ปิด power save → รับ ESP-NOW ได้ต่อเนื่อง ไม่หลุดเป็นช่วงๆ
  IPAddress ip = WiFi.softAPIP();
  Serial.printf("[WIFI] AP '%s' up at %s (channel %d)\n", AP_SSID,
                ip.toString().c_str(), AP_CHANNEL);

  // Log association events. Without these, "the dashboard is offline" is
  // unanswerable from here: a phone that dropped off the access point and a phone
  // that is associated but whose HTTP is failing look identical — both show
  // ws=0 and no requests. These two lines separate them.
  WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t info) {
    const uint8_t *m = info.wifi_ap_staconnected.mac;
    DLOG("WIFI", "เครื่องเข้าร่วม %02X:%02X:%02X:%02X:%02X:%02X (รวม %u)",
         m[0], m[1], m[2], m[3], m[4], m[5],
         (unsigned)WiFi.softAPgetStationNum());
  }, ARDUINO_EVENT_WIFI_AP_STACONNECTED);

  WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t info) {
    const uint8_t *m = info.wifi_ap_stadisconnected.mac;
    DLOG("WIFI", "เครื่องออก %02X:%02X:%02X:%02X:%02X:%02X (เหลือ %u)",
         m[0], m[1], m[2], m[3], m[4], m[5],
         (unsigned)WiFi.softAPgetStationNum());
  }, ARDUINO_EVENT_WIFI_AP_STADISCONNECTED);

  g_ws.onEvent(onWsEvent);
  // NO handshake gate here — deliberately.
  //
  // There used to be one that refused WebSocket upgrades from an IP for 2 s after
  // it requested the dashboard, meant to stop the outgoing page's socket from
  // retrying during the transfer. It backfired: the *incoming* page runs its JS
  // and dials its socket within a few hundred milliseconds of the document
  // landing, so the fresh page got refused, retried on a 400 ms backoff, and the
  // connection indicator flickered offline/connecting for the first couple of
  // seconds of every visit. The reconnect storm it was written for came from
  // closing old sockets in sendDashboard, which no longer happens.
  g_http.addHandler(&g_ws);
  registerRoutes();
  modelsMigrateLegacy(); // fold any pre-library /model.json into /models
  g_http.begin();
  Serial.println("[HTTP] Listening on :80");
  // Failure here is deliberately non-fatal: the established HTTP dashboard
  // remains available until the rig is provisioned with its SD PEM pair.
  const bool secureReady = beginHttps();

  // Once a public certificate is installed, answer DNS for its canonical name
  // only.  A wildcard captive portal routes iOS/Android probes and third-party
  // hosts (for example fonts.googleapis.com) to this TLS listener; their SNI
  // cannot match pokoman.online and the failed handshakes exhaust TLS RAM.
  // The HTTP-only fallback retains the traditional captive-portal wildcard.
  if (secureReady) {
    g_dns.setErrorReplyCode(DNSReplyCode::NonExistentDomain);
    g_dns.start(53, g_httpsCanonicalHost, ip);
    Serial.printf("[DNS] secure route %s → %s (others NXDOMAIN)\n",
                  g_httpsCanonicalHost.c_str(), ip.toString().c_str());
  } else {
    g_dns.setErrorReplyCode(DNSReplyCode::NoError);
    g_dns.start(53, "*", ip);
    Serial.println("[DNS] captive portal เปิด (ทุกโดเมน → dashboard)");
  }
  return true;
}

// ── live IMU stream ────────────────────────────────────────────────────────
// Frames are coalesced into one WebSocket message instead of one message each.
// Four nodes produce ~200 frames/s, and every separate message costs a WS
// header, a TCP segment, a wifi frame and a wake-up on the phone. Packing what
// arrived in the last few milliseconds into a single message cuts that overhead
// several-fold with zero data loss: each sub-frame is self-describing, so the
// dashboard simply walks the buffer.
static constexpr size_t WS_FRAME_MAX =
    16 + IMU_SAMPLES_PER_PACKET * sizeof(ImuSample);
static constexpr size_t WS_BATCH_CAP = WS_FRAME_MAX * 8;
// Coalesce ~40ms of frames per WS message (was 12ms). At 12ms the SoftAP put
// ~83 msg/s at the phone — faster than it drains — so batches piled into the
// client send queue and it rendered frames hundreds of ms stale (bufferbloat,
// felt as "delay"). ~40ms → ~25 msg/s the phone keeps up with, so the queue
// stays shallow and live latency drops to about one batch. (A per-client
// queueLen() drop-oldest guard would bound it harder, but getClients() has no
// public lock — iterating it off the AsyncTCP task races client disconnect —
// so we pace the send rate instead, which keeps the queue shallow safely.)
static constexpr uint32_t WS_BATCH_MS = 40;
// ส่งเข้า WS แค่ 1 ใน N เฟรม (ลดโหลด SoftAP · SD ยังเต็ม 400Hz)
// 1-in-2: ครอบคลุมต่อโหนด ~50% (ลื่นกว่า 1-in-4) · batch 40ms คุม msg-rate ให้ต่ำอยู่แล้ว
#define WS_DOWNSAMPLE 2
static uint8_t g_batch[WS_BATCH_CAP];
static size_t g_batchLen = 0;
static uint32_t g_batchOpenMs = 0;

bool streamIsQuiet() {
  const uint32_t until = g_streamQuietUntilMs;
  return until && (int32_t)(millis() - until) < 0;
}

static void flushImuBatch() {
  if (g_batchLen == 0)
    return;
  // Yield the radio to an in-flight page load (see sendDashboard).
  if (streamIsQuiet()) {
    g_batchLen = 0;
    g_quietDrops++;
    return;
  }
  // Backpressure. A phone on SoftAP cannot always drain this, and piling onto
  // a full TCP queue churns the heap until AsyncTCP resets the socket (the
  // dashboard then flaps OFFLINE↔LIVE).
  //
  // The old guard was availableForWriteAll(), false when *any* client is
  // backed up — one phone on a weak signal starved every other phone.
  // binaryAll() builds one shared payload for all clients and drops it only
  // for those whose own queue is full, so a slow phone degrades alone.
  // IMU frames are real-time: a dropped batch beats a dropped connection.
  if (g_ws.count() && ESP.getFreeHeap() >= 40 * 1024) {
    if (g_ws.binaryAll(g_batch, g_batchLen) == AsyncWebSocket::DISCARDED) {
      g_wsDropped++;
      // Zombie defence, by BEHAVIOUR rather than by counting sockets.
      //
      // Counting was tried twice and both attempts became reconnect engines: they
      // closed sockets that were perfectly healthy and merely numerous, and every
      // such close made the page dial again. What actually identifies a dead
      // socket is that it never accepts anything — a phone that walked out of
      // range leaves a client whose queue stays full forever, while a working page
      // drains one every few milliseconds.
      //
      // DISCARDED means NO client accepted this batch. Sustained for this long,
      // every socket in the list is wedged, so dropping the lot is right: pages
      // that are actually alive reconnect within a second and stream again. Any
      // single accepting client resets the timer, so a healthy page can never be
      // caught by this, however many zombies sit beside it.
      if (g_allDiscardSinceMs == 0)
        g_allDiscardSinceMs = millis();
      else if (millis() - g_allDiscardSinceMs > WS_WEDGED_MS) {
        DLOG("WS", "ทุก client ไม่รับข้อมูลนาน %lu วิ — ปิดทั้งหมดให้ต่อใหม่",
             (unsigned long)(WS_WEDGED_MS / 1000));
        g_ws.closeAll();
        g_allDiscardSinceMs = 0;
      }
    } else {
      g_allDiscardSinceMs = 0; // somebody took it — nothing is wedged
    }
  }
  // Native esp_https_server has no AsyncWebSocket::binaryAll().  Copy one
  // bounded snapshot into its work queue so all WSS clients see the exact same
  // wire-format batch while a slow TLS client can only cost bounded drops.
  if (httpsWsHasClients())
    queueHttpsWsBatch(g_batch, g_batchLen);
  g_batchLen = 0;
}

void broadcastImuFrame(const ImuFrame &f) {
  if ((g_ws.count() == 0 && !httpsWsHasClients()) || streamIsQuiet()) {
    g_batchLen = 0;
    return;
  }
#if WS_DOWNSAMPLE > 1
  // downsample live stream: ส่งเข้า WS แค่ 1 ใน WS_DOWNSAMPLE เฟรม
  // (ลดโหลด SoftAP → live ลื่น + reconnect เร็ว · SD ยังบันทึกครบทุกเฟรม)
  static uint32_t s_wsSkip = 0;
  if ((s_wsSkip++ % WS_DOWNSAMPLE) != 0)
    return;
#endif
  const size_t frameLen = 16 + f.sampleCount * sizeof(ImuSample);
  if (frameLen > WS_FRAME_MAX)
    return;
  if (g_batchLen + frameLen > WS_BATCH_CAP)
    flushImuBatch();
  if (g_batchLen == 0)
    g_batchOpenMs = millis();

  uint8_t *p = g_batch + g_batchLen;
  p[0] = 0x01;
  p[1] = (uint8_t)f.slot;
  p[2] = f.sampleCount;
  p[3] = (uint8_t)f.rssi;
  memcpy(p + 4, &f.seq, 4);
  memcpy(p + 8, &f.recvTimestampMs, 4);
  memcpy(p + 12, &f.nodeTimestampUs, 4);
  memcpy(p + 16, f.samples, f.sampleCount * sizeof(ImuSample));
  g_batchLen += frameLen;
}

void loop() {
  const uint32_t now = millis();
  g_dns.processNextRequest(); // captive portal DNS

  if (g_batchLen && (now - g_batchOpenMs) >= WS_BATCH_MS)
    flushImuBatch();

  // cleanupClients() walks the client list under its lock; at ~250 loop passes
  // per second that is pure overhead. Dead sockets are already erased by the
  // library's own disconnect path, so this only has to enforce the client cap.
  // Keep the pipeline stood down for as long as a download is running.
  if (g_downloadActive)
    g_streamQuietUntilMs = now + DOWNLOAD_QUIET_MS;

  // Did a document response never finish? Say so, loudly, in the log.
  if (g_pagePending && (int32_t)(now - g_pageStartMs) > 10000) {
    g_pagePending = false;
    g_pageStalled++;
    g_streamQuietUntilMs = 0; // don't stay muted forever on a dead load
    DLOG("HTTP", "⚠ ส่งหน้าเว็บไม่จบใน 10 วิ — ค้าง (สำเร็จ %lu / ค้าง %lu)",
         (unsigned long)g_pageOk, (unsigned long)g_pageStalled);
  }

  static uint32_t lastCleanupMs = 0;
  if (now - lastCleanupMs >= 500) {
    lastCleanupMs = now;
    g_ws.cleanupClients(MAX_WS_CLIENTS);
  }
  if (g_rebootAtMs && (int32_t)(now - g_rebootAtMs) >= 0) {
    Serial.println("[RESET] rebooting…");
    Serial.flush();
    ESP.restart();
  }
}
size_t connectedClients() { return g_ws.count() + httpsWsClientCount(); }
size_t secureSessions() { return httpsSessionCount(); }
size_t secureSessionLimit() { return HTTPS_MAX_OPEN_SOCKETS; }
uint32_t wsDropped() { return g_wsDropped + httpsWsDroppedCount(); }
uint32_t quietDrops() { return g_quietDrops; }
} // namespace WebServerApp

// ============================================================
//  MAIN  (setup / loop)
// ============================================================
static uint32_t g_lastStatsLogMs = 0;

static StatusLed::State pickLedState() {
  if (!SdLogger::isReady())
    return StatusLed::SD_ERROR;
  if (Session::isActive())
    return StatusLed::RECORDING;
  return Session::anyNodeFresh(2000) ? StatusLed::NODE_LINK : StatusLed::AP_UP;
}

static void logStats() {
  const uint32_t now = millis();
  if (now - g_lastStatsLogMs < 2000)
    return;
  g_lastStatsLogMs = now;
  Serial.printf(
      "[STATS] rx=%lu drop=%lu wsdrop=%lu nodes=%u wifi=%u ws=%u tls=%u/%u "
      "sess=%s sd=%s rows=%lu heap=%lu iheap=%lu\n",
      (unsigned long)EspNowRx::packetsReceived(),
      (unsigned long)EspNowRx::packetsDropped(),
      (unsigned long)WebServerApp::wsDropped(),
      (unsigned)Session::liveNodeCount(3000),
      (unsigned)WiFi.softAPgetStationNum(),
      (unsigned)WebServerApp::connectedClients(),
      (unsigned)WebServerApp::secureSessions(),
      (unsigned)WebServerApp::secureSessionLimit(),
      Session::isActive() ? "ON" : "off", SdLogger::isReady() ? "OK" : "ERR",
      (unsigned long)SdLogger::rowsWritten(), (unsigned long)ESP.getFreeHeap(),
      // TLS handshakes are paid for out of internal DRAM only; the PSRAM in the
      // plain heap figure above cannot be used for them.
      (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}

void setup() {
  Serial.begin(115200);
  // Never let a log line block the loop. On USB-CDC, writes stall waiting for a
  // host that has read the buffer — with no laptop plugged in (i.e. every real
  // training session) the 2 s stats line froze the loop long enough to overflow
  // the IMU queue and drop hundreds of packets. Measured: thousands of drops
  // headless, zero once the timeout is off.
  Serial.setTxTimeoutMs(0);
  delay(500);
  Serial.println("\n=== StrikeSense Main Node (Arduino IDE build) ===");
  Serial.printf("Build: %s %s\n", __DATE__, __TIME__);
  Serial.printf("ESP32-S3 . %d MHz . Flash %lu MB . PSRAM %lu KB\n",
                ESP.getCpuFreqMHz(),
                (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)),
                (unsigned long)(ESP.getPsramSize() / 1024));

  StatusLed::begin();
  Session::begin();

  if (!SdLogger::begin()) {
    Serial.println("[WARN] SD card unavailable - sessions will not be logged");
  }

  if (!WebServerApp::begin()) {
    Serial.println("[FATAL] Web server failed to start");
  }

  // Printed here, not at the top of setup(): the radio has no MAC until
  // WebServerApp::begin() puts WiFi into AP+STA, so the banner used to read
  // 00:00:00:00:00:00 every boot.
  Serial.printf("=========================================\n");
  Serial.printf(">> MAIN NODE MAC ADDRESS: %s <<\n", WiFi.macAddress().c_str());
  Serial.printf("=========================================\n");

  if (!EspNowRx::begin()) {
    Serial.println("[FATAL] ESP-NOW RX init failed");
  } else {
    Serial.println("[ESPNOW] RX ready");
  }
  if (!EspNowTx::begin()) {
    Serial.println("[WARN] ESP-NOW TX broadcast peer not registered");
  } else {
    Serial.println("[ESPNOW] TX ready (broadcast peer added)");
  }

  StatusLed::setState(StatusLed::AP_UP);
  Serial.println("=== Ready ===\n");
}

void loop() {
  ImuFrame frame;
  int drained = 0;

  // While a page is being delivered, give the document EVERYTHING.
  //
  // Four Strike Nodes put ~200 ESP-NOW frames a second through the same radio
  // the SoftAP is trying to send a 55 KB document over. Silencing only the
  // WebSocket left the CPU still parsing every one of those frames, still
  // writing the SD card, and still handing them to the TCP stack — so the page
  // load kept losing the race. Here the whole pipeline stands down: frames are
  // drained and thrown away (they are live telemetry; a second of it is worth
  // less than the page loading at all) and nothing touches the card.
  if (WebServerApp::streamIsQuiet()) {
    while (drained < 64 && EspNowRx::nextFrame(frame, 0))
      drained++;
    WebServerApp::loop();
    StatusLed::tick();
    delay(2);
    return;
  }
  // Block on the queue for the first frame instead of spinning + delay(2): when
  // no sensor is transmitting the loop task now sleeps rather than burning a
  // core, which leaves the WiFi and AsyncTCP tasks room to breathe. Subsequent
  // reads are non-blocking so a burst drains in one pass.
  while (drained < 32 &&
         EspNowRx::nextFrame(frame, drained == 0 ? pdMS_TO_TICKS(4) : 0)) {
    Session::noteImuFrame(frame.sampleCount);
    // per-node peak |accel| (g) for shake-to-assign
    float pk = 0.0f;
    for (uint8_t i = 0; i < frame.sampleCount; ++i) {
      const float ax = frame.samples[i].ax / 2048.0f;
      const float ay = frame.samples[i].ay / 2048.0f;
      const float az = frame.samples[i].az / 2048.0f;
      const float m = sqrtf(ax * ax + ay * ay + az * az);
      if (m > pk)
        pk = m;
    }
    Session::noteActivity(frame.mac, pk);
    if (Session::isActive())
      SdLogger::logFrame(frame);
    WebServerApp::broadcastImuFrame(frame);
    drained++;
  }

  // Log a joining node once, from here — never from the RX callback.
  uint8_t newMac[6];
  if (EspNowRx::takeNewNodeNotice(newMac)) {
    DLOG("NODE", "เข้าร่วม %02X:%02X:%02X:%02X:%02X:%02X (ออนไลน์ %u ตัว)",
         newMac[0], newMac[1], newMac[2], newMac[3], newMac[4], newMac[5],
         (unsigned)Session::liveNodeCount(3000));
  }

  // Periodic health snapshot — the baseline that makes an anomaly obvious when
  // reading the log back after something went wrong.
  static uint32_t lastHealthLogMs = 0;
  const uint32_t nowMs = millis();
  if (nowMs - lastHealthLogMs >= 15000) {
    lastHealthLogMs = nowMs;
    DLOG("SYS",
         "โหนด %u · wifi %u · ws %u · rx %lu drop %lu · wsdrop %lu quiet %lu · heap %lu",
         (unsigned)Session::liveNodeCount(3000),
         (unsigned)WiFi.softAPgetStationNum(),
         (unsigned)WebServerApp::connectedClients(),
         (unsigned long)EspNowRx::packetsReceived(),
         (unsigned long)EspNowRx::packetsDropped(),
         (unsigned long)WebServerApp::wsDropped(),
         (unsigned long)WebServerApp::quietDrops(),
         (unsigned long)ESP.getFreeHeap());
  }

  WebServerApp::loop();
  EspNowTx::tick();
  SdLogger::tick();
  StatusLed::setState(pickLedState());
  StatusLed::tick();
  logStats();
}

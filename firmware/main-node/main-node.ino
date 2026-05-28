// =============================================================================
// StrikeSense Main Node — single-file Arduino IDE sketch
// Target board : "ESP32S3 Dev Module"
// Settings     : Flash 8MB, PSRAM "OPI PSRAM", Partition "8M with spiffs (3MB APP)"
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

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <SPI.h>
#include <SD.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <Adafruit_NeoPixel.h>
#include <time.h>

// ============================================================
//  CONFIG
// ============================================================
#define AP_SSID        "StrikeSense"
#define AP_PASSWORD    "muaythai123"   // >= 8 chars
#define AP_CHANNEL     1               // MUST match STRIKESENSE_ESPNOW_CHANNEL

#define HTTP_PORT      80
#define WS_PATH        "/ws"

#define SD_CS_PIN      10
#define SD_MOSI_PIN    11
#define SD_SCK_PIN     12
#define SD_MISO_PIN    13

#define IMU_QUEUE_SIZE 64
#define STATUS_LED_PIN 48

// ============================================================
//  PROTOCOL (shared with Strike Node firmware)
// ============================================================
#define STRIKESENSE_PROTOCOL_VERSION 1
#define STRIKESENSE_ESPNOW_CHANNEL   1
#define STRIKESENSE_SAMPLE_RATE_HZ   400
#define STRIKESENSE_SAMPLE_PERIOD_US 2500   // 1_000_000 / 400
#define IMU_SAMPLES_PER_PACKET       8

enum NodeSlot : uint8_t {
    SLOT_UNASSIGNED = 0,
    SLOT_LEFT_HAND  = 1,
    SLOT_RIGHT_HAND = 2,
    SLOT_LEFT_SHIN  = 3,
    SLOT_RIGHT_SHIN = 4,
};

enum PacketType : uint8_t {
    PKT_IMU_BATCH   = 0x01,
    PKT_NODE_HELLO  = 0x02,
    PKT_NODE_STATUS = 0x03,
    PKT_TIME_SYNC   = 0x80,
    PKT_CMD_CONFIG    = 0x81,
    PKT_CMD_IDENTIFY  = 0x82,
    PKT_CMD_CALIBRATE = 0x83,
    PKT_CMD_RESTART   = 0x84,
};

typedef struct __attribute__((packed)) {
    int16_t ax, ay, az;
    int16_t gx, gy, gz;
} ImuSample;

typedef struct __attribute__((packed)) {
    uint8_t   version;
    uint8_t   type;
    uint8_t   reserved;
    uint8_t   sampleCount;
    uint32_t  seq;
    uint32_t  firstTimestampUs;
    uint16_t  samplePeriodUs;
    uint16_t  reserved2;
    ImuSample samples[IMU_SAMPLES_PER_PACKET];
} ImuBatchPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;
    uint8_t  firmwareMajor;
    uint8_t  firmwareMinor;
    uint8_t  macAddr[6];
} NodeHelloPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;
    uint8_t  batteryPct;
    int8_t   rssi;
    uint32_t uptimeMs;
    uint16_t lostPackets;
    uint16_t reserved;
} NodeStatusPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;
    uint8_t  reserved[2];
    uint32_t mainNodeTimestampMs;
} TimeSyncPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;
    uint8_t  newSampleRateHz;
    uint8_t  accelRangeG;
    uint8_t  gyroRangeDps;
    uint8_t  reserved[3];
} ConfigCommandPacket;

typedef struct __attribute__((packed)) {
    uint8_t  version;
    uint8_t  type;
} SimpleCommandPacket;


// ============================================================
//  SHARED STRUCTS
// ============================================================
struct NodeMapping {
    uint8_t  mac[6];
    NodeSlot slot;
    int8_t   lastRssi;
    uint32_t lastSeenMs;
    uint8_t  batteryPct;
    uint32_t nodeUptimeMs;
    uint16_t firmwareVersion;
    uint32_t packetsRx;
    uint32_t lastSeq;
    uint32_t seqGaps;
    bool     active;
};

struct SessionStats {
    uint32_t startedAtMs;
    uint32_t endedAtMs;
    uint32_t totalImuPackets;
    uint32_t totalImuSamples;
    bool     active;
};

struct ImuFrame {
    uint8_t   mac[6];
    NodeSlot  slot;
    int8_t    rssi;
    uint32_t  recvTimestampMs;
    uint32_t  nodeTimestampUs;
    uint32_t  seq;
    uint8_t   sampleCount;
    ImuSample samples[IMU_SAMPLES_PER_PACKET];
};

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
    static SessionStats g_stats   = {};
    static char g_sessionId[32]   = "";
    static char g_athleteName[32] = "";

    static bool macEquals(const uint8_t* a, const uint8_t* b) {
        for (int i = 0; i < 6; ++i) if (a[i] != b[i]) return false;
        return true;
    }
    static int findNode(const uint8_t* mac) {
        for (size_t i = 0; i < MAX_NODES; ++i) {
            if (g_nodes[i].active && macEquals(g_nodes[i].mac, mac)) return (int)i;
        }
        return -1;
    }
    static int findFreeSlot() {
        for (size_t i = 0; i < MAX_NODES; ++i) if (!g_nodes[i].active) return (int)i;
        return -1;
    }

    void begin() {
        for (auto& n : g_nodes) n = {};
        g_stats = {};
    }

    bool start(const char* athleteName) {
        if (g_stats.active) return false;
        g_stats = {};
        g_stats.active      = true;
        g_stats.startedAtMs = millis();
        strncpy(g_athleteName, athleteName ? athleteName : "anonymous", sizeof(g_athleteName) - 1);
        snprintf(g_sessionId, sizeof(g_sessionId), "%lu", (unsigned long)g_stats.startedAtMs);
        return true;
    }

    bool stop() {
        if (!g_stats.active) return false;
        g_stats.active    = false;
        g_stats.endedAtMs = millis();
        return true;
    }

    bool isActive()                  { return g_stats.active; }
    const SessionStats& stats()      { return g_stats; }
    const char* currentSessionId()   { return g_sessionId; }

    void rememberNode(const uint8_t* mac, int8_t rssi) {
        int idx = findNode(mac);
        if (idx < 0) {
            idx = findFreeSlot();
            if (idx < 0) return;
            memcpy(g_nodes[idx].mac, mac, 6);
            g_nodes[idx].slot            = SLOT_UNASSIGNED;
            g_nodes[idx].active          = true;
            g_nodes[idx].packetsRx       = 0;
            g_nodes[idx].lastSeq         = 0;
            g_nodes[idx].seqGaps         = 0;
            g_nodes[idx].batteryPct      = 0;
            g_nodes[idx].nodeUptimeMs    = 0;
            g_nodes[idx].firmwareVersion = 0;
        }
        g_nodes[idx].lastRssi   = rssi;
        g_nodes[idx].lastSeenMs = millis();
    }

    void countImuPacket(const uint8_t* mac, uint32_t seq) {
        int idx = findNode(mac);
        if (idx < 0) return;
        g_nodes[idx].packetsRx++;
        if (g_nodes[idx].lastSeq != 0 && seq > g_nodes[idx].lastSeq + 1) {
            g_nodes[idx].seqGaps += (seq - g_nodes[idx].lastSeq - 1);
        }
        g_nodes[idx].lastSeq = seq;
    }

    void updateNodeStatus(const uint8_t* mac, uint8_t batteryPct, uint32_t uptimeMs) {
        int idx = findNode(mac);
        if (idx < 0) return;
        g_nodes[idx].batteryPct   = batteryPct;
        g_nodes[idx].nodeUptimeMs = uptimeMs;
    }

    void updateNodeHello(const uint8_t* mac, uint8_t fwMajor, uint8_t fwMinor) {
        int idx = findNode(mac);
        if (idx < 0) return;
        g_nodes[idx].firmwareVersion = ((uint16_t)fwMajor << 8) | fwMinor;
    }

    void noteImuFrame(uint8_t sampleCount) {
        if (!g_stats.active) return;
        g_stats.totalImuPackets++;
        g_stats.totalImuSamples += sampleCount;
    }

    bool assignSlot(const uint8_t* mac, NodeSlot slot) {
        int idx = findNode(mac);
        if (idx < 0) return false;
        g_nodes[idx].slot = slot;
        return true;
    }

    NodeSlot lookupSlot(const uint8_t* mac) {
        int idx = findNode(mac);
        return idx < 0 ? SLOT_UNASSIGNED : g_nodes[idx].slot;
    }

    size_t listNodes(NodeMapping* out, size_t maxCount) {
        size_t n = 0;
        for (size_t i = 0; i < MAX_NODES && n < maxCount; ++i) {
            if (g_nodes[i].active) out[n++] = g_nodes[i];
        }
        return n;
    }

    void cleanStaleNodes() {
        const uint32_t now = millis();
        for (size_t i = 0; i < MAX_NODES; ++i) {
            if (g_nodes[i].active && (now - g_nodes[i].lastSeenMs > 5000)) {
                g_nodes[i].active = false;
                g_nodes[i].slot = SLOT_UNASSIGNED;
            }
        }
    }
} // namespace Session

// ============================================================
//  ESP-NOW RX MODULE
// ============================================================
namespace EspNowRx {
    static QueueHandle_t      g_queue    = nullptr;
    static volatile uint32_t  g_received = 0;
    static volatile uint32_t  g_dropped  = 0;

    static void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
        if (!g_queue) return;
        if (len < 2 || data[0] != STRIKESENSE_PROTOCOL_VERSION) return;

        const uint8_t* mac  = info->src_addr;
        const int8_t   rssi = info->rx_ctrl ? info->rx_ctrl->rssi : 0;

        // DEBUG: พิมพ์ข้อมูลทุกครั้งที่มีคนส่ง ESP-NOW เข้ามา
        Serial.printf("[DEBUG RX] Got %d bytes from %02X:%02X:%02X:%02X:%02X:%02X, Type: 0x%02X, RSSI: %d\n", 
            len, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], data[1], rssi);

        Session::rememberNode(mac, rssi);

        switch (data[1]) {
            case PKT_IMU_BATCH: {
                if (len < (int)sizeof(ImuBatchPacket)) return;
                const auto* pkt = reinterpret_cast<const ImuBatchPacket*>(data);
                Session::countImuPacket(mac, pkt->seq);

                ImuFrame frame;
                memcpy(frame.mac, mac, 6);
                frame.slot            = Session::lookupSlot(mac);
                frame.rssi            = rssi;
                frame.recvTimestampMs = millis();
                frame.nodeTimestampUs = pkt->firstTimestampUs;
                frame.seq             = pkt->seq;
                frame.sampleCount     = pkt->sampleCount;
                memcpy(frame.samples, pkt->samples, sizeof(frame.samples));

                if (xQueueSendFromISR(g_queue, &frame, nullptr) != pdTRUE) {
                    g_dropped++;
                }
                g_received++;
                break;
            }
            case PKT_NODE_HELLO: {
                if (len < (int)sizeof(NodeHelloPacket)) return;
                const auto* pkt = reinterpret_cast<const NodeHelloPacket*>(data);
                Session::updateNodeHello(mac, pkt->firmwareMajor, pkt->firmwareMinor);
                break;
            }
            case PKT_NODE_STATUS: {
                if (len < (int)sizeof(NodeStatusPacket)) return;
                const auto* pkt = reinterpret_cast<const NodeStatusPacket*>(data);
                Session::updateNodeStatus(mac, pkt->batteryPct, pkt->uptimeMs);
                break;
            }
            default: break;
        }
    }

    bool begin() {
        g_queue = xQueueCreate(IMU_QUEUE_SIZE, sizeof(ImuFrame));
        if (!g_queue) return false;
        if (esp_now_init() != ESP_OK) return false;
        esp_now_register_recv_cb(onRecv);
        esp_wifi_set_channel(STRIKESENSE_ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
        return true;
    }

    bool nextFrame(ImuFrame& out, TickType_t waitTicks = 0) {
        if (!g_queue) return false;
        return xQueueReceive(g_queue, &out, waitTicks) == pdTRUE;
    }

    uint32_t packetsReceived() { return g_received; }
    uint32_t packetsDropped()  { return g_dropped;  }
} // namespace EspNowRx

// ============================================================
//  ESP-NOW TX MODULE
// ============================================================
namespace EspNowTx {
    static constexpr uint8_t  BROADCAST_MAC[6]  = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
    static constexpr uint32_t SYNC_INTERVAL_MS  = 5000;
    static bool      g_ready       = false;
    static uint32_t  g_lastSyncMs  = 0;

    static bool ensurePeer(const uint8_t mac[6]) {
        if (esp_now_is_peer_exist(mac)) return true;
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
        if (!g_ready) return false;
        TimeSyncPacket pkt      = {};
        pkt.version             = STRIKESENSE_PROTOCOL_VERSION;
        pkt.type                = PKT_TIME_SYNC;
        pkt.mainNodeTimestampMs = millis();
        return esp_now_send(BROADCAST_MAC, (const uint8_t*)&pkt, sizeof(pkt)) == ESP_OK;
    }

    bool sendConfig(const uint8_t mac[6], uint8_t sampleRateHz, uint8_t accelG, uint8_t gyroDps) {
        if (!ensurePeer(mac)) return false;
        ConfigCommandPacket pkt = {};
        pkt.version             = STRIKESENSE_PROTOCOL_VERSION;
        pkt.type                = PKT_CMD_CONFIG;
        pkt.newSampleRateHz     = sampleRateHz;
        pkt.accelRangeG         = accelG;
        pkt.gyroRangeDps        = gyroDps;
        return esp_now_send(mac, (const uint8_t*)&pkt, sizeof(pkt)) == ESP_OK;
    }

    bool sendCommand(const uint8_t mac[6], uint8_t cmdType) {
        if (!ensurePeer(mac)) return false;
        SimpleCommandPacket pkt = {};
        pkt.version = STRIKESENSE_PROTOCOL_VERSION;
        pkt.type    = cmdType;
        return esp_now_send(mac, (const uint8_t*)&pkt, sizeof(pkt)) == ESP_OK;
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
    static SPIClass  g_spi(HSPI);
    static bool      g_ready          = false;
    static bool      g_sessionOpen    = false;
    static File      g_file;
    static char      g_currentId[24]  = "";

    static constexpr size_t   WRITE_BUF_SIZE  = 16 * 1024;
    static char               g_buf[WRITE_BUF_SIZE];
    static size_t             g_bufLen        = 0;
    static uint32_t           g_lastFlushMs   = 0;
    static constexpr uint32_t BUFFER_FLUSH_MS = 500;

    static uint32_t g_rowsWritten    = 0;
    static uint32_t g_bytesWritten   = 0;
    static uint32_t g_sessionStartMs = 0;

    struct SessionEntry {
        char id[24];
        uint32_t sizeBytes;
        uint32_t modTime;
    };

    static void ensureDir(const char* path) {
        if (!SD.exists(path)) SD.mkdir(path);
    }

    static void writeHeader(const char* athleteName) {
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
        if (n > 0) g_bufLen += n;
    }

    static void flushBufferToCard() {
        if (!g_sessionOpen || g_bufLen == 0) return;
        size_t w = g_file.write((const uint8_t*)g_buf, g_bufLen);
        g_bytesWritten += w;
        g_bufLen = 0;
        g_file.flush();
        g_lastFlushMs = millis();
    }

    static void appendRow(uint32_t tMs, const ImuFrame& f, size_t sampleIdx, const ImuSample& s) {
        if (g_bufLen + 96 >= WRITE_BUF_SIZE) flushBufferToCard();
        int n = snprintf(g_buf + g_bufLen, WRITE_BUF_SIZE - g_bufLen,
            "%lu,%u,%lu,%u,%d,%d,%d,%d,%d,%d\n",
            (unsigned long)tMs,
            (unsigned)f.slot,
            (unsigned long)f.seq,
            (unsigned)sampleIdx,
            s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
        if (n > 0) g_bufLen += (size_t)n;
        g_rowsWritten++;
    }

    uint64_t cardSizeMB() { return g_ready ? SD.cardSize() / (1024ULL * 1024ULL) : 0; }
    uint64_t usedMB()     { return g_ready ? SD.usedBytes() / (1024ULL * 1024ULL) : 0; }

    bool begin() {
        g_spi.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
        if (!SD.begin(SD_CS_PIN, g_spi, 20000000)) {
            Serial.println("[SD] mount failed (card missing?)");
            g_ready = false;
            return false;
        }
        if (SD.cardType() == CARD_NONE) {
            Serial.println("[SD] no card detected");
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

    bool openSession(const char* sessionId, const char* athleteName) {
        if (!g_ready || g_sessionOpen) return false;
        char path[64];
        snprintf(path, sizeof(path), "/sessions/%s.csv", sessionId);
        g_file = SD.open(path, FILE_WRITE);
        if (!g_file) {
            Serial.printf("[SD] failed to open %s\n", path);
            return false;
        }
        strncpy(g_currentId, sessionId, sizeof(g_currentId) - 1);
        g_currentId[sizeof(g_currentId) - 1] = 0;
        g_sessionOpen    = true;
        g_bufLen         = 0;
        g_rowsWritten    = 0;
        g_bytesWritten   = 0;
        g_sessionStartMs = millis();
        writeHeader(athleteName);
        flushBufferToCard();
        Serial.printf("[SD] session opened: %s\n", path);
        return true;
    }

    void logFrame(const ImuFrame& frame) {
        if (!g_sessionOpen) return;
        const uint32_t sessionTimeMs = millis() - g_sessionStartMs;
        for (size_t i = 0; i < frame.sampleCount; ++i) {
            appendRow(sessionTimeMs, frame, i, frame.samples[i]);
        }
        const uint32_t now = millis();
        if (now - g_lastFlushMs >= BUFFER_FLUSH_MS || g_bufLen > (WRITE_BUF_SIZE * 3 / 4)) {
            flushBufferToCard();
        }
    }

    void flush() { flushBufferToCard(); }

    void closeSession() {
        if (!g_sessionOpen) return;
        flushBufferToCard();
        g_file.close();
        g_sessionOpen = false;
        Serial.printf("[SD] session closed: %s (%lu rows, %lu bytes)\n",
            g_currentId, (unsigned long)g_rowsWritten, (unsigned long)g_bytesWritten);
    }

    uint32_t rowsWritten()  { return g_rowsWritten; }
    uint32_t bytesWritten() { return g_bytesWritten; }

    size_t listSessions(SessionEntry* out, size_t maxCount) {
        if (!g_ready) return 0;
        File dir = SD.open("/sessions");
        if (!dir || !dir.isDirectory()) return 0;
        size_t n = 0;
        File f;
        while ((f = dir.openNextFile()) && n < maxCount) {
            if (!f.isDirectory()) {
                const char* name = f.name();
                strncpy(out[n].id, name, sizeof(out[n].id) - 1);
                out[n].id[sizeof(out[n].id) - 1] = 0;
                size_t L = strlen(out[n].id);
                if (L > 4 && strcmp(out[n].id + L - 4, ".csv") == 0) out[n].id[L - 4] = 0;
                out[n].sizeBytes = f.size();
                out[n].modTime   = f.getLastWrite();
                n++;
            }
            f.close();
        }
        dir.close();
        return n;
    }

    bool deleteSession(const char* id) {
        if (!g_ready) return false;
        char path[64];
        snprintf(path, sizeof(path), "/sessions/%s.csv", id);
        return SD.remove(path);
    }

    const char* sessionPath(const char* id, char* out, size_t n) {
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
    static State    g_state       = BOOT;
    static uint32_t g_lastTickMs  = 0;
    static float    g_phase       = 0;

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
        if (g_state == s) return;
        g_state = s;
    }

    void tick() {
        const uint32_t now = millis();
        if (now - g_lastTickMs < 40) return;
        g_lastTickMs = now;
        g_phase += 0.05f;
        const float pulse = (sinf(g_phase) + 1.0f) * 0.5f;

        switch (g_state) {
            case BOOT:      setColor(40, 40, 40); break;
            case AP_UP:     setColor(0, 30, 60);  break;
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
    static AsyncWebServer    g_http(HTTP_PORT);
    static AsyncWebSocket    g_ws(WS_PATH);

    static void macToStr(const uint8_t* m, char* buf, size_t n) {
        snprintf(buf, n, "%02X:%02X:%02X:%02X:%02X:%02X", m[0],m[1],m[2],m[3],m[4],m[5]);
    }

    static bool parseMac(const char* s, uint8_t* out) {
        unsigned int v[6];
        if (sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0],&v[1],&v[2],&v[3],&v[4],&v[5]) != 6) return false;
        for (int i = 0; i < 6; ++i) out[i] = (uint8_t)v[i];
        return true;
    }

    static void onWsEvent(AsyncWebSocket*, AsyncWebSocketClient* client,
                          AwsEventType type, void*, uint8_t*, size_t) {
        if (type == WS_EVT_CONNECT) {
            Serial.printf("[WS] Client #%u connected\n", client->id());
        } else if (type == WS_EVT_DISCONNECT) {
            Serial.printf("[WS] Client #%u disconnected\n", client->id());
        }
    }

    static void registerRoutes() {
        // ---- Embedded dashboard ----
        auto sendDashboard = [](AsyncWebServerRequest* req) {
            AsyncWebServerResponse* resp = req->beginResponse_P(200, "text/html", DASHBOARD_HTML);
            req->send(resp);
        };
        g_http.on("/",           HTTP_GET, sendDashboard);
        g_http.on("/index.html", HTTP_GET, sendDashboard);

        // ---- GET /api/status ----
        g_http.on("/api/status", HTTP_GET, [](AsyncWebServerRequest* req) {
            DynamicJsonDocument doc(1024);
            doc["uptimeMs"]  = millis();
            doc["heap"]      = ESP.getFreeHeap();
            doc["psram"]     = ESP.getFreePsram();
            doc["rx"]        = EspNowRx::packetsReceived();
            doc["dropped"]   = EspNowRx::packetsDropped();
            doc["wsClients"] = g_ws.count();

            JsonObject sess = doc["session"].to<JsonObject>();
            const auto& s = Session::stats();
            sess["active"]     = s.active;
            sess["id"]         = Session::currentSessionId();
            sess["startedAt"]  = s.startedAtMs;
            sess["durationMs"] = s.active ? (millis() - s.startedAtMs) : (s.endedAtMs - s.startedAtMs);
            sess["packets"]    = s.totalImuPackets;
            sess["samples"]    = s.totalImuSamples;

            JsonObject sd = doc["sd"].to<JsonObject>();
            sd["ready"]  = SdLogger::isReady();
            sd["cardMB"] = (uint32_t)SdLogger::cardSizeMB();
            sd["usedMB"] = (uint32_t)SdLogger::usedMB();
            sd["rows"]   = SdLogger::rowsWritten();
            sd["bytes"]  = SdLogger::bytesWritten();

            String out; serializeJson(doc, out);
            req->send(200, "application/json", out);
        });

        // ---- GET /api/nodes ----
        g_http.on("/api/nodes", HTTP_GET, [](AsyncWebServerRequest* req) {
            NodeMapping nodes[8];
            size_t n = Session::listNodes(nodes, 8);
            DynamicJsonDocument doc(1024);
            JsonArray arr = doc.to<JsonArray>();
            const uint32_t nowMs = millis();
            for (size_t i = 0; i < n; ++i) {
                char macStr[18]; macToStr(nodes[i].mac, macStr, sizeof(macStr));
                JsonObject o = arr.add<JsonObject>();
                o["mac"]          = macStr;
                o["slot"]         = (int)nodes[i].slot;
                o["rssi"]         = nodes[i].lastRssi;
                o["lastSeenMs"]   = nodes[i].lastSeenMs;
                o["ageMs"]        = nowMs - nodes[i].lastSeenMs;
                o["batteryPct"]   = nodes[i].batteryPct;
                o["nodeUptimeMs"] = nodes[i].nodeUptimeMs;
                o["firmware"]     = nodes[i].firmwareVersion;
                o["packetsRx"]    = nodes[i].packetsRx;
                o["lastSeq"]      = nodes[i].lastSeq;
                o["seqGaps"]      = nodes[i].seqGaps;
            }
            String out; serializeJson(arr, out);
            req->send(200, "application/json", out);
        });

        // ---- POST /api/nodes/assign ----
        g_http.on("/api/nodes/assign", HTTP_POST,
            [](AsyncWebServerRequest*) {},
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t, size_t) {
                DynamicJsonDocument doc(1024);
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

        // ---- POST /api/nodes/identify ----
        g_http.on("/api/nodes/identify", HTTP_POST,
            [](AsyncWebServerRequest*) {},
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t, size_t) {
                DynamicJsonDocument doc(512);
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
                req->send(ok ? 200 : 500, "application/json", ok ? "{\"ok\":true}" : "{\"error\":\"tx failed\"}");
            });

        // ---- POST /api/nodes/restart ----
        g_http.on("/api/nodes/restart", HTTP_POST,
            [](AsyncWebServerRequest*) {},
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t, size_t) {
                DynamicJsonDocument doc(512);
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
                req->send(ok ? 200 : 500, "application/json", ok ? "{\"ok\":true}" : "{\"error\":\"tx failed\"}");
            });

        // ---- POST /api/session/start ----
        g_http.on("/api/session/start", HTTP_POST,
            [](AsyncWebServerRequest*) {},
            nullptr,
            [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t, size_t) {
                DynamicJsonDocument doc(512); deserializeJson(doc, data, len);
                const char* athlete = doc["athlete"] | "anonymous";
                if (!Session::start(athlete)) {
                    req->send(409, "application/json", "{\"error\":\"already active\"}");
                    return;
                }
                bool sdOk = SdLogger::openSession(Session::currentSessionId(), athlete);
                DynamicJsonDocument res(512);
                res["sessionId"] = Session::currentSessionId();
                res["sdLogging"] = sdOk;
                if (!sdOk) res["warning"] = "SD logging unavailable";
                String out; serializeJson(res, out);
                req->send(200, "application/json", out);
            });

        // ---- POST /api/session/stop ----
        g_http.on("/api/session/stop", HTTP_POST, [](AsyncWebServerRequest* req) {
            SdLogger::closeSession();
            bool ok = Session::stop();
            req->send(ok ? 200 : 409, "application/json",
                      ok ? "{\"ok\":true}" : "{\"error\":\"not active\"}");
        });

        // ---- GET /api/sessions ----
        g_http.on("/api/sessions", HTTP_GET, [](AsyncWebServerRequest* req) {
            SdLogger::SessionEntry entries[32];
            size_t n = SdLogger::listSessions(entries, 32);
            DynamicJsonDocument doc(2048);
            JsonArray arr = doc.to<JsonArray>();
            for (size_t i = 0; i < n; ++i) {
                JsonObject o = arr.add<JsonObject>();
                o["id"]      = entries[i].id;
                o["bytes"]   = entries[i].sizeBytes;
                o["modTime"] = entries[i].modTime;
            }
            String out; serializeJson(arr, out);
            req->send(200, "application/json", out);
        });

        // ---- GET /api/sessions/{id} (download CSV) ----
        g_http.on("/api/session/download", HTTP_GET, [](AsyncWebServerRequest* req) {
            if(!req->hasParam("id")) { req->send(400, "application/json", "{\"error\":\"missing id\"}"); return; }
            String id = req->getParam("id")->value();
            char path[64];
            SdLogger::sessionPath(id.c_str(), path, sizeof(path));
            if (!SD.exists(path)) { req->send(404, "application/json", "{\"error\":\"not found\"}"); return; }
            AsyncWebServerResponse* resp = req->beginResponse(SD, path, "text/csv", true);
            req->send(resp);
        });

        // ---- DELETE /api/sessions/{id} ----
        g_http.on("/api/session/delete", HTTP_DELETE, [](AsyncWebServerRequest* req) {
            if(!req->hasParam("id")) { req->send(400, "application/json", "{\"error\":\"missing id\"}"); return; }
            String id = req->getParam("id")->value();
            bool ok = SdLogger::deleteSession(id.c_str());
            req->send(ok ? 200 : 404, "application/json",
                      ok ? "{\"ok\":true}" : "{\"error\":\"not found\"}");
        });

        g_http.onNotFound([](AsyncWebServerRequest* req) {
            req->send(404, "text/plain", "Not found");
        });
    }

    bool begin() {
        // ใช้ WIFI_AP_STA เพื่อแก้บั๊กรับ ESP-NOW Broadcast ไม่เข้าในบางบอร์ด (ESP32-S3/C3)
        WiFi.mode(WIFI_AP_STA);
        WiFi.softAP(AP_SSID, AP_PASSWORD, AP_CHANNEL);
        IPAddress ip = WiFi.softAPIP();
        Serial.printf("[WIFI] AP '%s' up at %s (channel %d)\n",
            AP_SSID, ip.toString().c_str(), AP_CHANNEL);

        g_ws.onEvent(onWsEvent);
        g_http.addHandler(&g_ws);
        registerRoutes();
        g_http.begin();
        Serial.println("[HTTP] Listening on :80");
        return true;
    }

    void broadcastImuFrame(const ImuFrame& f) {
        if (g_ws.count() == 0) return;
        uint8_t buf[16 + IMU_SAMPLES_PER_PACKET * 12];
        buf[0] = 0x01;
        buf[1] = (uint8_t)f.slot;
        buf[2] = f.sampleCount;
        buf[3] = (uint8_t)f.rssi;
        memcpy(buf + 4,  &f.seq, 4);
        memcpy(buf + 8,  &f.recvTimestampMs, 4);
        memcpy(buf + 12, &f.nodeTimestampUs, 4);
        memcpy(buf + 16, f.samples, f.sampleCount * sizeof(ImuSample));
        g_ws.binaryAll(buf, 16 + f.sampleCount * sizeof(ImuSample));
    }

    void loop()                  { g_ws.cleanupClients(); }
    size_t connectedClients()    { return g_ws.count(); }
} // namespace WebServerApp

// ============================================================
//  MAIN  (setup / loop)
// ============================================================
static uint32_t g_lastStatsLogMs = 0;

static StatusLed::State pickLedState() {
    if (!SdLogger::isReady()) return StatusLed::SD_ERROR;
    if (Session::isActive())  return StatusLed::RECORDING;
    NodeMapping nodes[8];
    size_t n = Session::listNodes(nodes, 8);
    const uint32_t now = millis();
    for (size_t i = 0; i < n; ++i) {
        if (now - nodes[i].lastSeenMs < 2000) return StatusLed::NODE_LINK;
    }
    return StatusLed::AP_UP;
}

static void logStats() {
    const uint32_t now = millis();
    if (now - g_lastStatsLogMs < 2000) return;
    g_lastStatsLogMs = now;
    Serial.printf("[STATS] rx=%lu drop=%lu ws=%u sess=%s sd=%s rows=%lu heap=%lu\n",
        (unsigned long)EspNowRx::packetsReceived(),
        (unsigned long)EspNowRx::packetsDropped(),
        (unsigned)WebServerApp::connectedClients(),
        Session::isActive() ? "ON" : "off",
        SdLogger::isReady() ? "OK" : "ERR",
        (unsigned long)SdLogger::rowsWritten(),
        (unsigned long)ESP.getFreeHeap());
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("\n=== StrikeSense Main Node (Arduino IDE build) ===");
    Serial.printf("Build: %s %s\n", __DATE__, __TIME__);
    Serial.printf("ESP32-S3 . %d MHz . Flash %lu MB . PSRAM %lu KB\n",
        ESP.getCpuFreqMHz(),
        (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)),
        (unsigned long)(ESP.getPsramSize() / 1024));

    // พิมพ์ MAC Address ของ Main Node ออกมาให้เห็นชัดๆ
    String mac = WiFi.macAddress();
    Serial.printf("=========================================\n");
    Serial.printf(">> MAIN NODE MAC ADDRESS: %s <<\n", mac.c_str());
    Serial.printf("=========================================\n");

    StatusLed::begin();
    Session::begin();

    if (!SdLogger::begin()) {
        Serial.println("[WARN] SD card unavailable - sessions will not be logged");
    }

    if (!WebServerApp::begin()) {
        Serial.println("[FATAL] Web server failed to start");
    }

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
    while (drained < 32 && EspNowRx::nextFrame(frame, 0)) {
        Session::noteImuFrame(frame.sampleCount);
        if (Session::isActive()) SdLogger::logFrame(frame);
        WebServerApp::broadcastImuFrame(frame);
        drained++;
    }

    WebServerApp::loop();
    EspNowTx::tick();
    Session::cleanStaleNodes();
    SdLogger::flush();
    StatusLed::setState(pickLedState());
    StatusLed::tick();
    logStats();

    if (drained == 0) delay(2);
}

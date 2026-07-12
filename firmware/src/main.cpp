// Shabat Clock ESP32 firmware — SPEC §6.
// The DEVICE is authoritative for schedule execution: schedules persist in NVS and
// run off the local clock; connectivity is never required to keep שבת working.
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Adafruit_MCP23X17.h>
#include <esp_task_wdt.h>
#include <time.h>
#include <vector>
#include <map>
#include "canonical.h"

#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif

// ── [D36] hardware profiles: board type → relay count + pin map. A new board
//    layout is a new profile in a firmware release — never a schema/API change. ──
struct Profile {
  const char* id;
  const char* label;
  uint8_t relayCount;
  int8_t gpio[8];      // direct GPIO channels (first N); -1 = unused
  uint8_t mcpChannels; // channels driven via MCP23017 after the GPIOs
};
static const Profile PROFILES[] = {
  { "relay2",  "2ch GPIO",            2,  {26, 27, -1, -1, -1, -1, -1, -1}, 0  },
  { "relay4",  "4ch GPIO",            4,  {26, 27, 32, 33, -1, -1, -1, -1}, 0  },
  { "relay8",  "8ch GPIO",            8,  {26, 27, 32, 33, 25, 14, 12, 13}, 0  },
  { "relay16", "16ch MCP23017",       16, {-1, -1, -1, -1, -1, -1, -1, -1}, 16 },
  { "relay20", "4ch GPIO + MCP23017", 20, {26, 27, 32, 33, -1, -1, -1, -1}, 16 },
};
static const int PROFILE_COUNT = sizeof(PROFILES) / sizeof(PROFILES[0]);

// Israel DST rule per SPEC §6.2.
static const char* TZ_ISRAEL = "IST-2IDT,M3.4.4/26,M10.5.0";
static const int MIN_PER_WEEK = 7 * 24 * 60;
static const uint8_t BOOT_PIN = 0; // hold 5s at boot → reconfigure portal
static const int MAX_EXEC_QUEUE = 100; // [D26]

// Let's Encrypt ISRG Root X1 — broker cert chain (§5).
static const char ISRG_ROOT_X1[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";

// ── state ──────────────────────────────────────────────────
Preferences prefs;
WiFiClientSecure tlsClient;
PubSubClient mqttClient(tlsClient);
Adafruit_MCP23X17 mcp;

String deviceUid, brokerHost, mqttSecret;
const Profile* profile = &PROFILES[0];
bool mcpOk = false;
bool timeValid = false;
uint32_t execDropped = 0;

struct WeeklyEvent { long sid; uint8_t relay; uint8_t day; uint16_t minutes; bool on; };
struct OnceEvent   { long sid; uint8_t relay; int y, mo, d; uint16_t minutes; bool on; };
struct RelayCfg    { bool present = false; uint8_t boot = 2; }; // 0=off 1=last_state 2=schedule
std::vector<WeeklyEvent> weekly;
std::vector<OnceEvent> once;
RelayCfg relayCfg[21]; // 1-based
bool relayState[21] = {false};
long schedVersion = 0;

long lastCmdIds[32] = {0};
int lastCmdIdx = 0;
std::map<long long, time_t> firedAt; // (sid*2+action) → utc of last fire, pruned at 48h
int prevMow = -1;
unsigned long lastStatusMs = 0, lastReconnectMs = 0, reconnectDelayMs = 1000;

// ── relay drive: active-LOW; ALL OFF at GPIO init before anything else (§6.9) ──
void driveRelay(uint8_t no, bool on) {
  int idx = no - 1;
  int8_t gpioCount = 0;
  for (int i = 0; i < 8; i++) if (profile->gpio[i] >= 0) gpioCount++;
  if (idx < gpioCount) {
    digitalWrite(profile->gpio[idx], on ? LOW : HIGH);
  } else if (mcpOk) {
    mcp.digitalWrite(idx - gpioCount, on ? LOW : HIGH);
  }
  relayState[no] = on;
}

void initRelays() {
  int8_t gpioCount = 0;
  for (int i = 0; i < 8; i++) {
    if (profile->gpio[i] >= 0) {
      pinMode(profile->gpio[i], OUTPUT);
      digitalWrite(profile->gpio[i], HIGH); // OFF
      gpioCount++;
    }
  }
  if (profile->mcpChannels > 0) {
    mcpOk = mcp.begin_I2C();
    if (mcpOk) {
      for (int i = 0; i < profile->mcpChannels; i++) {
        mcp.pinMode(i, OUTPUT);
        mcp.digitalWrite(i, HIGH); // OFF
      }
    }
  }
  for (int i = 1; i <= 20; i++) relayState[i] = false;
}

// ── NVS persistence ────────────────────────────────────────
void saveRelayStates() {
  char buf[24];
  uint32_t bits = 0;
  for (int i = 1; i <= 20; i++) if (relayState[i]) bits |= (1u << i);
  snprintf(buf, sizeof(buf), "%u", bits);
  prefs.putString("laststate", buf);
}

bool lastSavedState(uint8_t no) {
  uint32_t bits = (uint32_t)prefs.getString("laststate", "0").toInt();
  return bits & (1u << no);
}

// ── schedule model ─────────────────────────────────────────
uint16_t parseHHMM(const char* t) {
  return (uint16_t)((t[0] - '0') * 10 + (t[1] - '0')) * 60 + (t[3] - '0') * 10 + (t[4] - '0');
}

// [D35] full replace: NVS schedule + relay config overwritten wholesale; relay
// numbers absent from the payload are cleared and forced OFF.
void applySchedulePayload(JsonObjectConst p) {
  weekly.clear();
  once.clear();
  for (int i = 1; i <= 20; i++) relayCfg[i] = RelayCfg{};

  for (JsonObjectConst r : p["relays"].as<JsonArrayConst>()) {
    int no = r["no"].as<int>();
    if (no < 1 || no > profile->relayCount) continue;
    relayCfg[no].present = true;
    const char* b = r["boot"].as<const char*>();
    relayCfg[no].boot = strcmp(b, "off") == 0 ? 0 : strcmp(b, "last_state") == 0 ? 1 : 2;
  }
  for (JsonObjectConst e : p["events"].as<JsonArrayConst>()) {
    weekly.push_back({ e["sid"].as<long>(), (uint8_t)e["relay"].as<int>(),
                       (uint8_t)e["day"].as<int>(), parseHHMM(e["time"].as<const char*>()),
                       strcmp(e["action"].as<const char*>(), "on") == 0 });
  }
  for (JsonObjectConst o : p["once"].as<JsonArrayConst>()) {
    int y, mo, d;
    sscanf(o["date"].as<const char*>(), "%d-%d-%d", &y, &mo, &d);
    once.push_back({ o["sid"].as<long>(), (uint8_t)o["relay"].as<int>(), y, mo, d,
                     parseHHMM(o["time"].as<const char*>()),
                     strcmp(o["action"].as<const char*>(), "on") == 0 });
  }
  schedVersion = p["version"].as<long>();
  for (int no = 1; no <= profile->relayCount; no++) {
    if (!relayCfg[no].present && relayState[no]) driveRelay(no, false);
  }
  saveRelayStates();
}

void loadScheduleFromNvs() {
  String raw = prefs.getString("sched", "");
  if (raw.isEmpty()) return;
  JsonDocument doc;
  if (deserializeJson(doc, raw) == DeserializationError::Ok) {
    applySchedulePayload(doc.as<JsonObjectConst>());
  }
}

// ── boot behavior (§6.3): compute what state each relay SHOULD be in right now ──
time_t weeklyLastOccurrence(const WeeklyEvent& e, const tm& now, time_t nowUtc) {
  int nowMow = (now.tm_wday) * 1440 + now.tm_hour * 60 + now.tm_min;
  // daily (day 0): treat as an event on every day — nearest past occurrence today/yesterday
  int bestBack = MIN_PER_WEEK + 1;
  for (int day = 1; day <= 7; day++) {
    if (e.day != 0 && e.day != day) continue;
    int evMow = (day - 1) * 1440 + e.minutes;
    int back = ((nowMow - evMow) % MIN_PER_WEEK + MIN_PER_WEEK) % MIN_PER_WEEK;
    if (back < bestBack) bestBack = back;
  }
  return bestBack > MIN_PER_WEEK ? 0 : nowUtc - (time_t)bestBack * 60;
}

void applyBootBehavior() {
  time_t nowUtc = time(nullptr);
  tm lt;
  localtime_r(&nowUtc, &lt);
  for (int no = 1; no <= profile->relayCount; no++) {
    if (!relayCfg[no].present) { driveRelay(no, false); continue; }
    if (relayCfg[no].boot == 0) { driveRelay(no, false); continue; }
    if (relayCfg[no].boot == 1) { driveRelay(no, lastSavedState(no)); continue; }
    // 'schedule': most recent event for this relay wins; no event → off. Needs a
    // valid clock — without one stay inert (OFF) per §5b (better inert than wrong).
    if (!timeValid) { driveRelay(no, false); continue; }
    time_t bestT = 0;
    bool bestOn = false;
    for (const auto& e : weekly) {
      if (e.relay != no) continue;
      time_t t = weeklyLastOccurrence(e, lt, nowUtc);
      if (t > bestT) { bestT = t; bestOn = e.on; }
    }
    for (const auto& o : once) {
      if (o.relay != no) continue;
      tm evt = {};
      evt.tm_year = o.y - 1900; evt.tm_mon = o.mo - 1; evt.tm_mday = o.d;
      evt.tm_hour = o.minutes / 60; evt.tm_min = o.minutes % 60; evt.tm_isdst = -1;
      time_t t = mktime(&evt);
      if (t <= nowUtc && t > bestT) { bestT = t; bestOn = o.on; }
    }
    driveRelay(no, bestT ? bestOn : false);
  }
  saveRelayStates();
}

// ── MQTT ───────────────────────────────────────────────────
String topic(const char* leaf) { return "dev/" + deviceUid + "/" + leaf; }

void publishStatus() {
  JsonDocument doc;
  doc["online"] = true;
  doc["fw"] = FW_VERSION;
  doc["rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  doc["time_valid"] = timeValid;
  doc["sched_version"] = schedVersion;
  doc["exec_dropped"] = execDropped;
  JsonArray relays = doc["relays"].to<JsonArray>();
  for (int no = 1; no <= profile->relayCount; no++) {
    JsonObject r = relays.add<JsonObject>();
    r["no"] = no;
    r["state"] = relayState[no] ? "on" : "off";
  }
  String out;
  serializeJson(doc, out);
  mqttClient.publish(topic("status").c_str(), (const uint8_t*)out.c_str(), out.length(), true);
  lastStatusMs = millis();
}

// [D26]/[D41] exec-report queue in NVS: max 100, FIFO; overflow drops the OLDEST
// and bumps the persistent exec_dropped counter. Execution never blocks on it.
void queueExecReport(const String& json) {
  JsonDocument doc;
  deserializeJson(doc, prefs.getString("execq", "[]"));
  JsonArray arr = doc.as<JsonArray>();
  while ((int)arr.size() >= MAX_EXEC_QUEUE) {
    arr.remove(0);
    execDropped++;
    prefs.putUInt("execdrop", execDropped);
  }
  JsonDocument item;
  deserializeJson(item, json);
  arr.add(item);
  String out;
  serializeJson(arr, out);
  prefs.putString("execq", out);
}

void flushExecQueue() {
  if (!mqttClient.connected()) return;
  String raw = prefs.getString("execq", "[]");
  if (raw == "[]") return;
  JsonDocument doc;
  deserializeJson(doc, raw);
  JsonArray arr = doc.as<JsonArray>();
  while (arr.size() > 0) {
    String out;
    serializeJson(arr[0], out);
    if (!mqttClient.publish(topic("exec").c_str(), out.c_str())) break;
    arr.remove(0);
  }
  String rest;
  serializeJson(arr, rest);
  prefs.putString("execq", rest);
}

void reportExec(long sid, uint8_t relay, bool on, const tm& lt) {
  // Occurrence = fire-time local minute with the CURRENT UTC offset — this is what
  // makes device and server agree on the [D33] occurrence key across DST edges.
  char occ[32];
  long offMin = lt.tm_gmtoff / 60;
  snprintf(occ, sizeof(occ), "%04d-%02d-%02dT%02d:%02d:00%+03ld:%02ld",
           lt.tm_year + 1900, lt.tm_mon + 1, lt.tm_mday, lt.tm_hour, lt.tm_min,
           offMin / 60, labs(offMin % 60));
  JsonDocument doc;
  doc["sid"] = sid;
  doc["occurrence"] = occ;
  doc["action"] = on ? "on" : "off";
  doc["relay"] = relay;
  String out;
  serializeJson(doc, out);
  if (!mqttClient.connected() || !mqttClient.publish(topic("exec").c_str(), out.c_str())) {
    queueExecReport(out);
  }
}

// ── cmd handling (§6.5): absolute, idempotent, cmd_id dedupe, always ack ──
void handleCmd(JsonObjectConst cmd) {
  long cmdId = cmd["cmd_id"].as<long>();
  int relay = cmd["relay"].as<int>();
  bool on = strcmp(cmd["action"].as<const char*>() | "", "on") == 0;

  bool dup = false;
  for (int i = 0; i < 32; i++) if (lastCmdIds[i] == cmdId) dup = true;
  if (!dup) {
    lastCmdIds[lastCmdIdx] = cmdId;
    lastCmdIdx = (lastCmdIdx + 1) % 32;
  }

  JsonDocument ack;
  ack["cmd_id"] = cmdId;
  if (relay < 1 || relay > profile->relayCount) {
    ack["ok"] = false;
    ack["err"] = "bad_relay";
  } else {
    if (!dup) { // duplicate delivery: same state, single log entry
      driveRelay(relay, on);
      saveRelayStates();
    }
    ack["ok"] = true;
    ack["state"] = relayState[relay] ? "on" : "off";
  }
  String out;
  serializeJson(ack, out);
  mqttClient.publish(topic("ack").c_str(), out.c_str());
  if (!dup) publishStatus();
}

// ── schedule handling (§6.6): verify hash, persist, full replace, ack ──
void handleSchedule(const String& raw) {
  JsonDocument doc;
  if (deserializeJson(doc, raw) != DeserializationError::Ok) return;
  JsonObjectConst p = doc.as<JsonObjectConst>();
  std::string canon = canonicalString(p);
  std::string hash = sha256hex(canon);
  const char* claimed = p["sha256"].as<const char*>();

  JsonDocument ack;
  ack["version"] = p["version"].as<long>();
  ack["sha256"] = hash.c_str();
  if (!claimed || hash != claimed) {
    ack["ok"] = false; // discard; server re-publishes
  } else {
    prefs.putString("sched", raw);
    applySchedulePayload(p);
    applyBootBehavior(); // re-assert expected current state under the new schedule
    ack["ok"] = true;
  }
  String out;
  serializeJson(ack, out);
  mqttClient.publish(topic("schedule_ack").c_str(), out.c_str());
  publishStatus();
}

void onMqttMessage(char* t, byte* payload, unsigned int len) {
  String body;
  body.reserve(len);
  for (unsigned int i = 0; i < len; i++) body += (char)payload[i];
  String tp(t);
  if (tp == topic("cmd")) {
    JsonDocument doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) handleCmd(doc.as<JsonObjectConst>());
  } else if (tp == topic("schedule")) {
    handleSchedule(body);
  }
}

bool mqttConnect() {
  mqttClient.setServer(brokerHost.c_str(), 8883);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(8192);
  String will = "{\"online\":false}";
  if (!mqttClient.connect(deviceUid.c_str(), deviceUid.c_str(), mqttSecret.c_str(),
                          topic("status").c_str(), 1, true, will.c_str())) {
    return false;
  }
  mqttClient.subscribe(topic("cmd").c_str(), 1);
  mqttClient.subscribe(topic("schedule").c_str(), 1); // retained → syncs on reconnect
  publishStatus();
  flushExecQueue();
  return true;
}

// ── execution loop (§6.4): [D33] due-rule via minute-of-week crossing ──
void fireEvent(long sid, uint8_t relay, bool on, const tm& lt) {
  time_t nowUtc = time(nullptr);
  long long key = sid * 2 + (on ? 1 : 0);
  auto it = firedAt.find(key);
  // Dedupe by UTC minute: the fall-back repeated hour is a DIFFERENT utc → fires again.
  if (it != firedAt.end() && nowUtc - it->second < 55) return;
  firedAt[key] = nowUtc;
  if (firedAt.size() > 512) firedAt.clear(); // 48h-scale pruning, coarse
  if (relay >= 1 && relay <= profile->relayCount && relayCfg[relay].present) {
    driveRelay(relay, on);
    saveRelayStates();
    reportExec(sid, relay, on, lt);
    publishStatus();
  }
}

struct DueEvt { int mowFromPrev; long sid; uint8_t relay; bool on; };

void executionTick() {
  if (!timeValid) return; // §5b: no valid clock → refuse schedule execution
  time_t nowUtc = time(nullptr);
  tm lt;
  localtime_r(&nowUtc, &lt);
  int mow = lt.tm_wday * 1440 + lt.tm_hour * 60 + lt.tm_min;
  if (prevMow < 0) { prevMow = mow; return; }
  int delta = ((mow - prevMow) % MIN_PER_WEEK + MIN_PER_WEEK) % MIN_PER_WEEK;
  if (delta == 0) return;
  if (delta > 180) { prevMow = mow; return; } // clock rewound (fall-back) or big jump: no catch-up

  // Collect events in the cyclic window (prevMow, mow]; §5.4 deterministic order:
  // ascending position (intended local time), then sid, ON before OFF.
  std::vector<DueEvt> due;
  auto inWindow = [&](int evMow) {
    int fromPrev = ((evMow - prevMow) % MIN_PER_WEEK + MIN_PER_WEEK) % MIN_PER_WEEK;
    return fromPrev >= 1 && fromPrev <= delta ? fromPrev : -1;
  };
  for (const auto& e : weekly) {
    for (int day = 1; day <= 7; day++) {
      if (e.day != 0 && e.day != day) continue;
      int pos = inWindow((day - 1) * 1440 + e.minutes);
      if (pos > 0) due.push_back({ pos, e.sid, e.relay, e.on });
    }
  }
  for (const auto& o : once) {
    if ((lt.tm_year + 1900 != o.y || lt.tm_mon + 1 != o.mo || lt.tm_mday != o.d)) continue;
    int pos = inWindow(lt.tm_wday * 1440 + o.minutes);
    if (pos > 0) due.push_back({ pos, o.sid, o.relay, o.on });
  }
  std::sort(due.begin(), due.end(), [](const DueEvt& a, const DueEvt& b) {
    if (a.mowFromPrev != b.mowFromPrev) return a.mowFromPrev < b.mowFromPrev;
    if (a.sid != b.sid) return a.sid < b.sid;
    return a.on && !b.on; // ON applied before OFF → tie ends OFF, the safe state
  });
  for (const auto& d : due) fireEvent(d.sid, d.relay, d.on, lt);
  prevMow = mow;
}

// ── provisioning portal (§6.1): QR JSON pasted in; profile mismatch REFUSED [D40] ──
void runPortalIfNeeded(bool force) {
  bool provisioned = prefs.getString("secret", "").length() > 0;
  WiFiManager wm;
  wm.setTitle("Shabat Clock Setup");
  String qrHint = "Paste QR JSON: {\"broker_host\",\"secret\",\"relay_count\"}";
  WiFiManagerParameter pQr("qr", qrHint.c_str(), "", 512);
  String profHint = "Profile id: relay2|relay4|relay8|relay16|relay20";
  WiFiManagerParameter pProfile("profile", profHint.c_str(), prefs.getString("profile", "relay2").c_str(), 16);
  String macNote = "This device MAC (device_uid): " + deviceUid;
  WiFiManagerParameter pInfo(macNote.c_str());
  wm.addParameter(&pInfo);
  wm.addParameter(&pQr);
  wm.addParameter(&pProfile);

  bool saved = false;
  wm.setSaveParamsCallback([&]() { saved = true; });

  if (force || !provisioned) {
    wm.setConfigPortalTimeout(300);
    wm.startConfigPortal(("shabat-" + deviceUid.substring(6)).c_str());
  } else {
    wm.setConnectTimeout(20);
    wm.autoConnect(("shabat-" + deviceUid.substring(6)).c_str());
  }

  if (saved && strlen(pQr.getValue()) > 0) {
    JsonDocument doc;
    if (deserializeJson(doc, pQr.getValue()) == DeserializationError::Ok) {
      const Profile* chosen = nullptr;
      for (int i = 0; i < PROFILE_COUNT; i++) {
        if (strcmp(PROFILES[i].id, pProfile.getValue()) == 0) chosen = &PROFILES[i];
      }
      int expected = doc["relay_count"].as<int>();
      // [D40] a server/portal mismatch is blocked at install time.
      if (chosen && chosen->relayCount == expected) {
        prefs.putString("broker", doc["broker_host"].as<const char*>());
        prefs.putString("secret", doc["secret"].as<const char*>());
        prefs.putString("profile", chosen->id);
      } else {
        Serial.println("PORTAL: profile relay_count mismatch — NOT saved");
      }
    }
  }
}

// ── setup / loop ───────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  pinMode(BOOT_PIN, INPUT_PULLUP);
  prefs.begin("shabat", false);

  uint8_t mac[6];
  WiFi.macAddress(mac);
  char uid[13];
  snprintf(uid, sizeof(uid), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  deviceUid = uid;
  Serial.printf("device_uid: %s\n", uid);

  String profId = prefs.getString("profile", "relay2");
  for (int i = 0; i < PROFILE_COUNT; i++) {
    if (profId == PROFILES[i].id) profile = &PROFILES[i];
  }
  initRelays(); // ALL OFF before anything else runs

  execDropped = prefs.getUInt("execdrop", 0);

  // Held BOOT for ~5s → reconfigure.
  bool force = false;
  if (digitalRead(BOOT_PIN) == LOW) {
    delay(5000);
    force = digitalRead(BOOT_PIN) == LOW;
  }
  runPortalIfNeeded(force);

  // Re-read config (portal may have just written it).
  profId = prefs.getString("profile", "relay2");
  for (int i = 0; i < PROFILE_COUNT; i++) {
    if (profId == PROFILES[i].id) profile = &PROFILES[i];
  }
  brokerHost = prefs.getString("broker", "");
  mqttSecret = prefs.getString("secret", "");

  // NTP with Israel DST (§6.2); time_valid=false until first sync since boot [D25].
  configTzTime(TZ_ISRAEL, "pool.ntp.org", "time.google.com");

  loadScheduleFromNvs();
  tlsClient.setCACert(ISRG_ROOT_X1);

  esp_task_wdt_init(30, true);
  esp_task_wdt_add(nullptr);
}

void loop() {
  esp_task_wdt_reset();

  if (!timeValid) {
    time_t now = time(nullptr);
    if (now > 1700000000) { // sane epoch → NTP synced
      timeValid = true;
      applyBootBehavior(); // power loss during שבת self-heals on restore (§5b)
      publishStatus();
    }
  }

  // WiFi/MQTT reconnect, exponential backoff 1s→5min; local execution continues.
  // Jitter (±50% of the doubled delay) desynchronizes fleet reconnects after a
  // broker outage — without it every device retries at the same instants
  // (thundering herd). Baked in pre-fleet: there is no OTA to fix it later.
  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected() && brokerHost.length()) {
    if (millis() - lastReconnectMs > reconnectDelayMs) {
      lastReconnectMs = millis();
      if (mqttConnect()) {
        reconnectDelayMs = 1000;
      } else {
        unsigned long base = min(reconnectDelayMs * 2, 300000UL);
        reconnectDelayMs = base / 2 + random(base / 2 + 1);
      }
    }
  }
  mqttClient.loop();

  static unsigned long lastExecCheck = 0;
  if (millis() - lastExecCheck >= 1000) {
    lastExecCheck = millis();
    executionTick();
    flushExecQueue();
  }

  if (mqttClient.connected() && millis() - lastStatusMs > 60000) publishStatus(); // heartbeat

  delay(10);
}

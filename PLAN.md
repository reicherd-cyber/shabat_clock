# Shabat Clock — IVR-Controlled ESP32 Switch System

> Build plan for a Shabbat smart-clock system: users call a kosher phone number (Yemot HaMashiach IVR),
> identify by Caller ID, and switch relays on/off immediately or on a weekly schedule.
> Commands flow from the IVR to a Node.js server, over MQTT, to ESP32 devices.

**Stack:** Node.js + Express · MySQL · Mosquitto (MQTT/TLS) · React (RTL) · ESP32 (PlatformIO) · PM2 on DigitalOcean

---

## System Overview

```
Caller ──▶ Yemot HaMashiach (IVR) ──HTTP API──▶ Server (Node.js)
                                                  ├── MySQL (users, devices, schedules, logs)
                                                  ├── Scheduler (cron, every minute)
                                                  ├── MQTT Broker (Mosquitto, TLS :8883)
                                                  └── Admin Web (user panel + super-admin)
                                                          │
                                              MQTT ◀──────┘
                                                ▼
                                          ESP32 (relays: מטבח / סלון ...)
```

**Key design decision (reliability):** schedules are **pushed to the ESP32 and executed locally**
(stored in NVS, clock via NTP). The server scheduler acts as backup/monitor. A Shabbat clock must
keep working even if the internet drops — this is the single most important architectural choice.

**Execution authority (who toggles, when):**
- **The DEVICE is authoritative** for schedule execution. When it executes an event it publishes
  `{"schedule_id":N, "occurrence":"2026-07-03T18:00+03:00", "state":"on"}` on its status topic.
- **The server backup fires only if the device is ONLINE** yet no execution report for that
  `(schedule_id, occurrence)` arrived within a grace window (2 min after due time) — e.g. the
  device missed a schedule sync. If the device is **offline**, the server cannot command it
  either: mark the occurrence `unverified_offline` and rely on local execution (that's what
  it's for); reconcile from the device's status report when it reconnects.
- **All commands are idempotent by design**: actions are absolute (`on`/`off`), never toggle —
  a duplicate delivery sets the same state, it cannot flip a relay wrong.
- **Correlation:** every command carries `cmd_id`; every scheduled execution is keyed by
  `(schedule_id, occurrence)`. Device dedupes on these; server logs one execution per occurrence,
  tagged `executed_by: device|server_backup` — so logs never double-count.

---

## 1. Database Structure (MySQL)

```sql
-- ── Identity ──────────────────────────────────────────────
admins            (id, name, email, password_hash, role ENUM('superadmin','support'),
                   is_active, last_login_at, created_at)

users             (id, full_name, pin_code CHAR(4),          -- PIN for unknown caller-ID
                   status ENUM('active','suspended'), max_devices,
                   language DEFAULT 'he', notes, created_at)

user_phones       (id, user_id FK, phone VARCHAR(15) UNIQUE,  -- caller-ID lookup, indexed
                   label, is_primary)

-- ── Hardware ──────────────────────────────────────────────
devices           (id, user_id FK, device_uid CHAR(12) UNIQUE, -- ESP32 MAC
                   name, mqtt_secret_hash CHAR(60),            -- bcrypt; plaintext shown ONCE at provisioning
                   fw_version, timezone DEFAULT 'Asia/Jerusalem',
                   is_online BOOL, last_seen_at,
                   -- schedule sync tracking (per device, not per schedule row):
                   schedule_version INT DEFAULT 0,             -- bumped on ANY schedule change
                   device_ack_version INT DEFAULT 0,           -- last version the ESP32 ACKed
                   last_pushed_at DATETIME,
                   sync_status ENUM('pending','synced','error') DEFAULT 'pending',
                   sync_error VARCHAR(255),
                   created_at,
                   UNIQUE(id, user_id))                        -- composite-FK target for relays guardrail

relays            (id, device_id FK, user_id FK,              -- user_id denormalized for constraint
                   relay_no TINYINT,                          -- channel 1-20 (GPIO or MCP23017)
                   name VARCHAR(50),                          -- "מטבח", "סלון"
                   ivr_digit TINYINT,                         -- stored as int, rendered "%02d" (7→"07")
                   boot_behavior ENUM('off','last_state','schedule') DEFAULT 'schedule',
                   current_state ENUM('on','off','unknown'), state_updated_at,
                   UNIQUE(device_id, relay_no),               -- one row per physical channel
                   UNIQUE(user_id, ivr_digit),                -- IVR menu spans ALL user's devices
                   -- ownership consistency: relays.user_id MUST equal devices.user_id.
                   -- Enforced at DB level via composite FK:
                   --   devices: add UNIQUE(id, user_id)
                   --   relays:  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
                   -- so reassigning a device to another user forces its relays to move with it.
                   FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id))

-- ── Scheduling (diagram steps 4.1 / 4.2) ─────────────────
-- A schedule is an ON/OFF *pair*, each with its own day — the canonical Shabbat
-- case crosses days (ON Friday 18:00 → OFF Saturday 20:00).
schedules         (id, user_id FK, relay_id FK,
                   on_day_of_week TINYINT,                    -- 1-7 (א׳-ש׳), NULL = daily
                   on_time TIME,
                   off_day_of_week TINYINT,                   -- may differ from on-day
                   off_time TIME,
                   repeat_type ENUM('weekly','once'),
                   on_date DATE NULL, off_date DATE NULL,     -- REQUIRED when repeat_type='once'
                   is_enabled BOOL,
                   created_via ENUM('ivr','web','admin'), created_at, updated_at)
-- 'once' semantics: explicit dates, auto-disabled after execution.
-- v1 scope: the IVR creates WEEKLY schedules only (matches the day-of-week flow);
-- 'once' is created via the web panel (date picker). IVR one-time = v2.
-- NOTE: sync state lives on `devices` (schedule_version / device_ack_version / sync_status),
-- not per schedule row — the device always receives its FULL schedule set as one versioned payload.

-- Sync layer flattens each pair into two independent events for the ESP32:
--   {day:6, time:"18:00", relay:1, action:"on"}, {day:7, time:"20:00", relay:1, action:"off"}
-- Validation: reject pairs where off <= on within the same week cycle;
-- daily (NULL day) requires off_day also NULL.

-- ── Operations / audit ────────────────────────────────────
commands          (id, relay_id FK, action ENUM('on','off'),
                   source ENUM('ivr','web','schedule','admin'),
                   schedule_id FK NULL, call_id FK NULL,
                   status ENUM('pending','sent','acked','failed'),
                   requested_at, acked_at)

-- One row per scheduled occurrence — THE dedupe/authority record.
-- UNIQUE constraint makes double-execution logging impossible at the DB level.
schedule_executions (id, schedule_id FK, occurrence_at DATETIME, action ENUM('on','off'),
                   executed_by ENUM('device','server_backup'),
                   status ENUM('executed','unverified_offline','failed'),
                   command_id FK NULL,                        -- set when server_backup fired
                   reported_at,
                   UNIQUE(schedule_id, occurrence_at, action))

call_logs         (id, yemot_call_id, phone, user_id FK NULL,
                   menu_path VARCHAR(255),                    -- what the caller did
                   outcome ENUM('command','schedule','status','auth_fail','abandoned'),
                   started_at, ended_at)

device_events     (id, device_id FK, event ENUM('online','offline','boot','ack','error'),
                   payload JSON, created_at)

audit_log         (id, admin_id FK, action, entity, entity_id, diff JSON, created_at)

settings          (key PRIMARY, value, description)           -- IVR texts, feature flags
```

---

## 2. Program Structure (Node.js)

```
shabat_clock/
├── src/
│   ├── config/           # env, DB pool, constants
│   ├── db/               # migrations (migrate1.js, migrate2.js, ...)
│   ├── ivr/              # ★ Yemot webhook
│   │   ├── router.js     #   GET /ivr?token=... — single entry point
│   │   ├── session.js    #   per-call state (keyed by ApiCallId)
│   │   ├── menus/        #   main.js, immediate.js, schedule.js, status.js
│   │   └── responses.js  #   builders for read= / id_list_message= / go_to_folder=
│   ├── mqtt/
│   │   ├── client.js     # connect to Mosquitto, publish cmd, handle ack/status/LWT
│   │   └── provisioning.js # per-device credentials
│   ├── scheduler/
│   │   └── tick.js       # cron every minute: due schedules → commands (backup mode)
│   ├── services/         # users, devices, relays, schedules, commands (business logic)
│   ├── api/              # REST for the web panels (+auth middleware, RBAC)
│   ├── web/              # admin frontend (React + Tailwind, RTL)
│   └── app.js
├── firmware/             # ESP32 (PlatformIO)
└── ecosystem.config.js   # PM2
```

### How the Yemot side works

In Yemot's system you create a **שלוחת API** (API extension) and set its `api_link` to
`https://yourdomain.com/ivr?token=SECRET`. Yemot then GETs your URL on every step with
`ApiCallId`, `ApiPhone` (caller ID), `ApiDID`, plus any digits you asked for. Your server
replies with plain-text commands: `read=` (play + capture digits), `id_list_message=`
(play message), `go_to_folder=` / `hangup`.

**Your Node server *is* the IVR logic** — Yemot is just the voice front-end.
(Verify exact command syntax against the Yemot docs during implementation.)

### IVR call flow (maps to the diagram)

```
1. Call arrives → lookup ApiPhone in user_phones
   ├─ found → main menu
   └─ not found → "הקש מספר משתמש ואישור" + PIN → auth

2. Main menu (תפריט ראשי):
   1 = הדלקה מיידית   → relay menu (built from `relays` table) → MQTT cmd → wait ≤5s for ack
   2 = כיבוי מיידי    → same

   ★ Relay menu is DYNAMIC — never hardcoded. The server reads the caller's relays
     from the DB and builds the prompt at call time, e.g.:
       "למטבח הקש 01, לסלון הקש 02, לדוד שמש הקש 03..."
     Names + codes come from relays.name / relays.ivr_digit — add/rename/remove a relay
     in the admin panel (or user panel) and the IVR menu updates instantly, no redeploy.
     TTS reads the Hebrew name straight from the DB.
   3 = תזמון עתידי    → step 4.1: day (1-7) → time HHMM (on)
                       → step 4.2: day (1-7) → time HHMM (off)
                       → read back for confirmation → save + push to device
   4 = מצב נוכחי      → read relay states from retained MQTT status
   * = back, 0 = repeat

3. Feedback (step 10): "הפקודה בוצעה בהצלחה" / "אירעה שגיאה, המכשיר לא מחובר" → hangup
```

The immediate command waits up to ~5 seconds for the device ACK inside the HTTP response
window, so the caller hears **real** success/failure.

⚠️ **Verify Yemot's actual webhook timeout in Phase 1** (test with a deliberately slow response).
If the timeout is tight or inconsistent, switch to a two-step flow instead of blocking:
respond immediately with "הפקודה התקבלה, הקש 1 לבדיקת ביצוע" — the follow-up keypress
triggers a second webhook that checks `commands.status` (acked/failed) and reads the real result.
The two-step flow is the fallback design; the 5s blocking wait is the preferred UX if Yemot allows it.

### MQTT design

| Topic | Direction | Content |
|---|---|---|
| `dev/{uid}/cmd` | server → ESP32 | `{"cmd_id":123,"relay":1,"action":"on"}` |
| `dev/{uid}/ack` | ESP32 → server | `{"cmd_id":123,"ok":true,"state":"on"}` |
| `dev/{uid}/status` | ESP32 → server (retained) | full relay states + fw + rssi |
| `dev/{uid}/schedule` | server → ESP32 (retained) | full schedule JSON **+ `version` + `sha256` hash** |
| `dev/{uid}/schedule_ack` | ESP32 → server | `{"version":N,"hash":"...","ok":true}` — ACKs that EXACT version |
| LWT → `dev/{uid}/status` | broker | `{"online":false}` on disconnect |

**Schedule sync protocol:** any schedule change bumps `devices.schedule_version`, server publishes
the full set (retained) with version+hash → ESP32 validates hash, persists to NVS, ACKs the version →
server sets `device_ack_version = N`, `sync_status = 'synced'`. If no ACK within 60s and device is
online → `sync_status = 'error'` + alert in admin monitoring. Retained delivery means an offline
device syncs automatically on reconnect.

Mosquitto with **per-device username/password**, TLS on 8883, ACL so each device only sees its
own topics.

**Credential lifecycle (be precise):** the plaintext secret necessarily exists briefly at
provisioning — generated in memory, flashed to device NVS, piped to `mosquitto_passwd`, and
shown/downloaded **exactly once** in the admin UI. Rules: it is **never written to any log**
(provisioning endpoint excluded from request/response logging), never stored in the DB
(bcrypt hash only, for verification/audit), and **cannot be retrieved later — lost secret =
rotate**, which is a one-click reprovision in the admin panel.

### ESP32 firmware outline

WiFiManager (first-time setup portal) → NTP sync (with Israel DST) → MQTT TLS connect →
subscribe `cmd` + `schedule` → relays on GPIOs → **schedule stored in NVS and executed
locally by the device clock** → publish retained status on every change + 60s heartbeat.

---

## 3. User Admin Panel (Hebrew, RTL, mobile-first)

**Login:** phone number → OTP (Yemot outbound call/SMS reads the code) — no passwords to forget.

| Page | Contents |
|---|---|
| **דשבורד** | Device cards: online dot, relay toggles (מטבח/סלון) with instant on/off, last-seen |
| **תזמונים** | Weekly grid (days × relays), add/edit on-off pairs, enable/disable toggle, "synced ✓" indicator |
| **היסטוריה** | Recent commands + calls: who, when, from which phone, result |
| **הגדרות** | Manage caller-ID phones, change PIN, **manage relays** — add/rename/reorder/disable relays and their IVR codes (these drive the IVR prompts directly) |

Design: card-based, large touch targets, green/red state colors, Tailwind RTL.
This audience often uses kosher phones — the web panel is secondary to the IVR.

## 4. Super-Admin Panel

| Page | Contents |
|---|---|
| **משתמשים** | CRUD, suspend, phones, PIN reset, **impersonate** (open user panel as them) |
| **מכשירים** | Provision new ESP32 (generates `device_uid` + secret + QR for flashing), assign to user, fw version, online status |
| **ניטור** | Live: online devices count, pending/failed commands, MQTT broker health, failed-auth calls |
| **יומני שיחות** | Full call_logs with menu path — critical for debugging IVR issues |
| **תזמונים** | View/edit any user's schedules, see sync status |
| **הגדרות מערכת** | IVR prompt texts (from `settings` table — editable without redeploy), retry policy |
| **מנהלים** | Admin accounts, roles (superadmin/support), audit log viewer |

---

## 5. Security & Ops

- Yemot webhook: secret token in URL + optional IP allowlist; rate-limit per phone
- **Caller-ID is spoofable** — treat it as identification, not authentication:
  - `users.require_pin BOOL` — per-user flag forcing PIN entry even from a known number
  - PIN always required for destructive/settings actions regardless of flag (future-proofing)
  - PIN lockout after 5 failures (per phone, 15-min window); OTP for web login
- MQTT:
  - **Port 1883 bound to localhost ONLY** (server-internal); devices connect exclusively
    via **8883 TLS**. Firewall (ufw): allow 80/443/8883, deny 1883 external.
  - Per-device creds + ACL (`dev/{uid}/#` only); secret rotatable from admin
  - `mqtt_secret` never stored raw: bcrypt hash in DB, live cred in Mosquitto passwd file
    (written via `mosquitto_passwd` at provisioning), plaintext exists only on the device
- HTTPS via Let's Encrypt; PM2 (`shabat-clock` app) + Mosquitto as systemd service
- Daily MySQL backup (or DO Managed MySQL)

## 5b. Hardware & Failsafe (matters more than the web panel)

- **Boot state:** per-relay configurable `boot_behavior ENUM('off','last_state','schedule')`,
  default `schedule` — on boot the ESP32 computes what state the relay SHOULD be in right now
  from the stored schedule and applies it. Power loss during שבת self-heals on restore.
- **Relay hardware:** opto-isolated active-low relay boards; for high loads (דוד שמש, boiler,
  heaters >10A) the relay drives a **contactor** — never switch high current through a hobby relay.
- **Reconnect:** WiFi + MQTT with exponential backoff (1s → 5min cap), device keeps executing
  the local schedule the whole time; hardware watchdog reset on firmware hang.
- **Clock integrity:** NTP with Israel DST rules; if time was never synced since boot (RTC invalid),
  device refuses schedule execution and reports `error: no_time` — better inert than wrong on שבת.
- **Separation:** ESP32 + relay logic powered by a proper 5V supply, isolated from switched loads.

## 6. Build Phases

| Phase | Deliverable | Est. |
|---|---|---|
| **1** | DB + migrations, Yemot webhook skeleton, caller-ID auth, main menu with dummy responses | week 1 |
| **2** | Mosquitto + ESP32 firmware v1 (immediate on/off + ack + status), IVR immediate commands end-to-end | week 2 |
| **3** | Scheduling: IVR 4.1/4.2 flow, schedule push to device, local execution, server backup cron | week 3 |
| **4** | User web panel (OTP login, dashboard, schedules) | week 4 |
| **5** | Super-admin panel, monitoring, call logs, provisioning flow | week 5 |
| **6** | Hardening: TLS everywhere, lockouts, backups, load test IVR, pilot with 2-3 real devices — must pass the acceptance checklist below | week 6 |

### Phase 6 acceptance checklist (pilot passes only if ALL green)

| # | Test | Expected |
|---|---|---|
| 1 | **Internet outage during scheduled event** — pull WAN 10 min before ON time | Device executes locally on time; server backup does NOT double-fire after reconnect |
| 2 | **Power cycle before event** — cut device power, restore 5 min before ON time | NTP resync, boot_behavior applies correct current state, event fires |
| 3 | **Power loss DURING on-window** — cut power mid-שבת, restore | Device recomputes "should be ON now" from schedule and turns relay back on |
| 4 | **DST transition** — simulate clock change (Israel spring/fall) | Events fire at correct local wall-time, no skip/double |
| 5 | **Duplicate MQTT delivery** — replay a cmd message | State unchanged (idempotent), single log entry (cmd_id dedupe) |
| 6 | **Broker restart** — restart Mosquitto mid-day | Devices reconnect, retained schedule/status intact, no lost commands |
| 7 | **Invalid IVR input** — wrong PIN ×5, garbage digits, hangup mid-flow | Lockout works, no crash, call_log records `abandoned`/`auth_fail` |
| 8 | **Command to offline device** | Caller hears "המכשיר לא מחובר" within 5s; command marked `failed`, not stuck `pending` |
| 9 | **Schedule sync failure** — block schedule_ack | `sync_status='error'` + admin alert within 60s; retained payload syncs on next connect |
| 10 | **Server down entirely** — stop PM2 app for an hour across an event | Device executes schedule locally; admin panel shows the gap honestly after restart |

---

## Decisions (2026-07-02)

1. **Deployment:** same droplet as `ivr-card-collector` (188.166.29.235).
   Two PM2 apps side by side — `ivr-collector` (port 3000) + `shabat-clock` (port 3001),
   nginx routes by domain/path. Mosquitto as separate systemd service (1883/8883).
2. **Relays per ESP32: up to 20.** Firmware designed as configurable 1–20 channels.
   For >8 relays use I2C port expanders (MCP23017 — 16 channels each, chainable) rather
   than raw GPIOs (many ESP32 pins are strapping/input-only).
   **IVR implication:** relay selection is two-digit input (01–20), not a single keypress.
3. **Yemot number:** `043131481` (account exists). Configure a שלוחת API on it pointing
   to `https://<domain>/ivr?token=SECRET`.

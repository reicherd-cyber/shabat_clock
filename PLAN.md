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
                   name, mqtt_secret CHAR(32),                 -- per-device MQTT password
                   fw_version, timezone DEFAULT 'Asia/Jerusalem',
                   is_online BOOL, last_seen_at, created_at)

relays            (id, device_id FK, relay_no TINYINT,        -- channel 1-20 (GPIO or MCP23017)
                   name VARCHAR(50),                          -- "מטבח", "סלון"
                   ivr_digit TINYINT,                         -- 2-digit code (01-20) caller presses
                   current_state ENUM('on','off','unknown'), state_updated_at)

-- ── Scheduling (diagram steps 4.1 / 4.2) ─────────────────
schedules         (id, user_id FK, relay_id FK,
                   day_of_week TINYINT,                       -- 1-7 (א׳-ש׳), NULL = daily
                   on_time TIME, off_time TIME,
                   repeat_type ENUM('weekly','once'),
                   is_enabled BOOL,
                   synced_to_device BOOL,                     -- pushed to ESP32?
                   created_via ENUM('ivr','web','admin'), created_at)

-- ── Operations / audit ────────────────────────────────────
commands          (id, relay_id FK, action ENUM('on','off'),
                   source ENUM('ivr','web','schedule','admin'),
                   schedule_id FK NULL, call_id FK NULL,
                   status ENUM('pending','sent','acked','failed'),
                   requested_at, acked_at)

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

### MQTT design

| Topic | Direction | Content |
|---|---|---|
| `dev/{uid}/cmd` | server → ESP32 | `{"cmd_id":123,"relay":1,"action":"on"}` |
| `dev/{uid}/ack` | ESP32 → server | `{"cmd_id":123,"ok":true,"state":"on"}` |
| `dev/{uid}/status` | ESP32 → server (retained) | full relay states + fw + rssi |
| `dev/{uid}/schedule` | server → ESP32 (retained) | full schedule JSON for local execution |
| LWT → `dev/{uid}/status` | broker | `{"online":false}` on disconnect |

Mosquitto with **per-device username/password** (from `devices.mqtt_secret`), TLS on 8883,
ACL so each device only sees its own topics.

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
- PIN lockout after 5 failures; OTP for web login
- MQTT: TLS + per-device creds + ACL; device secret rotatable from admin
- HTTPS via Let's Encrypt; PM2 (`shabat-clock` app) + Mosquitto as systemd service
- Daily MySQL backup (or DO Managed MySQL)

## 6. Build Phases

| Phase | Deliverable | Est. |
|---|---|---|
| **1** | DB + migrations, Yemot webhook skeleton, caller-ID auth, main menu with dummy responses | week 1 |
| **2** | Mosquitto + ESP32 firmware v1 (immediate on/off + ack + status), IVR immediate commands end-to-end | week 2 |
| **3** | Scheduling: IVR 4.1/4.2 flow, schedule push to device, local execution, server backup cron | week 3 |
| **4** | User web panel (OTP login, dashboard, schedules) | week 4 |
| **5** | Super-admin panel, monitoring, call logs, provisioning flow | week 5 |
| **6** | Hardening: TLS everywhere, lockouts, backups, load test IVR, pilot with 2-3 real devices | week 6 |

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

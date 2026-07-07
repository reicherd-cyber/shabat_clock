# Shabat Clock — Implementation Specification (v1)

Derived from [PLAN.md](PLAN.md). This document is the build contract: exact schemas, API
shapes, protocol payloads, state machines, and acceptance criteria. Where PLAN.md left a
choice open, this spec makes it and marks it **[D#]** — each such decision is overridable
before its module is built, after which changing it is a migration.

**Scope of v1:** everything in PLAN.md phases 1–6. Explicitly OUT of v1: IVR-created
one-time schedules, multi-language IVR, push notifications, OTA firmware updates.

---

## 0. Conventions & Global Decisions

- **[D1] Timezone model:** all schedule times are **device-local wall time** (per
  `devices.timezone`, default `Asia/Jerusalem`). The DB stores `TIME`/`DATE` as entered,
  never UTC-converted. Timestamps (`*_at` columns) are stored UTC (`DATETIME`), rendered
  local in UI. To make the `DEFAULT CURRENT_TIMESTAMP` columns genuinely UTC, every DB
  connection runs with `time_zone = '+00:00'` (set once in the pool's connection config) —
  UTC storage must not depend on the server's OS timezone.
  Occurrence keys are ISO-8601 with offset (`2026-07-03T18:00:00+03:00`).
- **[D2] IDs:** all primary keys `BIGINT UNSIGNED AUTO_INCREMENT`. `cmd_id` on the wire
  **is** `commands.id`. `sid` on the wire is `schedules.id`.
- **[D3] Charset:** MySQL 8, `utf8mb4` / `utf8mb4_unicode_ci`, engine InnoDB, everywhere.
- **[D4] API error envelope:** every non-2xx response is
  `{"error": {"code": "SNAKE_CASE_CODE", "message": "human text"}}`. Validation errors add
  `"fields": {"field_name": "reason"}`.
- **[D5] Days of week:** integer 1–7 = Sunday(א׳)–Saturday(ש׳), matching the IVR keypad.
  `0` on the wire (MQTT schedule payload) means "daily"; in the DB, daily = `NULL`.
- **[D6] Server port:** 3001 behind nginx (same droplet as `ivr-collector` on 3000).
- Language: server code, logs, API in English; all user-facing strings (IVR TTS, web UI)
  in Hebrew, loaded from `settings` where marked editable.

---

## 1. Database — DDL

Migrations live in `src/db/` as sequential `migrateN.js` files; each is idempotent-guarded
by a `schema_migrations (version INT PRIMARY KEY, applied_at)` table. **[D7]**

```sql
CREATE TABLE admins (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash CHAR(60) NOT NULL,                -- bcrypt cost 12
  role          ENUM('superadmin','support') NOT NULL DEFAULT 'support',
  is_active     BOOL NOT NULL DEFAULT TRUE,
  last_login_at DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name    VARCHAR(100) NOT NULL,
  ivr_code     CHAR(6) NOT NULL UNIQUE,           -- random 6-digit, non-sequential; IVR login from unknown caller ID [D32]
  pin_hash     CHAR(60) NOT NULL,                 -- bcrypt of 4-digit PIN
  require_pin  BOOL NOT NULL DEFAULT FALSE,
  status       ENUM('active','suspended') NOT NULL DEFAULT 'active',
  max_devices  TINYINT UNSIGNED NOT NULL DEFAULT 3,
  language     CHAR(2) NOT NULL DEFAULT 'he',
  notes        TEXT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_phones (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  phone      VARCHAR(15) NOT NULL UNIQUE,         -- normalized 0XXXXXXXXX [D8]
  label      VARCHAR(50) NULL,
  is_primary BOOL NOT NULL DEFAULT FALSE,
  verified_at DATETIME NULL,                      -- NULL = control of the number not yet proven [D34]
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_phone (phone)
);
-- [D8] Phone normalization: strip non-digits; +972XX / 972XX → 0XX. Applied at every
-- write AND at caller-ID lookup, so both sides always compare the same form.

CREATE TABLE devices (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id            BIGINT UNSIGNED NOT NULL,
  device_uid         CHAR(12) NULL UNIQUE,        -- ESP32 MAC, lowercase hex, no colons; NULL until first flash [D31]
  name               VARCHAR(100) NOT NULL,
  mqtt_secret_hash   CHAR(60) NOT NULL,           -- bcrypt, for API-side verification
  mqtt_passwd_hash   VARCHAR(200) NOT NULL,       -- mosquitto_passwd-format hash; lets the broker passwd entry be (re)written from DB once device_uid is known
  fw_version         VARCHAR(20) NULL,
  timezone           VARCHAR(40) NOT NULL DEFAULT 'Asia/Jerusalem',
  relay_count        TINYINT UNSIGNED NOT NULL,   -- declared hardware profile size, 1..20; relay_no must not exceed it [D40]
  is_online          BOOL NOT NULL DEFAULT FALSE,
  last_seen_at       DATETIME NULL,
  schedule_version   INT UNSIGNED NOT NULL DEFAULT 0,
  device_ack_version INT UNSIGNED NOT NULL DEFAULT 0,
  last_pushed_at     DATETIME NULL,
  sync_status        ENUM('pending','synced','error') NOT NULL DEFAULT 'pending',
  sync_error         VARCHAR(255) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE KEY uq_device_owner (id, user_id),       -- composite-FK target
  CHECK (relay_count BETWEEN 1 AND 20)
);

CREATE TABLE relays (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id        BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,      -- denormalized for ownership FK
  relay_no         TINYINT UNSIGNED NOT NULL,     -- 1..20
  name             VARCHAR(50) NOT NULL,
  ivr_digit        TINYINT UNSIGNED NULL,         -- 1..20, rendered "%02d"; NOT NULL for live rows (service-layer rule), NULLed on soft delete to free the digit [D38]
  is_enabled       BOOL NOT NULL DEFAULT TRUE,    -- disabled: hidden from IVR menu + UI toggle
  sort_order       SMALLINT NOT NULL DEFAULT 0,
  boot_behavior    ENUM('off','last_state','schedule') NOT NULL DEFAULT 'schedule',
  current_state    ENUM('on','off','unknown') NOT NULL DEFAULT 'unknown',
  state_updated_at DATETIME NULL,
  deleted_at       DATETIME NULL,                 -- soft delete [D38]; history FKs stay valid
  UNIQUE KEY uq_channel (device_id, relay_no),
  UNIQUE KEY uq_ivr (user_id, ivr_digit),
  UNIQUE KEY uq_relay_owner (id, user_id),
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id) ON UPDATE CASCADE,
  CHECK (relay_no BETWEEN 1 AND 20),
  CHECK (ivr_digit BETWEEN 1 AND 20)
);

CREATE TABLE schedules (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT UNSIGNED NOT NULL,
  relay_id        BIGINT UNSIGNED NOT NULL,
  on_day_of_week  TINYINT UNSIGNED NULL,          -- 1-7, NULL = daily
  on_time         TIME NOT NULL,
  off_day_of_week TINYINT UNSIGNED NULL,
  off_time        TIME NOT NULL,
  repeat_type     ENUM('weekly','once') NOT NULL DEFAULT 'weekly',
  on_date         DATE NULL,                      -- required iff repeat_type='once'
  off_date        DATE NULL,
  is_enabled      BOOL NOT NULL DEFAULT TRUE,
  deleted_at      DATETIME NULL,                  -- soft delete [D37]; commands/schedule_executions FKs stay valid
  created_via     ENUM('ivr','web','admin') NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (relay_id, user_id) REFERENCES relays(id, user_id) ON UPDATE CASCADE
);

CREATE TABLE call_logs (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  yemot_call_id VARCHAR(64) NOT NULL,
  phone         VARCHAR(15) NOT NULL,
  user_id       BIGINT UNSIGNED NULL,
  menu_path     VARCHAR(255) NOT NULL DEFAULT '', -- e.g. "main>immediate_on>relay:2>ok"
  outcome       ENUM('command','schedule','status','auth_fail','abandoned') NULL,
  started_at    DATETIME NOT NULL,
  ended_at      DATETIME NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),    -- safe: user rows are never deleted [D39]
  INDEX idx_call (yemot_call_id)
);

CREATE TABLE commands (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  relay_id     BIGINT UNSIGNED NOT NULL,
  action       ENUM('on','off') NOT NULL,
  source       ENUM('ivr','web','schedule','admin') NOT NULL,
  schedule_id  BIGINT UNSIGNED NULL,              -- for source='schedule': always copied from the execution row, never set independently (invariant §5.4)
  schedule_execution_id BIGINT UNSIGNED NULL,     -- exact occurrence attempt this command serves (backup scheduler); FK added below — circular with schedule_executions.command_id
  call_id      BIGINT UNSIGNED NULL,
  status       ENUM('pending','sent','acked','failed') NOT NULL DEFAULT 'pending',
  fail_reason  VARCHAR(100) NULL,                 -- 'offline','timeout','nack','publish_error'
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acked_at     DATETIME NULL,
  FOREIGN KEY (relay_id) REFERENCES relays(id),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id),
  FOREIGN KEY (call_id) REFERENCES call_logs(id),
  INDEX idx_status (status, requested_at),
  INDEX idx_sched_exec (schedule_execution_id)    -- attempt-trail lookups (§5.4); reused by the fk_cmd_exec FK added below
);

CREATE TABLE schedule_executions (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  schedule_id      BIGINT UNSIGNED NOT NULL,
  occurrence_utc   DATETIME NOT NULL,             -- UTC instant of the due event; DST-unambiguous [D33]
  occurrence_local CHAR(25) NOT NULL,             -- ISO-8601 with offset per [D1], display/debug only
  action        ENUM('on','off') NOT NULL,
  executed_by   ENUM('device','server_backup') NULL,
  status        ENUM('pending','executed','unverified_offline','failed') NOT NULL,
  command_id    BIGINT UNSIGNED NULL,             -- LATEST backup-command attempt, retained even if a device claim wins the row; full trail = commands WHERE schedule_execution_id=id [§5.4]
  reported_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_occurrence (schedule_id, occurrence_utc, action),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id),
  FOREIGN KEY (command_id) REFERENCES commands(id)
);

-- Second half of the circular commands ↔ schedule_executions pair; must come after both
-- tables exist. Insert order is never a problem: the execution row is created first
-- (status='pending'), then the command pointing at it, then command_id is set.
-- Both sides of the cycle (schedule_executions.command_id, commands.schedule_execution_id)
-- are nullable BY DESIGN — that is what makes the cycle insertable and lets migrations /
-- test fixtures load either table first. Never migrate either to NOT NULL.
ALTER TABLE commands
  ADD CONSTRAINT fk_cmd_exec FOREIGN KEY (schedule_execution_id) REFERENCES schedule_executions(id);

CREATE TABLE device_events (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  device_id  BIGINT UNSIGNED NOT NULL,
  event      ENUM('online','offline','boot','ack','error') NOT NULL,
  payload    JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES devices(id),
  INDEX idx_dev_time (device_id, created_at)
);

CREATE TABLE audit_log (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id   BIGINT UNSIGNED NOT NULL,
  action     VARCHAR(50) NOT NULL,                -- 'create','update','delete','impersonate','provision','rotate_secret','pin_reset'
  entity     VARCHAR(50) NOT NULL,
  entity_id  BIGINT UNSIGNED NULL,
  diff       JSON NULL,                           -- {before:{...}, after:{...}}, secrets redacted
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admins(id)
);

CREATE TABLE settings (
  setting_key   VARCHAR(100) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  description   VARCHAR(255) NULL
);

-- [D9] Web-login OTPs (PLAN §3 login). Hashed like a password; short-lived.
CREATE TABLE otp_codes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone      VARCHAR(15) NOT NULL,
  purpose    ENUM('login','phone_add') NOT NULL,  -- each verify endpoint accepts only its own purpose
  user_phone_id BIGINT UNSIGNED NULL,             -- for phone_add: the pending user_phones row this code confirms — binds code to row, not just to a phone string
  code_hash  CHAR(60) NOT NULL,                   -- bcrypt of 6-digit code
  expires_at DATETIME NOT NULL,                   -- now + 5 min
  attempts   TINYINT NOT NULL DEFAULT 0,          -- max 3 verify attempts
  used_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_phone_id) REFERENCES user_phones(id) ON DELETE CASCADE,
  INDEX idx_lookup (phone, purpose, expires_at)   -- verify queries filter by phone+purpose+liveness
);

-- [D10] PIN/auth failure tracking for lockout (per phone, 15-min window, 5 failures).
-- DB-backed (not in-memory) so lockout survives a server restart.
-- 'web_otp' deliberately pools BOTH OTP purposes (login + phone_add): they are the same
-- guessing surface against the same phone, and separate buckets would double an
-- attacker's attempt budget. Consequence (accepted): failed phone-add verifications can
-- lock OTP login for that phone for 15 min, and vice versa.
CREATE TABLE auth_failures (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone      VARCHAR(15) NOT NULL,
  kind       ENUM('ivr_pin','web_otp') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lockout (phone, kind, created_at)
);
```

### 1.1 Schedule validation rules (service layer — single source of truth)

Implemented once in `services/schedules.js#validate(schedule)`, used by IVR, web API, and
admin API alike:

1. `on_time`, `off_time` required, minute granularity (seconds forced to `:00`).
2. **weekly:** `on_date`/`off_date` must be NULL.
   - Days either both set (1–7) or both NULL (daily pair).
   - Cyclic duration `= ((off_day*1440 + off_min) − (on_day*1440 + on_min)) mod 10080`
     must be `> 0`. Wrap-around legal; identical day+time rejected (`ZERO_LENGTH_PAIR`).
   - Daily pair: duration `= (off_min − on_min) mod 1440`, `> 0`; off before on means
     next-day off.
3. **once:** `on_date` and `off_date` required, day-of-week columns forced NULL (derived
   from the date at sync time). `off_date+off_time > on_date+on_time`
   (`OFF_BEFORE_ON`), and `on_date+on_time` must be in the future (`ALREADY_PAST` —
   which by transitivity covers the OFF too). A once-schedule can therefore never be
   created mid-window: "on from now until X" is expressed by submitting `on_time` as
   the next whole minute (UI convenience), not by a past ON — this keeps device
   behavior on sync/boot unambiguous (no inferring state from an ON that predates the
   schedule's existence).
4. Relay must belong to the acting user, be `is_enabled`, and not be soft-deleted
   (`RELAY_NOT_FOUND` — same error whether missing, deleted, or foreign; don't leak
   existence).
5. **[D11] Overlap between schedules on the same relay is ALLOWED** (last event wins on
   the device — events are absolute on/off, so overlaps are well-defined). The web UI
   shows a warning badge but does not block.

Any successful create/update/delete/enable/disable of a schedule, and any relay
delete/disable or `boot_behavior` change (the relay config rides in the same payload,
[D35]), atomically increments `devices.schedule_version` for the affected device(s),
sets `sync_status='pending'`, and triggers a schedule push (§5.3).

---

## 2. Server Layout & Environment

Directory layout as PLAN §2. Single Express app, `src/app.js`, run under PM2 as
`shabat-clock`.

**[D12] Environment variables** (`.env`, never committed):

| Var | Meaning |
|---|---|
| `PORT` | 3001 |
| `DATABASE_URL` | `mysql://user:pass@localhost:3306/shabat_clock` |
| `IVR_TOKEN` | shared secret in Yemot's `api_link` URL |
| `MQTT_URL` | `mqtts://localhost:8883` (server may use localhost:1883 internally — **[D13]** server connects via localhost 1883 with its own superuser cred; TLS is for devices) |
| `MQTT_SERVER_USER` / `MQTT_SERVER_PASS` | broker superuser (full `dev/#` ACL) |
| `JWT_SECRET` | HS256 signing key |
| `OTP_YEMOT_*` | Yemot outbound API creds for OTP calls |
| `NODE_ENV` | production / development |

**[D14] Auth tokens:** JWT HS256. User panel token: `{sub:user_id, role:'user'}`, TTL 30
days (kosher-phone audience logs in rarely; OTP is the gate). Admin token:
`{sub:admin_id, role:'superadmin'|'support'}`, TTL 12h. Impersonation token:
`{sub:user_id, role:'user', imp:admin_id}`, TTL 1h; every write made under `imp` is
audit-logged against the admin.

---

## 3. REST API

Base path `/api/v1`. All bodies JSON. Auth via `Authorization: Bearer <jwt>`.
Errors per [D4]. Common codes: 400 `VALIDATION`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`,
404 `NOT_FOUND`, 409 `CONFLICT`, 429 `RATE_LIMITED`.

### 3.1 Auth

| Method & path | Body → Response | Notes |
|---|---|---|
| `POST /auth/otp/request` | `{phone}` → `{ok:true}` | Always 200 even for unknown phone (no user enumeration). Rate limit: 3/phone/15min, 10/IP/hour. Sends 6-digit code via Yemot outbound call. |
| `POST /auth/otp/verify` | `{phone, code}` → `{token, user:{id, full_name}}` | 401 `BAD_CODE` on mismatch. Accepts `purpose='login'` codes only — a phone-add code never grants a session, and vice versa. **Failed-verify writes (both purposes, one transaction):** increment that code's `otp_codes.attempts` (code permanently dead at 3) AND insert an `auth_failures('web_otp')` row (phone locked at 5 failures / 15 min, pooled across both purposes [D10]). Lockout is checked before the code. |
| `POST /admin/auth/login` | `{email, password}` → `{token, admin:{id, name, role}}` | bcrypt compare; update `last_login_at`. `is_active=FALSE` fails with the same generic 401 `UNAUTHENTICATED` as an unknown email or wrong password — no distinction leaked. |

### 3.2 User panel (role `user`; every query implicitly scoped `WHERE user_id = :sub`)

| Method & path | Purpose |
|---|---|
| `GET /me` | Profile + phones list. |
| `POST /me/pin` | `{old_pin, new_pin}` — change 4-digit PIN. |
| `GET /me/phones` / `POST /me/phones` / `POST /me/phones/:id/verify` / `DELETE /me/phones/:id` | Manage caller-ID phones. **[D34]** Because caller ID grants IVR access (for `!require_pin` users), adding a phone must prove control of it: `POST` inserts the row with `verified_at=NULL` and places an OTP call **to the new number**; `verify {code}` sets `verified_at` (identical failure writes as login verify — §3.1: code `attempts`++ plus a pooled `auth_failures('web_otp')` row, in one transaction; the code is `purpose='phone_add'` with `user_phone_id` set to the pending row, and verify matches on **that row id** — owned by `:sub` — not merely the phone string, so the binding survives any future relaxation of phone uniqueness; purposes never cross). Unverified phones are ignored by IVR caller-ID lookup and cannot be `is_primary`; a successful web OTP *login* via an unverified phone also verifies it (identical proof). Admin-created phones (via `/admin/users`) are verified immediately — audit-logged. Cannot delete the last verified phone (409 `LAST_PHONE`). |
| `GET /devices` | Devices with nested relays (live rows only — soft-deleted relays [D38] never appear in user-facing listings): `[{id, name, is_online, last_seen_at, sync_status, relays:[{id, relay_no, name, ivr_digit, is_enabled, current_state, sort_order}]}]` — the dashboard payload. |
| `POST /relays/:id/command` | `{action:'on'\|'off'}` → `{command_id, status}`. Same relay gate as §1.1 rule 4: must belong to the user, be live (`deleted_at IS NULL`), and `is_enabled` — else 404 `RELAY_NOT_FOUND`. Publishes MQTT cmd; **waits up to 5s** for ack (same blocking pattern as IVR); returns final `status: 'acked'\|'failed'` so the toggle shows truth. |
| `PATCH /relays/:id` | `{name?, ivr_digit?, is_enabled?, sort_order?, boot_behavior?}`. `ivr_digit` conflict → 409 `IVR_DIGIT_TAKEN`. Disabling a relay with enabled schedules → 409 `HAS_SCHEDULES` unless `?force=true` (then schedules are disabled too). |
| `GET /schedules` | All the user's schedules with relay names + device sync status. |
| `POST /schedules` | Create (weekly or once), rules §1.1, `created_via:'web'`. |
| `PATCH /schedules/:id` | Update / enable / disable. |
| `DELETE /schedules/:id` | **[D37] Soft delete** — sets `deleted_at`; the row is retained because `commands.schedule_id` and `schedule_executions.schedule_id` reference it (physical DELETE would fail once history exists). Soft-deleted schedules disappear from every listing, validation, and sync payload; version bump + push as usual. |
| `GET /history?limit=50&cursor=<opaque>` | Merged recent activity: commands (with source, relay name, status) + call_logs (menu_path, outcome), newest first. The two sources have independent id spaces, so the cursor is an opaque base64 of `{ts, type, id}` taken from the last returned item; `ts` is `commands.requested_at` / `call_logs.started_at` (fixed per type — never the ack/end time, which mutates after insert); `type` is the literal string `'call'` (call_logs) or `'cmd'` (commands); total order is `(ts DESC, type ASC, id DESC)` — so at equal `ts`, `'call' < 'cmd'` by byte order. Fully pinned, so every implementation produces identical pages and cursors. Response includes `next_cursor` (null at end). |

### 3.3 Admin panel (role `superadmin` unless noted; `support` = read-only everywhere **[D15]**)

| Method & path | Purpose |
|---|---|
| `GET/POST/PATCH /admin/users`, `/admin/users/:id` | Create/read/update, suspend (`status`), `max_devices`, notes. `ivr_code` is auto-generated at create (random, retry on UNIQUE collision), read-only, shown in the admin panel and in `GET /me`. **[D39] No `DELETE`:** user rows are never physically deleted — devices, relays, schedules, call logs, and audit history all hang off them. The terminal lifecycle state is `status='suspended'` (blocks IVR, web login, and OTP). Devices can be reassigned away first [D31]; full data erasure, if ever legally required, is an explicit offline procedure out of scope for v1. |
| `POST /admin/users/:id/pin-reset` | `{new_pin}` — audit-logged. |
| `POST /admin/users/:id/impersonate` | → `{token}` (impersonation JWT per [D14]). |
| `GET /admin/devices` | All devices + owner + sync + online. |
| `POST /admin/devices/provision` | `{user_id, name, relay_count, device_uid?}` → `{device, mqtt_secret, qr_png_base64}`. `relay_count` is embedded in the QR payload (`{device_uid?, broker_host, secret, relay_count}`), and the AP portal accepts only a hardware profile whose relay count matches it — a server/portal mismatch is blocked at install time, not merely detected later via status [D36][D40]. Secret generated (32 chars base62), hashed to DB twice — bcrypt (`mqtt_secret_hash`) and mosquitto_passwd format (`mqtt_passwd_hash`) — **returned exactly once**; endpoint excluded from request/response logging. **[D31]** `device_uid` may be omitted: stored `NULL` (column is nullable-UNIQUE, so any number of unflashed devices coexist). The Mosquitto passwd entry (username = `device_uid`) is written from `mqtt_passwd_hash` only once the UID is known — at provision time if given, else when set later via `PATCH`. **Omitted-UID install flow:** the QR simply lacks `device_uid`; at install the AP portal displays the ESP32's MAC (which *is* the `device_uid`) on its status page, the installer reports it, and the admin enters it via `PATCH /admin/devices/:id` — that write creates the broker passwd entry. In the gap the broker rejects the device's connects (auth failure); firmware needs no special mode — its normal reconnect backoff (§6.7) rides it out. Note the honest caveat: "local operation" during the gap means executing whatever schedule is already persisted in NVS — on a first install nothing is yet, so the device just idles with relays per the GPIO-init OFF default until broker auth succeeds and the retained schedule arrives. Until then `sync_status` stays `pending`. |
| `POST /admin/devices/:id/rotate-secret` | `{relay_count?}` — new secret, same once-only rules; device must be re-flashed. The response includes a fresh QR embedding the current (optionally updated) `relay_count`, making rotate the only path to change hardware profile on a flashed device [D40]. Same guard as `PATCH`: a `relay_count` below an existing live relay's `relay_no` → 409 `CONFLICT` (delete or renumber those relays first). |
| `PATCH /admin/devices/:id` | Rename, timezone, `relay_count` — editable **only while `device_uid IS NULL`** [D40] (the QR/portal handshake hasn't happened yet; afterwards the value is pinned to physical hardware — 409 `DEVICE_FLASHED`; a genuine hardware change goes through `rotate-secret` with a new QR). Shrinking below an existing live relay's `relay_no` → 409 `CONFLICT`. Set `device_uid` (allowed only while `NULL` [D31] — changing a set UID requires rotate-secret, since the broker username changes). Reassign `user_id` in a single transaction: pre-check the target user against `uq_ivr` (conflicting `ivr_digit` → 409 `IVR_DIGIT_TAKEN`; admin renumbers first) and `max_devices` (409 `MAX_DEVICES`), then `UPDATE devices SET user_id` — `relays.user_id` and `schedules.user_id` follow automatically via the composite FKs' `ON UPDATE CASCADE`. |
| `POST /admin/devices/:id/relays` / `PATCH` / `DELETE` | Manage relay rows. Channel mapping — creation, deletion, `relay_no` — is admin/install-time only; everything else (`name`, `ivr_digit`, `is_enabled`, `sort_order`, `boot_behavior`) users can also edit themselves via `PATCH /relays/:id` (§3.2). `relay_no` must be ≤ the device's `relay_count` (400 `VALIDATION`) [D40]. **[D38]** `DELETE` is soft: sets `deleted_at`, `is_enabled=FALSE`, `ivr_digit=NULL` (freeing the digit — the column is nullable for exactly this), and soft-deletes the relay's schedules [D37]; `commands` history keeps its FK. `POST` for a `(device_id, relay_no)` with a soft-deleted row **revives** that row (clears `deleted_at`, resets fields) instead of inserting, so `uq_channel` never conflicts; a live row at that channel → 409 `CONFLICT`. **Digit invariant (service layer):** a live row must always carry a non-NULL `ivr_digit` — `POST` (create and revive alike) requires it in the body (400 `VALIDATION` if missing; the digit freed at delete is *not* auto-restored), `PATCH` may never set it NULL on a live row, and every assignment re-checks 409 `IVR_DIGIT_TAKEN`. Only the soft-delete path writes NULL. |
| `GET /admin/monitoring` | `{devices_online, devices_total, commands_pending, commands_failed_24h, sync_errors:[...], auth_failures_24h, broker_ok}`. |
| `GET /admin/call-logs?phone=&user_id=&from=&to=` | Full call logs with menu_path. |
| `GET /admin/schedules?user_id=` / full CRUD | Any user's schedules, `created_via:'admin'`. Delete uses the same soft-delete path as the user endpoint [D37] — a physical `DELETE` is never issued against `schedules`, by any actor. |
| `GET/PUT /admin/settings` | The `settings` table (IVR texts etc.) — superadmin only. |
| `GET/POST/PATCH /admin/admins` | Admin accounts — superadmin only. |
| `GET /admin/audit-log` | Filterable audit trail. |

---

## 4. IVR Webhook

Single endpoint: `GET /ivr` (Yemot calls GET with query params). Reject any request where
`token !== IVR_TOKEN` with 403 (and log IP). Optional IP allowlist via nginx.

**Session:** in-memory `Map` keyed by `ApiCallId` — `{user_id, state, data, updated_at}`,
TTL 10 minutes, swept each minute. **[D16]** In-memory is acceptable because a Yemot call
lives entirely on one server process; a restart mid-call loses only that call (caller
redials). `call_logs.menu_path` is appended on every step regardless.

**Response format:** plain text per Yemot API-extension protocol — `read=...` (play +
collect digits), `id_list_message=...` (play), `go_to_folder=hangup`. Exact syntax to be
verified against Yemot docs in Phase 1 (PLAN §2 warning) — `ivr/responses.js` is the only
module allowed to emit protocol strings, so a syntax correction touches one file.

All prompt texts come from `settings` keys prefixed `ivr.` (e.g. `ivr.main_menu`,
`ivr.cmd_ok`, `ivr.cmd_offline`, `ivr.pin_prompt`, `ivr.locked_out`) with hardcoded
Hebrew defaults seeded by migration. **[D17]**

### 4.1 State machine

States (stored in session): `AUTH_PIN → MAIN → RELAY_SELECT(ctx) → SCHED_ON_DAY →
SCHED_ON_TIME → SCHED_OFF_DAY → SCHED_OFF_TIME → SCHED_CONFIRM → done/hangup`.

1. **Call arrives** (no session): normalize `ApiPhone` [D8], look up `user_phones`
   (**verified rows only** [D34] — an unverified phone is treated as not found).
   - Found & user `active` & `!require_pin` → create session, state `MAIN`.
   - Found & `require_pin` → state `AUTH_PIN` (PIN only).
   - Not found → prompt "הקש מספר משתמש" (= `users.ivr_code`, the random 6-digit code
     [D32] — never `users.id`, so accounts can't be enumerated by counting up) → then
     PIN → verify both together (one generic failure message, no hint which part was
     wrong) → `MAIN` or fail; failures count toward the same `ivr_pin` lockout.
   - Locked out (≥5 `ivr_pin` failures in 15 min for this phone [D10]) → play
     `ivr.locked_out`, log `auth_fail`, hangup.
   - User `suspended` → treat as not found (no info leak).
2. **MAIN:** `1` immediate ON, `2` immediate OFF, `3` schedule, `4` status,
   `0` repeat menu, `*` = back (from MAIN: repeat). Invalid input ×3 → polite hangup,
   outcome `abandoned`.
3. **RELAY_SELECT:** dynamic prompt built from the caller's enabled relays ordered by
   `sort_order`: "למטבח הקש 01, לסלון הקש 02…". Input is **two digits** (01–20).
   - Exactly one enabled relay and context is immediate → **[D18] skip the menu**,
     act on it directly (announce the relay name in the confirmation).
   - Zero enabled relays → play "אין מכשירים מוגדרים", hangup.
4. **Immediate command:** insert `commands` row (`source:'ivr'`, `call_id`), publish MQTT
   cmd, block up to **5s** for ack (§5.2).
   - `acked` → play `ivr.cmd_ok` → back to MAIN (not hangup — allow another action) **[D19]**.
   - device offline (known immediately from `is_online`) or timeout → mark command
     `failed` (+`fail_reason`), play `ivr.cmd_offline`, back to MAIN.
   - *Fallback (only if Phase-1 testing shows Yemot can't hold 5s):* two-step flow per
     PLAN §2 — respond "הפקודה התקבלה, הקש 1 לבדיקה", second webhook reads `commands.status`.
5. **Schedule flow (weekly only):** relay → on-day (1 digit, 1–7) → on-time (4 digits
   HHMM, validate 0000–2359) → off-day → off-time → validate per §1.1 → read back full
   sentence ("להדלקת מטבח ביום שישי בשעה 18:00 וכיבוי ביום שבת בשעה 20:00 — הקש 1 לאישור,
   2 לביטול") → on confirm: insert schedule (`created_via:'ivr'`), bump version, push,
   play `ivr.sched_saved` → MAIN.
6. **Status:** for each enabled relay read `current_state` from DB (kept fresh by retained
   status ingestion): "מטבח דולק, סלון כבוי, דוד — מצב לא ידוע" → MAIN.
7. **Hangup/timeout without outcome** → `call_logs.outcome='abandoned'`, `ended_at=now`.

---

## 5. MQTT Contract

Broker: Mosquitto. Listeners: 1883 bound to 127.0.0.1 (server only), 8883 TLS
(Let's Encrypt cert) for devices. Per-device username = `device_uid`, password = the
provisioned secret; ACL restricts each device to `dev/{uid}/#`. Server account has full
`dev/#`.

**[D20] QoS & flags:**

| Topic | Dir | QoS | Retained | Payload |
|---|---|---|---|---|
| `dev/{uid}/cmd` | S→D | 1 | no | `{"cmd_id":123,"relay":1,"action":"on"}` |
| `dev/{uid}/ack` | D→S | 1 | no | `{"cmd_id":123,"ok":true,"state":"on"}` — `ok:false` + `"err":"bad_relay"\|"no_time"` on refusal |
| `dev/{uid}/status` | D→S | 1 | **yes** | see 5.1 |
| `dev/{uid}/exec` | D→S | 1 | no | `{"sid":45,"occurrence":"2026-07-03T18:00:00+03:00","action":"on","relay":1}` |
| `dev/{uid}/schedule` | S→D | 1 | **yes** | see 5.3 |
| `dev/{uid}/schedule_ack` | D→S | 1 | no | `{"version":12,"sha256":"...","ok":true}` |
| LWT on `dev/{uid}/status` | broker | 1 | yes | `{"online":false}` |

### 5.1 Status payload (published on connect, on every state change, and each 60s heartbeat)

```json
{"online":true, "fw":"1.0.3", "rssi":-61, "ip":"10.0.0.14",
 "time_valid":true, "sched_version":12, "exec_dropped":0,
 "relays":[{"no":1,"state":"on"},{"no":2,"state":"off"}]}
```

Server ingestion: update `devices.is_online/last_seen_at/fw_version`,
`relays.current_state/state_updated_at`; insert `device_events` on online/offline edge
transitions only (not every heartbeat). A reported relay list that disagrees with
`devices.relay_count`, or an `exec_dropped` counter that increased since the last status
[D41], inserts a `device_events` `'error'` row and surfaces in `GET /admin/monitoring`
[D40]. If `sched_version < devices.schedule_version` →
re-push schedule (device missed it). Reconciliation on reconnect: open
`unverified_offline` occurrences within the last 24h whose expected end-state matches the
reported relay state are marked `executed` by `device` (**[D21]** best-effort reconcile,
window 24h).

### 5.2 Immediate command lifecycle

```
insert commands(status='pending')
  → device offline? → status='failed', fail_reason='offline'  (no publish)
  → publish cmd (QoS1) → status='sent'
  → ack {ok:true} within 5s → status='acked', acked_at, update relays.current_state
  → ack {ok:false}          → status='failed', fail_reason='nack:'+err
  → no ack in 5s            → status='failed', fail_reason='timeout'
```
A late ack after timeout updates relay state but leaves the command `failed` (the caller
was already told it failed — honesty over tidiness). **[D22]**

### 5.3 Schedule sync

Payload (retained, replaces previous):

```json
{"version":12, "tz":"Asia/Jerusalem",
 "relays":[ {"no":1,"boot":"schedule"}, {"no":2,"boot":"off"} ],
 "events":[ {"sid":45,"relay":1,"day":6,"time":"18:00","action":"on"},
            {"sid":45,"relay":1,"day":7,"time":"20:00","action":"off"} ],
 "once":  [ {"sid":52,"relay":2,"date":"2026-09-22","time":"18:00","action":"on"},
            {"sid":52,"relay":2,"date":"2026-09-23","time":"20:00","action":"off"} ],
 "sha256":"<hex>"}
```

- Each enabled schedule flattens to two entries (ON + OFF). Weekly → `events`
  (`day` 1–7, or `0` = daily [D5]); once → `once` with explicit dates. Disabled or
  soft-deleted schedules and disabled/soft-deleted relays contribute no events.
- **[D35]** `relays` carries per-relay device config — currently just
  `boot` = `boot_behavior` — one entry per live (non-deleted) relay row of the device
  (enabled or not; a disabled relay still boots), ordered by `no` ascending. Piggybacking on this payload
  means `boot_behavior` edits reach the device through the same retained + versioned +
  hashed + acked channel; no separate config topic exists. The payload **replaces** the
  device's entire relay config — never merges into it: any relay number of the hardware
  profile absent from `relays` has its NVS config cleared and is forced OFF at apply
  time and on every subsequent boot. A soft-deleted relay therefore goes dark on the
  very next sync instead of lingering with stale `boot_behavior`/last-state.
- **[D23] Hash:** `sha256` = SHA-256 over a byte-exact canonical string that both sides
  **construct by concatenation** (server: string-build then hash, never
  `JSON.stringify` a parsed object; firmware: same `snprintf`-style build from its
  parsed values — neither side hashes the wire bytes, which may differ in whitespace):
  - Single UTF-8 line, no whitespace anywhere. All values are ASCII by construction.
  - Keys in this **fixed literal order** (not library "sorted keys"):
    `{"version":V,"tz":"TZ","relays":[R,...],"events":[E,...],"once":[O,...]}`;
    each R = `{"no":N,"boot":"off"|"last_state"|"schedule"}`;
    each E = `{"sid":N,"relay":N,"day":N,"time":"HH:MM","action":"on"|"off"}`;
    each O = `{"sid":N,"relay":N,"date":"YYYY-MM-DD","time":"HH:MM","action":...}`.
  - Integers: base-10, no sign, no leading zeros. No floats, no `null` fields ever.
    `time` always zero-padded `HH:MM`. Empty arrays serialize as `[]`, never omitted.
  - Array order: `relays` ascending `no`; `events`/`once` ascending `sid`, and within
    a sid the `on` entry before `off`.
  - The `sha256` field itself is excluded (it's appended to the wire payload after hashing).
  - **Test vector** (must pass as a unit test in both server and firmware CI):
    input string
    `{"version":1,"tz":"Asia/Jerusalem","relays":[{"no":1,"boot":"schedule"}],"events":[{"sid":1,"relay":1,"day":6,"time":"18:00","action":"on"},{"sid":1,"relay":1,"day":7,"time":"20:00","action":"off"}],"once":[]}`
    → sha256 `32cbd8e3bb7a613d6c8ea8d452ea84ff656b5607373bccfca65f9fba45f6fcc4`.
- Flow: bump `schedule_version` → publish retained → device validates hash, persists to
  NVS, publishes `schedule_ack` → server sets `device_ack_version`, `sync_status='synced'`.
  No ack in 60s **while device online** → `sync_status='error'`, `sync_error` set,
  surfaces in admin monitoring. Offline device → stays `pending`; retained message
  syncs it on reconnect.

### 5.4 Server backup scheduler (`scheduler/tick.js`, cron `* * * * *`)

Each minute, in device-local time per device:

1. Compute occurrences due in the window `[now−3min, now−2min]` (the 2-minute grace has
   elapsed) from all enabled schedules. **[D33] DST rules:** occurrences are computed in
   device-local wall time but keyed by their UTC instant (`occurrence_utc`), which is
   always unambiguous. On fall-back, the repeated wall hour yields **two distinct UTC
   occurrences** — both are due and both fire (actions are absolute/idempotent, so the
   second is a harmless re-assert). On spring-forward, wall times inside the skipped hour
   become due at the first instant after the jump (rule on both server and firmware:
   an event is due once `local_now ≥ event_time` within its occurrence window, not only
   on exact match). When several events are due in the same pass (a spring-forward batch,
   the 1-minute server window, or post-reboot catch-up), both sides apply them in the
   same deterministic order: ascending **intended local event time**, then ascending
   `sid`, and at fully identical timestamps OFF is applied after ON — so an ON/OFF pair
   squeezed into the skipped hour lands in the intended final state, and an exact tie
   resolves to off, the safe state. `dev/{uid}/exec` ingestion parses the offset-bearing `occurrence`
   string to UTC for the row key and stores the original string in `occurrence_local`.
2. For each due `(schedule_id, occurrence, action)` **missing** from
   `schedule_executions` — and, per the retry rule below, each existing `failed` row
   still inside its retry window:
   - Device **online** → the device failed to report: `INSERT ... ON DUPLICATE KEY IGNORE`
     a row with `executed_by='server_backup'`, `status='pending'`, then send a normal
     command (`source:'schedule'`, linked `command_id`). Only on ack does the row become
     `status='executed'` (and only if still `pending` — a device `exec` report may have
     claimed it meanwhile). Every command the scheduler sends carries
     `schedule_execution_id` and copies its `schedule_id` and `action` **from that same
     execution row** — the scheduler is the only writer of these columns on
     `source='schedule'` commands, so command and execution can never disagree. The
     command-create service enforces this as a hard precondition: `source='schedule'`
     with a missing `schedule_execution_id` is rejected outright (internal assertion —
     it can only mean a code bug, never bad user input). An
     attempt is thus always attributable to its exact occurrence + action even when a
     schedule's ON and OFF are due or retried close together. Command failed/timed out → `status='failed'`,
     `executed_by=NULL`. A row is never marked `executed` before the ack.
   - **Retry:** a `failed` row whose occurrence is < 60 min old is retried on each
     subsequent tick while the device is online (new command, same row; an ack flips it
     to `executed`, `executed_by='server_backup'`). Past 60 min it stays `failed` and
     is visible via `commands_failed_24h` in monitoring. Each retry inserts a fresh
     `commands` row (same `schedule_execution_id`) and repoints `command_id` at it —
     the column holds the **latest** attempt; the full attempt trail is
     `commands WHERE schedule_execution_id = :id`, so no separate attempt log is needed.
   - Device **offline** → insert `status='unverified_offline'`, `executed_by=NULL`.
     No command sent. Reconciled later per [D21].
3. `dev/{uid}/exec` ingestion (async, any time): `INSERT ... ON DUPLICATE KEY UPDATE` —
   the device claims the row (`executed_by='device'`, `status='executed'`) unless it is
   already `status='executed'`; `pending`/`unverified_offline`/`failed` rows are
   overwritten. A device claim leaves `command_id` untouched — it stays pointing at the
   last server-backup attempt (if any) as audit trail; `executed_by='device'` is what
   records who actually executed. First writer to reach `executed` wins (the UNIQUE key
   makes the race safe); never two executions logged. **Before the upsert the report is
   validated:**
   `sid` must resolve to a schedule whose relay belongs to the device identified by the
   topic uid — **including disabled and soft-deleted schedules/relays**: a late report
   for an occurrence that was legitimately due before a user/admin edit is real history
   and is recorded (the device fired it before its next sync). The payload's `relay`
   must equal that relay's `relay_no`, and the occurrence must lie within the [D21] 24h
   window — anything else is discarded with a `device_events` `'error'` row. A device thus can't rewrite another device's history,
   and a stale (>24h) or malformed report can't flip a genuinely `failed` backup
   command to `executed`. (A *legitimate* late report inside the window may — the
   device really did execute, which is the truth we want recorded.)
4. **Once-schedules:** auto-disable (`is_enabled=FALSE` + bump/push) only when the OFF
   occurrence reaches `executed` or `unverified_offline`, or when a `failed` OFF row has
   exhausted the 60-min retry window above — never on a fresh failure, so the relay is
   not stranded ON while retries are still possible. An exhausted failure disables the
   schedule anyway (its dates are past; it can never re-fire) but stays loud in
   monitoring.
5. Missed windows while the server was down are NOT back-filled beyond 24h; on startup
   the tick scans the last 24h once and records gaps honestly (`unverified_offline` /
   nothing), matching acceptance test #10. **[D24]**

---

## 6. Firmware (ESP32, PlatformIO)

Requirements, not code — full firmware detail lives in `firmware/README` when built:

1. **Provisioning:** first boot (or held BOOT button 5s) → WiFiManager AP portal.
   NVS stores: wifi creds, `device_uid`, mqtt secret, broker host, hardware profile id,
   per-relay `boot_behavior` (initial default `schedule`; thereafter maintained from the
   `relays` section of the schedule payload [D35]), schedule JSON + version, last relay
   states. **[D36] Pin map:** GPIO/MCP23017 wiring is **firmware-side only** — the
   firmware ships named hardware profiles (board type → relay count + pin map), and the
   installer selects one in the AP portal; the portal **refuses to save** a profile whose
   relay count differs from the `relay_count` in the scanned QR [D40], and the status
   payload's relay list gives the server a runtime backstop. The server never stores or transmits GPIO
   numbers; it addresses relays exclusively by `relay_no` (1..profile count). A new board
   layout means a new profile in a firmware release, not a schema or API change.
2. **Clock:** NTP (pool + fallback), TZ rule string for Israel DST
   (`IST-2IDT,M3.4.4/26,M10.5.0`). `time_valid=false` until first successful sync since
   boot → schedule execution refused, `err:"no_time"` reported, immediate commands still
   allowed **[D25]** (a human asked; the risk calculus differs from autonomous execution).
3. **Boot sequence:** apply `boot_behavior` per relay — `off` → off; `last_state` → NVS
   saved state; `schedule` → compute expected state now from stored schedule (walk the
   cyclic week backwards to the most recent event for that relay; no event → off), apply.
4. **Execution loop:** every second, check schedule events against local time using the
   [D33] due-rule (`local_now ≥ event_time` within the occurrence window — so events in
   a spring-forward gap fire at the jump, and the fall-back repeated hour fires twice);
   fire each `(sid, occurrence, action)` at most once (dedupe key kept for 48h in RAM +
   last-fired marker in NVS). Publish `exec` report (queue and retry until delivered if offline at
   fire time — **[D26]** exec reports are queued in NVS, max 100, FIFO). **[D41]
   Overflow:** when the queue is full, the **oldest** report is dropped (recent history
   is the most reconcilable) and a persistent `exec_dropped` counter (cumulative since
   boot) increments; it is included in every status payload. Execution itself is never
   blocked by a full queue. A dropped report is at worst re-asserted by the server
   backup scheduler (commands are absolute/idempotent) or reconciled per [D21].
5. **cmd handling:** validate relay no; apply state (absolute, idempotent); dedupe by
   `cmd_id` (last 32 ids); always ack with resulting state.
6. **schedule handling:** verify `sha256`; on match persist + ack; on mismatch discard +
   `schedule_ack {ok:false}` (server re-publishes). Persisting is a **full replace**
   per [D35]: NVS schedule + relay config are overwritten wholesale; relay numbers
   missing from the payload get their config cleared and are forced OFF.
7. **Connectivity:** WiFi/MQTT reconnect with exponential backoff 1s→5min; local
   execution never blocks on connectivity. Hardware watchdog (task WDT) resets on hang.
8. **Status:** retained publish on connect, on any relay change, every 60s heartbeat.
9. **Relay drive:** active-LOW outputs, all relays forced OFF (HIGH) at GPIO init before
   anything else runs; >8 channels via MCP23017.

---

## 7. Web Panels

Both panels: React + Tailwind, RTL (`dir="rtl"`), Hebrew, mobile-first, served from
`src/web/dist` by Express (same origin — no CORS). **[D27]** Design reference:
`design/mockup-user-dashboard.html`.

**User panel routes:** `/login` (phone → OTP), `/` dashboard, `/schedules`, `/history`,
`/settings`. Dashboard polls `GET /devices` every 10s (**[D28]** polling, not websockets,
for v1 — the IVR is the primary interface; websockets are v2 polish). Relay toggle is
optimistic-off: shows spinner until the 5s command round-trip resolves, then true state.

**Admin panel** at `/admin` (same app, separate route tree + login): pages per PLAN §4.
Provisioning modal shows the secret + QR exactly once with an explicit "I saved it"
confirmation before it can be closed.

---

## 8. Security Requirements (testable statements)

1. `/ivr` without valid `token` → 403; token never logged (nginx log format strips query
   string on `/ivr`). **[D29]**
2. Caller-ID = identification only: `require_pin` users always get PIN prompt; PIN
   lockout 5 fails / 15 min / per phone; lockout state survives restart (DB-backed).
   Caller-ID identification works only through **verified** phones — adding a number
   never grants access until control of it is proven [D34].
3. Rate limits: `/ivr` 30 req/min/phone; OTP request 3/phone/15min; OTP verify 3/code;
   admin login 5/15min/IP. 429 beyond.
4. Secrets: PINs, OTPs, admin passwords, device secrets — one-way hashes only (bcrypt),
   never plaintext at rest, never in logs. Provisioning + rotate endpoints excluded from
   body logging. The one deliberate addition is `devices.mqtt_passwd_hash`: a
   mosquitto_passwd-format **PBKDF2-SHA512 verifier** (also one-way, not reversible),
   stored so broker passwd entries can be (re)built from the DB [D31]. It is redacted
   from all API responses, logs, and `audit_log` diffs exactly like the bcrypt hashes,
   and it rides in DB backups as a verifier only. Threat assessment: DB compromise alone
   yields no usable broker credential (offline guessing of a random 32-char base62
   secret is infeasible); *installing* a verifier into the broker requires write access
   to the passwd file, i.e. server compromise — at which point the attacker owns the
   broker regardless. Net exposure over bcrypt-only: none.
5. MQTT: 1883 loopback-only; ufw allows 80/443/8883 only; per-device ACL `dev/{uid}/#`;
   a device presenting valid creds for uid A cannot publish/subscribe uid B (verified by
   an automated test in Phase 6).
6. JWTs per [D14]; user endpoints hard-scoped by `user_id` from the token — no id from
   the client is ever trusted for ownership.
7. Impersonation writes carry the admin's id in `audit_log`.
8. Daily `mysqldump` to DO Spaces (or Managed MySQL), 30-day retention; restore drill in
   Phase 6. **[D30]**

---

## 9. Acceptance

Phase gates per PLAN §6. The pilot ships only when PLAN's Phase-6 checklist (tests 1–10)
is all green, plus these spec-level additions:

| # | Test | Expected |
|---|---|---|
| 11 | ACL cross-device attempt (device A creds, topic B) | Broker denies; no data leak |
| 12 | `once` schedule end-to-end (web create → device exec → auto-disable) | Fires on the exact dates, `is_enabled` flips false, device schedule shrinks on next sync |
| 13 | Relay rename in user panel, then call IVR | New name heard in the very next call, correct `ivr_digit` |
| 14 | OTP brute force (4th wrong code) | Code invalidated, lockout row written, 429 on further requests |
| 15 | Restore-from-backup drill | Yesterday's dump restores to a working staging DB |
| 16 | Scheduler command↔execution invariant (unit test) | Every `source='schedule'` command's `schedule_id`, `action`, and relay match its `schedule_execution_id` row exactly (§5.4) — the invariant is service-enforced only, so this test is its guard |

---

## Open items (tracked, not blocking)

- Verify exact Yemot response-command syntax + webhook timeout (Phase 1 spike) — decides
  blocking-ack vs two-step IVR feedback.
- Confirm whether Yemot outbound (OTP call) is available on account `043131481` or needs
  a separate module/credit.
- MCP23017 wiring map + enclosure choice — hardware install doc, Phase 2.

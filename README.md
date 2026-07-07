# Shabat Clock — IVR-Controlled ESP32 Switch System

Users call a kosher phone number (Yemot HaMashiach IVR), identify by caller ID, and
switch relays on/off immediately or on a weekly schedule. Commands flow IVR → Node.js
server → MQTT → ESP32. **Schedules execute locally on the device** (NVS + NTP); the
server scheduler is backup/monitor only — שבת keeps working if the internet drops.

Docs: [PLAN.md](PLAN.md) (architecture) · [SPEC.md](SPEC.md) (build contract) ·
[firmware/README.md](firmware/README.md) (ESP32).

## Layout

```
src/
├── config/      env, error envelope [D4], constants
├── db/          pool (UTC session tz [D1]), migrations [D7]
├── ivr/         Yemot webhook — state machine §4 (responses.js is the only
│                module that emits protocol strings)
├── mqtt/        broker client — §5 contract (cmd/ack/status/exec/schedule)
├── scheduler/   backup scheduler §5.4 (DST-safe occurrences [D33])
├── services/    business logic — validation §1.1, canonical hash [D23],
│                provisioning, OTP, lockouts, history cursor
├── api/         REST §3 (user panel + admin, JWT [D14], rate limits §8.3)
└── web/         React + Tailwind RTL panels (user + /admin) [D27]
firmware/        ESP32 (PlatformIO)
```

## Setup (dev)

```bash
npm install
cp .env.example .env            # fill DATABASE_URL, IVR_TOKEN, JWT_SECRET, MQTT_*
mysql -e "CREATE DATABASE shabat_clock CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
npm run migrate
npm run build:web               # builds src/web/dist (served by Express)
npm run dev                     # server on :3001 (runs migrations on start too)
npm test                        # unit tests incl. the [D23] sha256 test vector
```

First admin account (run once):

```sql
INSERT INTO admins (name, email, password_hash, role)
VALUES ('Admin', 'you@example.com', '<bcrypt hash>', 'superadmin');
-- node -e "console.log(require('bcryptjs').hashSync('your-password', 12))"
```

## Production (per PLAN Decisions)

- Same droplet as `ivr-collector`: PM2 app `shabat-clock` on **:3001**
  (`pm2 start ecosystem.config.js`), nginx routes by domain/path, HTTPS via
  Let's Encrypt. Strip the query string from nginx access logs on `/ivr` [D29].
- **Mosquitto** as systemd service: 1883 bound to **127.0.0.1 only** (server),
  8883 TLS for devices; per-device username/password (`MOSQUITTO_PASSWD_FILE`)
  + ACL `dev/%u/#`. ufw: allow 80/443/8883 only.
- **Yemot**: create a שלוחת API on `043131481` with
  `api_link = https://<domain>/ivr?token=<IVR_TOKEN>`.
  ⚠️ Phase-1 spike: verify exact response-command syntax + webhook timeout
  (`src/ivr/responses.js` is the single place to correct).
- Daily `mysqldump` to DO Spaces, 30-day retention [D30].

Pilot ships only when the Phase-6 acceptance checklist (PLAN §6 + SPEC §9) is all green.

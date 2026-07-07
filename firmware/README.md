# Shabat Clock — ESP32 Firmware

Implements SPEC §6. The device is **authoritative** for schedule execution: schedules
persist in NVS and run off the local clock (NTP, Israel DST). Internet loss never stops
a שבת schedule.

## Hardware profiles [D36]

Pin maps are firmware-side only; the server addresses relays exclusively by `relay_no`.

| Profile id | Channels | Drive |
|---|---|---|
| `relay2` | 2 | GPIO 26, 27 |
| `relay4` | 4 | GPIO 26, 27, 32, 33 |
| `relay8` | 8 | GPIO 26, 27, 32, 33, 25, 14, 12, 13 |
| `relay16` | 16 | MCP23017 (I2C, addr 0x20) |
| `relay20` | 20 | GPIO 26, 27, 32, 33 + MCP23017 |

All outputs **active-LOW**; every relay is forced OFF at GPIO init before anything else
runs (§6.9). For loads >10A (דוד שמש, boilers) the relay must drive a **contactor**.

## Install flow

1. Admin provisions the device in the panel → QR containing
   `{"broker_host","secret","relay_count"}` (+ `device_uid` if pre-known).
2. First boot (or hold BOOT 5s) → WiFi AP `shabat-XXXXXX` → setup portal:
   - connect WiFi
   - paste the QR JSON
   - pick the hardware profile — the portal **refuses to save** a profile whose channel
     count differs from the QR's `relay_count` [D40]
   - the portal shows this device's MAC (= `device_uid`); if the QR had no UID, report
     it to the admin, who enters it via PATCH /admin/devices/:id — until then the broker
     rejects connects and the normal reconnect backoff rides it out [D31].
3. Broker auth succeeds → retained schedule arrives → NVS persist → `schedule_ack`.

## Behavior guarantees

- **Clock integrity:** schedule execution refused until first NTP sync since boot
  (`time_valid=false` in status); immediate commands still allowed [D25].
- **Boot state:** per-relay `boot_behavior` (`off` / `last_state` / `schedule`); with
  `schedule` the device recomputes "what should I be right now" — power loss during
  שבת self-heals on restore.
- **DST [D33]:** due-rule is minute-of-week crossing — spring-forward gap events fire
  at the jump; the fall-back repeated hour fires twice (distinct UTC occurrences).
- **Idempotent commands:** absolute on/off, `cmd_id` dedupe (last 32), always acked
  with the resulting state.
- **Exec reports:** queued in NVS when offline (max 100, FIFO; overflow drops oldest
  and bumps the persistent `exec_dropped` counter shown in status) [D26][D41].
- **Reconnect:** WiFi/MQTT exponential backoff 1s→5min; hardware watchdog (30s).

## Build & test

```
pio run                 # build
pio run -t upload       # flash
pio test                # on-target tests, incl. the [D23] canonical-hash vector
```

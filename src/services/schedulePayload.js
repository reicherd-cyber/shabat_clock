// §5.3 schedule payload + [D23] canonical hash. The canonical string is built by
// CONCATENATION (never JSON.stringify of a parsed object) — byte-exact contract
// shared with the firmware; the test vector in test/hash.test.js guards it.
import crypto from 'node:crypto';
import { query } from '../db/pool.js';

function hhmm(t) {
  // MySQL TIME arrives as "HH:MM:SS"
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function ymd(v) {
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  return String(v).slice(0, 10);
}

// Core payload (without sha256) for a device. Disabled/soft-deleted schedules and
// disabled/soft-deleted relays contribute no events; live relays (enabled or not)
// each contribute a config entry [D35].
export async function buildDevicePayload(deviceId) {
  const [device] = await query('SELECT id, schedule_version, timezone FROM devices WHERE id = ?', [deviceId]);
  if (!device) throw new Error(`Device ${deviceId} not found`);

  const relays = await query(
    'SELECT relay_no, boot_behavior, id, is_enabled FROM relays WHERE device_id = ? AND deleted_at IS NULL ORDER BY relay_no',
    [deviceId],
  );

  const schedules = await query(
    `SELECT s.id, s.on_day_of_week, s.on_time, s.off_day_of_week, s.off_time,
            s.repeat_type, s.on_date, s.off_date, r.relay_no
     FROM schedules s
     JOIN relays r ON r.id = s.relay_id
     WHERE r.device_id = ? AND s.is_enabled = TRUE AND s.deleted_at IS NULL
       AND r.is_enabled = TRUE AND r.deleted_at IS NULL
     ORDER BY s.id`,
    [deviceId],
  );

  const events = [];
  const once = [];
  for (const s of schedules) {
    if (s.repeat_type === 'weekly') {
      // [D5] 0 on the wire = daily (NULL in DB). One-sided weekly contributes a
      // single entry — the wire format is unchanged, entries were always independent.
      if (s.on_time) events.push({ sid: Number(s.id), relay: s.relay_no, day: s.on_day_of_week ?? 0, time: hhmm(s.on_time), action: 'on' });
      if (s.off_time) events.push({ sid: Number(s.id), relay: s.relay_no, day: s.off_day_of_week ?? 0, time: hhmm(s.off_time), action: 'off' });
    } else {
      // One-sided 'once' contributes a single entry — the wire format is unchanged,
      // each entry was always an independent action.
      if (s.on_date && s.on_time) once.push({ sid: Number(s.id), relay: s.relay_no, date: ymd(s.on_date), time: hhmm(s.on_time), action: 'on' });
      if (s.off_date && s.off_time) once.push({ sid: Number(s.id), relay: s.relay_no, date: ymd(s.off_date), time: hhmm(s.off_time), action: 'off' });
    }
  }

  return {
    version: Number(device.schedule_version),
    tz: device.timezone,
    relays: relays.map((r) => ({ no: r.relay_no, boot: r.boot_behavior })),
    events,
    once,
  };
}

// [D23] canonical string: single line, no whitespace, fixed literal key order,
// arrays ordered (relays asc no; events/once asc sid, 'on' before 'off' — the
// builder above already emits that order).
export function canonicalString(p) {
  let s = `{"version":${p.version},"tz":"${p.tz}","relays":[`;
  s += p.relays.map((r) => `{"no":${r.no},"boot":"${r.boot}"}`).join(',');
  s += '],"events":[';
  s += p.events.map((e) => `{"sid":${e.sid},"relay":${e.relay},"day":${e.day},"time":"${e.time}","action":"${e.action}"}`).join(',');
  s += '],"once":[';
  s += p.once.map((o) => `{"sid":${o.sid},"relay":${o.relay},"date":"${o.date}","time":"${o.time}","action":"${o.action}"}`).join(',');
  s += ']}';
  return s;
}

export function payloadSha256(p) {
  return crypto.createHash('sha256').update(canonicalString(p), 'utf8').digest('hex');
}

// Wire payload = core + sha256 appended after hashing.
export async function buildWirePayload(deviceId) {
  const core = await buildDevicePayload(deviceId);
  return { ...core, sha256: payloadSha256(core) };
}

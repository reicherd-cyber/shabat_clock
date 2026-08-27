// WHY is a device unreachable? Three independent witnesses tell it apart:
//  1. The broker log — is the device still knocking? Failed TLS handshakes
//     (filter forging the cert), sessions cut short (filter timeout), or
//     total silence each leave a different trace.
//  2. Ping to the household's last-known public IP — separates "house lost
//     internet/power" from "house is up but the device can't get through".
//     (No ICMP answer is inconclusive — many routers drop ping.)
//  3. The DB flap history (device_events) — survives broker log rotation.
// The broker log lives on the production host; a dev server reports no_data.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter } from 'node:path';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

const pExecFile = promisify(execFile);
// Override for tests/dev: MOSQUITTO_LOGS as a path-delimiter-separated list
// (':' on linux, ';' on Windows — so drive letters survive).
const LOG_FILES = (process.env.MOSQUITTO_LOGS
  || '/var/log/mosquitto/mosquitto.log.1:/var/log/mosquitto/mosquitto.log').split(delimiter);
const WINDOW_S = 24 * 3600;
const FLAPPING_SESSION_S = 300;   // median session under 5 min = the line cuts it
const RECENT_CONNECT_S = 30 * 60; // connected within the last half hour = still cycling

const RE_CONNECT = /^(\d+): New client connected from ([\d.]+):\d+ as (\S+)/;
const RE_ATTEMPT = /^(\d+): New connection from ([\d.]+):\d+ on port 8883\./;
const RE_CLOSE = /^(\d+): Client (\S+) (?:closed its connection|disconnected)/;

function heDuration(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 90) return `כ-${min} דקות`;
  return `כ-${Math.round(min / 60)} שעות`;
}

async function readBrokerLog() {
  let text = '';
  for (const f of LOG_FILES) {
    try { text += await readFile(f, 'utf8'); } catch { /* rotated away / dev machine */ }
  }
  return text;
}

// One ICMP echo from the server to the household's public IP.
// Only meaningful on the production host (linux); anywhere else → null.
async function pingHouse(ip) {
  if (!ip || process.platform !== 'linux') return null;
  try {
    await pExecFile('ping', ['-c', '1', '-W', '2', ip], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function diagnoseDevice(deviceId) {
  const [device] = await query(
    `SELECT d.id, d.name, d.device_uid, d.transport, d.ip_address, d.is_online, d.last_seen_at,
            TIMESTAMPDIFF(MINUTE, d.last_seen_at, UTC_TIMESTAMP()) AS seen_min
     FROM devices d WHERE d.id = ?`,
    [deviceId],
  );
  if (!device) throw Object.assign(new Error('device not found'), { status: 404 });
  if (!device.device_uid) return { verdict: 'no_uid', text: 'למכשיר אין עדיין UID — הוא מעולם לא חובר.', evidence: {} };
  const uid = device.device_uid;

  // Flap history from the DB — broker-independent.
  const [{ flaps }] = await query(
    `SELECT COUNT(*) AS flaps FROM device_events
     WHERE device_id = ? AND event IN ('online','offline')
       AND created_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR`,
    [deviceId],
  );

  const log = await readBrokerLog();
  const nowS = Math.floor(Date.now() / 1000);
  const sinceS = nowS - WINDOW_S;

  // Walk the log once: sessions for THIS device (client id ends with its uid),
  // plus raw 8883 attempts per source IP (failed TLS handshakes never reach a
  // client id — they only exist as attempts with no matching connect).
  const sessions = [];          // {start, end|null}
  const attemptsByIp = new Map(); // ip → count in window
  const connectsByIp = new Map(); // ip → count in window (any client)
  let lastIp = null;
  let lastConnectS = null;
  let open = null;
  for (const line of log.split('\n')) {
    const at = RE_ATTEMPT.exec(line);
    if (at) {
      if (Number(at[1]) >= sinceS) attemptsByIp.set(at[2], (attemptsByIp.get(at[2]) || 0) + 1);
      continue;
    }
    const co = RE_CONNECT.exec(line);
    if (co) {
      const ts = Number(co[1]);
      if (ts >= sinceS) connectsByIp.set(co[2], (connectsByIp.get(co[2]) || 0) + 1);
      if (co[3].endsWith(uid)) {
        lastIp = co[2];
        lastConnectS = ts;
        open = { start: ts, end: null };
        sessions.push(open);
      }
      continue;
    }
    const cl = RE_CLOSE.exec(line);
    if (cl && cl[2].endsWith(uid) && open) { open.end = Number(cl[1]); open = null; }
  }

  const inWindow = sessions.filter((s) => s.start >= sinceS);
  const lengths = inWindow.filter((s) => s.end).map((s) => s.end - s.start).sort((a, b) => a - b);
  const medianSession = lengths.length ? lengths[Math.floor(lengths.length / 2)] : null;
  const connects24 = inWindow.length;
  const attempts24 = lastIp ? (attemptsByIp.get(lastIp) || 0) : 0;
  const failedAttempts = lastIp ? Math.max(0, attempts24 - (connectsByIp.get(lastIp) || 0)) : 0;
  const houseUp = await pingHouse(lastIp);

  // Before blaming the customer: if OUR broker link is down, every device
  // looks dead — that's a service-side outage, full stop.
  const prodHere = env.nodeEnv === 'production' || process.env.HEALTH_ACTIVE === '1';
  if (prodHere) {
    const { brokerConnected } = await import('../mqtt/client.js');
    if (!brokerConnected()) {
      return {
        verdict: 'service_down', category: 'service',
        text: 'השרת מנותק מהברוקר — כל המכשירים ייראו מנותקים. זו תקלה בשירות שלנו, לא אצל הלקוח.',
        evidence: {},
      };
    }
  }

  // Ground truth beats every log heuristic: a device that answers an RPC right
  // now is connected, even if its session predates the log window (32-day
  // sessions have no connect line left in any rotated file). A dev server
  // skips mqtt probes — the fleet dials the production broker, not ours.
  let answersNow = false;
  const canProbe = device.transport === 'lan' || prodHere;
  if (canProbe) {
    const { shellyCall } = await import('./shelly.js');
    answersNow = await shellyCall(device, 'Sys.GetStatus').then(() => true).catch(() => false);
  }

  const evidence = {
    answers_now: canProbe ? answersNow : 'unavailable',
    is_online: !!device.is_online,
    last_seen_min: device.seen_min,
    flaps_24h: Number(flaps),
    broker_log_available: log.length > 0,
    last_public_ip: lastIp,
    last_connect_min_ago: lastConnectS ? Math.round((nowS - lastConnectS) / 60) : null,
    connects_24h: connects24,
    attempts_24h: attempts24,
    failed_tls_attempts_24h: failedAttempts,
    median_session_s: medianSession,
    ping: houseUp === null ? 'unavailable' : (houseUp ? 'answered' : 'no_answer'),
  };

  // Same-household devices share a public IP, so attempt counts from that IP
  // can mix siblings — treated as supporting evidence, never the sole verdict.
  const flappingLine = connects24 > 10 && medianSession !== null && medianSession < FLAPPING_SESSION_S;
  let verdict; let text;
  if (answersNow) {
    if (flappingLine) {
      verdict = 'connected_flapping';
      text = `המכשיר מגיב כרגע, אבל הקו שלו נופל ומתחבר שוב ושוב (${connects24} התחברויות ביממה, חציון חיבור ${medianSession} שניות) — כנראה ספק הסינון מנתק אותו. תזמונים מקומיים ממשיכים לפעול; מומלץ לבקש החרגה אצל ספק הסינון.`;
    } else {
      verdict = 'connected_ok';
      text = 'המכשיר מגיב כרגע והחיבור תקין.';
    }
  } else if (!log.length) {
    verdict = 'no_data';
    text = 'יומן הברוקר אינו זמין (שרת פיתוח?) — אין מספיק נתונים לאבחון.';
  } else if (connects24 > 0 && (nowS - lastConnectS) < RECENT_CONNECT_S
             && medianSession !== null && medianSession < FLAPPING_SESSION_S) {
    verdict = 'filter_flapping';
    text = `הבית מחובר והמכשיר תקין, אבל ספק הסינון מנתק את החיבור שוב ושוב (חציון חיבור: ${medianSession} שניות, ${connects24} התחברויות ביממה). נדרשת החרגה של כתובת השרת אצל ספק הסינון.`;
  } else if (connects24 === 0 && failedAttempts > 0) {
    verdict = 'tls_blocked';
    text = `יש חשמל ואינטרנט בבית — המכשיר מנסה להתחבר (${failedAttempts} ניסיונות ביממה) אך נחסם לפני שהחיבור נפתח. זו חסימת סינון (זיוף תעודה) — נדרשת החרגה אצל ספק הסינון.`;
  } else if (connects24 === 0 && attempts24 === 0) {
    if (houseUp === true) {
      verdict = 'silent_house_up';
      text = 'אין שום ניסיון התחברות מהמכשיר, אבל הראוטר בבית הלקוח מגיב — כנראה המכשיר מנותק מחשמל, או שהסינון חוסם את היציאה לגמרי. כדאי לבקש מהלקוח לבדוק שהמכשיר דולק.';
    } else {
      verdict = 'silent_house_down';
      text = 'אין שום ניסיון התחברות והבית לא מגיב לבדיקה — ככל הנראה הפסקת חשמל או נפילת אינטרנט בבית הלקוח. (ייתכן גם שהראוטר פשוט לא עונה לפינג — עדות תומכת, לא מוחלטת.)';
    }
  } else {
    // Connected at some point in the window but stopped since.
    const ago = lastConnectS ? heDuration(nowS - lastConnectS) : 'זמן לא ידוע';
    if (flappingLine) {
      // Hundreds of short sessions and THEN silence isn't a customer outage —
      // it's the filter's throttling worsening into a full block.
      verdict = 'flapping_went_silent';
      text = `הקו נפל והתחבר שוב ושוב (${connects24} התחברויות ביממה, חציון חיבור ${medianSession} שניות) ולפני ${ago} השתתק לגמרי — דפוס מובהק של חסימת סינון שהחמירה. נדרשת החרגה אצל ספק הסינון.`;
    } else if (houseUp === true) {
      verdict = 'went_silent_house_up';
      text = `המכשיר התחבר לאחרונה לפני ${ago} ומאז שקט, אבל הבית עצמו מגיב — או שהמכשיר כבה, או שהסינון החמיר לחסימה מלאה. כדאי לבדוק מול הלקוח.`;
    } else {
      verdict = 'went_silent';
      text = `המכשיר התחבר לאחרונה לפני ${ago} ומאז שקט, והבית לא מגיב לבדיקה — ייתכן ניתוק חשמל/אינטרנט בבית, או החמרה של חסימת הסינון.`;
    }
  }

  // The admin's bottom-line question: whose problem is it? 'customer' = power/
  // internet at the house, 'filter' = the filtered-ISP blocking us (fix =
  // exclusion request), 'service' = our side, 'ok' = nothing wrong, 'unknown'.
  const CATEGORY = {
    connected_ok: 'ok',
    connected_flapping: 'filter',
    filter_flapping: 'filter',
    flapping_went_silent: 'filter',
    tls_blocked: 'filter',
    silent_house_up: 'customer',
    silent_house_down: 'customer',
    went_silent_house_up: 'customer',
    went_silent: 'customer',
    no_data: 'unknown',
  };
  return { verdict, category: CATEGORY[verdict] || 'unknown', text, evidence };
}

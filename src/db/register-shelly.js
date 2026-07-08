// Register the physical Shelly Pro 2 as a 'shelly' device with 2 relays, owned by the
// test user, reading its current on/off state live. Idempotent on ip_address.
//   node src/db/register-shelly.js <ip> [ownerPhone]
import { pathToFileURL } from 'node:url';
import { pool, query, withTransaction } from './pool.js';
import { shellyInfo, shellyGetState } from '../services/shelly.js';

const IP = process.argv[2] || process.env.SHELLY_IP || '';
const OWNER_PHONE = process.argv[3] || process.env.SEED_PHONE || '0500000001';

if (!IP) {
  console.error('usage: node src/db/register-shelly.js <ip> [ownerPhone]');
  process.exit(1);
}

export async function registerShelly(ip = IP, ownerPhone = OWNER_PHONE) {
  const info = await shellyInfo(ip); // throws if unreachable
  const uid = String(info.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 12);

  const [existing] = await query('SELECT id FROM devices WHERE ip_address = ? OR device_uid = ?', [ip, uid]);
  if (existing) {
    console.log(`Shelly already registered as device id ${existing.id}.`);
    return existing.id;
  }

  const [owner] = await query(
    'SELECT user_id FROM user_phones WHERE phone = ?', [ownerPhone],
  );
  if (!owner) throw new Error(`No user with phone ${ownerPhone} — run npm run seed first.`);

  // Read live state so the dashboard matches reality immediately.
  const st0 = await shellyGetState(ip, 1).catch(() => null);
  const st1 = await shellyGetState(ip, 2).catch(() => null);

  const deviceId = await withTransaction(async (conn) => {
    const [d] = await conn.query(
      `INSERT INTO devices
         (user_id, device_uid, device_type, ip_address, name,
          mqtt_secret_hash, mqtt_passwd_hash, relay_count, is_online, fw_version)
       VALUES (?,?, 'shelly', ?,?, '', '', 2, TRUE, ?)`,
      [owner.user_id, uid, ip, `Shelly Pro 2 (${info.model})`, info.ver || null],
    );
    const id = d.insertId;
    const relays = [
      [1, 'ערוץ 1', 3, st0],
      [2, 'ערוץ 2', 4, st1],
    ];
    for (const [relayNo, name, ivrDigit, state] of relays) {
      await conn.query(
        `INSERT INTO relays (device_id, user_id, relay_no, name, ivr_digit, current_state, state_updated_at, sort_order)
         VALUES (?,?,?,?,?,?, UTC_TIMESTAMP(), ?)`,
        [id, owner.user_id, relayNo, name, ivrDigit,
          state === null ? 'unknown' : state ? 'on' : 'off', relayNo],
      );
    }
    return id;
  });

  console.log(`Registered Shelly ${uid} at ${ip} as device ${deviceId} (relays 1=${st0}, 2=${st1}) for user ${owner.user_id}.`);
  return deviceId;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  registerShelly()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}

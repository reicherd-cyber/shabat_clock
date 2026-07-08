// Dev-only seed: one test user + phone + device + two relays, so the web panels
// have something to show and OTP login works locally. Idempotent — safe to re-run.
//   npm run seed
import { pathToFileURL } from 'node:url';
import { pool, query, withTransaction } from './pool.js';
import { bcryptHash } from '../services/users.js';

// Overridable so real numbers/emails never live in the (public) repo.
const PHONE = process.env.SEED_PHONE || '0500000001';
const PIN = process.env.SEED_PIN || '1234';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASS = process.env.SEED_ADMIN_PASS || 'admin1234';
const USER_EMAIL = process.env.SEED_USER_EMAIL || 'user@example.com';

async function seedAdmin() {
  const [existing] = await query('SELECT id FROM admins WHERE email = ?', [ADMIN_EMAIL]);
  if (existing) {
    console.log(`Admin ${ADMIN_EMAIL} already exists (id ${existing.id}).`);
    return;
  }
  const r = await query(
    `INSERT INTO admins (name, email, password_hash, role, is_active)
     VALUES (?,?,?, 'superadmin', TRUE)`,
    ['מנהל ראשי', ADMIN_EMAIL, bcryptHash(ADMIN_PASS)],
  );
  console.log(`Seeded superadmin ${ADMIN_EMAIL} (id ${r.insertId}), password: ${ADMIN_PASS}`);
}

export async function seed() {
  await seedAdmin();

  const [existing] = await query('SELECT id FROM user_phones WHERE phone = ?', [PHONE]);
  if (existing) {
    console.log(`Seed skipped — phone ${PHONE} already exists (user_phone id ${existing.id}).`);
    return;
  }

  await withTransaction(async (conn) => {
    const [u] = await conn.query(
      `INSERT INTO users (full_name, ivr_code, pin_hash, email, status) VALUES (?,?,?,?, 'active')`,
      ['משתמש בדיקה', '100001', bcryptHash(PIN), USER_EMAIL],
    );
    const userId = u.insertId;

    await conn.query(
      `INSERT INTO user_phones (user_id, phone, label, is_primary, verified_at)
       VALUES (?,?,?, TRUE, UTC_TIMESTAMP())`,
      [userId, PHONE, 'ראשי'],
    );

    const [d] = await conn.query(
      `INSERT INTO devices (user_id, name, mqtt_secret_hash, mqtt_passwd_hash, relay_count, is_online)
       VALUES (?,?,?,?, 2, FALSE)`,
      [userId, 'שעון שבת - בית', bcryptHash('dev-secret'), bcryptHash('dev-secret')],
    );
    const deviceId = d.insertId;

    const relays = [
      [1, 'מטבח', 1],
      [2, 'סלון', 2],
    ];
    for (const [relayNo, name, ivrDigit] of relays) {
      await conn.query(
        `INSERT INTO relays (device_id, user_id, relay_no, name, ivr_digit, current_state, sort_order)
         VALUES (?,?,?,?,?, 'off', ?)`,
        [deviceId, userId, relayNo, name, ivrDigit, relayNo],
      );
    }

    console.log(`Seeded user ${userId} (${PHONE}, PIN ${PIN}), device ${deviceId}, 2 relays.`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}

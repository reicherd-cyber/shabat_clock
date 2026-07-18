import { query } from '../db/pool.js';

// settings table cache — IVR prompts are read on every call step; 30s TTL keeps
// admin edits near-instant without a query per prompt.
let cache = null;
let cacheAt = 0;
const TTL_MS = 30_000;

async function load() {
  const rows = await query('SELECT setting_key, setting_value FROM settings');
  cache = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
  cacheAt = Date.now();
}

export async function getSetting(key, fallback = '') {
  if (!cache || Date.now() - cacheAt > TTL_MS) await load();
  return cache.has(key) ? cache.get(key) : fallback;
}

// Simple {placeholder} interpolation for IVR texts.
export async function getText(key, vars = {}) {
  let text = await getSetting(key, key);
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
}

export async function listSettings() {
  const rows = await query('SELECT setting_key, setting_value, description FROM settings ORDER BY setting_key');
  return rows;
}

// Single-key upsert that can seed a description on first write (putSettings
// leaves description untouched — it serves the settings-page bulk save).
export async function setSetting(key, value, description = null) {
  await query(
    `INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
       description = COALESCE(settings.description, VALUES(description))`,
    [key, String(value), description],
  );
  cache = null; // invalidate
}

export async function putSettings(entries) {
  for (const { setting_key, setting_value } of entries) {
    await query(
      'INSERT INTO settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [setting_key, setting_value],
    );
  }
  cache = null; // invalidate
}

// Which instance owns the device fleet. Production (or HEALTH_ACTIVE=1) is the
// single "primary": it heals devices, pushes schedules, emails admins, and is
// the ONLY one allowed to write what it hears on the broker into the DB.
// Staging and local dev share the production DB and broker (user decision) —
// before this gate every Shelly birth/death landed twice in device_events, once
// per listening server (found 2026-09-16). Passive instances still send
// commands and RPCs and read their own replies; they just never take notes.
import { env } from './env.js';

export const isPrimary = () => env.nodeEnv === 'production' || process.env.HEALTH_ACTIVE === '1';

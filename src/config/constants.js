// [D5] Days of week: 1–7 = Sunday(א׳)–Saturday(ש׳). 0 on the MQTT wire = daily; NULL in DB.
export const DAY_NAMES_HE = { 1: 'ראשון', 2: 'שני', 3: 'שלישי', 4: 'רביעי', 5: 'חמישי', 6: 'שישי', 7: 'שבת' };

export const MINUTES_PER_WEEK = 7 * 24 * 60; // 10080
export const MINUTES_PER_DAY = 24 * 60;

export const ACK_TIMEOUT_MS = 5000;          // §5.2 immediate command ack window
export const SCHEDULE_ACK_TIMEOUT_MS = 60_000; // §5.3 sync ack window
export const BACKUP_GRACE_MIN = 2;           // §5.4 grace before server backup fires
export const RETRY_WINDOW_MIN = 60;          // §5.4 failed-occurrence retry window
export const RECONCILE_WINDOW_H = 24;        // [D21]

export const LOCKOUT_MAX_FAILURES = 5;       // [D10]
export const LOCKOUT_WINDOW_MIN = 15;
export const OTP_TTL_MIN = 5;                // [D9]
export const OTP_MAX_ATTEMPTS = 3;

export const IVR_SESSION_TTL_MS = 10 * 60 * 1000; // [D16]
export const MAX_RELAYS = 20;

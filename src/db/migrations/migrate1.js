// Full schema per SPEC §1. [D3] utf8mb4 / InnoDB everywhere (DB default set below).
const ddl = [
  `CREATE TABLE admins (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash CHAR(60) NOT NULL,
    role          ENUM('superadmin','support') NOT NULL DEFAULT 'support',
    is_active     BOOL NOT NULL DEFAULT TRUE,
    last_login_at DATETIME NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE users (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    full_name    VARCHAR(100) NOT NULL,
    ivr_code     CHAR(6) NOT NULL UNIQUE,
    pin_hash     CHAR(60) NOT NULL,
    require_pin  BOOL NOT NULL DEFAULT FALSE,
    status       ENUM('active','suspended') NOT NULL DEFAULT 'active',
    max_devices  TINYINT UNSIGNED NOT NULL DEFAULT 3,
    language     CHAR(2) NOT NULL DEFAULT 'he',
    notes        TEXT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE user_phones (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    phone       VARCHAR(15) NOT NULL UNIQUE,
    label       VARCHAR(50) NULL,
    is_primary  BOOL NOT NULL DEFAULT FALSE,
    verified_at DATETIME NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_phone (phone)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE devices (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id            BIGINT UNSIGNED NOT NULL,
    device_uid         CHAR(12) NULL UNIQUE,
    name               VARCHAR(100) NOT NULL,
    mqtt_secret_hash   CHAR(60) NOT NULL,
    mqtt_passwd_hash   VARCHAR(200) NOT NULL,
    fw_version         VARCHAR(20) NULL,
    timezone           VARCHAR(40) NOT NULL DEFAULT 'Asia/Jerusalem',
    relay_count        TINYINT UNSIGNED NOT NULL,
    is_online          BOOL NOT NULL DEFAULT FALSE,
    last_seen_at       DATETIME NULL,
    schedule_version   INT UNSIGNED NOT NULL DEFAULT 0,
    device_ack_version INT UNSIGNED NOT NULL DEFAULT 0,
    last_pushed_at     DATETIME NULL,
    sync_status        ENUM('pending','synced','error') NOT NULL DEFAULT 'pending',
    sync_error         VARCHAR(255) NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE KEY uq_device_owner (id, user_id),
    CHECK (relay_count BETWEEN 1 AND 20)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE relays (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    device_id        BIGINT UNSIGNED NOT NULL,
    user_id          BIGINT UNSIGNED NOT NULL,
    relay_no         TINYINT UNSIGNED NOT NULL,
    name             VARCHAR(50) NOT NULL,
    ivr_digit        TINYINT UNSIGNED NULL,
    is_enabled       BOOL NOT NULL DEFAULT TRUE,
    sort_order       SMALLINT NOT NULL DEFAULT 0,
    boot_behavior    ENUM('off','last_state','schedule') NOT NULL DEFAULT 'schedule',
    current_state    ENUM('on','off','unknown') NOT NULL DEFAULT 'unknown',
    state_updated_at DATETIME NULL,
    deleted_at       DATETIME NULL,
    UNIQUE KEY uq_channel (device_id, relay_no),
    UNIQUE KEY uq_ivr (user_id, ivr_digit),
    UNIQUE KEY uq_relay_owner (id, user_id),
    FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id) ON UPDATE CASCADE,
    CHECK (relay_no BETWEEN 1 AND 20),
    CHECK (ivr_digit BETWEEN 1 AND 20)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE schedules (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    relay_id        BIGINT UNSIGNED NOT NULL,
    on_day_of_week  TINYINT UNSIGNED NULL,
    on_time         TIME NOT NULL,
    off_day_of_week TINYINT UNSIGNED NULL,
    off_time        TIME NOT NULL,
    repeat_type     ENUM('weekly','once') NOT NULL DEFAULT 'weekly',
    on_date         DATE NULL,
    off_date        DATE NULL,
    is_enabled      BOOL NOT NULL DEFAULT TRUE,
    deleted_at      DATETIME NULL,
    created_via     ENUM('ivr','web','admin') NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (relay_id, user_id) REFERENCES relays(id, user_id) ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE call_logs (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    yemot_call_id VARCHAR(64) NOT NULL,
    phone         VARCHAR(15) NOT NULL,
    user_id       BIGINT UNSIGNED NULL,
    menu_path     VARCHAR(255) NOT NULL DEFAULT '',
    outcome       ENUM('command','schedule','status','auth_fail','abandoned') NULL,
    started_at    DATETIME NOT NULL,
    ended_at      DATETIME NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_call (yemot_call_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE commands (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    relay_id     BIGINT UNSIGNED NOT NULL,
    action       ENUM('on','off') NOT NULL,
    source       ENUM('ivr','web','schedule','admin') NOT NULL,
    schedule_id  BIGINT UNSIGNED NULL,
    schedule_execution_id BIGINT UNSIGNED NULL,
    call_id      BIGINT UNSIGNED NULL,
    status       ENUM('pending','sent','acked','failed') NOT NULL DEFAULT 'pending',
    fail_reason  VARCHAR(100) NULL,
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acked_at     DATETIME NULL,
    FOREIGN KEY (relay_id) REFERENCES relays(id),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id),
    FOREIGN KEY (call_id) REFERENCES call_logs(id),
    INDEX idx_status (status, requested_at),
    INDEX idx_sched_exec (schedule_execution_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE schedule_executions (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    schedule_id      BIGINT UNSIGNED NOT NULL,
    occurrence_utc   DATETIME NOT NULL,
    occurrence_local CHAR(25) NOT NULL,
    action        ENUM('on','off') NOT NULL,
    executed_by   ENUM('device','server_backup') NULL,
    status        ENUM('pending','executed','unverified_offline','failed') NOT NULL,
    command_id    BIGINT UNSIGNED NULL,
    reported_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_occurrence (schedule_id, occurrence_utc, action),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id),
    FOREIGN KEY (command_id) REFERENCES commands(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Second half of the circular commands ↔ schedule_executions pair (SPEC §1).
  // Both columns stay nullable BY DESIGN — never migrate to NOT NULL.
  `ALTER TABLE commands
    ADD CONSTRAINT fk_cmd_exec FOREIGN KEY (schedule_execution_id) REFERENCES schedule_executions(id)`,

  `CREATE TABLE device_events (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    device_id  BIGINT UNSIGNED NOT NULL,
    event      ENUM('online','offline','boot','ack','error') NOT NULL,
    payload    JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id),
    INDEX idx_dev_time (device_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE audit_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_id   BIGINT UNSIGNED NOT NULL,
    action     VARCHAR(50) NOT NULL,
    entity     VARCHAR(50) NOT NULL,
    entity_id  BIGINT UNSIGNED NULL,
    diff       JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admins(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE settings (
    setting_key   VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    description   VARCHAR(255) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE otp_codes (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone         VARCHAR(15) NOT NULL,
    purpose       ENUM('login','phone_add') NOT NULL,
    user_phone_id BIGINT UNSIGNED NULL,
    code_hash     CHAR(60) NOT NULL,
    expires_at    DATETIME NOT NULL,
    attempts      TINYINT NOT NULL DEFAULT 0,
    used_at       DATETIME NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_phone_id) REFERENCES user_phones(id) ON DELETE CASCADE,
    INDEX idx_lookup (phone, purpose, expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE auth_failures (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone      VARCHAR(15) NOT NULL,
    kind       ENUM('ivr_pin','web_otp') NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lockout (phone, kind, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// [D17] IVR prompt texts — hardcoded Hebrew defaults, editable in admin without redeploy.
const settingsSeed = [
  ['ivr.main_menu', 'שלום {name}. להדלקה מיידית הקש 1, לכיבוי מיידי הקש 2, לתזמון עתידי הקש 3, למצב נוכחי הקש 4', 'Main menu prompt; {name} = user full name'],
  ['ivr.pin_prompt', 'הקש קוד סודי בן 4 ספרות', 'PIN prompt for require_pin users'],
  ['ivr.user_code_prompt', 'הקש מספר משתמש בן 6 ספרות', 'Unknown caller: IVR user-code prompt'],
  ['ivr.auth_fail', 'הפרטים שגויים, נסה שוב', 'Generic auth failure (no hint which part was wrong)'],
  ['ivr.locked_out', 'החשבון נחסם זמנית עקב ניסיונות כושלים, נסה שוב בעוד רבע שעה', 'Lockout message'],
  ['ivr.relay_menu_item', 'ל{name} הקש {digit}', 'Dynamic relay-menu fragment'],
  ['ivr.no_relays', 'אין מכשירים מוגדרים בחשבון זה', 'Zero enabled relays'],
  ['ivr.cmd_ok', 'הפקודה בוצעה בהצלחה', 'Immediate command acked'],
  ['ivr.cmd_offline', 'אירעה שגיאה, המכשיר לא מחובר', 'Device offline / timeout'],
  ['ivr.sched_on_day', 'להדלקה, הקש יום בשבוע, 1 עד 7', 'Schedule flow: ON day'],
  ['ivr.sched_on_time', 'הקש שעת הדלקה, 4 ספרות', 'Schedule flow: ON time HHMM'],
  ['ivr.sched_off_day', 'לכיבוי, הקש יום בשבוע, 1 עד 7', 'Schedule flow: OFF day'],
  ['ivr.sched_off_time', 'הקש שעת כיבוי, 4 ספרות', 'Schedule flow: OFF time HHMM'],
  ['ivr.sched_confirm', 'להדלקת {relay} ביום {on_day} בשעה {on_time} וכיבוי ביום {off_day} בשעה {off_time}, הקש 1 לאישור, 2 לביטול', 'Schedule read-back'],
  ['ivr.sched_saved', 'התזמון נשמר בהצלחה', 'Schedule saved'],
  ['ivr.sched_invalid', 'התזמון אינו תקין, נסה שוב', 'Schedule validation failed'],
  ['ivr.status_item', '{name} {state}', 'Status readout fragment'],
  ['ivr.state_on', 'דולק', 'Relay state: on'],
  ['ivr.state_off', 'כבוי', 'Relay state: off'],
  ['ivr.state_unknown', 'מצב לא ידוע', 'Relay state: unknown'],
  ['ivr.invalid_input', 'בחירה לא תקינה', 'Invalid menu input'],
  ['ivr.goodbye', 'להתראות', 'Polite hangup'],
];

export async function migrate1(conn) {
  for (const stmt of ddl) await conn.query(stmt);
  for (const [k, v, d] of settingsSeed) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_key = setting_key',
      [k, v, d],
    );
  }
}

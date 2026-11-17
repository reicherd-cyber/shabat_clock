// Unified contact card (2026-11-17). Every unknown number that calls the line or
// sends a WhatsApp message becomes a lightweight CONTACT the moment it reaches us,
// so a card can gather everything about that person (calls, WhatsApp, support,
// orders) in one place and a second call simply accumulates on the same contact.
//
// A "contact" is a crm_leads row — the sales pipeline already IS a by-phone
// contact record outside the app's users table, so we extend it rather than add a
// parallel table. Registered app accounts keep their own home (users) and are NOT
// duplicated here; the card aggregates those by user_id + verified phones.
//
//   first_channel   — how we first heard from them ('phone' | 'whatsapp' | 'web')
//   last_contact_at — most recent inbound touch (ordering + "called again" recency)
//   auto_created    — 1 = opened automatically by an inbound call/message (triage),
//                     0 = a lead someone entered by hand
//
// callbacks = every outbound "call this contact back from the system" (a Yemot
// BRIDGE campaign that rings our agent and the customer and connects them, the
// customer seeing the Zimna caller-ID). One row per attempt, so the card shows
// who called whom, when, and whether Yemot accepted it.
export async function migrate97(conn) {
  await conn.query(`ALTER TABLE crm_leads
    ADD COLUMN first_channel   VARCHAR(20) NULL AFTER source,
    ADD COLUMN last_contact_at DATETIME    NULL AFTER follow_up,
    ADD COLUMN auto_created    TINYINT(1)  NOT NULL DEFAULT 0 AFTER first_channel`);

  await conn.query(`CREATE TABLE callbacks (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    lead_id     BIGINT UNSIGNED NULL,
    user_id     BIGINT UNSIGNED NULL,
    phone       VARCHAR(20) NOT NULL,              -- the customer number we dialed
    agent_phone VARCHAR(20) NULL,                  -- our side that was rung (the admin)
    caller_id   VARCHAR(20) NULL,                  -- what the customer saw on screen (Zimna)
    campaign_id VARCHAR(64) NULL,                  -- Yemot campaign id, for status lookups
    status      ENUM('queued','ok','failed') NOT NULL DEFAULT 'queued',
    detail      VARCHAR(500) NULL,                 -- Yemot response / error, for debugging
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by  VARCHAR(32) NULL,
    INDEX idx_phone (phone, id),
    INDEX idx_lead (lead_id, id),
    INDEX idx_user (user_id, id),
    CONSTRAINT fk_callback_lead FOREIGN KEY (lead_id) REFERENCES crm_leads(id),
    CONSTRAINT fk_callback_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
}

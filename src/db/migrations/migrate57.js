// Command verification by the channel meter (2026-10-08). The firmware's ack
// only means "accepted"; after every immediate command the channel is read
// back and what the meter saw is kept with the command and reported to whoever
// gave the order (phone, web, voice):
//   verify    — flow | off_ok | no_flow | stuck_on | not_switched | unmetered | unverified
//   verify_ma — current through the contact at verification time, milliamps
export async function migrate57(conn) {
  await conn.query(`ALTER TABLE commands
    ADD COLUMN verify VARCHAR(16) NULL AFTER fail_reason,
    ADD COLUMN verify_ma SMALLINT UNSIGNED NULL AFTER verify`);
}

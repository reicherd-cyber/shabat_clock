// Executes actions produced by services/nlu.js interpretCommand() — shared by
// the phone line (ivr/router.js) and the WhatsApp bot (whatsapp/bot.js). The
// interpreter already scoped every relay/schedule id to the user; this runs the
// same service calls the digit menu and the web use, and logs each one.
// Nothing here is called before the user confirmed (1 on the phone, the button
// on WhatsApp) [see D-remove-disable-confirm].
import { sendImmediateCommand } from './commands.js';
import { createSchedule, deleteSchedule, updateSchedule, setPlanEnabled } from './schedules.js';
import { logAction } from './audit.js';
import { localParts, shiftDate } from './time.js';

// today/tomorrow (device-local) → YYYY-MM-DD, for once-schedules created by voice/chat.
export function ymdForDay(day, tz) {
  const p = localParts(new Date(), tz || 'Asia/Jerusalem');
  const t = day === 'tomorrow' ? shiftDate({ y: p.y, mo: p.mo, d: p.d }, 1) : { y: p.y, mo: p.mo, d: p.d };
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}

// source: 'ivr' | 'whatsapp' — the commands.source / schedules.created_via /
// audit actor_type value, so history shows where the order came from.
// Returns the number of immediate actions the device did NOT acknowledge, so the
// caller can report honestly — schedules are just DB rows and can't fail this way.
export async function runNluActions({ userId, actions, tz, source, callId = null }) {
  const actor = { type: source, id: userId };
  const actorStamp = `${source}:${userId}`;
  // Immediate orders go out together: each one blocks ~2s on its meter
  // read-back (services/commands.js verifyCommand), and "כבה הכל" on a
  // 4-channel unit run serially would leave the caller in dead air.
  const immediate = [];
  for (const a of actions) {
    if (a.kind === 'immediate') {
      immediate.push(sendImmediateCommand({ relayId: a.relay_id, action: a.action, source, callId })
        .then(async (result) => {
          await logAction(actor, 'command', 'relay', a.relay_id, { after: { action: a.action, status: result.status, verify: result.verify, via: 'nlu' } });
          return { ...result, relay_name: a.relay_name, action: a.action };
        }));
    } else if (a.kind === 'recurring') {
      const fields = {
        on_day_of_week: a.on_day, on_time: a.on_time,
        off_day_of_week: a.off_day, off_time: a.off_time,
      };
      const created = await createSchedule({
        userId, actingUserId: userId, actor: actorStamp,
        relayId: a.relay_id, createdVia: source, repeat_type: 'weekly', ...fields,
      });
      await logAction(actor, 'create', 'schedule', created.id, { after: { relay_id: a.relay_id, ...fields, via: 'nlu' } });
    } else if (a.kind === 'delete_schedule') {
      // Soft delete (restorable) — same service the web app uses.
      await deleteSchedule({ userId, scheduleId: a.schedule_id, actor: actorStamp });
      await logAction(actor, 'delete', 'schedule', a.schedule_id, { after: { via: 'nlu' } });
    } else if (a.kind === 'plan_toggle') {
      // Stop/start a תוכנית = flip is_enabled on each member row — the same
      // per-row PATCH the web plan toggle issues (nothing deleted, restorable).
      const is_enabled = a.action === 'on';
      // Whole plan in one go for every real plan_id (user plans 'p…', demo
      // plans 'demo…'); only the loose single-row entries ('s<id>', nlu.js
      // planEntries) keep the per-row path.
      const via = source === 'whatsapp' ? 'whatsapp' : 'nlu';
      if (!/^s\d+$/.test(String(a.plan_key))) {
        const r = await setPlanEnabled({ userId, planId: String(a.plan_key), isEnabled: is_enabled, actor: actorStamp });
        await logAction(actor, 'plan_toggle', 'schedule', r.first_id, { plan_id: r.plan_id, name: r.name, members: r.members, relays: r.relays, before: r.before, after: r.after, via });
      } else for (const id of a.schedule_ids) {
        const changed = await updateSchedule({ userId, scheduleId: id, patch: { is_enabled }, actor: actorStamp });
        await logAction(actor, 'update', 'schedule', id, { before: changed.before, after: { ...changed.after, plan_key: a.plan_key, via } });
      }
    } else {
      const date = ymdForDay(a.day, tz);
      const fields = a.action === 'off'
        ? { off_time: a.time, off_date: date }
        : { on_time: a.time, on_date: date };
      const created = await createSchedule({
        userId, actingUserId: userId, actor: actorStamp,
        relayId: a.relay_id, createdVia: source, repeat_type: 'once', ...fields,
      });
      await logAction(actor, 'create', 'schedule', created.id, { after: { relay_id: a.relay_id, ...fields, via: 'nlu' } });
    }
  }
  const results = await Promise.all(immediate);
  const unacked = results.filter((x) => x.status !== 'acked').length;
  return { unacked, results };
}

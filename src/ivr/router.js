// §4 IVR webhook — single GET /ivr endpoint; the state machine per §4.1.
// Yemot is just the voice front-end; this IS the IVR logic.
import { Router } from 'express';
import { env } from '../config/env.js';
import { normalizePhone } from '../services/phone.js';
import { findUserByPhone, verifyPin } from '../services/users.js';
import { isLockedOut, recordFailure } from '../services/authFailures.js';
import { enabledRelaysForUser } from '../services/relays.js';
import { sendImmediateCommand } from '../services/commands.js';
import { createSchedule, validateScheduleRules } from '../services/schedules.js';
import { logAction } from '../services/audit.js';
import { startCall, setCallUser, appendPath, finishCall } from '../services/callLogs.js';
import { getText, getSetting } from '../services/settings.js';
import { getSession, createSession, endSession } from './session.js';
import { ask, askVoice, sayAndHangup } from './responses.js';
import { DAY_NAMES_HE } from '../config/constants.js';
import { interpretCommand } from '../services/nlu.js';
import { localParts, shiftDate } from '../services/time.js';

// today/tomorrow (device-local) → YYYY-MM-DD, for once-schedules created by voice.
function ymdForDay(day, tz) {
  const p = localParts(new Date(), tz || 'Asia/Jerusalem');
  const t = day === 'tomorrow' ? shiftDate({ y: p.y, mo: p.mo, d: p.d }, 1) : { y: p.y, mo: p.mo, d: p.d };
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}

// Execute the interpreted actions (relay ids already scoped to the user by the
// interpreter — this runs the same service calls as the digit menu / web).
// Returns the number of immediate actions the device did NOT acknowledge, so the
// caller can report honestly — schedules are just DB rows and can't fail this way.
async function runNluActions(session) {
  const tz = session.data.nluTz;
  let unacked = 0;
  for (const a of session.data.nluActions) {
    if (a.kind === 'immediate') {
      const result = await sendImmediateCommand({ relayId: a.relay_id, action: a.action, source: 'ivr', callId: session.callLogId });
      await logAction({ type: 'ivr', id: session.userId }, 'command', 'relay', a.relay_id, { after: { action: a.action, status: result.status, via: 'nlu' } });
      if (result.status !== 'acked') unacked += 1;
    } else {
      const date = ymdForDay(a.day, tz);
      const fields = a.action === 'off'
        ? { off_time: a.time, off_date: date }
        : { on_time: a.time, on_date: date };
      const created = await createSchedule({
        userId: session.userId, actingUserId: session.userId, actor: `ivr:${session.userId}`,
        relayId: a.relay_id, createdVia: 'ivr', repeat_type: 'once', ...fields,
      });
      await logAction({ type: 'ivr', id: session.userId }, 'create', 'schedule', created.id, { after: { relay_id: a.relay_id, ...fields, via: 'nlu' } });
    }
  }
  return unacked;
}

// Confirmation readback for voice commands, composed from neural-voice fragments
// with only the user data (relay name, HH:MM) as TTS — same juxtaposition trick
// as the status readout. Falls back to full TTS when recordings are absent.
async function nluConfirmItems(actions) {
  const items = [];
  for (const a of actions) {
    const verbKey = a.kind === 'timed' && a.time
      ? (a.action === 'on' ? 'ivr.nlu_on_at' : 'ivr.nlu_off_at')
      : (a.action === 'on' ? 'ivr.nlu_on_now' : 'ivr.nlu_off_now');
    const verbFallback = a.kind === 'timed' && a.time
      ? (a.action === 'on' ? 'הדלקה של' : 'כיבוי של')
      : (a.action === 'on' ? 'הדלקה מיידית של' : 'כיבוי מיידי של');
    items.push(...await speak(verbKey, {}, verbFallback));
    items.push({ t: `${a.relay_name},` });
    if (a.kind === 'timed' && a.time) {
      items.push(...await speak(a.day === 'tomorrow' ? 'ivr.nlu_tomorrow_at' : 'ivr.nlu_today_at', {},
        a.day === 'tomorrow' ? 'מחר בשעה' : 'היום בשעה'));
      items.push({ t: `${a.time},` });
    }
  }
  items.push(...await speak('ivr.nlu_confirm', {}, 'להקיש 1 לאישור, 2 לביטול'));
  return items;
}

export const ivrRouter = Router();

// Prompt as response items: the neural-voice recording when ivr.audio.<key> is set
// (see scripts/ivr-audio.mjs), else the editable TTS text. Delete the audio setting
// row after editing a text to make the change audible again.
async function speak(key, vars = {}, fallback = null) {
  const audio = await getSetting(key.replace(/^ivr\./, 'ivr.audio.'));
  if (audio) return [{ f: audio }];
  const text = await getText(key, vars);
  // getText echoes the key when no settings row exists — newer prompts ship only
  // as recordings + an inline fallback here, with no seeded text row.
  return [{ t: text === key && fallback ? fallback : text }];
}

async function mainMenu(session, message = null) {
  session.state = 'MAIN';
  session.invalidCount = 0;
  // The recording excludes the personal greeting — prepend it as TTS when known.
  const greeting = session.userName ? [{ t: `שלום ${session.userName},` }] : [];
  let items;
  if (env.anthropic.apiKey) {
    // Voice command is option 1; on/off/schedule/status shift to 2-5 — the digit map
    // below matches. main_menu_voice recording via scripts/ivr-audio.mjs.
    items = [...greeting, ...await speak('ivr.main_menu_voice', {},
      'לומר בקשה בקול, הקישו 1, להדלקת מכשיר, הקישו 2, לכיבוי מכשיר, הקישו 3, לתזמון, הקישו 4, לשמיעת מצב המכשירים, הקישו 5')];
  } else {
    const audio = await getSetting('ivr.audio.main_menu');
    items = audio
      ? [...greeting, { f: audio }]
      : [{ t: await getText('ivr.main_menu', { name: session.userName || '' }) }];
  }
  return ask(items, { message });
}

async function relayMenu(session, ctx) {
  const relays = await enabledRelaysForUser(session.userId);
  if (relays.length === 0) {
    await finishCall(session.callLogId, 'abandoned');
    endSession(session.callId);
    return sayAndHangup(await speak('ivr.no_relays'));
  }
  session.data.ctx = ctx;

  // [D18] exactly one enabled relay + immediate context → skip the menu.
  if (relays.length === 1 && (ctx === 'on' || ctx === 'off')) {
    return runImmediate(session, relays[0]);
  }

  session.state = 'RELAY_SELECT';
  const itemTpl = await getText('ivr.relay_menu_item');
  const prompt = relays
    .map((r) => itemTpl.replaceAll('{name}', r.name).replaceAll('{digit}', String(r.ivr_digit)))
    .join(', ');
  // Fixed-width entry (min===max), same pattern as the reliably-working main menu —
  // a variable min<max range left every real call stuck unanswered at this exact
  // step (confirmed via call_logs: every real call reaching RELAY_SELECT was
  // abandoned, min=1/max=2 never actually submitted on Yemot's real DTMF collection).
  // Width only grows to 2 digits once a relay actually needs it (digit ≥ 10).
  const width = Math.max(...relays.map((r) => r.ivr_digit)) >= 10 ? 2 : 1;
  return ask(prompt, { min: width, max: width });
}

async function runImmediate(session, relay) {
  const action = session.data.ctx;
  await appendPath(session.callLogId, `relay:${relay.ivr_digit}`);
  const result = await sendImmediateCommand({
    relayId: relay.id, action, source: 'ivr', callId: session.callLogId,
  });
  await logAction({ type: 'ivr', id: session.userId }, 'command', 'relay', relay.id, { after: { action, status: result.status } });
  await appendPath(session.callLogId, result.status === 'acked' ? 'ok' : `fail:${result.fail_reason}`);
  await finishCall(session.callLogId, 'command');
  // [D19] back to MAIN, not hangup — allow another action.
  const feedback = await speak(result.status === 'acked' ? 'ivr.cmd_ok' : 'ivr.cmd_offline');
  return mainMenu(session, feedback);
}

async function runStatus(session) {
  const relays = await enabledRelaysForUser(session.userId);
  if (relays.length === 0) {
    endSession(session.callId);
    return sayAndHangup(await speak('ivr.no_relays'));
  }
  // Relay names are user data (TTS); states are recorded fragments when available.
  // Juxtaposes name + state directly, superseding the ivr.status_item template.
  const stateItems = {
    on: await speak('ivr.state_on'),
    off: await speak('ivr.state_off'),
    unknown: await speak('ivr.state_unknown'),
  };
  const items = relays.flatMap((r) => [
    { t: `${r.name},` },
    ...(stateItems[r.current_state] || stateItems.unknown),
  ]);
  await appendPath(session.callLogId, 'status');
  await finishCall(session.callLogId, 'status');
  return mainMenu(session, items);
}

async function invalidInput(session) {
  session.invalidCount += 1;
  if (session.invalidCount >= 3) {
    await finishCall(session.callLogId, 'abandoned');
    endSession(session.callId);
    return sayAndHangup(await speak('ivr.goodbye'));
  }
  return ask(await speak('ivr.invalid_input'));
}

async function authFailed(session, phone) {
  await recordFailure(phone, 'ivr_pin');
  await appendPath(session.callLogId, 'auth_fail');
  if (await isLockedOut(phone, 'ivr_pin')) {
    await finishCall(session.callLogId, 'auth_fail');
    endSession(session.callId);
    return sayAndHangup(await speak('ivr.locked_out'));
  }
  session.invalidCount += 1;
  if (session.invalidCount >= 3) {
    await finishCall(session.callLogId, 'auth_fail');
    endSession(session.callId);
    return sayAndHangup(await speak('ivr.goodbye'));
  }
  // Generic failure — no hint which part was wrong.
  return ask(await speak('ivr.pin_prompt'), { min: 4, max: 4, message: await speak('ivr.auth_fail') });
}

// Token in the path (/ivr/<token>) — Yemot's api_link appends its params with '?'
// even when the URL already has a query string, which would mangle a ?token= query.
// The bare /ivr?token= form still works for manual testing.
ivrRouter.get(['/ivr', '/ivr/:token'], async (req, res, next) => {
  try {
    if ((req.params.token || req.query.token) !== env.ivrToken) {
      console.warn(`IVR: bad token from ${req.ip}`);
      return res.status(403).send('forbidden');
    }
    res.type('text/plain; charset=utf-8');

    const callId = String(req.query.ApiCallId || '');
    if (!callId) return res.send(sayAndHangup('שגיאה'));
    const phone = normalizePhone(req.query.ApiPhone);
    let session = getSession(callId);

    // Hangup notification → close the log honestly (§4.1.7).
    if (req.query.ApiHangup !== undefined || req.query.hangup === 'yes') {
      if (session) {
        await finishCall(session.callLogId, 'abandoned');
        endSession(callId);
      }
      return res.send('ok');
    }

    // ── Call arrives (no session) ──
    if (!session) {
      const callLogId = await startCall(callId, phone);
      if (await isLockedOut(phone, 'ivr_pin')) {
        await finishCall(callLogId, 'auth_fail');
        return res.send(sayAndHangup(await speak('ivr.locked_out')));
      }
      const user = await findUserByPhone(phone);
      // Suspended → treated as not found (no info leak).
      if (user && user.status === 'active') {
        session = createSession(callId, { callLogId, phone, userId: user.id, userName: user.full_name, requirePin: Boolean(user.require_pin) });
        await setCallUser(callLogId, user.id);
        if (user.require_pin) {
          session.state = 'AUTH_PIN';
          session.data.pinUser = user;
          await appendPath(callLogId, 'pin');
          return res.send(ask(await speak('ivr.pin_prompt'), { min: 4, max: 4 }));
        }
        await appendPath(callLogId, 'main');
        return res.send(await mainMenu(session));
      }
      // Unregistered (or suspended) caller-ID → polite refusal + hangup. There is
      // deliberately no code-entry fallback: users must call from a registered number.
      await appendPath(callLogId, 'unknown');
      await finishCall(callLogId, 'auth_fail');
      return res.send(sayAndHangup(await speak('ivr.unknown_caller')));
    }

    // Yemot re-sends every prior val= on the query string across the whole call rather
    // than just the newest one, so from the 2nd digit-collecting step onward this
    // arrives as an array (e.g. ["2","1"]) — take the last (current) entry, not the
    // whole array (String(array) joins with commas and never matches anything).
    const rawVal = req.query.val;
    const input = String(Array.isArray(rawVal) ? rawVal[rawVal.length - 1] : (rawVal ?? '')).trim();

    switch (session.state) {
      // ── auth: known caller with require_pin ──
      case 'AUTH_PIN': {
        const user = session.data.pinUser;
        if (!/^\d{4}$/.test(input) || !verifyPin(user, input)) {
          return res.send(await authFailed(session, session.phone));
        }
        await appendPath(session.callLogId, 'main');
        return res.send(await mainMenu(session));
      }

      // ── main menu ──
      case 'MAIN': {
        if (input === '0' || input === '*') return res.send(await mainMenu(session));
        if (env.anthropic.apiKey) {
          // Voice-command build: 1=voice, 2=on, 3=off, 4=schedule, 5=status.
          if (input === '1') {
            await appendPath(session.callLogId, 'nlu');
            session.state = 'NLU_LISTEN';
            session.data.nluRetries = 0;
            return res.send(askVoice(await speak('ivr.nlu_listen', {},
              'אמרו את הבקשה לאחר הצפצוף, למשל: כבה את הסלון בעוד חמש דקות')));
          }
          if (input === '2' || input === '3') {
            await appendPath(session.callLogId, input === '2' ? 'immediate_on' : 'immediate_off');
            return res.send(await relayMenu(session, input === '2' ? 'on' : 'off'));
          }
          if (input === '4') {
            await appendPath(session.callLogId, 'schedule');
            return res.send(await relayMenu(session, 'sched'));
          }
          if (input === '5') return res.send(await runStatus(session));
        } else {
          // Legacy build (no key): 1=on, 2=off, 3=schedule, 4=status.
          if (input === '1' || input === '2') {
            await appendPath(session.callLogId, input === '1' ? 'immediate_on' : 'immediate_off');
            return res.send(await relayMenu(session, input === '1' ? 'on' : 'off'));
          }
          if (input === '3') {
            await appendPath(session.callLogId, 'schedule');
            return res.send(await relayMenu(session, 'sched'));
          }
          if (input === '4') return res.send(await runStatus(session));
        }
        return res.send(await invalidInput(session));
      }

      // ── natural-language voice command: transcribe → interpret → confirm → run ──
      case 'NLU_LISTEN': {
        const rawNlu = req.query.nlu;
        const spoken = String(Array.isArray(rawNlu) ? rawNlu[rawNlu.length - 1] : (rawNlu ?? '')).trim();
        if (!spoken) return res.send(await invalidInput(session));
        let interp;
        try {
          interp = await interpretCommand({ userId: session.userId, text: spoken, phone: session.phone });
        } catch (e) {
          console.error('IVR NLU interpret error:', e);
          return res.send(await mainMenu(session, await speak('ivr.nlu_parse_error', {}, 'אירעה שגיאה בפירוש הבקשה, נסו שוב')));
        }
        if (!interp.understood) {
          await appendPath(session.callLogId, 'nlu_fail');
          // Re-listen right away (clarification as the prompt) instead of a main-menu
          // round-trip; after two misses fall back to the menu so nobody loops forever.
          session.data.nluRetries = (session.data.nluRetries || 0) + 1;
          if (session.data.nluRetries <= 2) {
            return res.send(askVoice([{ t: interp.clarification }]));
          }
          return res.send(await mainMenu(session, [{ t: interp.clarification }]));
        }
        session.data.nluActions = interp.actions;
        session.data.nluTz = interp.tz;
        session.state = 'NLU_CONFIRM';
        return res.send(ask(await nluConfirmItems(interp.actions)));
      }
      case 'NLU_CONFIRM': {
        if (input === '2') return res.send(await mainMenu(session));
        if (input !== '1') return res.send(await invalidInput(session));
        let unacked;
        try {
          unacked = await runNluActions(session);
        } catch (e) {
          console.error('IVR NLU execute error:', e);
          return res.send(await mainMenu(session, await speak('ivr.nlu_exec_error', {}, 'אירעה שגיאה בביצוע הבקשה')));
        }
        await appendPath(session.callLogId, unacked ? 'nlu_fail_exec' : 'nlu_done');
        await finishCall(session.callLogId, 'command');
        const feedback = unacked
          ? await speak('ivr.cmd_offline')
          : await speak('ivr.nlu_done', {}, 'הבקשה בוצעה');
        return res.send(await mainMenu(session, feedback));
      }

      // ── dynamic relay menu (immediate + schedule contexts) ──
      case 'RELAY_SELECT': {
        if (input === '*') return res.send(await mainMenu(session));
        const digit = Number(input);
        const relays = await enabledRelaysForUser(session.userId);
        const relay = relays.find((r) => r.ivr_digit === digit);
        if (!relay) return res.send(await invalidInput(session));
        if (session.data.ctx === 'sched') {
          session.data.relay = relay;
          session.state = 'SCHED_ON_DAY';
          await appendPath(session.callLogId, `relay:${digit}`);
          return res.send(ask(await speak('ivr.sched_on_day')));
        }
        return res.send(await runImmediate(session, relay));
      }

      // ── schedule flow 4.1 / 4.2 (weekly only in v1) ──
      case 'SCHED_ON_DAY': {
        if (!/^[1-7]$/.test(input)) return res.send(await invalidInput(session));
        session.data.on_day = Number(input);
        session.state = 'SCHED_ON_TIME';
        return res.send(ask(await speak('ivr.sched_on_time'), { min: 4, max: 4 }));
      }
      case 'SCHED_ON_TIME': {
        if (!/^([01]\d|2[0-3])[0-5]\d$/.test(input)) return res.send(await invalidInput(session));
        session.data.on_time = `${input.slice(0, 2)}:${input.slice(2)}`;
        session.state = 'SCHED_OFF_DAY';
        return res.send(ask(await speak('ivr.sched_off_day')));
      }
      case 'SCHED_OFF_DAY': {
        if (!/^[1-7]$/.test(input)) return res.send(await invalidInput(session));
        session.data.off_day = Number(input);
        session.state = 'SCHED_OFF_TIME';
        return res.send(ask(await speak('ivr.sched_off_time'), { min: 4, max: 4 }));
      }
      case 'SCHED_OFF_TIME': {
        if (!/^([01]\d|2[0-3])[0-5]\d$/.test(input)) return res.send(await invalidInput(session));
        session.data.off_time = `${input.slice(0, 2)}:${input.slice(2)}`;
        // Validate per §1.1 before the read-back.
        try {
          validateScheduleRules({
            repeat_type: 'weekly',
            on_day_of_week: session.data.on_day, on_time: session.data.on_time,
            off_day_of_week: session.data.off_day, off_time: session.data.off_time,
          });
        } catch {
          session.state = 'SCHED_ON_DAY';
          return res.send(ask(await speak('ivr.sched_on_day'), { message: await speak('ivr.sched_invalid') }));
        }
        session.state = 'SCHED_CONFIRM';
        const confirm = await getText('ivr.sched_confirm', {
          relay: session.data.relay.name,
          on_day: DAY_NAMES_HE[session.data.on_day], on_time: session.data.on_time,
          off_day: DAY_NAMES_HE[session.data.off_day], off_time: session.data.off_time,
        });
        return res.send(ask(confirm));
      }
      case 'SCHED_CONFIRM': {
        if (input === '2') return res.send(await mainMenu(session));
        if (input !== '1') return res.send(await invalidInput(session));
        try {
          const created = await createSchedule({
            userId: session.userId, actingUserId: session.userId, actor: `ivr:${session.userId}`,
            relayId: session.data.relay.id, createdVia: 'ivr',
            repeat_type: 'weekly',
            on_day_of_week: session.data.on_day, on_time: session.data.on_time,
            off_day_of_week: session.data.off_day, off_time: session.data.off_time,
          });
          await logAction({ type: 'ivr', id: session.userId }, 'create', 'schedule', created.id, {
            after: {
              relay_id: session.data.relay.id,
              on_day_of_week: session.data.on_day, on_time: session.data.on_time,
              off_day_of_week: session.data.off_day, off_time: session.data.off_time,
            },
          });
        } catch {
          session.state = 'SCHED_ON_DAY';
          return res.send(ask(await speak('ivr.sched_on_day'), { message: await speak('ivr.sched_invalid') }));
        }
        await appendPath(session.callLogId, 'sched_saved');
        await finishCall(session.callLogId, 'schedule');
        return res.send(await mainMenu(session, await speak('ivr.sched_saved')));
      }

      default:
        return res.send(await invalidInput(session));
    }
  } catch (e) {
    next(e);
  }
});

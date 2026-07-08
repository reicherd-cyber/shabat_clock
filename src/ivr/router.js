// §4 IVR webhook — single GET /ivr endpoint; the state machine per §4.1.
// Yemot is just the voice front-end; this IS the IVR logic.
import { Router } from 'express';
import { env } from '../config/env.js';
import { normalizePhone } from '../services/phone.js';
import { findUserByPhone, findUserByIvrCode, verifyPin } from '../services/users.js';
import { isLockedOut, recordFailure } from '../services/authFailures.js';
import { enabledRelaysForUser } from '../services/relays.js';
import { sendImmediateCommand } from '../services/commands.js';
import { createSchedule, validateScheduleRules } from '../services/schedules.js';
import { startCall, setCallUser, appendPath, finishCall } from '../services/callLogs.js';
import { getText } from '../services/settings.js';
import { getSession, createSession, endSession } from './session.js';
import { ask, sayAndHangup } from './responses.js';
import { DAY_NAMES_HE } from '../config/constants.js';

export const ivrRouter = Router();

async function mainMenu(session, message = null) {
  session.state = 'MAIN';
  session.invalidCount = 0;
  const text = await getText('ivr.main_menu', { name: session.userName || '' });
  return ask(text, { message });
}

async function relayMenu(session, ctx) {
  const relays = await enabledRelaysForUser(session.userId);
  if (relays.length === 0) {
    await finishCall(session.callLogId, 'abandoned');
    endSession(session.callId);
    return sayAndHangup(await getText('ivr.no_relays'));
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
  await appendPath(session.callLogId, result.status === 'acked' ? 'ok' : `fail:${result.fail_reason}`);
  await finishCall(session.callLogId, 'command');
  // [D19] back to MAIN, not hangup — allow another action.
  const feedback = await getText(result.status === 'acked' ? 'ivr.cmd_ok' : 'ivr.cmd_offline');
  return mainMenu(session, feedback);
}

async function runStatus(session) {
  const relays = await enabledRelaysForUser(session.userId);
  if (relays.length === 0) {
    endSession(session.callId);
    return sayAndHangup(await getText('ivr.no_relays'));
  }
  const stateText = {
    on: await getText('ivr.state_on'),
    off: await getText('ivr.state_off'),
    unknown: await getText('ivr.state_unknown'),
  };
  const itemTpl = await getText('ivr.status_item');
  const text = relays
    .map((r) => itemTpl.replaceAll('{name}', r.name).replaceAll('{state}', stateText[r.current_state] || stateText.unknown))
    .join(', ');
  await appendPath(session.callLogId, 'status');
  await finishCall(session.callLogId, 'status');
  return mainMenu(session, text);
}

async function invalidInput(session) {
  session.invalidCount += 1;
  if (session.invalidCount >= 3) {
    await finishCall(session.callLogId, 'abandoned');
    endSession(session.callId);
    return sayAndHangup(await getText('ivr.goodbye'));
  }
  return ask(await getText('ivr.invalid_input'));
}

async function authFailed(session, phone) {
  await recordFailure(phone, 'ivr_pin');
  await appendPath(session.callLogId, 'auth_fail');
  if (await isLockedOut(phone, 'ivr_pin')) {
    await finishCall(session.callLogId, 'auth_fail');
    endSession(session.callId);
    return sayAndHangup(await getText('ivr.locked_out'));
  }
  session.invalidCount += 1;
  if (session.invalidCount >= 3) {
    await finishCall(session.callLogId, 'auth_fail');
    endSession(session.callId);
    return sayAndHangup(await getText('ivr.goodbye'));
  }
  // Generic failure — no hint which part was wrong.
  if (session.state === 'AUTH_CODE_PIN') {
    session.state = 'AUTH_CODE';
    return ask(await getText('ivr.user_code_prompt'), { min: 6, max: 6, message: await getText('ivr.auth_fail') });
  }
  return ask(await getText('ivr.pin_prompt'), { min: 4, max: 4, message: await getText('ivr.auth_fail') });
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
        return res.send(sayAndHangup(await getText('ivr.locked_out')));
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
          return res.send(ask(await getText('ivr.pin_prompt'), { min: 4, max: 4 }));
        }
        await appendPath(callLogId, 'main');
        return res.send(await mainMenu(session));
      }
      session = createSession(callId, { callLogId, phone, userId: null });
      session.state = 'AUTH_CODE';
      await appendPath(callLogId, 'auth');
      return res.send(ask(await getText('ivr.user_code_prompt'), { min: 6, max: 6 }));
    }

    // Yemot re-sends every prior val= on the query string across the whole call rather
    // than just the newest one, so from the 2nd digit-collecting step onward this
    // arrives as an array (e.g. ["2","1"]) — take the last (current) entry, not the
    // whole array (String(array) joins with commas and never matches anything).
    const rawVal = req.query.val;
    const input = String(Array.isArray(rawVal) ? rawVal[rawVal.length - 1] : (rawVal ?? '')).trim();

    switch (session.state) {
      // ── auth: unknown caller — ivr_code then PIN, verified together ──
      case 'AUTH_CODE': {
        if (!/^\d{6}$/.test(input)) return res.send(await invalidInput(session));
        session.data.enteredCode = input;
        session.state = 'AUTH_CODE_PIN';
        return res.send(ask(await getText('ivr.pin_prompt'), { min: 4, max: 4 }));
      }
      case 'AUTH_CODE_PIN': {
        const user = await findUserByIvrCode(session.data.enteredCode);
        if (!user || user.status !== 'active' || !/^\d{4}$/.test(input) || !verifyPin(user, input)) {
          return res.send(await authFailed(session, session.phone));
        }
        session.userId = user.id;
        session.userName = user.full_name;
        await setCallUser(session.callLogId, user.id);
        await appendPath(session.callLogId, 'main');
        return res.send(await mainMenu(session));
      }
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
        if (input === '0') return res.send(await mainMenu(session));
        if (input === '*') return res.send(await mainMenu(session));
        if (input === '1' || input === '2') {
          await appendPath(session.callLogId, input === '1' ? 'immediate_on' : 'immediate_off');
          return res.send(await relayMenu(session, input === '1' ? 'on' : 'off'));
        }
        if (input === '3') {
          await appendPath(session.callLogId, 'schedule');
          return res.send(await relayMenu(session, 'sched'));
        }
        if (input === '4') return res.send(await runStatus(session));
        return res.send(await invalidInput(session));
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
          return res.send(ask(await getText('ivr.sched_on_day')));
        }
        return res.send(await runImmediate(session, relay));
      }

      // ── schedule flow 4.1 / 4.2 (weekly only in v1) ──
      case 'SCHED_ON_DAY': {
        if (!/^[1-7]$/.test(input)) return res.send(await invalidInput(session));
        session.data.on_day = Number(input);
        session.state = 'SCHED_ON_TIME';
        return res.send(ask(await getText('ivr.sched_on_time'), { min: 4, max: 4 }));
      }
      case 'SCHED_ON_TIME': {
        if (!/^([01]\d|2[0-3])[0-5]\d$/.test(input)) return res.send(await invalidInput(session));
        session.data.on_time = `${input.slice(0, 2)}:${input.slice(2)}`;
        session.state = 'SCHED_OFF_DAY';
        return res.send(ask(await getText('ivr.sched_off_day')));
      }
      case 'SCHED_OFF_DAY': {
        if (!/^[1-7]$/.test(input)) return res.send(await invalidInput(session));
        session.data.off_day = Number(input);
        session.state = 'SCHED_OFF_TIME';
        return res.send(ask(await getText('ivr.sched_off_time'), { min: 4, max: 4 }));
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
          return res.send(ask(await getText('ivr.sched_on_day'), { message: await getText('ivr.sched_invalid') }));
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
          await createSchedule({
            userId: session.userId, actingUserId: session.userId,
            relayId: session.data.relay.id, createdVia: 'ivr',
            repeat_type: 'weekly',
            on_day_of_week: session.data.on_day, on_time: session.data.on_time,
            off_day_of_week: session.data.off_day, off_time: session.data.off_time,
          });
        } catch {
          session.state = 'SCHED_ON_DAY';
          return res.send(ask(await getText('ivr.sched_on_day'), { message: await getText('ivr.sched_invalid') }));
        }
        await appendPath(session.callLogId, 'sched_saved');
        await finishCall(session.callLogId, 'schedule');
        return res.send(await mainMenu(session, await getText('ivr.sched_saved')));
      }

      default:
        return res.send(await invalidInput(session));
    }
  } catch (e) {
    next(e);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fwUpdateBlocker, WINDOW, MIN_UPTIME_S, RETRY_AFTER_MS, REFUSE_BACKOFF_MS, BLOCKER_HE } from '../src/monitor/fw-update.js';
import { localParts } from '../src/services/time.js';
import { dayKeysOn } from '../src/services/holidays.js';

const TZ = 'Asia/Jerusalem';
// Tuesday 2026-10-27 03:00 IL (IST, UTC+2 after the Oct 25 DST end) — an ordinary night.
const weekdayNight = Date.UTC(2026, 9, 27, 1, 0);
const green = { now: weekdayNight, offered: '2.1.0', current: '1.6.0', uptime_s: 86400 };

test('an ordinary weekday night inside the window with an update offered is green', () => {
  assert.equal(localParts(new Date(weekdayNight), TZ).hh, 3);
  assert.equal(fwUpdateBlocker(green), null);
});

test('nothing offered, or the offered version already running, is no_update — before any clock check', () => {
  assert.equal(fwUpdateBlocker({ ...green, offered: null }), 'no_update');
  assert.equal(fwUpdateBlocker({ ...green, offered: '1.6.0' }), 'no_update');
  assert.equal(fwUpdateBlocker({ ...green, offered: null, now: Date.UTC(2026, 9, 27, 12) }), 'no_update');
});

test('the kill switch wins over everything', () => {
  assert.equal(fwUpdateBlocker({ ...green, enabled: false }), 'disabled');
});

test('outside the nightly window nothing moves (daytime, and the minute before/after the edges)', () => {
  assert.equal(fwUpdateBlocker({ ...green, now: Date.UTC(2026, 9, 27, 12) }), 'outside_window'); // 14:00 IL
  const dayStart = Date.UTC(2026, 9, 26, 22); // 2026-10-27 00:00 IL
  assert.equal(fwUpdateBlocker({ ...green, now: dayStart + (WINDOW.fromH * 60 - 1) * 60_000 }), 'outside_window');
  assert.equal(fwUpdateBlocker({ ...green, now: dayStart + WINDOW.fromH * 3600_000 }), null);
  assert.equal(fwUpdateBlocker({ ...green, now: dayStart + (WINDOW.toH * 60 - 1) * 60_000 }), null);
  assert.equal(fwUpdateBlocker({ ...green, now: dayStart + WINDOW.toH * 3600_000 }), 'outside_window');
});

test('שבת night is a rest day even inside the window; Friday night (Thursday→Friday) is fine', () => {
  // Saturday 2026-10-24 03:00 IL = 00:00Z (still IDT, UTC+3)
  assert.equal(fwUpdateBlocker({ ...green, now: Date.UTC(2026, 9, 24, 0, 0) }), 'rest_day');
  // Friday 2026-10-23 03:00 IL
  assert.equal(fwUpdateBlocker({ ...green, now: Date.UTC(2026, 9, 23, 0, 0) }), null);
});

test('a יום טוב that falls on a weekday is a rest day too', () => {
  // Find the first weekday holiday after 2026-11-01 from the calendar itself —
  // whatever hebcal says, the blocker must agree with it.
  let d = Date.UTC(2026, 10, 1, 1, 0); // 03:00 IL
  for (let i = 0; i < 400; i++, d += 86400_000) {
    const p = localParts(new Date(d), TZ);
    if (p.dow !== 7 && dayKeysOn(p).length) break;
  }
  const p = localParts(new Date(d), TZ);
  assert.notEqual(p.dow, 7);
  assert.ok(dayKeysOn(p).length, 'found a weekday holiday');
  assert.equal(fwUpdateBlocker({ ...green, now: d }), 'rest_day');
});

test('a unit expecting a reboot, freshly booted, recently tried, or sharing the night with another update waits', () => {
  assert.equal(fwUpdateBlocker({ ...green, expectReboot: true }), 'reboot_pending');
  assert.equal(fwUpdateBlocker({ ...green, uptime_s: MIN_UPTIME_S - 1 }), 'just_booted');
  assert.equal(fwUpdateBlocker({ ...green, uptime_s: MIN_UPTIME_S }), null);
  assert.equal(fwUpdateBlocker({ ...green, lastAttemptAt: weekdayNight - RETRY_AFTER_MS + 60_000 }), 'recent_attempt');
  assert.equal(fwUpdateBlocker({ ...green, lastAttemptAt: weekdayNight - RETRY_AFTER_MS - 60_000 }), null);
  assert.equal(fwUpdateBlocker({ ...green, inflight: true }), 'another_in_progress');
});

test('a refused Shelly.Update backs off an hour, not a day', () => {
  assert.equal(fwUpdateBlocker({ ...green, refusedAt: weekdayNight - REFUSE_BACKOFF_MS + 60_000 }), 'refused_recently');
  assert.equal(fwUpdateBlocker({ ...green, refusedAt: weekdayNight - REFUSE_BACKOFF_MS - 60_000 }), null);
});

test('a schedule due on one of the channels in the next minutes postpones the install', () => {
  assert.equal(fwUpdateBlocker({ ...green, dueSoon: true }), 'schedule_due');
});

test('every blocker has Hebrew for the admin page', () => {
  for (const why of ['disabled', 'no_update', 'outside_window', 'rest_day', 'reboot_pending', 'just_booted', 'recent_attempt', 'refused_recently', 'another_in_progress', 'schedule_due']) {
    assert.ok(BLOCKER_HE[why], why);
  }
});

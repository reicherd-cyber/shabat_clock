// §3.2 GET /history — merged commands + call_logs, cursor fully pinned:
// total order (ts DESC, type ASC, id DESC); type 'call' < 'cmd' by byte order;
// ts fixed per type (requested_at / started_at — never the mutating ack/end time).
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';

export function encodeCursor(c) {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(s) {
  try {
    const c = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (typeof c.ts !== 'string' || !['call', 'cmd'].includes(c.type) || !Number.isFinite(Number(c.id))) throw new Error();
    return c;
  } catch {
    throw errors.validation('Bad cursor', { cursor: 'invalid' });
  }
}

export function compareItems(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;       // ts DESC
  if (a.type !== b.type) return a.type < b.type ? -1 : 1; // type ASC ('call' < 'cmd')
  return Number(b.id) - Number(a.id);                     // id DESC
}

const tsIso = (d) => (d instanceof Date ? d.toISOString() : String(d));

// Admin variant: all users, every field filterable. Same pinned total order and
// cursor as getHistory. A command-only filter (source/action/status/device) silently
// narrows to commands; a call-only filter (outcome/phone) narrows to calls — mixing
// the two kinds yields the empty intersection the filters describe.
export async function getAdminHistory(f = {}) {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
  const c = f.cursor ? decodeCursor(f.cursor) : null;

  const cmdCond = [];
  const cmdParams = [];
  const callCond = [];
  const callParams = [];
  if (f.user_id) {
    cmdCond.push('r.user_id = ?'); cmdParams.push(Number(f.user_id));
    callCond.push('cl.user_id = ?'); callParams.push(Number(f.user_id));
  }
  if (f.from) {
    cmdCond.push('c.requested_at >= ?'); cmdParams.push(f.from);
    callCond.push('cl.started_at >= ?'); callParams.push(f.from);
  }
  if (f.to) {
    cmdCond.push('c.requested_at <= ?'); cmdParams.push(f.to);
    callCond.push('cl.started_at <= ?'); callParams.push(f.to);
  }
  if (f.device_id) { cmdCond.push('r.device_id = ?'); cmdParams.push(Number(f.device_id)); }
  if (f.source) { cmdCond.push('c.source = ?'); cmdParams.push(f.source); }
  if (f.action) { cmdCond.push('c.action = ?'); cmdParams.push(f.action); }
  if (f.status) { cmdCond.push('c.status = ?'); cmdParams.push(f.status); }
  if (f.outcome) { callCond.push('cl.outcome = ?'); callParams.push(f.outcome); }
  if (f.phone) {
    const digits = String(f.phone).replace(/\D/g, '');
    if (digits) { callCond.push('cl.phone LIKE ?'); callParams.push(`%${digits}%`); }
  }

  let wantCmds = !f.type || f.type === 'cmd';
  let wantCalls = !f.type || f.type === 'call';
  if (f.device_id || f.source || f.action || f.status) wantCalls = false;
  if (f.outcome || f.phone) wantCmds = false;

  if (c) {
    const cts = new Date(c.ts);
    if (c.type === 'call') {
      callCond.push('(cl.started_at < ? OR (cl.started_at = ? AND cl.id < ?))');
      callParams.push(cts, cts, c.id);
      cmdCond.push('c.requested_at <= ?');
      cmdParams.push(cts);
    } else {
      cmdCond.push('(c.requested_at < ? OR (c.requested_at = ? AND c.id < ?))');
      cmdParams.push(cts, cts, c.id);
      callCond.push('cl.started_at < ?');
      callParams.push(cts);
    }
  }

  const cmds = !wantCmds ? [] : await query(
    `SELECT c.id, c.action, c.source, c.status, c.fail_reason, c.requested_at,
            r.name AS relay_name, d.name AS device_name, r.user_id, u.full_name AS owner_name
     FROM commands c
     JOIN relays r ON r.id = c.relay_id
     JOIN devices d ON d.id = r.device_id
     JOIN users u ON u.id = r.user_id
     ${cmdCond.length ? 'WHERE ' + cmdCond.join(' AND ') : ''}
     ORDER BY c.requested_at DESC, c.id DESC LIMIT ?`,
    [...cmdParams, limit + 1],
  );
  const calls = !wantCalls ? [] : await query(
    `SELECT cl.id, cl.phone, cl.menu_path, cl.outcome, cl.started_at, cl.ended_at,
            cl.user_id, u.full_name AS owner_name
     FROM call_logs cl
     LEFT JOIN users u ON u.id = cl.user_id
     ${callCond.length ? 'WHERE ' + callCond.join(' AND ') : ''}
     ORDER BY cl.started_at DESC, cl.id DESC LIMIT ?`,
    [...callParams, limit + 1],
  );

  const items = [
    ...cmds.map((r) => ({ type: 'cmd', id: Number(r.id), ts: tsIso(r.requested_at), data: r })),
    ...calls.map((r) => ({ type: 'call', id: Number(r.id), ts: tsIso(r.started_at), data: r })),
  ].sort(compareItems);

  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const last = page[page.length - 1];
  return {
    items: page,
    next_cursor: hasMore && last ? encodeCursor({ ts: last.ts, type: last.type, id: last.id }) : null,
  };
}

export async function getHistory({ userId, limit = 50, cursor = null }) {
  limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const c = cursor ? decodeCursor(cursor) : null;

  // Per-type predicates derived from the pinned total order.
  let cmdWhere = '';
  let callWhere = '';
  const cmdParams = [userId];
  const callParams = [userId];
  if (c) {
    const cts = new Date(c.ts);
    if (c.type === 'call') {
      callWhere = 'AND (cl.started_at < ? OR (cl.started_at = ? AND cl.id < ?))';
      callParams.push(cts, cts, c.id);
      cmdWhere = 'AND c.requested_at <= ?'; // cmds at equal ts come after 'call'
      cmdParams.push(cts);
    } else {
      cmdWhere = 'AND (c.requested_at < ? OR (c.requested_at = ? AND c.id < ?))';
      cmdParams.push(cts, cts, c.id);
      callWhere = 'AND cl.started_at < ?'; // calls at equal ts were already emitted
      callParams.push(cts);
    }
  }

  const cmds = await query(
    `SELECT c.id, c.action, c.source, c.status, c.fail_reason, c.requested_at, r.name AS relay_name
     FROM commands c JOIN relays r ON r.id = c.relay_id
     WHERE r.user_id = ? ${cmdWhere}
     ORDER BY c.requested_at DESC, c.id DESC LIMIT ?`,
    [...cmdParams, limit + 1],
  );
  const calls = await query(
    `SELECT cl.id, cl.phone, cl.menu_path, cl.outcome, cl.started_at, cl.ended_at
     FROM call_logs cl WHERE cl.user_id = ? ${callWhere}
     ORDER BY cl.started_at DESC, cl.id DESC LIMIT ?`,
    [...callParams, limit + 1],
  );

  const items = [
    ...cmds.map((r) => ({ type: 'cmd', id: Number(r.id), ts: tsIso(r.requested_at), data: r })),
    ...calls.map((r) => ({ type: 'call', id: Number(r.id), ts: tsIso(r.started_at), data: r })),
  ].sort(compareItems);

  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const last = page[page.length - 1];
  return {
    items: page,
    next_cursor: hasMore && last ? encodeCursor({ ts: last.ts, type: last.type, id: last.id }) : null,
  };
}

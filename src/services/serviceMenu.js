// מוקד שירות — the numbered-menu engine (2026-10-22). User decision: every
// path of customer service is a menu ("הזמנה לחצו 1, שירות לחצו 2…") and every
// question is answered with a number; free text only where a digit cannot
// carry the answer (a name, an address, a description) and only inside the
// הזמנה and שירות לקוחות branches — nothing in the menu ever calls a model
// (every free question costs money; user decision 2026-10-22). One engine, every
// channel: the WhatsApp bot and the site's "פניות" page drive it with the
// same state object; the phone tree follows.
//
// State = { node, data, trail } — serialisable, channel-agnostic. step() takes
// the customer's input (a digit or free text) and returns the next reply:
//   { text, options:[{n,label}], free:boolean, done:boolean, state }
// Navigation everywhere: 9 = main menu. 0 on the main menu = a person.
// Side effects (tickets, leads, device checks, the support bot) go through
// `io`, injected by the caller — the pure tree is unit-tested with a fake io.
import { query } from '../db/pool.js';
import { getSetting } from './settings.js';
import { diagnoseDevice } from './device-diagnosis.js';
import { logAction } from './audit.js';

export const MENU_MAIN = '9';
const BACK = { n: 9, label: 'תפריט ראשי' };

const CHANNEL_OPTIONS = [
  { n: 1, label: 'ערוץ אחד', value: 1 }, { n: 2, label: 'שני ערוצים', value: 2 },
  { n: 3, label: 'שלושה ערוצים', value: 3 }, { n: 4, label: 'ארבעה ערוצים ויותר', value: 4 },
];
const TIME_OPTIONS = [
  { n: 1, label: 'בוקר', value: 'בוקר' }, { n: 2, label: 'צהריים', value: 'צהריים' }, { n: 3, label: 'ערב', value: 'ערב' },
];
const INFO_TOPICS = [
  { n: 1, key: 'prices', label: 'מחירים' },
  { n: 2, key: 'how', label: 'איך זה עובד' },
  { n: 3, key: 'install', label: 'התקנה' },
  { n: 4, key: 'hours', label: 'שעות פעילות ואזורי שירות' },
  { n: 5, key: 'halacha', label: 'הלכה' },
];
const SCHEDULE_PROBLEMS = [
  { n: 1, label: 'לא נדלק', value: 'לא נדלק' }, { n: 2, label: 'לא כבה', value: 'לא כבה' }, { n: 3, label: 'פעל בשעה לא נכונה', value: 'שעה לא נכונה' },
];
// The callback promise (user, 2026-10-22): within 3 hours inside 9:00–18:00, else the next working day.
const CALLBACK_HE = 'תוך 3 שעות בשעות הפעילות (9:00–18:00), או ביום העבודה הבא';
const HELPED = [{ n: 1, label: 'עזר, תודה' }, { n: 2, label: 'לא עזר' }];

// ── io: everything that touches the world ─────────────────────────────
export const realIo = {
  async devices(userId) {
    return query(
      `SELECT id, name, is_online, last_seen_at FROM devices
        WHERE user_id = ? AND is_enabled = TRUE AND returned_to_stock_at IS NULL AND device_type <> 'demo' ORDER BY id`, [userId]);
  },
  async relays(userId) {
    return query(
      `SELECT r.id, r.name, r.ivr_digit, r.current_state, d.name AS device_name, d.id AS device_id
         FROM relays r JOIN devices d ON d.id = r.device_id
        WHERE r.user_id = ? AND r.is_enabled = TRUE AND r.deleted_at IS NULL AND d.is_enabled = TRUE
        ORDER BY r.sort_order, r.ivr_digit`, [userId]);
  },
  async deviceOnline(deviceId) {
    const [d] = await query('SELECT is_online FROM devices WHERE id = ?', [deviceId]);
    return Boolean(d?.is_online);
  },
  diagnose: (deviceId) => diagnoseDevice(deviceId).catch(() => null),
  infoText: (key) => getSetting(`menu.info.${key}`, ''),
  async ticket({ ctx, topic, body, details }) {
    const r = await query(
      `INSERT INTO support_messages (user_id, source, phone, topic, body, transcript, created_by) VALUES (?,?,?,?,?,?,?)`,
      [ctx.user?.id ?? null, ctx.source === 'whatsapp' ? 'whatsapp' : 'web', ctx.phone ?? null, topic, body,
        details ? JSON.stringify(details) : null, ctx.actor],
    );
    await logAction(ctx.actorObj, 'create', 'support_message', r.insertId, { after: { source: ctx.source, topic, via: 'menu' } }).catch(() => {});
    return r.insertId;
  },
  async lead({ ctx, name, city, channels, when }) {
    const notes = `מהתפריט (${ctx.source === 'whatsapp' ? 'וואטסאפ' : 'אתר'}): ${channels === 4 ? '4+' : channels} ערוצים, מועד נוח: ${when}`;
    const r = await query(
      'INSERT INTO crm_leads (name, phone, city, source, status, user_id, notes, created_by) VALUES (?,?,?,?,?,?,?,?)',
      [name, ctx.phone ?? null, city || null, `bot_${ctx.source}`, 'new', ctx.user?.id ?? null, notes, ctx.actor],
    );
    await logAction(ctx.actorObj, 'create', 'crm_lead', r.insertId, { after: { name, via: 'menu' } }).catch(() => {});
    return r.insertId;
  },
  async orders({ ctx }) {
    if (!ctx.phone && !ctx.user) return [];
    return query(
      `SELECT o.id, o.description, o.status, o.created_at FROM crm_orders o JOIN crm_leads l ON l.id = o.lead_id
        WHERE o.deleted_at IS NULL AND l.deleted_at IS NULL AND (l.phone = ? OR l.user_id = ?)
        ORDER BY o.id DESC LIMIT 5`, [ctx.phone ?? '', ctx.user?.id ?? 0]);
  },
};

// ── helpers ───────────────────────────────────────────────────────────
const firstName = (user) => String(user?.full_name || '').trim().split(/\s+/)[0] || '';
// `rest` carries channel instructions (action: an order to execute / a status request).
const reply = (state, text, { options = [], free = false, done = false, ...rest } = {}) => ({ text, options, free, done, state, ...rest });
const digit = (input) => { const m = /^\s*(\d{1,2})\s*$/.exec(String(input ?? '')); return m ? Number(m[1]) : null; };
const withBack = (options) => [...options, BACK];
const ORDER_STATUS_HE = { open: 'בטיפול — ההזמנה נקלטה ואנחנו עובדים עליה', delivered: 'סופקה', cancelled: 'בוטלה' };

function mainMenu(ctx) {
  const options = [
    { n: 1, label: 'הזמנה / מכירה' },
    { n: 2, label: 'שירות לקוחות' },
    { n: 3, label: 'מידע כללי' },
  ];
  if (ctx.user) options.push({ n: 4, label: 'הדלקה / כיבוי של ערוץ' }, { n: 5, label: 'מצב הערוצים' });
  options.push({ n: 0, label: 'נציג אנושי' });
  const hello = ctx.user ? `שלום ${firstName(ctx.user)}, ` : 'שלום, ';
  return { text: `${hello}כאן מוקד השירות של TelTech. במה נוכל לעזור?`, options };
}

export function menuStart(ctx) {
  const { text, options } = mainMenu(ctx);
  return reply({ node: 'main', data: {} }, text, { options });
}

const notUnderstood = (r) => ({ ...r, text: `לא הבנתי. בחרו מספר מהרשימה:\n${r.text}` });

// Re-render the current node without input (after an invalid answer).
async function render(ctx, state, io) {
  return step(ctx, { ...state, _render: true }, null, io);
}

// The one entry point. Returns the next reply; `state` inside it is what the
// channel must persist and hand back with the customer's next message.
export async function step(ctx, state, input, io = realIo) {
  const s = { node: state?.node || 'main', data: { ...(state?.data || {}) } };
  const rendering = state?._render === true;
  const d = rendering ? null : digit(input);
  const text = rendering ? '' : String(input ?? '').trim();

  // 9 = main menu from anywhere (except while the main menu itself is shown).
  if (!rendering && d === 9 && s.node !== 'main') return menuStart(ctx);

  switch (s.node) {
    case 'main': {
      if (rendering) return menuStart(ctx);
      if (d === 1) { s.node = 'order_channels'; return render(ctx, s, io); }
      if (d === 2) { s.node = ctx.user ? 'service' : 'service_unknown'; return render(ctx, s, io); }
      if (d === 3) { s.node = 'info'; return render(ctx, s, io); }
      if (d === 4 && ctx.user) { s.node = 'switch_relay'; return render(ctx, s, io); }
      if (d === 5 && ctx.user) { s.node = 'status'; return render(ctx, s, io); }
      if (d === 0) { s.node = 'agent'; return render(ctx, s, io); }
      return notUnderstood(menuStart(ctx));
    }

    // ── 1 הזמנה / מכירה ──
    case 'order_channels': {
      if (rendering) return reply(s, 'כמה ערוצים (שקעים/קווים) תרצו לשלוט בהם?', { options: withBack(CHANNEL_OPTIONS) });
      const o = CHANNEL_OPTIONS.find((x) => x.n === d);
      if (!o) return notUnderstood(await render(ctx, s, io));
      s.data.channels = o.value; s.node = 'order_time';
      return render(ctx, s, io);
    }
    case 'order_time': {
      if (rendering) {
        // "900,1200,1500,1800|1600,2000,2400,2800" = without | with installation, by channel count (settings, incl. VAT)
        const table = String(await io.infoText('price_table') || '').split('|').map((row) => row.split(',').map((v) => Number(v.trim()) || 0));
        const i = Math.min(Number(s.data.channels) || 1, 4) - 1;
        const no = table[0]?.[i], yes = table[1]?.[i];
        const price = no && yes
          ? `מחיר ל-${s.data.channels} ערוצים: ${no.toLocaleString('en-US')} ₪ ללא התקנה / ${yes.toLocaleString('en-US')} ₪ עם התקנה (כולל מע"מ).

`
          : '';
        return reply(s, `${price}מתי נוח לכם שנתקשר לתאם התקנה?`, { options: withBack(TIME_OPTIONS) });
      }
      const o = TIME_OPTIONS.find((x) => x.n === d);
      if (!o) return notUnderstood(await render(ctx, s, io));
      s.data.when = o.value;
      if (ctx.user?.full_name) { s.data.name = ctx.user.full_name; s.node = 'order_city'; } else s.node = 'order_name';
      return render(ctx, s, io);
    }
    case 'order_name': {
      if (rendering) return reply(s, 'מה שמכם המלא?', { free: true });
      if (text.length < 2 || d !== null) return reply(s, 'כתבו בבקשה שם מלא (לפחות 2 תווים).', { free: true });
      s.data.name = text.slice(0, 100); s.node = 'order_city';
      return render(ctx, s, io);
    }
    case 'order_city': {
      if (rendering) return reply(s, 'באיזה יישוב ההתקנה?', { free: true });
      if (text.length < 2 || d !== null) return reply(s, 'כתבו בבקשה את שם היישוב.', { free: true });
      s.data.city = text.slice(0, 60);
      const id = await io.lead({ ctx, name: s.data.name, city: s.data.city, channels: s.data.channels, when: s.data.when });
      return reply({ node: 'main', data: {} },
        `תודה ${s.data.name.split(' ')[0]}! הבקשה נרשמה (מס׳ ${id}). נציג מכירות יחזור אליכם ב${s.data.when} לתיאום ההתקנה.`,
        { options: [BACK], done: true });
    }

    // ── 2 שירות לקוחות ──
    case 'service_unknown': {
      if (rendering) return reply(s, 'המספר שממנו פניתם אינו רשום אצלנו. כתבו בבקשה את מספר הטלפון הרשום בחשבון ואת הבעיה בקצרה, ונציג יחזור אליכם.', { free: true });
      if (text.length < 4) return reply(s, 'כתבו בבקשה את מספר הטלפון הרשום והבעיה בקצרה.', { free: true });
      const id = await io.ticket({ ctx, topic: 'service_other', body: text.slice(0, 2000) });
      return reply({ node: 'main', data: {} }, `הפנייה נרשמה (מס׳ ${id}). נציג יחזור אליכם ${CALLBACK_HE}.`, { options: [BACK], done: true });
    }
    case 'service': {
      const options = withBack([
        { n: 1, label: 'המכשיר לא מגיב / מנותק' },
        { n: 2, label: 'תזמון לא פעל' },
        { n: 3, label: 'איפה ההזמנה שלי' },
        { n: 4, label: 'משהו אחר' },
        { n: 5, label: 'בקשה או הצעה לשיפור' },
      ]);
      if (rendering) return reply(s, 'שירות לקוחות — מה הבעיה?', { options });
      if (d === 1) { s.node = 'fault_device'; return render(ctx, s, io); }
      if (d === 2) { s.node = 'sched_problem'; return render(ctx, s, io); }
      if (d === 3) { s.node = 'order_status'; return render(ctx, s, io); }
      if (d === 4) { s.node = 'service_other'; return render(ctx, s, io); }
      if (d === 5) { s.node = 'feature'; return render(ctx, s, io); }
      return notUnderstood(await render(ctx, s, io));
    }
    case 'fault_device': {
      const devices = await io.devices(ctx.user.id);
      if (!devices.length) {
        return reply({ node: 'main', data: {} }, 'לחשבון שלכם אין עדיין מכשיר רשום. לחצו 0 לנציג.', { options: [{ n: 0, label: 'נציג אנושי' }, BACK] });
      }
      if (devices.length === 1) { s.data.device = { id: devices[0].id, name: devices[0].name }; s.node = 'fault_check'; return render(ctx, s, io); }
      const options = withBack(devices.map((x, i) => ({ n: i + 1, label: x.name })));
      if (rendering) return reply(s, 'על איזה מכשיר מדובר?', { options });
      const pick = devices[d - 1];
      if (!pick || d < 1) return notUnderstood(await render(ctx, s, io));
      s.data.device = { id: pick.id, name: pick.name }; s.node = 'fault_check';
      return render(ctx, s, io);
    }
    case 'fault_check': {
      // Live check first — a unit that answers needs no steps.
      const online = await io.deviceOnline(s.data.device.id);
      if (online) {
        s.node = 'fault_online_helped';
        return reply(s, `המכשיר "${s.data.device.name}" מחובר אלינו כרגע ומגיב ✅. אם ערוץ מסוים לא פועל, נסו להדליק ולכבות אותו מהמסך הראשי.\nזה עזר?`, { options: withBack(HELPED) });
      }
      s.data.step = 0; s.node = 'fault_steps';
      return render(ctx, s, io);
    }
    case 'fault_online_helped': {
      if (rendering) return reply(s, 'זה עזר?', { options: withBack(HELPED) });
      if (d === 1) return reply({ node: 'main', data: {} }, 'מצוין, שמחים לעזור!', { options: [BACK], done: true });
      if (d === 2) { s.node = 'service_other'; return render(ctx, s, io); }
      return notUnderstood(await render(ctx, s, io));
    }
    case 'fault_steps': {
      const STEPS = [
        'בדקו שהמכשיר מחובר לחשמל ושיש מתח בשקע (נסו מכשיר אחר באותו שקע).',
        'בדקו שהאינטרנט בבית פועל — הראוטר דולק ואפשר לגלוש ממכשיר אחר.',
        'נתקו את המכשיר מהחשמל, המתינו 10 שניות, חברו שוב והמתינו כ-2 דקות.',
      ];
      const i = s.data.step ?? 0;
      const options = withBack([{ n: 1, label: 'ביצעתי — בדקו שוב' }, { n: 0, label: 'נציג אנושי' }]);
      if (rendering) {
        const head = i === 0 ? `המכשיר "${s.data.device.name}" לא מגיב לשרת. נעבור יחד כמה צעדים.\n\n` : '';
        return reply(s, `${head}צעד ${i + 1} מתוך ${STEPS.length}: ${STEPS[i]}`, { options });
      }
      if (d === 0) { s.node = 'fault_ticket'; return render(ctx, s, io); }
      if (d !== 1) return notUnderstood(await render(ctx, s, io));
      if (await io.deviceOnline(s.data.device.id)) {
        return reply({ node: 'main', data: {} }, `המכשיר "${s.data.device.name}" חזר להיות מחובר ✅. התזמונים ממשיכים כרגיל.`, { options: [BACK], done: true });
      }
      if (i + 1 < STEPS.length) { s.data.step = i + 1; return render(ctx, s, io); }
      s.node = 'fault_offer_ticket';
      return render(ctx, s, io);
    }
    case 'fault_offer_ticket': {
      // The verdict itself (power / internet / filter) is the admin's — the
      // customer hears only that something is wrong and is offered a ticket.
      const options = withBack([{ n: 1, label: 'פתיחת פנייה' }]);
      if (rendering) return reply(s, `נראה שיש בעיה במכשיר "${s.data.device.name}" שלא נפתרת מרחוק. מומלץ לפתוח פנייה ונציג יחזור אליכם ${CALLBACK_HE}.`, { options });
      if (d === 1) { s.node = 'fault_ticket'; return render(ctx, s, io); }
      return notUnderstood(await render(ctx, s, io));
    }
    case 'fault_ticket': {
      const diag = await io.diagnose(s.data.device.id);
      const id = await io.ticket({
        ctx, topic: 'device_offline',
        body: `המכשיר "${s.data.device.name}" לא מגיב גם אחרי צעדי הבדיקה (חשמל, אינטרנט, הפעלה מחדש).`,
        details: { device_id: s.data.device.id, steps_done: (s.data.step ?? 0) + 1, diagnosis: diag ? { verdict: diag.verdict, category: diag.category, text: diag.text } : null },
      });
      return reply({ node: 'main', data: {} }, `הפנייה נרשמה (מס׳ ${id}) ונציג יחזור אליכם ${CALLBACK_HE}.`, { options: [BACK], done: true });
    }
    case 'sched_problem': {
      if (rendering) return reply(s, 'מה קרה עם התזמון?', { options: withBack(SCHEDULE_PROBLEMS) });
      const o = SCHEDULE_PROBLEMS.find((x) => x.n === d);
      if (!o) return notUnderstood(await render(ctx, s, io));
      s.data.problem = o.value; s.node = 'sched_relay';
      return render(ctx, s, io);
    }
    case 'sched_relay': {
      const relays = await io.relays(ctx.user.id);
      if (!relays.length) { s.node = 'service_other'; return render(ctx, s, io); }
      const options = withBack(relays.map((r, i) => ({ n: i + 1, label: relays.length > 1 && r.device_name ? `${r.name} (${r.device_name})` : r.name })));
      if (rendering) return reply(s, 'באיזה ערוץ?', { options });
      const pick = relays[d - 1];
      if (!pick || d < 1) return notUnderstood(await render(ctx, s, io));
      const id = await io.ticket({
        ctx, topic: 'schedule',
        body: `תזמון בערוץ "${pick.name}" — ${s.data.problem}.`,
        details: { relay_id: pick.id, device_id: pick.device_id, problem: s.data.problem },
      });
      return reply({ node: 'main', data: {} }, `הפנייה נרשמה (מס׳ ${id}). נבדוק את יומן התזמונים של "${pick.name}" ונחזור אליכם.`, { options: [BACK], done: true });
    }
    case 'order_status': {
      const orders = await io.orders({ ctx });
      if (!orders.length) { s.node = 'service_other'; return reply(s, 'לא מצאנו הזמנה פתוחה על המספר הזה. כתבו בקצרה על איזו הזמנה מדובר ונציג יבדוק.', { free: true }); }
      const lines = orders.map((o) => `• ${o.description}: ${ORDER_STATUS_HE[o.status] || o.status}`);
      s.node = 'order_status_helped';
      return reply(s, `ההזמנות שלכם:\n${lines.join('\n')}\n\nזה עזר?`, { options: withBack(HELPED) });
    }
    case 'order_status_helped': {
      if (rendering) return reply(s, 'זה עזר?', { options: withBack(HELPED) });
      if (d === 1) return reply({ node: 'main', data: {} }, 'בשמחה!', { options: [BACK], done: true });
      if (d === 2) { s.node = 'service_other'; return render(ctx, s, io); }
      return notUnderstood(await render(ctx, s, io));
    }
    case 'service_other': {
      if (rendering) return reply(s, 'כתבו בקצרה מה הבעיה, ונציג יחזור אליכם.', { free: true });
      if (text.length < 4) return reply(s, 'כתבו בבקשה כמה מילים על הבעיה.', { free: true });
      const id = await io.ticket({ ctx, topic: 'service_other', body: text.slice(0, 2000) });
      return reply({ node: 'main', data: {} }, `הפנייה נרשמה (מס׳ ${id}). נציג יחזור אליכם ${CALLBACK_HE}.`, { options: [BACK], done: true });
    }

    // ── 3 מידע כללי ──
    case 'info': {
      const options = withBack(INFO_TOPICS.map(({ n, label }) => ({ n, label })));
      if (rendering) return reply(s, 'על מה תרצו לדעת?', { options });
      const t = INFO_TOPICS.find((x) => x.n === d);
      if (!t) return notUnderstood(await render(ctx, s, io));
      const body = String(await io.infoText(t.key) || '').trim() || 'המידע הזה עדיין לא זמין כאן — לחצו 2 ונציג יענה.';
      s.data.topic = t.key; s.node = 'info_helped';
      return reply(s, `${body}\n\nזה עזר?`, { options: withBack(HELPED) });
    }
    case 'info_helped': {
      if (rendering) return reply(s, 'זה עזר?', { options: withBack(HELPED) });
      if (d === 1) return reply({ node: 'main', data: {} }, 'בשמחה!', { options: [BACK], done: true });
      if (d === 2) {
        // no free question, no model: the topic alone is the ticket
        const id = await io.ticket({ ctx, topic: 'info', body: `המידע על "${INFO_TOPICS.find((x) => x.key === s.data.topic)?.label || s.data.topic}" לא ענה על השאלה — לחזור ללקוח.`, details: { topic: s.data.topic } });
        return reply({ node: 'main', data: {} }, `הפנייה נרשמה (מס׳ ${id}). נציג יחזור אליכם עם תשובה ${CALLBACK_HE}.`, { options: [BACK], done: true });
      }
      return notUnderstood(await render(ctx, s, io));
    }

    // ── שירות לקוחות 5: בקשה / הצעה (free text — unavoidable) ──
    case 'feature': {
      if (rendering) return reply(s, 'כתבו מה הייתם רוצים שהמערכת תעשה, במילים שלכם:', { free: true });
      if (text.length < 4) return reply(s, 'כתבו בבקשה כמה מילים על הבקשה.', { free: true });
      const id = await io.ticket({ ctx, topic: 'feature', body: text.slice(0, 2000) });
      return reply({ node: 'main', data: {} }, `תודה! הבקשה נרשמה (מס׳ ${id}). נעדכן אתכם כשיהיה חדש.`, { options: [BACK], done: true });
    }

    // ── 4 הדלקה / כיבוי (registered users) ──
    case 'switch_relay': {
      const relays = await io.relays(ctx.user.id);
      if (!relays.length) return reply({ node: 'main', data: {} }, 'לחשבון שלכם אין עדיין ערוצים פעילים.', { options: [BACK] });
      const options = withBack(relays.map((r, i) => ({ n: i + 1, label: `${r.name}${r.current_state === 'on' ? ' (דולק)' : ' (כבוי)'}` })));
      if (rendering) return reply(s, 'איזה ערוץ?', { options });
      const pick = relays[d - 1];
      if (!pick || d < 1) return notUnderstood(await render(ctx, s, io));
      s.data.relay = { id: pick.id, name: pick.name }; s.node = 'switch_action';
      return render(ctx, s, io);
    }
    case 'switch_action': {
      const options = withBack([{ n: 1, label: 'הדלקה' }, { n: 2, label: 'כיבוי' }]);
      if (rendering) return reply(s, `"${s.data.relay.name}" — מה לעשות?`, { options });
      if (d !== 1 && d !== 2) return notUnderstood(await render(ctx, s, io));
      // The channel executes (WhatsApp: the existing confirm → runNluActions path).
      return reply({ node: 'main', data: {} }, '', {
        done: true,
        options: [BACK],
        action: { kind: 'immediate', relay_id: s.data.relay.id, relay_name: s.data.relay.name, action: d === 1 ? 'on' : 'off', summary: `${d === 1 ? 'הדלקת' : 'כיבוי'} ${s.data.relay.name} עכשיו` },
      });
    }
    case 'status': {
      return reply({ node: 'main', data: {} }, '', { done: true, options: [BACK], action: { kind: 'status' } });
    }

    // ── 0 נציג ──
    case 'agent': {
      // nothing to type: the request itself is the ticket, a person calls back
      const id = await io.ticket({ ctx, topic: 'agent', body: 'הלקוח ביקש נציג — לחזור אליו.' });
      return reply({ node: 'main', data: {} }, `הפנייה נרשמה (מס׳ ${id}). נציג יחזור אליכם ${CALLBACK_HE}.`, { options: [BACK], done: true });
    }
    default:
      return menuStart(ctx);
  }
}

// Plain-text rendering for channels without buttons (WhatsApp lists, phone):
// "1️⃣ הזמנה" lines under the text.
const KEYCAP = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
export function renderText(r) {
  const lines = (r.options || []).map((o) => `${KEYCAP[o.n] ?? `${o.n}.`} ${o.label}`);
  return [r.text, ...(lines.length ? ['', ...lines] : [])].filter((l, i) => l !== '' || i > 0).join('\n').trim();
}

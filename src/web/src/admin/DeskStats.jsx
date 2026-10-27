// מספרי המוקד (SPEC §10.4, phase 4): one row per week — tickets by source and
// topic, time to the first human reply against the 3-hour promise, what the
// bot answered / declined / escalated, free-text routings, containment, AI cost.
import { useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, ErrorNote, FilterSelect } from '../ui.jsx';

const TOPIC_HE = {
  device_offline: 'מכשיר מנותק', schedule: 'תזמון', login: 'התחברות', phone: 'מענה קולי', app: 'אפליקציה', other: 'אחר',
  order: 'הזמנה', order_status: 'הזמנה בתהליך', feature: 'בקשה לשיפור', agent: 'נציג', info: 'מידע', service_other: 'שירות — אחר',
};
const SOURCE_HE = { web: 'אתר', phone: 'טלפון', whatsapp: 'וואטסאפ' };
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const mins = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} דק׳` : m < 1440 ? `${(m / 60).toFixed(1)} שע׳` : `${(m / 1440).toFixed(1)} ימים`);
const weekLabel = (iso) => { const [y, m, d] = iso.split('-'); return `שבוע ${Number(d)}.${Number(m)}.${y.slice(2)}`; };

export default function DeskStats() {
  const [weeks, setWeeks] = useState('8');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setData(null); setError(null);
    adminApi.get(`/support-desk?weeks=${weeks}`).then(setData).catch(setError);
  }, [weeks]);
  const rows = data?.rows || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="text-muted">תקופה:</span>
        <FilterSelect value={weeks} onChange={(e) => setWeeks(e.target.value)} className="w-36">
          <option value="4">4 שבועות</option>
          <option value="8">8 שבועות</option>
          <option value="13">רבעון</option>
          <option value="26">חצי שנה</option>
        </FilterSelect>
        <span className="text-muted text-xs">הכלה = שיחות עם הבוט (עוזר + ניתוב) שלא הסתיימו בפנייה באותו יום · ההבטחה = תשובת נציג ראשונה תוך 3 שעות</span>
      </div>
      <ErrorNote error={error} />
      <Card flush className="table-scroll">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted">
              <th className="p-2">שבוע</th><th className="p-2">פניות</th><th className="p-2">לפי מקור</th><th className="p-2">נושאים</th>
              <th className="p-2">נענו</th><th className="p-2">תשובה ראשונה (חציון)</th><th className="p-2">בתוך ההבטחה</th>
              <th className="p-2">הבוט: ענה / סירב / הסלים</th><th className="p-2">ניתובים</th><th className="p-2">פקודות קוליות</th>
              <th className="p-2">הכלה</th><th className="p-2">עלות AI ($)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.week} className="border-t border-line">
                <td className="p-2 whitespace-nowrap">{weekLabel(r.week)}</td>
                <td className="p-2" dir="ltr">{r.tickets}</td>
                <td className="p-2 text-xs">{Object.entries(r.by_source).map(([k, v]) => `${SOURCE_HE[k] || k} ${v}`).join(' · ') || '—'}</td>
                <td className="p-2 text-xs">{r.top_topics.map(([k, v]) => `${TOPIC_HE[k] || k} ${v}`).join(' · ') || '—'}</td>
                <td className="p-2" dir="ltr">{r.replied}/{r.tickets}</td>
                <td className="p-2">{mins(r.first_reply_median_min)}</td>
                <td className="p-2" dir="ltr">{pct(r.within_promise_share)}</td>
                <td className="p-2" dir="ltr">{r.bot_answered} / {r.bot_declined} / {r.bot_escalated}</td>
                <td className="p-2" dir="ltr">{r.router_calls}</td>
                <td className="p-2" dir="ltr">{r.command_calls}</td>
                <td className="p-2" dir="ltr">{pct(r.containment)}{r.conversations ? ` (${r.conversations})` : ''}</td>
                <td className="p-2" dir="ltr">{r.ai_cost_usd.toFixed(2)}</td>
              </tr>
            ))}
            {data && rows.length === 0 && <tr><td colSpan={12} className="p-6 text-center text-muted">אין נתונים בתקופה</td></tr>}
            {!data && !error && <tr><td colSpan={12} className="p-6 text-center text-muted">טוען…</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

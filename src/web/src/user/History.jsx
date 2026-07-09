import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, SectionHead, ErrorNote, useAsync } from '../ui.jsx';

// Mockup .hist rows: icon square · sentence · time at the far edge.
const SOURCE_HE = { ivr: 'דרך הטלפון', web: 'דרך האתר', schedule: 'לפי תזמון', admin: 'על ידי מנהל' };
const OUTCOME_HE = { command: 'פקודה', schedule: 'תזמון חדש נשמר', status: 'בירור מצב', auth_fail: 'כשל זיהוי', abandoned: 'שיחה נותקה' };

function fmtTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  // Calendar days, not 24h blocks — yesterday evening must not read "היום".
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return `היום ${time}`;
  if (days === 1) return `אתמול ${time}`;
  if (days < 7) return `${d.toLocaleDateString('he-IL', { weekday: 'long' })} ${time}`;
  return `${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' })} ${time}`;
}

function Row({ item, first }) {
  const d = item.data;
  const isCmd = item.type === 'cmd';
  const ok = isCmd ? d.status === 'acked' : !['auth_fail', 'abandoned'].includes(d.outcome);
  const icon = isCmd ? (ok ? '💡' : '✕') : '📞';
  const iconBg = isCmd ? (ok ? 'bg-on-bg' : 'bg-off-bg') : 'bg-[#EFEAF7]';
  return (
    <div className={`flex items-center gap-3 px-5 py-[13px] text-sm ${first ? '' : 'border-t border-line'}`}>
      <span className={`w-[30px] h-[30px] rounded-[9px] grid place-items-center text-sm shrink-0 ${iconBg}`}>{icon}</span>
      <span className="min-w-0">
        {isCmd ? (
          <>
            <b>{d.relay_name}</b> {d.action === 'on' ? 'הודלק' : 'כובה'} {SOURCE_HE[d.source] || ''}
            {d.status === 'failed' && <span className="text-off"> — נכשל{d.fail_reason === 'offline' ? ' (המכשיר לא היה מחובר)' : ''}</span>}
          </>
        ) : (
          <>
            שיחה מ־<span dir="ltr">{d.phone}</span> — {OUTCOME_HE[d.outcome] || 'ללא פעולה'}
            {d.menu_path && <small className="block text-muted text-[12px]" dir="ltr">{d.menu_path}</small>}
          </>
        )}
      </span>
      <time className="mr-auto text-muted text-[12.5px] whitespace-nowrap">{fmtTime(item.ts)}</time>
    </div>
  );
}

export default function History() {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAsync();

  const load = (reset = false) => run(async () => {
    const q = !reset && cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res = await api.get(`/history?limit=30${q}`);
    setItems((prev) => reset ? res.items : [...prev, ...res.items]);
    setCursor(res.next_cursor);
    setDone(!res.next_cursor);
  });
  useEffect(() => { load(true); }, []);

  return (
    <>
      <SectionHead title="פעילות אחרונה" />
      <ErrorNote error={error} />
      {items.length === 0 && !busy && <Card>אין פעילות עדיין.</Card>}
      {items.length > 0 && (
        <Card flush>
          {items.map((it, i) => <Row key={`${it.type}:${it.id}`} item={it} first={i === 0} />)}
        </Card>
      )}
      {!done && items.length > 0 && (
        <Button variant="ghost" className="w-full mt-3" disabled={busy} onClick={() => load(false)}>טען עוד</Button>
      )}
    </>
  );
}

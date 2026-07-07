import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Badge, ErrorNote, useAsync } from '../ui.jsx';

const SOURCE_HE = { ivr: 'טלפון', web: 'אתר', schedule: 'תזמון', admin: 'מנהל' };
const OUTCOME_HE = { command: 'פקודה', schedule: 'תזמון', status: 'בירור מצב', auth_fail: 'כשל זיהוי', abandoned: 'נותקה' };

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
    <div className="space-y-3">
      <h2 className="font-bold text-xl">היסטוריה</h2>
      <ErrorNote error={error} />
      {items.map((it) => (
        <Card key={`${it.type}:${it.id}`} className="flex items-center justify-between gap-3 flex-wrap py-3">
          {it.type === 'cmd' ? (
            <>
              <div>
                <span className="font-semibold">{it.data.relay_name}</span>
                {' — '}{it.data.action === 'on' ? 'הדלקה' : 'כיבוי'}
                <span className="text-muted text-sm"> ({SOURCE_HE[it.data.source] || it.data.source})</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge ok={it.data.status === 'acked'}>
                  {it.data.status === 'acked' ? 'בוצע' : it.data.status === 'failed' ? 'נכשל' : it.data.status}
                </Badge>
                <span className="text-muted text-xs">{new Date(it.ts).toLocaleString('he-IL')}</span>
              </div>
            </>
          ) : (
            <>
              <div>
                <span className="font-semibold">שיחה</span>
                <span className="text-muted text-sm" dir="ltr"> {it.data.phone}</span>
                {it.data.menu_path && <div className="text-muted text-xs" dir="ltr">{it.data.menu_path}</div>}
              </div>
              <div className="flex items-center gap-2">
                <Badge ok={!['auth_fail', 'abandoned'].includes(it.data.outcome)}>
                  {OUTCOME_HE[it.data.outcome] || '—'}
                </Badge>
                <span className="text-muted text-xs">{new Date(it.ts).toLocaleString('he-IL')}</span>
              </div>
            </>
          )}
        </Card>
      ))}
      {items.length === 0 && !busy && <Card>אין פעילות עדיין.</Card>}
      {!done && items.length > 0 && (
        <Button variant="ghost" className="w-full" disabled={busy} onClick={() => load(false)}>טען עוד</Button>
      )}
    </div>
  );
}

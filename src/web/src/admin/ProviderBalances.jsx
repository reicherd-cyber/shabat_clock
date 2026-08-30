import { useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync } from '../ui.jsx';

// "יתרות בזמן אמת" — the real balances at the two metered providers: Yemot
// units (read from their API) and the Anthropic credit (admin-entered, then
// live spend subtracted). Lives on the admin home (moved from voice-costs,
// 2026-08-30) so a low balance is the first thing an admin sees.
const C_EXPENSE = '#e11d48'; // money-color convention: costs are red

export function ProviderBalances({ rate: rateProp = null }) {
  const [live, setLive] = useState(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [balDraft, setBalDraft] = useState(null); // null = closed; string = balance being typed
  const [rate, setRate] = useState(rateProp);
  const { busy, error, run, setError } = useAsync();

  useEffect(() => { adminApi.get('/billing/balances').then(setLive).catch(setError); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The units→₪ approximation needs the current Yemot rate; callers that already
  // have it pass it in, the admin home fetches the (cheap) today slice for it.
  useEffect(() => {
    if (rateProp) { setRate(rateProp); return; }
    adminApi.get('/voice-costs?period=today').then((d) => setRate(d?.rate || null)).catch(() => {});
  }, [rateProp]);

  const refreshLive = async () => {
    setLiveBusy(true);
    try { setLive(await adminApi.get('/billing/balances?refresh=1')); } catch (e) { setError(e); }
    setLiveBusy(false);
  };

  // The admin reads the current credit balance off the Anthropic billing page
  // and types it here; from that moment real spend is subtracted from it live.
  const saveBalance = () => run(async () => {
    await adminApi.put('/billing/anthropic-balance', { usd: Number(balDraft) });
    setBalDraft(null);
    await refreshLive();
  });

  if (!live) return <ErrorNote error={error} />;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-bold text-sm">יתרות בזמן אמת (מהספקים עצמם)</h3>
        <Button variant="ghost" disabled={liveBusy} onClick={refreshLive}>{liveBusy ? 'מרענן…' : 'רענון'}</Button>
        <span className="text-muted text-xs">עודכן {new Date(live.fetched_at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <ErrorNote error={error} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card className="text-center">
          {live.yemot?.ok ? (
            <>
              <div className="text-3xl font-bold" style={live.yemot.units < 10 ? { color: C_EXPENSE } : undefined}>
                {live.yemot.units.toFixed(2)}
              </div>
              <div className="text-muted text-sm">
                יתרת יחידות בימות המשיח
                {rate && <> <span dir="ltr">(≈ ₪{(live.yemot.units * rate.ils / rate.units).toFixed(2)})</span></>}
                {live.yemot.expires_at && <> · בתוקף עד {new Date(live.yemot.expires_at).toLocaleDateString('he-IL')}</>}
              </div>
              {live.yemot.units < 10 && (
                <div className="text-sm font-semibold mt-1" style={{ color: C_EXPENSE }}>
                  ⚠ היתרה נמוכה — מומלץ לטעון יחידות בימות המשיח
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-muted py-2">{live.yemot?.error || 'לא זמין'}</div>
          )}
        </Card>
        <Card className="text-center">
          {live.anthropic?.ok ? (
            <>
              {live.anthropic.balance_usd != null ? (
                <div className="text-3xl font-bold" style={live.anthropic.balance_usd < 5 ? { color: C_EXPENSE } : undefined}>
                  <span dir="ltr">${live.anthropic.balance_usd.toFixed(2)}</span>
                </div>
              ) : (
                <div className="text-3xl font-bold text-muted">—</div>
              )}
              {live.anthropic.balance_usd != null && live.anthropic.balance_usd < 5 && (
                <div className="text-sm font-semibold" style={{ color: C_EXPENSE }}>
                  ⚠ היתרה נמוכה — כדאי לטעון עכשיו, אחרת הפקודות הקוליות יפסיקו לעבוד
                </div>
              )}
              <div className="text-muted text-sm">
                {live.anthropic.balance_usd != null ? 'יתרה ב-Anthropic (משוערת)' : 'יתרת Anthropic — נדרשת הזנה ראשונית'}
                {' · '}
                <span style={{ color: C_EXPENSE }} dir="ltr">הוצאות החודש: ${live.anthropic.month_usd.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-center gap-2 mt-1 flex-wrap text-sm">
                {balDraft == null ? (
                  <>
                    <Button variant="ghost" onClick={() => setBalDraft(live.anthropic.balance_usd != null ? live.anthropic.balance_usd.toFixed(2) : '')}>
                      עדכון יתרה
                    </Button>
                    <a className="underline text-accent" href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">
                      טעינת יתרה ב-Anthropic ›
                    </a>
                  </>
                ) : (
                  <>
                    <span dir="ltr">$</span>
                    <Input autoFocus type="number" min="0" step="0.01" dir="ltr" className="w-24 py-1 text-sm"
                      placeholder="0.00" value={balDraft} onChange={(e) => setBalDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveBalance();
                        if (e.key === 'Escape') setBalDraft(null);
                      }} />
                    <Button disabled={busy || !(Number(balDraft) >= 0) || balDraft === ''} onClick={saveBalance}>שמור</Button>
                    <Button variant="ghost" onClick={() => setBalDraft(null)}>ביטול</Button>
                    <span className="text-muted text-xs">היתרה הנוכחית מדף החיוב של Anthropic</span>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted py-2">
              {live.anthropic?.configured === false
                ? 'להצגת היתרה יש להגדיר ANTHROPIC_ADMIN_KEY בשרת (מפתח Admin מהקונסולה של Anthropic)'
                : (live.anthropic?.error || 'לא זמין')}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

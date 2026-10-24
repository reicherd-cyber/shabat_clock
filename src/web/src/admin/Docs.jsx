// Admin תיעוד: the repo's own documents rendered inside the panel — the service
// tree (SERVICE-TREE.md), the spec (SPEC.md, by default only §10 customer
// service), the plan and the readme. Read-only; the server whitelists the files
// (GET /admin/docs, /admin/docs/:key?section=N) and the page renders markdown
// with `marked`. The documents are English prose with Hebrew labels and ASCII
// trees, so the body is LTR; the chrome around it stays RTL like every page.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { marked } from 'marked';
import { BookOpen, ExternalLink } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, ErrorNote, useAsync } from '../ui.jsx';

const REPO = 'https://github.com/reicherd-cyber/shabat_clock/blob/dev/';
const segBtn = (on) => `inline-flex items-center rounded-[8px] px-2.5 py-1.5 text-[13px] font-medium cursor-pointer transition border border-line ${
  on ? 'bg-accent text-white border-accent' : 'bg-surface2 text-muted hover:text-ink'}`;

export function Docs() {
  const [sp, setSp] = useSearchParams();
  const key = sp.get('doc') || 'tree';
  // The spec is long; §10 is the part the desk is run by. "whole" shows all of it.
  const whole = sp.get('whole') === '1';
  const list = useAsync(() => adminApi.get('/docs'), []);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    const entry = list.data?.docs?.find((d) => d.key === key);
    const q = entry?.section && !whole ? `?section=${entry.section}` : '';
    adminApi.get(`/docs/${key}${q}`)
      .then((d) => { if (alive) setDoc(d); })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [key, whole, list.data]);

  const html = useMemo(() => (doc?.markdown ? marked.parse(doc.markdown, { gfm: true, breaks: false }) : ''), [doc]);
  const entry = list.data?.docs?.find((d) => d.key === key);
  const pick = (k) => setSp((p) => { const n = new URLSearchParams(p); n.set('doc', k); n.delete('whole'); return n; });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold flex items-center gap-2"><BookOpen size={20} /> תיעוד</h1>
        <span className="text-muted text-sm">המסמכים של המערכת, כפי שהם במאגר — לקריאה בלבד</span>
      </div>
      {list.error && <ErrorNote error={list.error} />}
      <div className="flex flex-wrap gap-2">
        {(list.data?.docs || []).map((d) => (
          <button key={d.key} type="button" className={segBtn(d.key === key)} onClick={() => pick(d.key)}>{d.title}</button>
        ))}
      </div>
      {entry?.section && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={whole} onChange={(e) => setSp((p) => { const n = new URLSearchParams(p); if (e.target.checked) n.set('whole', '1'); else n.delete('whole'); return n; })} />
            המסמך כולו (ברירת המחדל: סעיף {entry.section} בלבד)
          </label>
        </div>
      )}
      {error && <ErrorNote error={error} />}
      <Card className="overflow-hidden">
        {doc && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted mb-3" dir="rtl">
            <span>{doc.file} · עודכן {new Date(doc.mtime).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}</span>
            <a className="inline-flex items-center gap-1 underline" href={`${REPO}${doc.file}`} target="_blank" rel="noreferrer">
              פתיחה ב-GitHub <ExternalLink size={12} />
            </a>
          </div>
        )}
        {/* Trusted content: our own repository files, served through a server-side whitelist. */}
        <div className="doc-md" dir="ltr" dangerouslySetInnerHTML={{ __html: html }} />
        {!doc && !error && <p className="text-muted">טוען…</p>}
      </Card>
    </div>
  );
}

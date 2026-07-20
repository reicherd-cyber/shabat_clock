import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { api, tokens } from './api.js';
import Login from './user/Login.jsx';
import Dashboard from './user/Dashboard.jsx';
import Schedules from './user/Schedules.jsx';
import Calendar from './user/Calendar.jsx';
import History from './user/History.jsx';
import Settings from './user/Settings.jsx';
import AdminLogin from './admin/AdminLogin.jsx';
import Users from './admin/Users.jsx';
import Devices from './admin/Devices.jsx';
import { Monitoring, DeviceHealth, CallLogs, Commands, AdminSchedules, SystemSettings, Admins, Audit } from './admin/Misc.jsx';
import { CallFlow } from './admin/CallFlow.jsx';
import { Recordings } from './admin/Recordings.jsx';
import AdminHistory from './admin/History.jsx';
import VoiceCosts from './admin/VoiceCosts.jsx';
import Finance from './admin/Finance.jsx';
import { Logo, Wordmark } from './ui.jsx';
import {
  LayoutGrid, CalendarClock, CalendarDays, History as HistoryIcon, Settings as SettingsIcon,
  Activity, Users as UsersIcon, Plug, PhoneCall, GitBranch, Wallet, Mic,
  ShieldCheck, ScrollText, ChevronDown, AudioLines,
} from 'lucide-react';

// Decode a JWT payload client-side (base64url) — used only to detect impersonation.
function tokenPayload(t) {
  try {
    return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return {}; }
}

// ── user panel shell per the mockup: sticky topbar (brand ✦ + user chip),
//    desktop inline nav, mobile bottom tab bar ──
const TABS = [
  { to: '/', label: 'דשבורד', Icon: LayoutGrid, end: true },
  { to: '/schedules', label: 'תזמונים', Icon: CalendarClock },
  { to: '/calendar', label: 'לוח', Icon: CalendarDays },
  { to: '/history', label: 'היסטוריה', Icon: HistoryIcon },
  { to: '/settings', label: 'הגדרות', Icon: SettingsIcon },
];

function UserLayout() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  useEffect(() => {
    if (tokens.user) api.get('/me').then((r) => setName(r.user.full_name)).catch(() => {});
  }, []);
  if (!tokens.user) return <Navigate to="/login" replace />;

  // When an admin is impersonating, the user token carries `imp` (the admin's id).
  const impersonating = !!tokenPayload(tokens.user).imp;

  const deskCls = ({ isActive }) =>
    `px-3 py-1.5 rounded-[10px] text-sm font-medium ${isActive ? 'bg-[#E4EFFE] text-accent-dk font-bold' : 'text-muted hover:text-ink'}`;
  const tabCls = ({ isActive }) =>
    `flex-1 text-center text-xs no-underline py-1.5 rounded-[10px] ${isActive ? 'text-accent-dk bg-[#E4EFFE] font-bold' : 'text-muted'}`;

  return (
    <div className="min-h-screen pb-[84px] md:pb-10">
      {impersonating && (
        <div className="bg-ink text-white text-sm px-6 py-2 flex items-center justify-between gap-3">
          <span>מצב התחזות{name ? ` — צופה כ${name}` : ''}</span>
          <button className="font-medium underline whitespace-nowrap cursor-pointer hover:opacity-80"
            onClick={() => nav('/admin')}>חזרה לפאנל הניהול ←</button>
        </div>
      )}
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-line bg-bg sticky top-0 z-10">
        <div className="flex items-center gap-2 cursor-pointer select-none"
          onClick={() => nav('/')} role="button" title="לדף הבית">
          <span className="text-accent shrink-0"><Logo size={34} /></span>
          <Wordmark size={21} tagline />
        </div>
        <nav className="hidden md:flex gap-1 items-center">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={deskCls}>
              <span className="flex items-center gap-1.5"><t.Icon size={15} strokeWidth={2} />{t.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2.5 font-medium text-muted">
          <span className="hidden sm:inline">{name}</span>
          <span className="w-8 h-8 rounded-full bg-surface2 border border-line grid place-items-center font-bold text-accent-dk">
            {name ? name[0] : '·'}
          </span>
          <button className="text-muted text-sm cursor-pointer hover:text-ink" onClick={() => { tokens.user = null; nav('/login'); }}>יציאה</button>
        </div>
      </header>
      <main className="max-w-[1040px] mx-auto px-6 py-8">
        <Outlet />
      </main>
      <nav className="fixed bottom-0 inset-x-0 z-20 flex bg-surface border-t border-line px-2.5 pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] md:hidden">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={tabCls}>
            <t.Icon size={20} strokeWidth={1.9} className="mx-auto mb-0.5" />{t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

// Admin nav grouped into sections — a flat top bar stopped scaling past ~10 pages.
// Section-less first group = top-level links. (The commands page is intentionally
// absent: it's a drill-down from the monitoring tiles.)
const ADMIN_NAV = [
  { items: [{ to: '/admin', label: 'ניטור', Icon: Activity, end: true }] },
  {
    title: 'ניהול',
    items: [
      { to: '/admin/users', label: 'משתמשים', Icon: UsersIcon },
      { to: '/admin/devices', label: 'מכשירים', Icon: Plug },
      { to: '/admin/schedules', label: 'תזמונים', Icon: CalendarClock },
    ],
  },
  {
    title: 'פעילות',
    items: [
      { to: '/admin/history', label: 'היסטוריה', Icon: HistoryIcon },
      { to: '/admin/call-logs', label: 'שיחות', Icon: PhoneCall },
      { to: '/admin/call-flow', label: 'תרשים שיחה', Icon: GitBranch },
      { to: '/admin/recordings', label: 'הקלטות מענה', Icon: AudioLines },
    ],
  },
  {
    title: 'כספים',
    items: [
      { to: '/admin/finance', label: 'הכנסות והוצאות', Icon: Wallet },
      { to: '/admin/voice-costs', label: 'עלויות קול', Icon: Mic },
    ],
  },
  {
    title: 'מערכת',
    items: [
      { to: '/admin/settings', label: 'הגדרות', Icon: SettingsIcon },
      { to: '/admin/admins', label: 'מנהלים', Icon: ShieldCheck },
      { to: '/admin/audit', label: 'ביקורת', Icon: ScrollText },
    ],
  },
];

function AdminNav({ onNavigate }) {
  // Folded/unfolded state per section title, remembered across reloads (default: all open).
  const [folded, setFolded] = useState(() => {
    try { return JSON.parse(localStorage.getItem('adminNavFolded')) || {}; } catch { return {}; }
  });
  const toggle = (title) => {
    setFolded((f) => {
      const next = { ...f, [title]: !f[title] };
      localStorage.setItem('adminNavFolded', JSON.stringify(next));
      return next;
    });
  };
  const linkCls = ({ isActive }) =>
    `block px-3 py-1.5 rounded-[10px] text-sm font-medium ${isActive ? 'bg-accent text-white' : 'text-ink hover:bg-line/50'}`;
  return (
    <nav className="space-y-4">
      {ADMIN_NAV.map((sec, i) => (
        <div key={i}>
          {sec.title && (
            <button
              className="w-full flex items-center justify-between text-muted hover:text-ink text-[11px] font-bold tracking-wide px-3 mb-1 cursor-pointer select-none"
              onClick={() => toggle(sec.title)}
            >
              <span>{sec.title}</span>
              <ChevronDown size={13} className={`transition-transform duration-150 ${folded[sec.title] ? '-rotate-90' : ''}`} />
            </button>
          )}
          {!(sec.title && folded[sec.title]) && (
            <div className="space-y-0.5">
              {sec.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className={linkCls} onClick={onNavigate}>
                  <span className="flex items-center gap-2">
                    {it.Icon && <it.Icon size={15} strokeWidth={1.9} className="shrink-0 opacity-80" />}
                    {it.label}
                  </span>
                </NavLink>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

function AdminLayout() {
  const nav = useNavigate();
  const [ver, setVer] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Collapsible sidebar; the choice survives reloads.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('adminNavCollapsed') === '1');
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem('adminNavCollapsed', c ? '0' : '1');
      return !c;
    });
  };
  useEffect(() => {
    fetch('/healthz').then((r) => r.json()).then(setVer).catch(() => {});
  }, []);
  if (!tokens.admin) return <Navigate to="/admin/login" replace />;

  const brand = (
    <div className="font-bold text-[19px] flex items-center gap-2 cursor-pointer select-none"
      onClick={() => { setMenuOpen(false); nav('/admin'); }} role="button" title="לדף הבית">
      <span className="text-accent shrink-0"><Logo size={30} /></span>
      <span className="flex items-center gap-1.5">ניהול · <Wordmark size={19} /></span>
    </div>
  );
  const logout = () => { tokens.admin = null; nav('/admin/login'); };

  return (
    <div className="min-h-screen md:flex">
      {/* Desktop sidebar (RTL: first flex child = right side); collapses to a slim rail */}
      <aside className={`hidden md:flex flex-col shrink-0 border-l border-line bg-surface sticky top-0 h-screen overflow-y-auto py-4 gap-5 transition-all duration-200 ${collapsed ? 'w-14 px-2 items-center' : 'w-56 px-3'}`}>
        {collapsed ? (
          <span className="text-accent cursor-pointer select-none"
            onClick={() => nav('/admin')} role="button" title="ניהול — TelTech"><Logo size={30} /></span>
        ) : brand}
        <button
          className="text-muted hover:text-ink cursor-pointer text-lg leading-none self-start px-1"
          title={collapsed ? 'הרחב תפריט' : 'צמצם תפריט'}
          onClick={toggleCollapsed}
        >{collapsed ? '«' : '»'}</button>
        {!collapsed && <AdminNav />}
        {!collapsed && (
          <div className="mt-auto space-y-2">
            <button className="block w-full text-right px-3 py-1.5 text-sm text-muted cursor-pointer hover:text-ink" onClick={logout}>יציאה</button>
            {ver?.version && (
              <div className="px-3 text-muted text-xs" dir="ltr">v {ver.version}{ver.version_date ? ` · ${ver.version_date}` : ''}</div>
            )}
          </div>
        )}
      </aside>

      {/* Mobile: top bar + drawer */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-line bg-bg sticky top-0 z-20">
        {brand}
        <button className="text-2xl px-2 cursor-pointer" aria-label="תפריט" onClick={() => setMenuOpen(true)}>☰</button>
      </header>
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-30" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="absolute top-0 bottom-0 right-0 w-64 bg-surface shadow-xl px-3 py-4 flex flex-col gap-5 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            {brand}
            <AdminNav onNavigate={() => setMenuOpen(false)} />
            <button className="mt-auto block w-full text-right px-3 py-1.5 text-sm text-muted cursor-pointer" onClick={logout}>יציאה</button>
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 px-6 py-8">
        <div className="max-w-5xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route element={<UserLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Monitoring />} />
          <Route path="users" element={<Users />} />
          <Route path="devices" element={<Devices />} />
          <Route path="schedules" element={<AdminSchedules />} />
          <Route path="call-logs" element={<CallLogs />} />
          <Route path="history" element={<AdminHistory />} />
          <Route path="voice-costs" element={<VoiceCosts />} />
          <Route path="finance" element={<Finance />} />
          <Route path="call-flow" element={<CallFlow />} />
          <Route path="recordings" element={<Recordings />} />
          <Route path="commands" element={<Commands />} />
          <Route path="health" element={<DeviceHealth />} />
          <Route path="settings" element={<SystemSettings />} />
          <Route path="admins" element={<Admins />} />
          <Route path="audit" element={<Audit />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { api, tokens } from './api.js';
import Login from './user/Login.jsx';
import Dashboard from './user/Dashboard.jsx';
import Schedules from './user/Schedules.jsx';
import History from './user/History.jsx';
import Settings from './user/Settings.jsx';
import AdminLogin from './admin/AdminLogin.jsx';
import Users from './admin/Users.jsx';
import Devices from './admin/Devices.jsx';
import { Monitoring, CallLogs, Commands, AdminSchedules, SystemSettings, Admins, Audit } from './admin/Misc.jsx';

// Decode a JWT payload client-side (base64url) — used only to detect impersonation.
function tokenPayload(t) {
  try {
    return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return {}; }
}

// ── user panel shell per the mockup: sticky topbar (brand ✦ + user chip),
//    desktop inline nav, mobile bottom tab bar ──
const TABS = [
  { to: '/', label: 'דשבורד', icon: '▦', end: true },
  { to: '/schedules', label: 'תזמונים', icon: '🕐' },
  { to: '/history', label: 'היסטוריה', icon: '≡' },
  { to: '/settings', label: 'הגדרות', icon: '⚙' },
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
    `px-3 py-1.5 rounded-[10px] text-sm font-medium ${isActive ? 'bg-[#F6EBE5] text-accent-dk font-bold' : 'text-muted hover:text-ink'}`;
  const tabCls = ({ isActive }) =>
    `flex-1 text-center text-xs no-underline py-1.5 rounded-[10px] ${isActive ? 'text-accent-dk bg-[#F6EBE5] font-bold' : 'text-muted'}`;

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
        <div className="font-serif font-bold text-[21px] flex items-center gap-2 cursor-pointer select-none"
          onClick={() => nav('/')} role="button" title="לדף הבית">
          <span className="w-[30px] h-[30px] rounded-[9px] bg-accent text-white grid place-items-center text-base">✦</span>
          שעון שבת
        </div>
        <nav className="hidden md:flex gap-1 items-center">
          {TABS.map((t) => <NavLink key={t.to} to={t.to} end={t.end} className={deskCls}>{t.label}</NavLink>)}
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
            <span className="block text-[19px] mb-0.5">{t.icon}</span>{t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function AdminLayout() {
  const nav = useNavigate();
  if (!tokens.admin) return <Navigate to="/admin/login" replace />;
  const navCls = ({ isActive }) =>
    `px-3 py-1.5 rounded-[10px] font-medium text-sm whitespace-nowrap ${isActive ? 'bg-accent text-white' : 'text-ink hover:bg-line/50'}`;
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-line bg-bg sticky top-0 z-10 flex-wrap gap-2">
        <div className="font-serif font-bold text-[21px] flex items-center gap-2 cursor-pointer select-none"
          onClick={() => nav('/admin')} role="button" title="לדף הבית">
          <span className="w-[30px] h-[30px] rounded-[9px] bg-ink text-white grid place-items-center text-base">✦</span>
          ניהול — שעון שבת
        </div>
        <nav className="flex gap-1 overflow-x-auto">
          <NavLink to="/admin" end className={navCls}>ניטור</NavLink>
          <NavLink to="/admin/users" className={navCls}>משתמשים</NavLink>
          <NavLink to="/admin/devices" className={navCls}>מכשירים</NavLink>
          <NavLink to="/admin/schedules" className={navCls}>תזמונים</NavLink>
          <NavLink to="/admin/call-logs" className={navCls}>שיחות</NavLink>
          <NavLink to="/admin/settings" className={navCls}>הגדרות</NavLink>
          <NavLink to="/admin/admins" className={navCls}>מנהלים</NavLink>
          <NavLink to="/admin/audit" className={navCls}>ביקורת</NavLink>
          <button className="px-3 py-1.5 text-sm text-muted cursor-pointer" onClick={() => { tokens.admin = null; nav('/admin/login'); }}>יציאה</button>
        </nav>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Outlet />
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
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Monitoring />} />
          <Route path="users" element={<Users />} />
          <Route path="devices" element={<Devices />} />
          <Route path="schedules" element={<AdminSchedules />} />
          <Route path="call-logs" element={<CallLogs />} />
          <Route path="commands" element={<Commands />} />
          <Route path="settings" element={<SystemSettings />} />
          <Route path="admins" element={<Admins />} />
          <Route path="audit" element={<Audit />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

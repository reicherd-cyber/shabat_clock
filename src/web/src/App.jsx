import { BrowserRouter, Routes, Route, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { tokens } from './api.js';
import Login from './user/Login.jsx';
import Dashboard from './user/Dashboard.jsx';
import Schedules from './user/Schedules.jsx';
import History from './user/History.jsx';
import Settings from './user/Settings.jsx';
import AdminLogin from './admin/AdminLogin.jsx';
import Users from './admin/Users.jsx';
import Devices from './admin/Devices.jsx';
import { Monitoring, CallLogs, AdminSchedules, SystemSettings, Admins, Audit } from './admin/Misc.jsx';

const navCls = ({ isActive }) =>
  `px-3 py-2 rounded-xl font-semibold text-sm whitespace-nowrap ${isActive ? 'bg-accent text-white' : 'text-ink hover:bg-line/50'}`;

function UserLayout() {
  const nav = useNavigate();
  if (!tokens.user) return <Navigate to="/login" replace />;
  return (
    <div className="max-w-3xl mx-auto p-4">
      <header className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <h1 className="font-bold text-xl">🕯️ שעון שבת</h1>
        <nav className="flex gap-1 overflow-x-auto">
          <NavLink to="/" end className={navCls}>דשבורד</NavLink>
          <NavLink to="/schedules" className={navCls}>תזמונים</NavLink>
          <NavLink to="/history" className={navCls}>היסטוריה</NavLink>
          <NavLink to="/settings" className={navCls}>הגדרות</NavLink>
          <button className="px-3 py-2 text-sm text-muted" onClick={() => { tokens.user = null; nav('/login'); }}>יציאה</button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

function AdminLayout() {
  const nav = useNavigate();
  if (!tokens.admin) return <Navigate to="/admin/login" replace />;
  return (
    <div className="max-w-5xl mx-auto p-4">
      <header className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <h1 className="font-bold text-xl">🛠️ ניהול — שעון שבת</h1>
        <nav className="flex gap-1 overflow-x-auto">
          <NavLink to="/admin" end className={navCls}>ניטור</NavLink>
          <NavLink to="/admin/users" className={navCls}>משתמשים</NavLink>
          <NavLink to="/admin/devices" className={navCls}>מכשירים</NavLink>
          <NavLink to="/admin/schedules" className={navCls}>תזמונים</NavLink>
          <NavLink to="/admin/call-logs" className={navCls}>שיחות</NavLink>
          <NavLink to="/admin/settings" className={navCls}>הגדרות</NavLink>
          <NavLink to="/admin/admins" className={navCls}>מנהלים</NavLink>
          <NavLink to="/admin/audit" className={navCls}>ביקורת</NavLink>
          <button className="px-3 py-2 text-sm text-muted" onClick={() => { tokens.admin = null; nav('/admin/login'); }}>יציאה</button>
        </nav>
      </header>
      <Outlet />
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
          <Route path="settings" element={<SystemSettings />} />
          <Route path="admins" element={<Admins />} />
          <Route path="audit" element={<Audit />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

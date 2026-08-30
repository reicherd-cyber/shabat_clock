// Same-origin API client [D27]. Separate token slots for the user and admin panels.
const BASE = '/api/v1';

export const tokens = {
  get user() { return localStorage.getItem('token'); },
  set user(v) { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); },
  get admin() { return localStorage.getItem('admin_token'); },
  set admin(v) { v ? localStorage.setItem('admin_token', v) : localStorage.removeItem('admin_token'); },
};

// localStorage is shared across same-origin tabs, so logging in as someone else in
// another tab silently swaps the token under this one — periodic refreshes then mix
// the old identity's page with the new identity's data. The storage event fires only
// in the OTHER tabs (never the writer), so reload this tab whenever its panel's token
// slot changes and let the app re-mount as the current login.
window.addEventListener('storage', (e) => {
  const slot = window.location.pathname.startsWith('/admin') ? 'admin_token' : 'token';
  if (e.key === null /* localStorage.clear() */ || e.key === slot) window.location.reload();
});

async function call(method, path, body, token, scope = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.code = data?.error?.code || 'HTTP_' + res.status;
    err.status = res.status;
    err.fields = data?.error?.fields;
    // Session expired (distinct from wrong-PIN 401s): drop the dead token and land
    // on the matching login page.
    if (err.code === 'SESSION_EXPIRED' && scope) {
      tokens[scope] = null;
      window.location.href = scope === 'admin' ? '/admin/login' : '/login';
    }
    throw err;
  }
  return data;
}

// ── Impersonation guard: when an admin runs the user panel via "כניסה בשמו"
// (the token carries `imp`), every mutation must be confirmed before it is
// sent — the change lands on someone else's account. The React shell registers
// a modal-based confirmer; window.confirm is the fallback so the guard can
// never silently fail open. One confirmation covers the burst of requests a
// single click can fan out into (e.g. deleting a merged schedule group) via a
// short sliding grace window.
let confirmMutation = null;
export const registerMutationConfirm = (fn) => { confirmMutation = fn; };

export const isImpersonating = () => {
  try {
    return !!JSON.parse(atob(tokens.user.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).imp;
  } catch { return false; }
};

let guardOkUntil = 0;
async function guardedCall(method, path, body) {
  if (isImpersonating()) {
    if (Date.now() > guardOkUntil) {
      const ok = confirmMutation
        ? await confirmMutation()
        : window.confirm('מצב התחזות — השינוי יחול על חשבון המשתמש. להמשיך?');
      if (!ok) {
        const err = new Error('הפעולה בוטלה');
        err.code = 'IMPERSONATION_CANCELLED';
        throw err;
      }
    }
    guardOkUntil = Date.now() + 2500;
    try {
      return await call(method, path, body, tokens.user, 'user');
    } finally { guardOkUntil = Date.now() + 2500; }
  }
  return call(method, path, body, tokens.user, 'user');
}

export const api = {
  get: (p) => call('GET', p, undefined, tokens.user, 'user'),
  post: (p, b) => guardedCall('POST', p, b),
  put: (p, b) => guardedCall('PUT', p, b),
  patch: (p, b) => guardedCall('PATCH', p, b),
  del: (p) => guardedCall('DELETE', p),
};

export const adminApi = {
  get: (p) => call('GET', '/admin' + p, undefined, tokens.admin, 'admin'),
  post: (p, b) => call('POST', '/admin' + p, b, tokens.admin, 'admin'),
  patch: (p, b) => call('PATCH', '/admin' + p, b, tokens.admin, 'admin'),
  put: (p, b) => call('PUT', '/admin' + p, b, tokens.admin, 'admin'),
  del: (p) => call('DELETE', '/admin' + p, undefined, tokens.admin, 'admin'),
};

export const publicApi = {
  get: (p) => call('GET', p, undefined, null),
  post: (p, b) => call('POST', p, b, null),
};

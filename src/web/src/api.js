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

export const api = {
  get: (p) => call('GET', p, undefined, tokens.user, 'user'),
  post: (p, b) => call('POST', p, b, tokens.user, 'user'),
  patch: (p, b) => call('PATCH', p, b, tokens.user, 'user'),
  del: (p) => call('DELETE', p, undefined, tokens.user, 'user'),
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

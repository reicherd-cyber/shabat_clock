// Same-origin API client [D27]. Separate token slots for the user and admin panels.
const BASE = '/api/v1';

export const tokens = {
  get user() { return localStorage.getItem('token'); },
  set user(v) { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); },
  get admin() { return localStorage.getItem('admin_token'); },
  set admin(v) { v ? localStorage.setItem('admin_token', v) : localStorage.removeItem('admin_token'); },
};

async function call(method, path, body, token) {
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
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => call('GET', p, undefined, tokens.user),
  post: (p, b) => call('POST', p, b, tokens.user),
  patch: (p, b) => call('PATCH', p, b, tokens.user),
  del: (p) => call('DELETE', p, undefined, tokens.user),
};

export const adminApi = {
  get: (p) => call('GET', '/admin' + p, undefined, tokens.admin),
  post: (p, b) => call('POST', '/admin' + p, b, tokens.admin),
  patch: (p, b) => call('PATCH', '/admin' + p, b, tokens.admin),
  put: (p, b) => call('PUT', '/admin' + p, b, tokens.admin),
  del: (p) => call('DELETE', '/admin' + p, undefined, tokens.admin),
};

export const publicApi = {
  get: (p) => call('GET', p, undefined, null),
  post: (p, b) => call('POST', p, b, null),
};

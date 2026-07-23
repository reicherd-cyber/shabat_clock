// Minimal service worker — exists only to satisfy Chrome's install-as-app
// requirement (a registered SW with a fetch handler). Deliberately does NOT cache
// anything: this is a live control panel (device state, schedules), not content
// that should ever be served stale.
//
// The fetch handler is intentionally EMPTY — it must not call respondWith().
// A pass-through respondWith(fetch(req)) makes the worker a single point of
// failure: any rejection inside the worker surfaces as ERR_FAILED / "Failed to
// fetch" for the whole site (bit us on a filtered/flaky line, 2026-07-24).
// With no respondWith, the browser handles all requests natively.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

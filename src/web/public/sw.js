// Minimal service worker — exists only to satisfy Chrome's install-as-app
// requirement (a registered SW with a fetch handler). Deliberately does NOT cache
// anything: this is a live control panel (device state, schedules), not content
// that should ever be served stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

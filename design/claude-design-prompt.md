# Claude Design Prompt

Use this prompt with Claude to generate or refine the Shabat Clock web-panel design.

```text
You are designing the web UI for "Shabat Clock", an IVR-first smart relay scheduling system for kosher-phone users.

Context:
- Product: users call an IVR to turn relays on/off or create weekly schedules; a secondary Hebrew web panel lets them manage devices, relays, schedules, phones, PIN, and history.
- Audience: Hebrew-speaking users, many primarily use kosher phones. The web panel must be simple, calm, mobile-first, RTL, and highly scannable.
- Tech target: React + Tailwind, served inside the same Express app. Use semantic component structure that can be implemented cleanly.
- Existing visual reference: `design/mockup-user-dashboard.html`.
- Main spec: `SPEC.md`, especially REST API sections 3.2/3.3 and Web Panels section 7.

Design language:
- Direction: RTL (`dir="rtl"`), Hebrew UI text.
- Feel: practical, warm, trustworthy, not flashy. This is an operational control panel, not a marketing site.
- Use the existing warm Claude-like palette from the mockup: warm cream background, white surfaces, warm near-black text, terracotta accent, olive success/online, brick error/offline, subtle borders.
- Typography: Hebrew-friendly sans for UI, optional Hebrew serif for page titles/brand only.
- Mobile-first. Desktop should use the extra width for denser layout, not decorative empty space.
- Avoid gradients, decorative blobs, hero sections, and marketing copy.
- Do not put cards inside cards. Cards are allowed for individual devices, schedule rows, history rows, and modals.

Required user-panel screens:
1. Login
   - Phone input.
   - OTP code state.
   - Loading, bad code, rate limited, and locked-out states.

2. Dashboard (`GET /devices`)
   - Device list with online/offline state, last seen, sync status.
   - Nested relay controls with name, current state, IVR digit, enabled/disabled state.
   - Toggle behavior: optimistic-off; show spinner while waiting for the 5s command result; then show acked/failed truth.
   - Clear offline/error feedback without alarming visual noise.

3. Schedules
   - Weekly and once schedule list.
   - Add/edit schedule flow: relay, ON day/time or date/time, OFF day/time or date/time.
   - Warning badge for overlapping schedules on same relay, but do not block.
   - Disabled and sync-pending/sync-error states.

4. History
   - Merged activity feed: commands and IVR calls.
   - Show source, relay name where relevant, status, time, and call outcome/menu path where relevant.
   - Cursor pagination / load more.

5. Settings
   - Manage caller-ID phones: verified/unverified, add phone, verify OTP, delete phone, cannot delete last verified phone.
   - Change PIN.
   - Relay management: rename, IVR digit, enabled state, sort order, boot behavior.

Required admin-panel screens:
1. Admin login.
2. Users: list, create/edit, suspend, max devices, notes, IVR code, PIN reset, impersonate.
3. Devices: list, provision device, set UID, rotate secret, relay count/profile handling, assign/reassign user.
4. Relay admin: create/revive/delete relay rows, channel number, IVR digit, enabled state, boot behavior.
5. Monitoring: online devices, pending/failed commands, sync errors, auth failures, broker health.
6. Call logs.
7. Schedules by user.
8. Settings and admins.
9. Audit log.

Important behavioral constraints:
- Never expose raw secrets except provisioning/rotate modal exactly once.
- Provisioning modal must force an "I saved it" confirmation before close.
- Support admins are read-only everywhere.
- User schedule delete and relay delete are soft-delete concepts; UI should say remove/archive, not imply destructive database erasure.
- All ownership/security failures should feel generic: do not reveal foreign resources.
- Error states should map naturally to API codes: VALIDATION, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, RATE_LIMITED.

Deliverables:
- Provide a complete design direction and component inventory.
- Provide screen-by-screen layout notes for mobile and desktop.
- Include Hebrew sample copy for labels, buttons, empty states, errors, and success toasts.
- Include state tables for dashboard relay toggle, phone verification, schedule sync, and provisioning modal.
- Include Tailwind-friendly design tokens: colors, spacing, radius, shadow, typography.
- Do not generate a marketing landing page. Start with the actual app experience.
```

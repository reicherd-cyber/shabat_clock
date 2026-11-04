# The guardian — alerts, lockdown, recovery (2026-11-04)

`src/monitor/guardian.js` watches the signals the system already records and, on the
primary instance only, evaluates its rules once a minute:

| rule | window | warn (email) | critical (lockdown) |
|---|---|---|---|
| admin login failures (`auth_failures` kind admin_login) | 10 min | 10 | 40 |
| forged webhook calls (WhatsApp signature / IVR token) | 10 min | 20 | — |
| a change to the admins table (create / update) | each | always | — |
| impersonation burst | 10 min | 6 | — |
| relay command flood from one source (not the scheduler) | 5 min | 40 | 150 |
| AI spend | 1 h | $5 | — |
| office-secretary writes | 10 min | 25 | 80 |
| a security-sensitive setting changed (security.*, whatsapp.secretary/menu/ignore, ivr.dev_forward/agent/service, ai.budget) | each | always | — |

Thresholds are the `security.*` settings (editable in the panel). A hit is a row in
`security_events` and one email to every active superadmin per rule per hour (the
"always" rules report each audit row once).

**Lockdown** (critical): `security.lockdown` holds the state; every admin API request
answers 423 LOCKDOWN, every admin session is invalidated, the WhatsApp office secretary
refuses to write, impersonation is refused (it is an admin route). The phone line has no
admin door at all. Customers, the phone line, the devices and the scheduler are untouched.

**Recovery**: the alert email carries a one-time unlock link (24 h) —
`/api/v1/admin/security/unlock?token=…` — and the server CLI works without a token:

    cd /opt/shabat_clock && node scripts/guardian.mjs status | lock "reason" | unlock | check

A change to an admin row (role, active flag, phone, name) is audited with the previous
values, and the alert email offers a one-click revert link per change
(`/api/v1/admin/security/revert/<audit id>?token=…`, signed per row, 24 h).

The guardian cannot see what it has no record of: traffic that never reached the app,
or a compromised server account. It is a tripwire on the application's own doors.

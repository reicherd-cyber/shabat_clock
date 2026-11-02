# WhatsApp bot — Meta Cloud API setup

The bot lives in `src/whatsapp/` and answers on the business number. A customer
whose number is a **verified phone on their account** can send free-text
commands ("כבה את הסלון", "הדלק את הפלטה מחר ב-7:00", "עצור את התוכנית של שבת"),
confirms with a button, and the order runs through the same services as the
site and the phone line. Everyone (registered or not) can ask questions; what
the support bot can't answer becomes a ticket in `/admin/support` with a
WhatsApp badge, and the admin's reply is pushed back into the chat.

Nothing is sent while `WHATSAPP_TOKEN` is blank — replies are printed to the
server console, which is how you test locally.

## 1. Meta side (one time, ~30 min + verification wait)

1. **Meta Business account** — business.facebook.com → create (or use) the
   TelTech business. Business verification (documents) is needed before the
   number can message real customers beyond the test allowance.
2. **Meta app** — developers.facebook.com → Create app → type *Business* →
   add the **WhatsApp** product.
3. **Phone number** — WhatsApp → API Setup → *Add phone number*. For the
   landline **04-3131481** choose *verify by voice call*. Meta calls the
   number and reads a 6-digit code: route the line to a phone you can answer
   (Yemot: temporary forward on the number, or listen to the call recording)
   for the few minutes of verification. The number must not be registered in
   the WhatsApp / WhatsApp Business **app**; a Cloud-API number can't also be
   used in an app.
4. Note from the API Setup page:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** (not needed by the code, keep for reference)
5. **Permanent token** — Business settings → Users → *System users* → add a
   system user (admin) → *Generate token* for the app with permissions
   `whatsapp_business_messaging` + `whatsapp_business_management`, expiry
   *never* → `WHATSAPP_TOKEN`. (The temporary token on the API Setup page dies
   after 24 h — don't deploy it.)
6. **App secret** — App settings → Basic → *App secret* → `WHATSAPP_APP_SECRET`.
   Every webhook POST is checked against it; in production an unsigned request
   is refused.
7. Pick any random string for `WHATSAPP_VERIFY_TOKEN` (e.g. `openssl rand -hex 16`).

## 2. Server side

Add to `/opt/shabat_clock/.env` (and `/opt/shabat_clock-dev/.env` for staging):

```
WHATSAPP_TOKEN=EAAB...
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_VERIFY_TOKEN=<random>
WHATSAPP_APP_SECRET=<app secret>
```

Deploy (migration 59 creates `whatsapp_sessions`, `whatsapp_messages`, adds the
`whatsapp` source/actor values and the editable `whatsapp.*` texts in הגדרות)
and restart pm2. Nginx already proxies everything to the app, so the webhook
URL is simply:

```
https://kosher-teltech.com/whatsapp/webhook        (prod)
https://dev.kosher-teltech.com/whatsapp/webhook    (staging)
```

## 3. Webhook subscription

Meta app → WhatsApp → Configuration → **Webhook** → Edit:

- Callback URL: the URL above
- Verify token: the `WHATSAPP_VERIFY_TOKEN` value
- *Verify and save* — the server answers the `hub.challenge` handshake
  (`GET /whatsapp/webhook`).
- Then **Manage** → subscribe to the `messages` field.

## 4. Test

1. From the API Setup page send the "hello_world" template to your own phone
   (adds your number to the test allowance) — or just write to the business
   number from WhatsApp.
2. Write **שלום** → greeting with the capabilities (registered number) or the
   "number not registered" text.
3. Write **מצב** → channel status list.
4. Write **כבה את הסלון** → confirm buttons → tap אישור → result line per
   channel, with the meter verdict (same as the IVR).
5. Write **למה המכשיר מנותק?** → support answer, or the hand-off text and a new
   ticket in `/admin/support` (filter: וואטסאפ). Answer it there — the reply
   lands in the chat.

Every message in and out is in `whatsapp_messages`; actions show in the
action log (יומן פעולות) and in history with the וואטסאפ source.

## Limits to know

- **24-hour window**: Meta allows free-form replies only within 24 h of the
  customer's last message. An admin reply later than that fails (recorded in
  `whatsapp_messages.status = failed`); a pre-approved *message template* would
  be needed for that case — not implemented yet.
- Free tier: service conversations (customer-initiated) are free up to the
  monthly allowance; the first 1,000 are free, beyond that per-conversation
  pricing applies.
- Per-sender guard: 12 messages/minute, then dropped silently.

## Voice notes (2026-11-01)

A customer's voice note is downloaded from Meta, transcribed through a Whisper-style
speech-to-text endpoint (`STT_URL`, `STT_API_KEY`, `STT_MODEL`, `STT_LANGUAGE=he` in
`.env`; OpenAI `whisper-1` / `gpt-4o-mini-transcribe`, or Groq `whisper-large-v3` at
`https://api.groq.com/openai/v1/audio/transcriptions`) and then handled exactly like the
same words typed — the menu, the free-text router, the order interpreter. The inbound
log keeps the transcript with a 🎤 prefix. Without a key the bot answers "text only", as
before. Unknown numbers are never transcribed (a paid call per note).

## The secretary (2026-11-02)

A superadmin whose own phone is set on their admin row (`admins.phone`, PATCH /admins/:id)
gets the office secretary on WhatsApp: **every** message from that number — text or a
voice note — goes to `services/secretary.js`, a tool-using Claude agent with full access
to leads, orders, payments, the ledger, the task board, the support inbox, customer
accounts and the admin's own devices. A clear instruction is read back with confirm
buttons and carried out on the admin's yes. The confirm binds execution to the proposal:
a write the model asks for is never run in that turn — the tool call is recorded, the
read-back is generated from its arguments, the recorded calls are stored on the WhatsApp
session (state CONFIRM, 10-minute TTL) only once the read-back was delivered, and the
yes replays exactly those calls with no model in between. An unclear request gets one
short question; questions are answered at once. The
chat log (`whatsapp_messages`, last 6 hours) is replayed as its memory, so a bare "6000"
answers "what is the amount?" and "cancel that" finds the id in the secretary's last
line. Writes use the same `services/crm.js` / `services/finance.js` / SQL as the panel,
stamped `admin:<id>` and audited; `עזרה` lists examples; a leading `#` is tolerated.
Model calls are capped at 300 per admin per day (`nlu_usage` kind `admin`).

On the phone the same number hears "למנהל, הקישו 8" — the structured assistant in
`services/adminAssistant.js` (one action, read back, key 1 to confirm).

## The customer's secretary (2026-11-03)

Registered numbers listed in the setting `whatsapp.secretary_phones` ('' = nobody,
'*' = everybody) talk to `services/userSecretary.js` instead of the greeting / status /
command / question paths: a tool-using agent that sees only the sender's own account —
relays and live state, plans, the next days' firings, history, their tickets — plus the
product knowledge base. The only change it can propose is a switch (on/off now, pause or
resume a plan): the words go to the command interpreter, whose validated actions are
stored on the session and run through the same confirm buttons and `executePending` as a
typed order. A standing weekly timing or deleting a timing is refused (the app does that). Every tool
takes the user from the verified sender; none has a user argument
(test/user-secretary.test.js). Model calls are logged under `nlu_usage` kind
`secretary` and count against the per-user AI budget.

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

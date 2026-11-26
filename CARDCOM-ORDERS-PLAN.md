# Orders + Cardcom payments — build plan

> Draft plan (2026-11-26). Keys to be supplied later. Nothing built yet.
> Current state: `crm_orders` + `crm_payments` exist (migration 30) but payments
> are **manual records only** (cash/credit/bit logged by hand) — no gateway, links,
> invoices, refunds, or card-charging code.

## 0. Core architecture decision
Use Cardcom's **LowProfile hosted payment page**, never raw card handling. Cardcom's
own docs say websites must use LowProfile, not the direct card API.
- The customer types their card on **Cardcom's** page (iframe/redirect) — card data
  **never touches our server** (lowest PCI scope, SAQ-A). Also respects our own rule
  that we never enter card data; the customer does, on the gateway.
- Flow: `POST /api/v11/LowProfile/Create` → we get a `Url` → customer pays → Cardcom
  **redirects** the browser to our success/fail page **and** POSTs a server-to-server
  **webhook**. **Do not trust the webhook body** — verify via `LowProfile/GetLpResult`;
  success = `ResponseCode == 0`.
- Base URL `https://secure.cardcom.solutions/api/v11/`; test terminal `1000`.

## 1. Phased delivery
- **Phase 1 — one-time card charge on an order** (the 80%): generate payment link →
  customer pays → webhook + verify → mark paid → auto-issue invoice → show on
  order/contact card. Build against **test terminal 1000** first.
- **Phase 2 — refunds** (admin "זיכוי", full/partial) + invoice credit-note.
- **Phase 3 — saved card / recurring** (`ChargeAndCreateToken` + token charges via
  `Transactions/Transaction`) — for device subscriptions / הוראת קבע, if wanted.
- **Phase 4 — reconciliation & polish**: a sweep that reconciles orphaned/pending
  transactions (webhook never arrived) via `GetLpResult`, plus reporting into the
  existing finance pages.

## 2. Data model (new tables + reuse)
Keep `crm_orders` / `crm_payments` as the **money ledger** (order balance = amount −
Σ payments). Add gateway-side tables:
- **`cardcom_transactions`** — one row per LowProfile session / charge: `order_id`,
  `crm_payment_id` (null until paid), `lowprofile_id` (unique), `operation`, `amount`,
  `status` (pending/paid/failed/refunded), `tranzaction_id`, `return_value`,
  `approval_number`, `last4`, `card_brand`, `num_payments`, `invoice_doc_type`,
  `invoice_number`, `invoice_url`, `token_id` (null), `response_code`, `response_desc`,
  `raw_json`, timestamps, stamps.
- **`cardcom_webhook_events`** — idempotency/audit: `lowprofile_id` (unique),
  `received_at`, `processed_at`, `raw_json`. Guarantees Cardcom's **7 retries** can't
  double-apply a payment.
- **`cardcom_tokens`** (Phase 3) — saved cards: `lead_id`/`user_id`, `token`
  (**encrypted**), `last4`, `card_exp_mmyy`, `brand`, label.
- A **successful charge writes a `crm_payments` row** (`method='credit'`, already
  exists) linked to the transaction — manual + card payments coexist, existing balance
  logic untouched. A **refund writes a negative `crm_payments` row** + a refund
  transaction.

## 3. Config & secrets
- **Secrets in env, encrypted at rest** (reuse `secretbox.js`): `CARDCOM_TERMINAL`,
  `CARDCOM_API_NAME`, `CARDCOM_API_PASSWORD`. Server-side only; never to the browser;
  never in logs (mask).
- **Settings** (non-secret, hot-editable): `cardcom.enabled`, `cardcom.test_mode`
  (terminal 1000 vs live), `cardcom.document_type` (e.g. `TaxInvoiceAndReceipt`),
  `cardcom.is_vat_free`, `cardcom.business_name/tax_id`, `cardcom.default_language`.

## 4. Backend service (`services/cardcom.js`)
Thin HTTP client + typed methods, with **pure, unit-tested helpers** (amount
formatting, success check, idempotency key, webhook correlation):
- `createPaymentPage({orderId, amount, customer, operation, document})` →
  `{lowProfileId, url}`; sets `ReturnValue=<transaction id>`, `WebHookUrl`,
  `SuccessRedirectUrl`, `FailedRedirectUrl`, `Document{…}`.
- `getLpResult(lowProfileId)` → verified result (source of truth).
- `chargeToken({token, amount, externalUniqTranId, document})` (Phase 3) —
  `ExternalUniqTranId` is Cardcom's idempotency key (dup → error 608).
- `refund({tranzactionId, amount, document})` (Phase 2) — needs `ApiPassword`;
  credit-note document. ⚠️ confirm exact refund endpoint/partial support against
  Cardcom Swagger (`/Api/v11/Docs`) before coding — public docs were thin on it.
- Central error mapping (Cardcom `ResponseCode`/`Description` → friendly Hebrew),
  timeouts, retries where safe.

## 5. One-time charge flow (Phase 1)
1. Admin opens an order → **"גבה תשלום בכרטיס"** → backend creates a
   `cardcom_transactions` (pending) + calls `LowProfile/Create` → returns the pay `Url`.
2. **Send the link to the customer** — copy / email (reuse `email_log`/Resend) / SMS
   (Yemot) / WhatsApp.
3. Customer pays on Cardcom's page → Cardcom redirects to **our `/pay/ok` / `/pay/fail`**
   (branded, mobile-fit) **and** POSTs the **webhook**.
4. **Webhook endpoint** (`POST /api/v1/cardcom/webhook`, public, no admin auth): record
   the event (idempotent on `lowProfileId`), call **`GetLpResult`** to verify, and on
   `ResponseCode==0`: flip transaction→paid, store `tranzaction_id`/`last4`/`approval`/
   `invoice_url`/token, **insert the `crm_payments` row**, recompute order balance, mark
   order delivered/paid if fully paid, **audit + alert admin**. Return `200` fast.
5. **Reconcile sweep** (tick, prod): any `pending` transaction older than N minutes →
   `GetLpResult` to catch a missed webhook.

## 6. Invoices (חשבונית)
Pass a **`Document` object** on the charge → Cardcom auto-issues the חשבונית מס/קבלה and
returns `DocumentUrl`, which we store and surface (view/resend). Items in
`Document.Products` must **sum to the charged amount**. You decide default document type
and VAT treatment.

## 7. Refunds (Phase 2)
Admin "זיכוי" on a paid payment → `refund(...)` (full/partial) → credit-note document →
negative `crm_payments` row + refund transaction. **Guardrails:** superadmin/
`requireWrite`, a **confirm modal** stating amount + that it's a real money movement +
that it can't be undone, and an audit entry (existing money-action/confirm conventions).

## 8. UI
- **Admin** (order on CRM + contact card): "גבה בכרטיס" → link/send; live payment
  status; invoice link; "זיכוי"; payments list shows `credit` with card last-4 +
  invoice. **Money colors** (green in / red refunds) and **mobile-fit** per conventions.
- **Customer**: Cardcom's page + our branded `/pay/ok` & `/pay/fail`.

## 9. Security & compliance
- PCI SAQ-A (hosted page; no card data server-side, no CVV stored, tokens encrypted).
- Webhook is public **but verified via GetLpResult** — never trust the POST body;
  idempotent; correlation via `ReturnValue` + `lowProfileId`.
- Keys encrypted, server-only, masked in logs; test vs live clearly separated.
- Every charge/refund **audited + stamped**; access gated (superadmin).
- Amounts as `DECIMAL`; ⚠️ confirm the shekels-vs-agorot ambiguity in Cardcom's docs
  before any real charge.

## 10. Infra / env
- Cardcom needs **public HTTPS** webhook + redirect URLs (no localhost). Dev/staging:
  `dev.kosher-teltech.com`; prod: `kosher-teltech.com` (Cloudflare-proxied inbound ok).
  Confirm Cardcom can reach them.
- Start on **test terminal 1000**; swap to live keys in prod `.env` at go-live.

## 11. Testing & rollout
- Unit tests for the pure helpers (amount, success check, idempotency, webhook
  correlation).
- End-to-end on test terminal (success, decline, missed-webhook reconcile, refund,
  double-webhook).
- Rollout: build+verify on **dev/test terminal** → live keys in prod → one small real
  charge → enable. Nothing to master until the user says "deploy to master."

## 12. What I need from you (to start / to go live)
1. **Keys**: `TerminalNumber`, `ApiName`, `ApiPassword` (+ confirm a sandbox/test
   terminal from Cardcom, or we use 1000).
2. **Invoices**: which document type (חשבונית מס/קבלה vs קבלה), VAT handling
   (`IsVatFree`?), and the **business details** to print (name, ע.מ/ח.פ).
3. **Features**: installments (תשלומים)? saved cards / recurring (Phase 3)?
4. **Link delivery**: which channels — copy / email / SMS / WhatsApp?
5. Scope: CRM leads' orders (current `crm_orders`), app **users** (device
   subscriptions), or both?

## Sources
- Cardcom KB — Create Payment Page & Retrieve Transaction:
  https://kb.cardcom.solutions/apijosn/en/articles/503/create-payment-page-retrieve-transaction-details
- JSON API / Swagger (`secure.cardcom.solutions/Api/v11/Docs`):
  https://kb.cardcom.solutions/apijosn/en/articles/468/json-api-interface-swagger
- Step 1+2 (he): https://cardcomapi.zendesk.com/hc/he/articles/25264402497426
- Third-party endpoint reference (unofficial; verify refund/field details against
  Swagger): https://github.com/peleg-jpg/cardcom-payment-gateway/blob/main/references/api-endpoints.md

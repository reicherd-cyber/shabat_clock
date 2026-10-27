# מוקד שירות — the complete tree

The one place the service tree is written down. The engine is `src/services/serviceMenu.js`
(one state machine, every channel); the rules are SPEC §10. Keep this file in step with the
code: a node added to the engine is added here in the same commit.

Legend
- ✅ built and in production
- 🔧 built on the dev tree (serviceMenu.js, not yet committed/deployed)
- 🆕 proposed in SPEC §10, not built
- ⚡ action on a device — always confirm first, read back the meter verdict
- 🎫 ends in a ticket (`support_messages`, topic in brackets) with the 3-hour promise
- 🤖 AI touchpoint — metered, never in control (SPEC [CS3]/[CS4])
- 📝 free text asked (only where a digit cannot carry the answer)
- 🔒 registered customers only (verified phone / logged in)

Navigation everywhere: `9` = main menu, `0` on the main menu = a person.

---

## A. The shared menu (site "פניות" 🔧 · WhatsApp 🔧 · phone follows)

```
ראשי  "שלום {שם}, כאן מוקד השירות של TelTech. במה נוכל לעזור?"
│
├─ 1  הזמנה / מכירה                                              🔧
│   ├─ כמה ערוצים?  1 אחד · 2 שניים · 3 שלושה · 4 ארבעה ויותר
│   ├─ (מחיר ל-N ערוצים: ללא / עם התקנה, מתוך settings menu.info.price_table)
│   ├─ מתי נוח שנתקשר?  1 בוקר · 2 צהריים · 3 ערב
│   ├─ 📝 שם מלא            (guests only — a customer's name is known)
│   ├─ 📝 יישוב ההתקנה
│   └─ ✔ "הבקשה נרשמה (מס׳ N). נציג מכירות יחזור ב{מועד}"  → CRM lead (source bot_<channel>)
│
├─ 2  שירות לקוחות
│   ├─ guest  📝 "המספר אינו רשום — כתבו טלפון רשום + הבעיה"    🎫 [service_other]   🔧
│   └─ 🔒 "מה הבעיה?"
│       ├─ 1  המכשיר לא מגיב / מנותק                                            🔧
│       │   ├─ (אין מכשיר → "לחצו 0 לנציג")
│       │   ├─ (כמה מכשירים → "על איזה מכשיר?"  1..n)
│       │   ├─ בדיקה חיה: מחובר?
│       │   │   ├─ כן → "המכשיר מחובר ומגיב ✅ … זה עזר?"  1 עזר · 2 לא עזר → 📝 תיאור 🎫 [service_other]
│       │   │   └─ לא → צעדים 1/3 חשמל · 2/3 אינטרנט · 3/3 ניתוק 10 שנ׳   (1 ביצעתי—בדקו שוב · 0 נציג)
│       │   │        ├─ חזר להיות מחובר → ✔ "חזר ✅. התזמונים ממשיכים"
│       │   │        └─ עדיין לא → "לא נפתר מרחוק — 1 פתיחת פנייה"
│       │   │             🎫 [device_offline] + details {device_id, steps_done, diagnosis verdict/category}
│       │   └─ 🔧 after "לא עזר": 1 לשאול את העוזר 🤖 (one question) · 2 לנציג
│       ├─ 2  תזמון לא פעל                                                      🔧
│       │   ├─ מה קרה?  1 לא נדלק · 2 לא כבה · 3 פעל בשעה לא נכונה
│       │   ├─ באיזה ערוץ?  1..n  (עם שם המכשיר כשיש כמה)
│       │   └─ 🎫 [schedule] + details {relay_id, device_id, problem}
│       │        🆕 enrichment for the agent 🤖: last 48h of that relay's executions + calendar replay attached
│       ├─ 3  איפה ההזמנה שלי                                                  🔧
│       │   ├─ הזמנות פתוחות על המספר → רשימה + "זה עזר?"  1 כן · 2 לא → 📝 🎫 [service_other]
│       │   └─ אין → 📝 "על איזו הזמנה מדובר?"  🎫 [service_other]
│       ├─ 4  משהו אחר  📝 תיאור                                 🎫 [service_other]   🔧
│       │   └─ 🔧 before the ticket: 1 לשאול את העוזר 🤖 · 2 לנציג  (assistant answer → "עזר?" → ticket if not)
│       ├─ 5  בקשה או הצעה לשיפור  📝                             🎫 [feature]         🔧
│       └─ 9  תפריט ראשי
│
├─ 3  מידע כללי                                                   🔧
│   ├─ 1 מחירים · 2 איך זה עובד · 3 התקנה · 4 שעות פעילות ואזורי שירות · 5 הלכה
│   │   (editable texts settings menu.info.*, seeded by migration 75)
│   └─ "זה עזר?"  1 כן → "בשמחה!" · 2 לא → 🎫 [info] (topic only — no free question, no model)
│       🔧 2 לא → 1 לשאול את העוזר 🤖 · 2 לנציג
│
├─ 4  🔒 הדלקה / כיבוי של ערוץ                                   🔧 ⚡
│   ├─ איזה ערוץ?  1..n  (עם המצב: דולק/כבוי)
│   ├─ מה לעשות?  1 הדלקה · 2 כיבוי
│   └─ → channel executes: site = the route itself; WhatsApp = confirm buttons → nluExec
│        read-back: "✅ {ערוץ} הודלק" / "⚠️ המכשיר לא אישר ({סיבה})"
│
├─ 5  🔒 מצב הערוצים                                             🔧
│   └─ "🟢 מטבח – דולק / ⚪ סלון – כבוי …"
│
├─ 6  🔒 🔧 תזמון מהיר                                            ⚡
│   ├─ איזה ערוץ?  1..n
│   ├─ מה?  1 הדלקה · 2 כיבוי
│   ├─ מתי?  1 בעוד שעה · 2 בעוד שעתיים · 3 הערב ב-20:00 · 4 📝 שעה (HH:MM היום)
│   └─ confirm → one-off schedule today (created_via = channel) → "נקבע: {ערוץ} {פעולה} ב-{שעה}"
│
├─ 7  🔒 🔧 התוכניות שלי
│   ├─ רשימה  1..n  "{שם התוכנית} — פעילה/מושבתת"
│   ├─ 1 עצירה · 2 הפעלה   (same as the web toggle: is_enabled per member row, nothing deleted)
│   └─ confirm → "התוכנית {שם} הושבתה / הופעלה"   (exists today as the phone intent plan_toggle ✅)
│
├─ 8  🔒 🔧 מה קורה השבוע / בשבת הקרובה
│   └─ the next 7 days per channel from GET /schedules/calendar (same data as the site's מועדים קרובים ✅):
│      "שבת: מטבח 🟢 18:12 כניסת שבת → ⚪ 20:30 … סלון …"   (read-only, no confirm)
│
├─ 0  נציג אנושי                                                  🔧
│   └─ 🎫 [agent] "הלקוח ביקש נציג — לחזור אליו"  (nothing to type)
│
└─ free text where a digit was expected
    ├─ today 🔧: "לא הבנתי. בחרו מספר מהרשימה" + the same options
    └─ 🔧 router 🤖 (Haiku-class, cached prompt, whitelisted node ids):
         "תכבה את הסלון"      → 4 → switch_action(סלון, כיבוי) → confirm
         "מה המצב"            → 5
         "המכשיר לא עובד"     → 2.1
         "כמה זה עולה"        → 3.1
         "תעצור את תוכנית חג" → 7 → confirm
         not matched / over budget → today's "לא הבנתי" line (never an error)
```

### WhatsApp-specific wrapping around the shared tree

```
inbound message (webhook, signature checked, deduped by wa_message_id)              ✅
├─ ignored senders (Meta notices)                                                    ✅
├─ sender = verified phone → 🔒 customer ; else guest                                ✅
├─ pending confirm? → button/word אישור|ביטול → execute via nluExec / cancel        ✅
├─ confirm word with nothing pending → whatsapp.confirm_expired text                 ✅
├─ greeting ("שלום", "תפריט", "היי" …) → main menu                                    ✅ → 🔧 numbered main menu
├─ "מצב" / "סטטוס" → status list (no model)                                           ✅
├─ digit → engine step                                                                🔧
├─ free text, command-like, 🔒 → today: Opus interpreter → confirm buttons            ✅
│                               🆕: router first (cheap); interpreter only for time expressions
├─ free text, question-like → today: answer bot 🤖 → answer, or ticket                 ✅
│                              🆕: the engine's "לשאול את העוזר" option instead (opt-in, capped)
├─ replies after a ticket: admin answer pushed to the chat inside 24h                 ✅
│                           🆕 template after 24h (needs Meta-approved templates)
└─ 🆕 outbound, consent + template only [CS7]: offline > N h · firmware updated · order delivered · pre-שבת reminder
```

---

## B. Phone IVR 04-3131481 (Yemot) — as it runs today ✅

```
call arrives → caller-ID → verified phone?
│
├─ registered (PIN if require_pin)
│   ראשי
│   ├─ 1  פקודה בקול 🤖  (record ≤30s → STT → Opus interpret → read-back → 1 אישור / 2 ביטול)   ✅
│   │      intents: on/off now · timed on/off · plan stop/start · (status)
│   │      not understood → re-listen ×2 → menu
│   ├─ 2  הדלקה  → ערוץ 01..20 (one relay → skipped) → ack ≤5 s → "בוצע" / "המכשיר לא מחובר"   ✅ ⚡
│   ├─ 3  כיבוי  → same                                                                           ✅ ⚡
│   ├─ 4  תזמונים → browse one by one · delete · weekly add (relay → day → HHMM → day → HHMM → confirm) ✅
│   ├─ 5  מצב   → "מטבח דולק, סלון כבוי…"                                                        ✅
│   ├─ 0  חזרה על התפריט · * חזרה                                                                 ✅
│   └─ 🔧 6  שירות לקוחות → the shared tree node 2 (device check with live verdict, schedule problem, 0 נציג)
│        🔧 7  מה קורה בשבת הקרובה → the shared node 8, spoken
│
└─ unregistered → sales menu (migration 53)                                                      ✅
    ├─ 1  מתעניין בהזמנה  → info + voice message  🎫 [order]
    ├─ 2  הזמנה בתהליך    → voice message          🎫 [order_status]
    ├─ hangup at the beep → voicemail_hangup flag, inbox says "call back"                      ✅
    └─ 🆕 align digits/texts with the shared tree node 1 (channels → time → lead), voice stays for name/city
```

---

## C. Site — "פניות" / help page ✅ (→ 🔧 numbered menu)

```
/help  (round "?" in the header)
├─ 6 topic cards with static self-help steps                                                     ✅
│   מכשיר מנותק (incl. NetFree) · תזמון לא פעל · התחברות · המענה הקולי · האתר והאפליקציה · משהו אחר
├─ free question → answer bot 🤖 (rules → reuse → cached prompt → model) → guide or "לפתוח פנייה"  ✅
├─ 🔧 the numbered menu (POST /support/menu) — the same tree as WhatsApp, actions run in the route
├─ "הפניות שלי": threads, admin replies, user reply re-opens (status new)                          ✅
└─ unread admin answers = red count on the "?"                                                   ✅
```

---

## D. Admin side ✅

```
/admin/support  פניות
├─ inbox: status tiles · filters (status / period / source incl. וואטסאפ / search) · topic labels   ✅
├─ ticket modal: transcript · chat bubbles · reply (email / WhatsApp push ≤24h) · טופלה (confirm)   ✅
├─ tab "שיחות עם הבוט": question, answer, outcome answered/declined/escalated, rules/cache badge, cost ₪ ✅
├─ 🆕 ticket enrichment 🤖 (async, on open): summary · suggested reply draft · urgency · diagnosis block
└─ 🆕 weekly desk numbers: containment · escalations by topic · cost/conversation · time to first reply
/admin/whatsapp  conversations · thread · tiles · chart                                            ✅
/admin/crm       leads from the order branch (source bot_whatsapp / bot_web)                        ✅
settings         menu.info.* · whatsapp.* · ivr.* texts — editable, no deploy                       ✅
```

---

## E. Where the AI sits, and what each call costs (SPEC [CS3]/[CS4])

| # | Touchpoint | Channel | Model class | Guard | Status |
|---|---|---|---|---|---|
| 1 | Free-text router → menu node + slots | WhatsApp, site | Haiku-class, cached prompt | whitelisted nodes, relay re-scoping, confirm | 🔧 |
| 2 | One-question assistant (knowledge base) | all | `SUPPORT_MODEL`, rules → reuse → cache | opt-in after the menu failed, 6/min + daily cap, `can_answer=false` → ticket | 🔧 |
| 3 | Voice interpretation (garbled STT) | phone | Opus-class, cached rules block | confirm read-back, re-listen ×2 | ✅ |
| 4 | Agent-side enrichment | admin | cheapest that passes eval | async, agent sends | 🆕 |
| — | Menu nodes | all | **none** | — | 🔧 |

Budgets: `ai.enabled` kill switch, `ai.budget.daily_usd`, `ai.budget.user_daily` 🔧 (migration 78);
every call logged to `nlu_usage` (source, kind, cost, outcome) ✅.

# TO Assistant v4 — Implementation Plan

**Theme:** *Remembers you + does things for you.*
**Combines:** Thesis A (persistent memory / identity) + Thesis B (transactional actions).
**Owner:** Hemant | **Target:** April–May 2026 | **Baseline:** v3.3.3 (commit `1a95f266`)

---

## 1. What changes between v3 and v4

| Dimension | v3.3.x (today) | v4 (target) |
|---|---|---|
| Memory | In-memory `Map`, wiped on Render restart | Supabase Postgres — survives restarts, scales across instances |
| Identity | Anonymous `ip:…` or client-sent `x-session-id` | Customer recognised by phone / email, linked to Magento customer + order history |
| Personalisation | None | Shoe size, grip, preferred brand, skill level, last sport, last 5 orders auto-hydrated into slots |
| Actions | Read-only (product search, reviews, policy answers) | Read + gated writes (track order, initiate return, book stringing, apply coupon, send payment link) |
| Safety on writes | — | Two-turn confirmation protocol, audit log, per-action feature flag, kill switch env |
| History | Lost on refresh | Conversations + slot snapshots archived per customer |
| Ops surface | 1 service (Express) | 1 service + Supabase + 1 cron (sync Magento orders to Supabase purchase cache) |

A v4 release that only ships one of Thesis A or Thesis B is a v3.4. Shipping both together is what earns the version bump.

---

## 2. Architecture

```
                    ┌─────────────────────────────────────┐
                    │              CLIENT                  │
                    │  chat widget | WhatsApp (future)    │
                    └──────────────┬──────────────────────┘
                                   │  POST /api/chat-agents
                                   │  { messages, session_id, identity? }
                    ┌──────────────▼──────────────────────┐
                    │         Express (server.js)          │
                    │  ┌───────────────────────────────┐   │
                    │  │ 1. identity.resolve()         │   │  ← new
                    │  │ 2. memory.hydrate(customer)   │   │  ← new (replaces session.js)
                    │  │ 3. parser.parseSlots()        │   │
                    │  │ 4. mergeSlots(prior, fresh)   │   │
                    │  │ 5. masterHandle({slots, cust})│   │
                    │  │ 6. memory.persist()           │   │  ← new
                    │  └───────────────────────────────┘   │
                    └──┬─────────────────┬─────────────────┘
                       │                 │
            ┌──────────▼───────┐   ┌─────▼─────────────────────────┐
            │  Supabase (pg)   │   │        Agents (agents.js)      │
            │  - customers     │   │  router → specialist → master  │
            │  - sessions      │   │  NEW: ActionAgent (gated)      │
            │  - messages      │   └─────┬─────────────────────────┘
            │  - purchases     │         │
            │  - actions       │         │  tool-calls
            │  - stringing     │   ┌─────▼──────────────────────────┐
            └──────────────────┘   │   Magento REST                 │
                                   │   Unicommerce REST  (writes)   │
                                   │   Bluedart tracking            │
                                   │   Razorpay payment links       │
                                   └────────────────────────────────┘
```

Two tracks run in parallel: the **memory track** (Thesis A) and the **action track** (Thesis B). Memory ships first because actions without identity are meaningless (every write needs to be attributed).

---

## 3. Track A — Persistent memory & identity

### 3.1 Data model (Supabase Postgres)

```sql
-- Customers: identity root. One row per real human.
create table customers (
  id                   uuid primary key default gen_random_uuid(),
  magento_customer_id  int  unique,
  email                text unique,
  phone                text unique,
  first_name           text,
  last_name            text,
  -- learned preferences (populated by parser + manual confirmation over time)
  shoe_size            numeric,
  grip                 text,
  preferred_brand      text,
  skill_level          text,
  preferred_sport      text,
  last_max_price       int,
  -- metadata
  consent_personalise  boolean default true,  -- opt-out switch
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  last_seen_at         timestamptz
);
create index on customers (phone);
create index on customers (email);
create index on customers (magento_customer_id);

-- Sessions: one per browser/WhatsApp thread, may belong to a customer once identified.
create table sessions (
  id            text primary key,            -- x-session-id or derived
  customer_id   uuid references customers(id) on delete set null,
  slots         jsonb default '{}'::jsonb,
  last_shown    jsonb default '[]'::jsonb,
  turns         int  default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index on sessions (customer_id);
create index on sessions (updated_at);

-- Messages: append-only conversation log.
create table messages (
  id           bigserial primary key,
  session_id   text references sessions(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  role         text check (role in ('user','assistant','tool','system')),
  content      text,
  intent       text,
  slots        jsonb,
  tool_name    text,
  tool_args    jsonb,
  tool_result  jsonb,
  created_at   timestamptz default now()
);
create index on messages (session_id, created_at);
create index on messages (customer_id, created_at desc);

-- Purchases: local cache of Magento orders (for fast lookup + personalisation).
create table purchases (
  id                bigserial primary key,
  customer_id       uuid references customers(id) on delete cascade,
  magento_order_id  text,
  sku               text,
  name              text,
  qty               int,
  price             numeric,
  ordered_at        timestamptz,
  status            text,
  awb               text
);
create index on purchases (customer_id, ordered_at desc);
create unique index on purchases (magento_order_id, sku);

-- Actions: every write attempt (proposed → confirmed → executed).
create table actions (
  id                  bigserial primary key,
  session_id          text,
  customer_id         uuid references customers(id),
  action              text,    -- 'track_order','initiate_return','book_stringing','apply_coupon','send_payment_link','place_order'
  params              jsonb,
  result              jsonb,
  status              text check (status in ('proposed','confirmed','executed','failed','cancelled')) default 'proposed',
  confirmation_token  text unique,
  created_at          timestamptz default now(),
  confirmed_at        timestamptz,
  executed_at         timestamptz,
  failed_reason       text
);
create index on actions (session_id, created_at desc);
create index on actions (customer_id, created_at desc);
create index on actions (status) where status in ('proposed','confirmed');

-- Stringing bookings (simple internal calendar).
create table stringing_bookings (
  id               bigserial primary key,
  customer_id      uuid references customers(id),
  racquet          text,
  string_sku       text,
  tension_main     int,
  tension_cross    int,
  slot_start       timestamptz,
  slot_end         timestamptz,
  status           text default 'pending',
  notes            text,
  created_at       timestamptz default now()
);
```

### 3.2 Identity resolution flow

```
Incoming POST /api/chat-agents
│
├─ Extract candidate identifiers from message and headers:
│   • phone regex:   /\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/
│   • email regex:   standard RFC5322-ish
│   • x-session-id:  persistent anon id
│   • customer hint: { phone, email } posted by widget on login
│
├─ If phone or email present:
│     1. SELECT * FROM customers WHERE phone=? OR email=?
│     2. If miss → call Magento /V1/customers/search?searchCriteria…
│        → on hit, INSERT INTO customers(magento_customer_id, email, phone, first_name, last_name)
│        → kick off async purchases sync (last 20 orders)
│     3. Set session.customer_id = customers.id
│
├─ memory.hydrate(customer) returns slot defaults:
│     { size: customer.shoe_size,
│       brand: customer.preferred_brand,
│       sport: customer.preferred_sport,
│       skill_level: customer.skill_level }
│
├─ mergedSlots = mergeSlots(sessionSlots, hydratedSlots, freshParsedSlots)
│   (precedence: fresh > session > hydrated — never override what the user just said)
│
└─ Pass mergedSlots + customer context to masterHandle()
```

### 3.3 Privacy & consent

1. **Opt-out first-class.** `customers.consent_personalise=false` disables hydration; the bot behaves as if anonymous.
2. **Minimal log retention.** `messages` table rolls forward — nothing deleted but `content` is TOXIC-SCRUBBED (phone, email, order id) before write.
3. **No credentials in messages ever.** Parser strips anything looking like a card number or password; messages are refused.
4. **Export / delete endpoints.** `/api/privacy/export?phone=…` (GDPR-like) and `/api/privacy/delete?phone=…` — token-gated admin-only.

### 3.4 Files / modules

```
/db.js              new — Supabase client singleton, connection pool
/memory.js          new — customers + sessions + messages + purchases helpers
/identity.js        new — phone/email extraction, Magento customer lookup, hydration
/session.js         REMOVED — replaced by memory.js with identical interface
/server.js          UPDATED — /api/chat-agents wiring
/migrations/        new — SQL migration files (v4.0_init.sql, v4.1_actions.sql, …)
/scripts/purchase_sync.js   new — cron job, every 30 min, syncs recent orders
```

### 3.5 Backward compatibility

`session.js` keeps its module shape (`get`, `update`, `reset`, `stats`, `fallbackId`) so `agents.js` doesn't care whether the store is in-memory or Postgres. The swap is transparent. If Supabase is down, fallback is in-memory-only (log a warning, don't crash).

---

## 4. Track B — Transactional actions

### 4.1 Two-turn confirmation protocol

**Every write** follows this pattern. No exceptions. The validator blocks any response that claims to have executed a write without a confirmed `actions.status='confirmed'` row.

```
Turn N   user:   "return my last order"
Turn N   bot  :  "I can start a return for order #400020695 — Babolat Pure Aero,
                 ₹16,990, delivered Mar 4. Reason required (damaged / wrong item /
                 changed mind). Reply **confirm return RET-7H3K** to proceed, or
                 **cancel** to abort. Link expires in 10 minutes."
                 [actions row inserted with status='proposed', token='RET-7H3K']

Turn N+1 user:   "confirm return RET-7H3K reason: damaged"
Turn N+1 bot  :  [server validates token + customer_id match + <10 min age]
                 [calls Unicommerce create-return API]
                 [updates actions.status='executed', stores result]
                 "Return initiated. Reference: RTN-2026-04-901. Pickup scheduled
                 in 24–48 hours; you'll get an SMS from BlueDart."
```

**Why a token, not just "yes"?** Because the next user turn could be about something unrelated, an injection attack could slip a "yes" into observed content, and one session can have multiple pending actions. Token pairs the confirmation with the specific proposed action.

### 4.2 Action catalogue (phased)

| # | Action | Risk | API | Ships in |
|---|---|---|---|---|
| 1 | `track_order` | Read | Magento `/V1/orders/{id}` + BlueDart `/track` | v4.0 |
| 2 | `list_my_orders` | Read | SELECT from `purchases` | v4.0 |
| 3 | `get_my_preferences` | Read | SELECT from `customers` | v4.0 |
| 4 | `update_my_preferences` | Low (self-data only) | UPDATE customers | v4.0 |
| 5 | `book_stringing` | Low (internal booking, no $) | INSERT stringing_bookings + email staff | v4.1 |
| 6 | `apply_coupon_to_cart` | Medium | Magento `/V1/carts/mine/coupons/{code}` | v4.1 |
| 7 | `initiate_return` | Medium ($) | Unicommerce return API | v4.2 |
| 8 | `send_payment_link` | Medium-High ($) | Razorpay `/v1/payment_links` | v4.2 |
| 9 | `place_order` | Highest ($$) | Magento `/V1/carts/mine/order` | v4.3 (behind flag) |

Actions 1–4 ship on v4.0 alongside memory. They prove the audit + confirmation flow without any real financial risk.

### 4.3 ActionAgent — agent contract

```js
// agents.js (additions)
action: `You are ActionAgent for TennisOutlet. You handle write-requests to the store
on behalf of an identified customer.

HARD RULES:
1. Every write requires a two-turn confirmation. Your first turn PROPOSES, your
   second turn EXECUTES only after the user replies with the confirmation token.
2. You MUST call propose_action tool first. Never call execute_action without a
   valid confirmation_token that matches the previous proposal.
3. If the customer is not identified (customer_id missing), you refuse and ask
   for phone or email first.
4. If the action's feature flag is off in env (WRITES_ENABLED=false or
   ACTION_<NAME>_ENABLED=false), you refuse and explain the feature is not live yet.
5. You NEVER invent an order id, return reference, AWB, or payment amount.
   All such values come from tool results only.

Available tools: propose_action, execute_action, cancel_action, list_my_orders,
get_order_status, track_shipment, get_my_preferences, update_my_preferences.`
```

`propose_action` writes an `actions` row with `status='proposed'` and returns the token. `execute_action(token)` verifies age, customer, status → dispatches to the underlying API → updates the row.

### 4.4 Feature flags

Every action respects three layers of gating, in order of precedence (strictest first):

```
WRITES_ENABLED=false                  # kill switch; disables ALL writes
ACTION_PLACE_ORDER_ENABLED=false      # per-action disable
ACTION_RATE_LIMIT_PER_CUSTOMER=3/h    # per-customer per-hour cap
ACTION_DRYRUN=true                    # propose but don't execute; for staging
```

Kill switch test is the first boot check. If `WRITES_ENABLED=false`, ActionAgent responds to any write intent with: *"Write actions are paused by staff right now — please call +91 9502517700 for anything account- or order-related. Shopping and questions still work."*

### 4.5 Unicommerce integration

Since TO sits behind Unicommerce as the OMS, returns, tracking and inventory should preferably go through Unicommerce not Magento directly (otherwise Unicommerce state drifts).

**Setup (you do this, not me):**
1. Log into `sso.unicommerce.com` yourself.
2. Settings → API → generate a tenant-level API token.
3. Add to Render env: `UNICOMMERCE_TENANT=tennisoutlet`, `UNICOMMERCE_TOKEN=<token>`.
4. Confirm which endpoints the token has scopes for — at minimum: orders GET, returns POST, shipment tracking GET.

**Module shape:**
```js
// unicommerce.js
async function getOrder(orderId)        { … }
async function listReturnsForCustomer() { … }
async function createReturn({ orderId, sku, reason, qty }) { … }
async function trackShipment(awb)       { … }
```

If a scope is missing, the relevant action returns `{ok:false, reason:'scope_missing'}` and ActionAgent falls back to "please call the store."

### 4.6 Payment links (Razorpay)

For action 8 (send payment link), generate via `/v1/payment_links` (not auto-charge — never auto-charge). The bot sends the URL to the customer's **already-on-file email/phone**, never a new address supplied in chat (prevents exfiltration). Email template includes the order summary + amount + expiry (24h).

Env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.

### 4.7 Audit + observability

Every action writes one row to `actions` at propose and updates at confirm/execute/fail. Add:

```js
// /api/admin/actions?since=2026-04-15&status=failed
```

Admin-only bearer-token endpoint for support staff to see every write attempt with full params/result/latency. This is your forensic trail if a customer disputes a return or payment.

---

## 5. Agent + router updates

### 5.1 New router intents

```
existing: order | shoe | racquet | brand | catalog | review | policy | greeting | other
new     : identity  — "I'm 9999999999", "use my phone", "it's rahul@…"
        : myaccount — "what have I bought", "show my orders", "my preferences"
        : action    — everything in §4.2 table
```

### 5.2 Updated system prompt fragment (master)

```
SESSION CONTEXT:
• customer_id: <uuid or "anonymous">
• customer_name: <first name or "">
• customer_known_since: <date or "">
• remembered_preferences: size=11, brand=ASICS, sport=tennis
• recent_orders: [
    #400020695 - Babolat Pure Aero - delivered Mar 4,
    #400018412 - ASICS Gel Resolution 9 size 11 - delivered Feb 12
  ]

GUIDANCE:
- Greet returning customers by first name on their first message of a session.
- Do NOT re-ask for size, brand, or sport if remembered_preferences has them
  unless the user explicitly says they want different.
- Recommend complementary items based on recent_orders (strings after a racquet,
  shoe replacement 6 months after last shoe purchase).
```

---

## 6. Rollout plan — four sprints

### v4.0 — Memory foundation (2 weeks)
- DB migrations, `db.js`, `memory.js`, `identity.js` modules.
- Swap `session.js` → `memory.js`; compatibility shim.
- Magento customer sync + purchase cache cron.
- Router `myaccount` intent + `list_my_orders`, `get_my_preferences`, `update_my_preferences` read actions.
- Greeting: "Welcome back, Rahul 🎾" for returning customers.
- Privacy endpoints (export / delete).
- **Gate:** Testing strategy v3.3.2 doc must be implemented as real Jest suite before this merges. No v4 on untested v3.

### v4.1 — Low-risk writes (2 weeks)
- ActionAgent + two-turn confirmation runtime.
- `book_stringing`, `apply_coupon_to_cart`, `track_order` go live.
- Feature flags + kill switch.
- Admin `/api/admin/actions` endpoint.
- Smoke tests cover proposal → confirmation → execution paths.

### v4.2 — Financial writes (2 weeks)
- Unicommerce integration for `initiate_return`.
- Razorpay for `send_payment_link`.
- Rate limits per customer.
- Staging-only `ACTION_DRYRUN=true` run for 1 week before production enable.

### v4.3 — In-chat order placement (3 weeks, behind flag)
- `place_order` action end-to-end: build cart → confirm address → confirm payment method → create order → return order id.
- Hard flag: default off, enabled per-customer for the first 50 opted-in users.
- Extensive contract tests on the LLM around money handling.

---

## 7. Safety checklist (before any v4 write goes to prod)

- [ ] Every action has a Jest unit test and a nock integration test for happy + sad path.
- [ ] Every action has at least one LLM-contract test asserting the bot does NOT execute without a valid token.
- [ ] Kill switch tested: flip `WRITES_ENABLED=false`, confirm all actions refuse with the right message.
- [ ] Rate limit tested: 4th action in an hour is rejected.
- [ ] Audit table populated for proposed / confirmed / executed / failed / cancelled on every path.
- [ ] PII scrubber applied to `messages.content` on write.
- [ ] Razorpay webhook verifier deployed (signature check) before payment links enable.
- [ ] Unicommerce API token scopes documented in `SECRETS.md`.
- [ ] Render env has separate `staging` and `production` databases; prod read-only for developers.

---

## 8. What I need from you to start v4.0

1. **Supabase project** — create a free-tier project, share the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Render env vars. Don't share them in chat; put them straight into Render's dashboard.
2. **Magento customer-search confirmation** — confirm your bearer token has `Magento_Customer::customer` ACL. Two-second check: `curl -H "Authorization: Bearer $TOKEN" "$BASE/rest/V1/customers/search?searchCriteria[pageSize]=1"`.
3. **Unicommerce token (for v4.1+)** — generate and add to env; we don't need it for v4.0.
4. **Decision on phone vs email primary key.** India-first suggests phone; do you want that or email-first?
5. **Decision on consent default.** Opt-in ("off by default, ask first") vs opt-out ("on by default, honour request to disable"). My recommendation: **opt-out with a clear disclosure in the first bot greeting for new customers.** Opt-in kills the feature's usefulness by ~70%.

Once 1, 2, 4, 5 are answered I'll scaffold `db.js`, `memory.js`, `identity.js`, the first migration SQL, and the `/api/chat-agents` rewrite — target PR in 2 days.

---

## 9. What's deliberately NOT in v4

- WhatsApp channel. Separate project, separate risk surface.
- Multi-language. Route it through customer preference but don't translate system prompts yet.
- Voice. Out of scope.
- Anthropic Sonnet upgrade or model swap. Orthogonal; do independently.
- Customer-facing admin dashboard. Staff-only endpoints only.
- Analytics / funnel reporting. Add in v4.x or v5; schema supports it via `messages` table.

---

## 10. Success metrics

| Metric | Baseline (v3.3) | Target end of v4 |
|---|---|---|
| Returning-customer recognition rate | 0% | ≥ 70% of sessions with a known phone/email |
| Slot-reask rate on identified customers | ~100% | < 30% (only for things we don't know) |
| Successful tracked-order resolutions via bot | 0/day | 20/day |
| Successful stringing bookings via bot | 0/day | 5/week |
| Write-action error rate (executed but failed downstream) | — | < 2% |
| Fraudulent / wrongly-executed writes | — | **0** (hard requirement) |
| Prod bugs caught by customers, per month | 4 (current) | ≤ 1 |

---

**TL;DR.** v4.0 is the memory release — finish the testing suite, add Supabase, ship returning-customer recognition. v4.1 adds low-risk writes with the confirmation protocol so you prove the audit flow works. v4.2 turns on returns and payment links once the flow is battle-tested. v4.3 is in-chat ordering behind a flag. Each step is shippable on its own and each step is reversible with a kill switch.

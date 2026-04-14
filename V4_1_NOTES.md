# TO Assistant v4.1-alpha — transactional action layer

Ships the Thesis B scaffold from V4_PLAN.md: read actions that return inline, write actions gated behind a two-turn confirmation protocol, every proposal and execution logged to the `actions` table for audit.

## What's in v4.1

| Module        | Role                                                                 |
|---------------|----------------------------------------------------------------------|
| `flags.js`    | Reads feature flags from env. `WRITES_ENABLED`, `ACTION_DRYRUN`, per-action opt-in. |
| `actions.js`  | Action catalogue + `propose` / `confirm` / `cancel` / `catalogue`. Rate-limited per customer. |
| `server.js`   | `/api/actions/catalogue`, `/api/actions/propose`, `/api/actions/confirm`, `/api/actions/cancel`. |

## Action catalogue (v4.1)

| Name                    | Kind  | Requires customer | Requires consent | Notes |
|-------------------------|-------|-------------------|------------------|-------|
| `track_order`           | read  | no                | no               | OAuth call to Magento Orders |
| `list_my_orders`        | read  | yes               | no               | Most recent N orders by email |
| `get_my_preferences`    | read  | yes               | no (returns `{}` if no consent) | |
| `update_my_preferences` | write | yes               | yes              | Writes to `customers` columns |
| `book_stringing`        | write | yes               | no               | Inserts into `stringing_bookings` |
| `apply_coupon_to_cart`  | write | no                | no               | Magento POST (DRYRUN-only until `magentoPost` helper lands) |

## Two-turn protocol

```
client -> POST /api/actions/propose { name, params, session_id, customer_id }
        <- { ok:true, kind:'write', confirmation_token, summary, expires_at }

(show summary to user; on explicit yes)

client -> POST /api/actions/confirm { confirmation_token }
        <- { ok:true, action, result }   // or { ok:false, error }
```

Proposals expire after `CONFIRM_TTL_MIN` (default 10 min). Confirmed proposals are idempotent via the unique `confirmation_token` column.

## Feature flags (env)

| Name                          | Default | Effect |
|-------------------------------|---------|--------|
| `WRITES_ENABLED`              | `false` | Master kill switch for all writes. |
| `ACTION_DRYRUN`               | `true`  | Writes stage to `actions` but don't hit Magento/OMS. |
| `ACTION_<NAME>_ENABLED`       | reads:`true`, writes:`false` | Per-action toggle. |
| `WRITE_RATE_LIMIT`            | `5`     | Max confirmed/executed writes per customer… |
| `WRITE_RATE_WINDOW_MIN`       | `60`    | …per N minutes. |
| `CONFIRM_TTL_MIN`             | `10`    | Proposal lifetime. |

## Safe rollout order

1. Deploy v4.1 with `WRITES_ENABLED=false`. Only reads work. Validate `/api/health` shows `writes_enabled:false`.
2. Flip `WRITES_ENABLED=true` and `ACTION_DRYRUN=true`. Write proposals now record to `actions` as `executed` with `dryrun:true` result — confirms the plumbing end-to-end without real side effects.
3. Per-action: set `ACTION_UPDATE_MY_PREFERENCES_ENABLED=true`, then `ACTION_BOOK_STRINGING_ENABLED=true`, etc. Monitor the `actions` table for `status='failed'` rows before unblocking the next action.
4. When confident, set `ACTION_DRYRUN=false`. Real writes begin.

## Rollback

Set `WRITES_ENABLED=false` in Render and redeploy (or hot-reload). All write proposals return `{ ok:false, error:"action disabled by feature flag" }` immediately. Reads are unaffected.

## Not yet in v4.1

- LLM tool-use integration: the chat agent doesn't yet call `propose` directly as a tool. Client-side UX still needs to POST to `/api/actions/propose` based on intent parsed by `agents.js`. That wiring ships in v4.1.1 once the flow is validated via direct API.
- `initiate_return` and `send_payment_link` are v4.2.
- `place_order` is v4.3 behind its own flag.
- `magentoPost` helper — added to `server.js` in v4.1.1 so coupon action can leave DRYRUN.

## Verify post-deploy

```
curl https://<host>/api/health
# expect: "version":"4.1-alpha", "writes_enabled":false, "action_dryrun":true, "supabase":"connected"

curl https://<host>/api/actions/catalogue
# expect: 6 actions, reads enabled, writes disabled

curl -X POST https://<host>/api/actions/propose \
  -H 'content-type: application/json' \
  -d '{"name":"track_order","params":{"order_id":"400020695"},"session_id":"diag"}'
# expect: { ok:true, kind:"read", result:{ found:..., status:..., ... } }
```

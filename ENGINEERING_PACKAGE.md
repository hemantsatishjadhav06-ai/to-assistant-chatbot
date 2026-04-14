# TO Assistant — Engineering Package

Handoff document for any engineer taking over this chatbot. Covers architecture (ADR), system design, code review, debug playbook, deploy checklist, documentation index, and testing strategy. Read top-to-bottom the first time; use as reference after.

---

## 1. ADR-001 — Multi-agent routing over single-agent

**Status:** Accepted, shipped in v3.2 (pending deploy).

**Context.** The v3.1 single-agent bot took a user query about racquets and returned Prince Championship *Balls*. Root cause was the model picking `get_products_by_category(338)` — a best-seller category that mixes balls and racquets — despite the prompt saying "use for racquets." Prompt-only guardrails didn't hold.

**Decision.** Introduce a Router–Specialist–Master topology:
- **Router** (gpt-4o-mini, JSON-locked) classifies intent into one of: `order | racquet | shoe | brand | catalog | policy | greeting | other`.
- **Specialist** (gpt-4o) per intent, each with a *tight* tool subset. The racquet specialist only sees `get_racquets_with_specs`; it cannot reach for catalog tools even if it wanted to.
- **Master** (`masterHandle` in `agents.js`) orchestrates, runs a post-response **validator**, retries once with a stricter system note if the response includes banned tokens (e.g., "ball" in a racquet response), and falls back to a phone-number handoff if retry also fails.

**Alternatives rejected.**
- *Stronger single-agent prompt*: fragile; drifts across model versions.
- *Fine-tuned model*: expensive, slow iteration, overkill for 8 intents.
- *Rules-first (no LLM router)*: brittle on paraphrase; we'd lose natural language robustness.

**Consequences.**
- +1 LLM hop (~300-500 ms, ~0.2¢ per message).
- New file (`agents.js`) to maintain alongside `server.js`.
- Validation layer catches the *class* of bug that produced the racquet-as-balls incident, not just this instance.

---

## 2. System Design

**Request path.**
```
Client (public/index.html)
  → POST /api/chat-agents {messages:[...]}
    → masterHandle(userMessages, allTools, executeFunction)
      → routeIntent(lastUser)            [gpt-4o-mini, JSON]
      → runSpecialist(intent, sport, …)  [gpt-4o + intent tools]
          → executeFunction(tool, args)  [Magento REST + cache]
      → validateResponse(intent, content)
          └─ on fail: one retry with stricter system note
  → JSON {message, agent_trace, usage}
```

**Data.**
- *Source of truth*: Magento 2 REST (`console.tennisoutlet.in/rest/V1`). Bearer token for catalog, OAuth 1.0a for orders/stock.
- *In-memory cache* built at boot: attribute option dictionaries for `brands, court_type, width, cushioning, shoe_type, shoe_size, color`. Used for ID→label resolution so we never show a customer a raw "67" instead of "Men's".
- *No persistence layer yet.* Supabase is wired via `.mcp.json` for future caching; not yet used at runtime.

**Categories (immutable IDs on the Magento side).**
- Racquets: tennis=25, padel=272, pickleball=250
- Shoes: tennis=24, pickleball=253, padel=274
- Skill filters: beginner=87, intermediate=80, advanced=79, senior=88, junior=81
- Misc: tennis_balls=31, pickleball_balls=252, padel_balls=273, strings=29, bags=115, accessories=37, used_racquets=90

**Scale posture.** Single Render web service, 1 worker. Node event-loop idle most of the time; latency bound by OpenRouter + Magento. Horizontal scale: bump `numInstances`. Attribute cache rebuilds per instance on boot, acceptable.

**Failure isolation.**
- Magento 5xx → tool returns `{error}` → specialist says "I'm having trouble reaching inventory, please call +91 9502517700."
- OpenRouter 429/5xx → caught in `callLLM`, surfaced as a graceful message.
- Router misfire (low-confidence `other`) → fallback agent politely redirects in-scope.

---

## 3. Code Review

**High-risk (must not regress).**
- `server.js` URL normalization — strips trailing `/` and `/rest/V1` from `MAGENTO_BASE_URL`. Without this, the attribute cache 404s at boot.
- `getRacquetsWithSpecs` — includes `type_id=configurable`. Without it, grip-size child SKUs (`TRAB0092-L2-4-1-4`) leak into listings.
- `agents.js` `validateResponse` — banned-token list is the last line of defense against the racquet bug class. Don't loosen it without replacement.
- Intent tool subsets in `specialistTools()` — if you add a tool, explicitly decide which intents see it.

**Medium.**
- Bluedart tracking URL still uses `?{AWB}`; correct format is `https://bluedart.com/tracking?trackFor=0&trackNo=<AWB>`. Fix next pass.
- Configurable parent products show `price=0` (Nike shoes). Need to fall back to first child price or `min_price` from `tier_prices`.
- `ATTR_OPTIONS` cache has no TTL. Add nightly refresh before seasonal shoe-size changes.

**Low.**
- No request-id correlation in logs. Add `req.id` middleware when traffic warrants.
- `executeFunction` default branch silently returns `undefined`. Add `console.warn` + `{error:'unknown_tool'}` return.

**Good patterns to preserve.**
- Intent-scoped tool registries — prevents the entire class of "model reaches for wrong tool" bugs.
- Validator with retry — catches issues prompts miss.
- Attribute cache at boot — users never see raw option IDs.

---

## 4. Debug Playbook

**Step 0.** Reproduce with the exact user text against `/api/chat-agents`. Don't debug a paraphrase.

**Step 1 — Which layer?** Read `agent_trace` in the response:
- `router.intent` wrong → tighten router prompt, add utterance to router eval suite.
- `specialist.iterations = 0` and no product data → model didn't call the tool. Check tool registry binding.
- `validation: "racquet_response_contains_non_racquet: ..."` → specialist called wrong tool or model hallucinated. Look at server logs for the actual tool call.
- `retried: true` → first attempt failed validation; second succeeded or fell back. Look at which.

**Step 2 — Magento or LLM?** Server logs show the exact tool call with args. Hit the Magento endpoint with the same args directly via curl:
```
curl -H "Authorization: Bearer $MAGENTO_TOKEN" \
  "https://console.tennisoutlet.in/rest/V1/products?searchCriteria[filterGroups][0][filters][0][field]=category_id&searchCriteria[filterGroups][0][filters][0][value]=25"
```
If Magento returns correct data, the issue is LLM shaping → tune the specialist prompt. If Magento returns wrong data, it's a catalog issue, not a bot issue.

**Step 3 — Known symptoms.**
| Symptom | Most likely cause | Fix |
|---|---|---|
| Racquet query returns balls | v3.1 deployed, fix not shipped | Deploy v3.2 |
| "Size X not available" shown | Model hallucinating; stock check failed silently | Force specialist prompt to say "sizes on product page" |
| Grip-size child SKU listed | `type_id=configurable` filter dropped | Restore filter |
| Attribute cache empty at boot | `MAGENTO_BASE_URL` double `/rest/V1` | Normalize URL |
| Order status returns nothing | OAuth not configured on Render | Add OAuth env vars |

**Step 4 — Widen the blast radius check.** After any fix, re-run the full smoke matrix (§7) before deploying.

---

## 5. Deploy Checklist (v3.2)

**Pre-flight (local).**
- [x] `node -e "require('./server.js')"` loads.
- [x] `node -e "require('./agents.js')"` loads.
- [x] `.env` present; `.gitignore` excludes `.env`.
- [x] Router eval: 8/8 intents classified correctly (verified this session).
- [x] `validateResponse` banned-token list in place.
- [ ] `git status` — confirm `server.js`, `agents.js`, `DEPLOY.md`, `ENGINEERING_PACKAGE.md`, `PROJECT_MEMORY.md`, `SHIP_IT.command` staged.

**Push + deploy.**
1. From the outputs folder: `bash SHIP_IT.command` (init/fetch/commit/push) — *or* push manually.
2. Render auto-deploys from `main`. Watch build logs for:
   ```
   [attr-cache] brands: 50 options
   [attr-cache] court_type: N options
   ...
   [startup] Attribute cache ready.
   Server listening on :PORT
   ```
3. Confirm health: `curl https://to-assistant-chatbot.onrender.com/api/health` → `magento_bearer: connected`.

**Post-deploy smoke (2 min).**
Send each of these through the live UI and confirm the response:
1. "which racquet can i buy" → 4–5 racquets, no balls. *This is the regression test.*
2. "show me ASICS tennis shoes for men" → 4–5 shoes with sizes.
3. "where is my order 100345" → polite lookup response.
4. "what brands do you carry" → brand list, grouped by sport.
5. "return policy" → under 8 lines, ends with "Is there anything else…".
6. "padel balls on sale" → balls only.
7. "hi" → short greeting.
8. "what's the weather" → polite redirect to tennis/padel/pickleball.

**Rollback triggers.**
- `/api/health` → `magento_bearer: error` for >5 min.
- Any smoke test returns wrong category.
- p95 chat latency >10 s.

**Rollback procedure.** Render dashboard → service → Deploys → previous → Rollback. Takes ~45 s.

---

## 6. Documentation Index

Files that exist, what each is for, what's stale.

| File | Purpose | Status |
|---|---|---|
| `PROJECT_MEMORY.md` | Cross-session context, decisions, blockers | Current |
| `ENGINEERING_PACKAGE.md` | This doc | Current |
| `DEPLOY.md` | Render deploy steps, env vars | Current |
| `SHIP_IT.command` | One-shot push-to-GitHub script | Current |
| `README.md` | Public-facing overview | **Stale** — still describes single-agent |
| `.env.example` | Env var template for new contributors | **Missing** — create next pass |
| `CHANGELOG.md` | Release notes | **Missing** — v3.2 entry needed |
| `RUNBOOK.md` | On-call procedures | See §8 below; extract to file when team > 1 |

---

## 7. Testing Strategy

**Unit (mocked).**
- `resolveAttr(code, id)` → correct label, handles multi-select CSV, missing ID returns raw.
- `brandNameToId('asics')` → case-insensitive match.
- URL normalization — 4 cases: plain root, trailing `/`, `/rest/V1`, `/rest/V1/`.
- `validateResponse('racquet', text)` — accepts racquet markdown, rejects ball/string.

**Integration (Magento fixture files).**
- `getRacquetsWithSpecs({sport:'tennis'})` → only `type_id=configurable` SKUs in output.
- `getShoesWithSpecs({sport:'tennis', brand:'ASICS'})` → specs populated with labels, not IDs.
- `list_brands()` non-empty, alphabetical.

**Agent tests (live OpenRouter, cheap).**
Router eval — 30 utterances, 8 intents. Target ≥95% accuracy.
```
"which racquet can i buy" → racquet
"show me balls on sale"   → catalog
"where's my order"        → order
"store hours"             → policy
...
```

Golden specialist outputs — for each intent, a representative prompt. Assert:
- Correct tool was called (check server log).
- Response passes `validateResponse`.
- Response ends with the brand closer.
- No banned phrases ("we don't have size X", "currently out of stock" without product context).

**E2E (Playwright against live Render URL).**
For each of the 8 smoke queries: open `/`, send, wait for response, assert content. Runtime budget: 10 s per query. Full suite under 2 min. Schedule nightly.

**Load test.** k6, 10 rps × 2 min. Assert p95 < 6 s, 0 error responses, 0 validator final-failures. Run before any promotional push.

**CI wiring.**
- GitHub Actions: unit + integration on PR.
- Agent + E2E nightly on `main`.
- Fail the build on router accuracy < 95% or any golden drift.

---

## 8. Runbook (on-call quick reference)

**Alerting.** (Not yet wired.) Recommended: Render built-in uptime ping on `/api/health` + UptimeRobot every 5 min; page on two consecutive failures.

**Incident triage.**
1. `curl /api/health`. If down: Render dashboard → check last deploy → rollback if regression.
2. If `magento_bearer: error`: Magento token may have rotated. Regen at Magento admin → update Render env var `MAGENTO_TOKEN` → manual redeploy.
3. If LLM errors: check OpenRouter dashboard for 429/5xx. Switch `OPENROUTER_MODEL` to `openai/gpt-4o-mini` temporarily (slower but sturdier fallback).
4. If a specific intent breaks: tail Render logs, find `[router]` + `[intent]` lines, compare tool args to Magento directly.

**Common tasks.**
- *Rotate Magento token*: Magento admin → System → Extensions → Integrations → regenerate → paste into Render env → redeploy.
- *Add a new intent*: extend ROUTER_PROMPT intents list, add AGENT_PROMPTS entry, add tool binding in `specialistTools()`, add smoke query.
- *Add a new product category*: add to the category map in `server.js`, add smoke query, redeploy.

**Escalation.** For Magento catalog issues: TennisOutlet store ops. For OpenRouter: OpenRouter support. For Render: Render support.

---

## 9. Snapshot — what's live vs what's local

| Capability | Local (ready) | Live on Render |
|---|---|---|
| Attribute ID→label resolution | ✅ | ❌ (v3.1 deployed) |
| `get_racquets_with_specs` tool | ✅ | ❌ |
| `get_shoes_with_specs` tool | ✅ | ❌ |
| Multi-agent router | ✅ | ❌ |
| Response validator + retry | ✅ | ❌ |
| Single-agent `/api/chat` legacy | ✅ | ✅ |

Deploying v3.2 flips every row to ✅.

---

End of package. Pair with `PROJECT_MEMORY.md` for full context.

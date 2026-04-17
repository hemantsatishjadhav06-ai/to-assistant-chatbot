# TO Assistant — Project Memory

Single source of truth for the TennisOutlet.in AI chatbot. Pick this up in any future session to resume without re-discovering context.

---

## 1. Product Brainstorming (PM lens)

**Problem.** TennisOutlet sells tennis/pickleball/padel gear on Magento. Customers ask shoe/racquet/order/policy questions in chat. Human agents can't scale; generic LLM answers hallucinate product data.

**Goal.** A self-serve chatbot that:
- pulls live data from Magento (no stale CSV),
- answers shoe, racquet, ball/bag/string, brand, order-status, and policy questions,
- never invents products, prices, or sizes,
- routes out-of-scope chatter cleanly.

**Users.** Shoppers on mobile, mostly first-time. Success = they leave with a product link they can buy or an order status they trust.

**Jobs-to-be-done.**
1. "Find me a racquet / shoe for my level & sport."
2. "Where is my order #?"
3. "Do you carry brand X? What's the return policy?"
4. "I'm just browsing — what's on sale?"

**Differentiator vs generic GPT.** Live Magento attribute resolution (brand IDs → names, size IDs → labels, category-aware filtering) + typed multi-agent routing so each specialist has tight tool access.

**Non-goals (for now).** Payments, account creation, personalized recommendations from purchase history, multi-language. Ship English + single-turn product discovery first.

---

## 2. Architecture (ADR-style)

**Decision.** Router-specialist-master multi-agent on top of OpenRouter, talking to Magento REST via Bearer token + OAuth 1.0a (orders), cached attribute option dictionary for offline ID→label resolution.

**Components.**
- `server.js` — Express app, Magento clients, tool registry, single-agent `/api/chat` (legacy) + multi-agent `/api/chat-agents`.
- `agents.js` — `routeIntent()` (gpt-4o-mini, JSON mode) → `runSpecialist()` (gpt-4o with intent-scoped tools) → returns final message + `agent_trace`.
- `.env` — Magento + OpenRouter creds.
- `render.yaml` — blueprint for one-click Render deploy.
- Static `public/index.html` — chat UI (already live).

**Trade-offs considered.**
- *Single agent with all tools* — simpler, but model routinely picked wrong tool (best-seller category for "racquet" → returned balls). Rejected.
- *Function-calling only* — same tools, smarter prompt. Helps but doesn't enforce; model still drifts. Rejected as the only mechanism.
- *Router + specialists (chosen)* — tight tool surface per intent; router is cheap (mini model, JSON-locked); master composes. Slight latency cost (1 extra LLM hop) for correctness gain.
- *Supabase cache* — offered; deferred. Magento is fast enough and the source of truth. Add only if we hit rate limits.

**Consequences.** Two LLM hops = +300-700ms and ~1.2x token cost, paid for by correctness. Adding a new intent = new prompt + tool list, ~20 lines.

---

## 3. Code Review

**High-risk spots.**
- `server.js` `MAGENTO_BASE_URL` normalization — fixed the `/rest/V1/rest/V1` bug by stripping trailing `/rest/V1`. Keep the regex test; regress easily if env changes.
- `getRacquetsWithSpecs` — must keep `type_id=configurable` filter. Without it, grip-size child SKUs (`TRAB0092-L2-4-1-4`) leak into responses.
- Tool `search_products` vs `get_products_by_category` — model conflates them. System prompt ROUTING RULES is load-bearing; don't soften it without re-testing.
- `executeFunction` switch — no default logging on unknown tool name. Add a `console.warn` + return `{error:'unknown_tool'}` for safety.

**Medium.**
- `callLLM` in `agents.js` throws on timeout; specialists bubble it. Wrap with a user-visible fallback message.
- Bluedart tracking link uses `?{AWB}`. Confirm format — correct is `https://bluedart.com/tracking?trackFor=0&trackNo=<AWB>`. TODO: fix.
- Nike configurable parents return `price=0`. Need to resolve via children or tier_prices.

**Low.**
- No request-id correlation between router and specialist logs. Add `req.id` once traffic grows.
- `ATTR_OPTIONS` cache never invalidates. Fine for now; add a nightly refresh job before shoe sizes change seasonally.

---

## 4. Debug Notes (fixes applied + playbook)

**v6.4.1 (2026-04-18) — Real root cause: resolver stemming gap (CORRECTION to v6.4.0)**

v6.4.0's framing was wrong. The user pushed back with a Magento admin screenshot showing Pickleball-Bags attribute set has 34 records and at least PIBG0021 (qty 5), PIBG0027 (4), PIBG0020 (3), PIBG0028 (3), PIBG0029 (3) are Simple Products with real stock. So the empty replies were NOT a true stockout — they were a retrieval miss.

Actual root cause in `server.js`:
- `buildCategoryIndex` indexed category-name tokens literally. "Pickleball Bags" → keys `pickleball`, `bags`, `pickleball bags`.
- `resolveCategoriesFromQuery` did a literal lookup on user tokens. "pickle bag" tokenises to `pickle`, `bag` — neither is in the index.
- Resolver returned `[]`. `smartProductSearch` fell back to `buildSearchParams` (LIKE `%pickle bag%` on name/sku/url_key). Product names are like "Engage Players Backpack" — substring misses everything.
- End result: empty product array → agent says "we don't have any". Same shape for "any shoes" (singular "shoe" never matches "shoes").

Fix (pure retrieval — no inventory dependency):
- `_stemVariants(token)`: deterministic English-ish stemmer covering plural↔singular (bags↔bag, shoes↔shoe, balls↔ball, racquets↔racquet, accessories↔accessory).
- `buildCategoryIndex`: each token is indexed together with its stem variants. Bigrams also index a singular-right variant ("pickleball bags" → also "pickleball bag").
- `QUERY_SYNONYMS` map: `pickle→pickleball`, `padle/paddel/paddle→padel`, `racket→racquet`, `footwear/sneaker/trainer→shoes`, `kitbag/pouch/carrier/backpack/duffel→bag`.
- `resolveCategoriesFromQuery`: each query token is synonym-resolved, then expanded to stem variants before bigram + unigram lookup. Cross-product over positions i and i+1 so bigrams reach all plural/singular forms.
- Safety net: if the resolver still returns empty but the query contains a known product noun (bag/shoe/ball/racquet/grip/string/apparel/accessories) or a known sport (tennis/pickleball/padel), fall back to bare-token index lookup.
- `/api/stock-debug?category=<id>[&attribute_set_id=<N>]`: new mode that pulls the real product list filtered by category via the Magento REST call `/products?searchCriteria[filter_groups][0][filters][0][field]=category_id` and merges live MSI stock per SKU. This is the "ultrareview" path — it answers "are PIBG* bags reachable + in stock?" independently of LIKE search.

Unit-verified locally via `test-resolver.js` (vm-sandboxed server.js prefix with a synthetic catalog mirroring Tennis/Pickleball/Padel × Racquets/Shoes/Bags/Balls):
- 22/22 assertions pass.
- "pickle bag" → Pickleball Bags resolves as top-tier hit.
- "any shoes" → all three Shoes categories resolve.
- "tennis shoes size 10" → Tennis Shoes top hit.
- "tennis balls" → Tennis Balls top hit (regression safe).
- "racket" synonym → Tennis Racquets resolves.
- "padle shoes" synonym → Padel Shoes resolves.
- Bare "bag" / "shoe" → safety-net lookup returns the right categories.
- Garbage query ("xyzabc qwerty") → empty (no false positives).

What v6.4.0 got right and we kept:
- `stripInternals` tagging `in_stock` / `availability` instead of dropping OOS rows.
- `mergeAvailability` fallback tier (in-stock first, OOS fill).
- Loosened `isProductAvailable` for configurables without loaded children.
- Boot retry ladder + lazy `CATEGORY_INDEX` reload.
- OOS-aware `PRODUCT_FORMAT` + specialist prompts in `agents.js`.
These still ship as hardening — they're correct UX but they were never the root cause. The bug was upstream in the resolver.

Pinecone / vector search:
- Still not needed for this bug. The fix is ~60 lines of deterministic stemming + a 20-entry synonym map.
- Phase 2 rationale intact: once catalog/query patterns exceed what a keyword index can cleanly cover, move to embeddings. Not today.

---

**v6.4.0 (2026-04-18) — "No output for pickle bag / any shoes" — SUPERSEDED BY v6.4.1**

> NOTE: the diagnosis below was based on the `/api/stock-debug?q=...` (keyword LIKE) path, which returned noisy configurable parents with qty=0. That wasn't the real category inventory. Treat the "real stockout" claim as incorrect — see v6.4.1 above for the corrected diagnosis. The stripInternals/mergeAvailability/prompt changes still ship.

Reported symptoms:
- "pickle bag" → empty / "we don't have any" response.
- "any shoes", "tennis shoes", "padel shoes", "pickleball shoes" → same empty response.

Diagnosis via `/api/stock-debug`:
- Tennis shoes (TSH*), pickleball shoes (PISH*), padel shoes (PDSH*): **every configurable's children are qty=0 in Magento MSI.** True stockout across the shoe catalog (248 products).
- Pickleball bags (PIBG*): **all 8 configurables qty=0.** Real stockout.
- Contrast check: tennis racquet bags TBG0143/TBG0206/TBG0207 **are** in stock (qty 2-4). So the retrieval pipeline itself is healthy.
- Secondary finding: some configurables (e.g. PISH0008) report parent MSI qty>=1 but return empty children arrays, so the strict `_children_loaded` check in `isProductAvailable` was dropping them too.
- Tertiary finding: `CATEGORY_INDEX` was occasionally empty at boot (Magento attribute cache fetch failing once, no retry).

Root cause: the UX was "nothing to show" because `stripInternals` ran a hard `qty>=1` filter on every tool return, so when the whole category was sold out the LLM got `[]` and said "we don't have any" — reading as a broken chatbot.

Fix (retrieval + prompt, not inventory):
- `stripInternals` now *tags* products with `in_stock` / `availability` instead of dropping OOS.
- New `mergeAvailability(tagged, pageSize)` returns in-stock first, then fills with up to 5 OOS items as a fallback tier when no in-stock exists, or up to 3 pre-slots when there's partial coverage.
- Every consumer of `stripInternals` (searchProducts, getProductsByCategory, getRacquetsWithSpecs, getShoesWithSpecs, getBalls, smartProductSearch) was rewired to `applyPriceSizeFilters → sort (in-stock-first) → mergeAvailability`.
- `getShoesWithSpecs` no longer hard-gates on `qty>=1`; sizes_available extraction preserved.
- `isProductAvailable` loosened for configurables without loaded children — trust parent MSI qty.
- Added lazy `CATEGORY_INDEX` reload (throttled 30s) + boot-time retry ladder for `initCategoryMap` (2s / 5s / 15s).
- `agents.js` prompts updated (`PRODUCT_FORMAT` `STOCK / AVAILABILITY RULE` + per-specialist rules for shoe/racquet/catalog/availability): LLM must show sold-out products in normal format with a "currently sold out — tap to get notified" note instead of replying "we don't have any".

Unit-verified locally:
- `stripInternals` + `mergeAvailability` behave as designed across 4 fixture shapes (full-stock, partial-stock, 1-in-stock fallback, all-OOS fallback). `node -c` passes on both files.

Pinecone / vector search:
- **Not the blocker** for these two bugs. The root failure was inventory + a hard availability gate, not a retrieval-coverage issue.
- Still useful as Phase 2 for synonym-heavy queries ("court shoes" → tennis shoes, "paddle carrier" → bags). Tracked in §9.

---

**Reported:** "which racquet can i buy" → returned Prince Championship *Balls*.
- Repro: single-agent, system prompt mapped "best racquets" to category 338 (best-seller), which sorts balls first.
- Root cause: category 338/434 are mixed best-seller buckets.
- Fix:
  1. New dedicated tool `get_racquets_with_specs(sport, brand?, skill_level?)` hitting correct category IDs 25/272/250.
  2. Filter `type_id=configurable` to exclude grip-size SKUs.
  3. Hard routing in system prompt + specialist in multi-agent.
- Verified locally against live Magento; all three sports return racquets only.

**Startup 404 on attribute cache.** Env had `MAGENTO_BASE_URL=.../rest/V1`, code appended `/rest/V1` again. Normalized at module load.

**MSI bulk stock 414 URL too long.** Pre-existing; graceful per-SKU fallback. Acceptable.

**Playbook for future issues.**
1. Reproduce in `curl` against `/api/chat-agents` with exact user text.
2. Check `agent_trace.router` — wrong intent = prompt/classifier drift.
3. Check server logs for the tool call + arguments.
4. Hit Magento endpoint directly with same args — isolate LLM vs Magento.
5. Only then edit prompts.

---

## 5. Deploy Checklist

Pre-ship gates (must all pass):
- [ ] `npm test` passes (once tests exist — see §8).
- [ ] `node -e "require('./server.js')"` loads without throw.
- [ ] `curl localhost:3000/api/health` → `magento_bearer: connected`.
- [ ] Smoke matrix: one query per intent (order, racquet, shoe, brand, catalog, policy, greeting, other) returns sensible content.
- [ ] No new secrets in code; all in `.env` / Render env vars.
- [ ] `.gitignore` includes `.env`, `.mcp.json`, `node_modules`.
- [ ] `render.yaml` lists all env vars; new ones marked `sync: false`.
- [ ] Tag the release (`git tag v3.2-multiagent`).

Deploy steps (Render blueprint):
1. `git push origin main` → Render auto-redeploys.
2. Watch build logs for `Attribute options cached` line.
3. Re-run smoke matrix against the live URL.
4. If a regression: Render → previous deploy → "Rollback".

Rollback triggers:
- `/api/health` returns `magento_bearer: error` for >5 min.
- p95 chat latency >10 s.
- Any intent returns an empty/error string in smoke tests.

**Blocker (unchanged):** This session cannot `git push` to `hemantsatishjadhav06-ai/to-assistant-chatbot`. Options to unblock, in order of preference: (a) paste a GitHub PAT with `repo` scope, (b) drag-drop the two modified files (`server.js`, `agents.js`) + new `DEPLOY.md` into the GitHub web editor, (c) `scp` a zip and push from local terminal.

---

## 6. Documentation (what exists, what's missing)

Exists in the repo:
- `README.md` — old, single-agent flow only. **Stale.**
- `DEPLOY.md` — new, covers Render blueprint + smoke checks.
- `PROJECT_MEMORY.md` — this file.

Needed:
- **README rewrite** — one-paragraph pitch, architecture diagram (Router → specialists → Magento/OpenRouter), `.env` table, `/api/chat-agents` contract, agent_trace shape.
- **RUNBOOK.md** — on-call steps for the 4 most likely failures: Magento down, OpenRouter 429, bad intent classification, grip-size child leaking.
- **CHANGELOG.md** — v3.1 → v3.2 entry (multi-agent, racquet fix, attribute cache).
- Inline JSDoc on `getShoesWithSpecs`, `getRacquetsWithSpecs`, `masterHandle` — argument contracts are non-obvious.

---

## 7. System Design

**Request flow (multi-agent).**
1. Client POST `/api/chat-agents` with `{messages:[...]}`.
2. `masterHandle` extracts last user text → `routeIntent` (gpt-4o-mini, `response_format: json_object`).
3. Router returns `{intent, sport, confidence}`.
4. `runSpecialist` loads intent-specific system prompt + tool subset, calls gpt-4o.
5. Model emits tool_calls (≤3 iterations), `executeFunction` hits Magento, results piped back.
6. Final assistant message returned with `agent_trace` (router decision + iteration count + token usage).

**Data.**
- Magento product catalog (source of truth).
- Attribute option cache (in-memory, loaded on boot): brands, court_type, width, cushioning, shoe_type, shoe_size, color.
- No DB of our own yet. Stateless per request.

**Scaling.**
- Single Render web service, 1 worker. Node is CPU-light; bottleneck is OpenRouter + Magento latency.
- Horizontal scale: set `numInstances` in render.yaml. Attribute cache rebuilds per instance on boot — fine.
- Add Redis or Supabase only when we want cross-instance cache invalidation or conversation memory.

**Failure modes & containment.**
- Magento 5xx → tool returns `{error}` → model says "I'm having trouble reaching inventory, here's our phone #".
- OpenRouter 429 → catch in `callLLM`, return graceful message, increment counter.
- Router returns `other` with low confidence → fallback agent politely redirects.

**Security.**
- Bearer token only in server env; never in client HTML.
- CORS restricted to tennisoutlet.in origins.
- No user PII logged beyond order ID they explicitly pasted.

---

## 8. Testing Strategy

**Unit.**
- `resolveAttr(code, id)` — given cached options, returns correct label; handles multi-select, missing IDs.
- `brandNameToId('asics')` — case-insensitive match.
- URL normalization — `/rest/V1` vs not, trailing slash, etc.

**Integration (mock Magento).**
- `getShoesWithSpecs({sport:'tennis', brand:'ASICS', shoe_type:"Men's"})` → calls right endpoint with right filters; maps specs.
- `getRacquetsWithSpecs` excludes non-configurable.
- `list_brands` returns non-empty.

**Agent tests (live OpenRouter, small suite).**
- Router fixtures: 30 utterances → expected intent. Fail the build on <95% accuracy.
- Golden specialist outputs: for each intent, a representative prompt → assert the response (a) mentions the right tool, (b) formats products per the brand voice template, (c) contains no banned phrases ("we don't have size X", etc.).

**E2E (Playwright against live Render URL).**
- Open `/`, send each of 8 intents, assert response renders in <10s and contains expected substrings (₹, "Is there anything else I can assist you with?").

**Load.** k6 at 10 req/s for 2 min — assert p95 <6s, 0 errors. Run before any promo campaign.

**CI wiring.** GitHub Actions: unit + integration on PR, agent + E2E nightly on main.

---

## 9. Open Blocker (must-read next session)

Deploy is the only thing in the way. All code changes (attribute cache, racquet fix, multi-agent) sit locally at:
- `/Users/hemantjadhav/.../outputs/to-assistant-chatbot/server.js`
- `/Users/hemantjadhav/.../outputs/to-assistant-chatbot/agents.js`
- `/Users/hemantjadhav/.../outputs/to-assistant-chatbot/DEPLOY.md`
- `/Users/hemantjadhav/.../outputs/to-assistant-chatbot/PROJECT_MEMORY.md` (this file)

Live bot on Render still runs v3.1 (single-agent, racquet bug present).

To ship: need GitHub write access to `hemantsatishjadhav06-ai/to-assistant-chatbot`. PAT with `repo` scope is the fastest unblock.

---

## 10. Key Credentials (already in .env, don't recreate)

- `MAGENTO_BASE_URL=https://console.tennisoutlet.in` (code strips trailing `/rest/V1` if present)
- `MAGENTO_TOKEN` — bearer for catalog
- `MAGENTO_CONSUMER_KEY/SECRET`, `MAGENTO_ACCESS_TOKEN/SECRET` — OAuth for orders
- `OPENROUTER_API_KEY` — all LLM calls
- `OPENROUTER_MODEL=openai/gpt-4o` (specialists)
- `OPENROUTER_ROUTER_MODEL=openai/gpt-4o-mini` (router)
- Supabase token (`sbp_7536c4790d9deaf5696f8d3696dfcc48602390fb`) — in `team-a-install.command`, currently only wired for Claude Code CLI via `.mcp.json`, not runtime.

---

## 11. Category & Attribute Cheatsheet

Racquet categories: `tennis=25, padel=272, pickleball=250`
Shoe categories: `tennis=24, pickleball=253, padel=274`
Skill sub-cats: `beginner=87, intermediate=80, advanced=79, senior=88, junior=81`
Other: `tennis_balls=31, pickleball_balls=252, padel_balls=273, strings=29, bags=115, accessories=37, used_racquets=90, wimbledon_sale=292, grand_slam=349, boxing_day=437`

Attribute codes cached: `brands, court_type, width, cushioning, shoe_type, shoe_size, color`.

---

End of memory. Start here next session.

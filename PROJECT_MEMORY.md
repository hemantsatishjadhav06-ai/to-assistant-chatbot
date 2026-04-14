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

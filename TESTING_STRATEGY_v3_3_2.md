# TO Assistant Chatbot — Testing Strategy (v3.3.2)

**Audit date:** 2026-04-15
**Scope:** `to-assistant-chatbot` (Node.js / Express + OpenRouter multi-agent + Magento 2 REST)
**Current state:** Zero automated tests. Every bug so far (price-cap ignored, size filter ignored, `₹X,XXX` placeholder leak, ball-machine zero results) was caught in production by you or a customer. That's the gap this document closes.

---

## 1. Why zero tests is the #1 risk

Four production bugs in two weeks, each one caught by manual chat probes, each one a regression against behavior that was "working" a few commits earlier. The common pattern: a prompt or parser change fixes case A and silently breaks case B. Without a regression suite, every deploy is a dice roll.

The fix isn't "100% coverage." It's a small deterministic test tier that catches the classes of bugs you keep shipping.

---

## 2. Testing pyramid, tuned to this codebase

```
                /  E2E   \     ~8 smoke queries, run after Render deploy
               /----------\
              / Contract   \   Magento schema tests, monthly
             /--------------\
            /   Integration  \  /api/chat-agents + mocked Magento
           /------------------\
          /      Unit tests    \  parser / session / validator / helpers
         /----------------------\
```

Ratio target by commit count: **70% unit, 20% integration, 10% E2E.** Unit tests run in <2s on every commit. Integration in <30s on PR. E2E only against the live Render URL after deploy.

---

## 3. What to test, ranked by payoff

### TIER 1 — Deterministic modules (write these this week)

These are pure functions. Tests are cheap, fast, and would have caught every bug we've shipped.

#### 3.1 `parser.js` — highest leverage in the repo

The parser is the slot-extraction oracle. If it's wrong, the LLM downstream has no chance. This is the single most important test file.

**Test framework:** Jest (no DB, no network, runs in ms).

**Example cases:**

```js
// parser.test.js
const { parseSlots, mergeSlots, shouldReset } = require('../parser');

describe('parseSlots — price shorthand', () => {
  test.each([
    ['under 5K',              { max_price: 5000 }],
    ['below 5000',            { max_price: 5000 }],
    ['less than 5k',          { max_price: 5000 }],
    ['upto 8K',               { max_price: 8000 }],
    ['<6000',                 { max_price: 6000 }],
    ['above 3k',              { min_price: 3000 }],
    ['over 10000',            { min_price: 10000 }],
    ['5-10k',                 { min_price: 5000,  max_price: 10000 }],
    ['₹500 to ₹2000',         { min_price: 500,   max_price: 2000  }],
    ['1L',                    { max_price: null,  min_price: null  }],   // ambiguous — neither cap alone
    ['under 1 lakh',          { max_price: 100000 }],
  ])('"%s" -> %o', (input, expected) => {
    const got = parseSlots(input);
    for (const [k, v] of Object.entries(expected)) expect(got[k]).toBe(v);
  });
});

describe('parseSlots — size', () => {
  test.each([
    ['shoe size 10',          10],
    ['size 11 under 6K',      11],
    ['UK 9.5',                9.5],
    ['shoe 6 size',           6],
    ['I need size 8 shoes',   8],
    ['size 20',               null],   // out of range
    ['racquet grip 2',        null],   // shouldn't pick up grip as shoe size
  ])('"%s" -> size=%s', (input, expected) => {
    expect(parseSlots(input).size).toBe(expected);
  });
});

describe('parseSlots — intent hint', () => {
  test('"shoe size 11 under 6k" -> shoe', () => {
    expect(parseSlots('shoe size 11 under 6k').intent_hint).toBe('shoe');
  });
  test('"tennis ball machine" -> catalog', () => {
    expect(parseSlots('tennis ball machine needed').intent_hint).toBe('catalog');
  });
  test('"review of TENNIIX Cliq" -> review', () => {
    expect(parseSlots('what is the review of TENNIIX Cliq').intent_hint).toBe('review');
  });
  test('"hi" -> greeting', () => {
    expect(parseSlots('hi').intent_hint).toBe('greeting');
  });
});

describe('mergeSlots — multi-turn memory', () => {
  test('follow-up "under 8K" carries prior {size: 6}', () => {
    const t1 = parseSlots('shoe 6 size');
    const t2 = parseSlots('under 8 K');
    const merged = mergeSlots(t1, t2);
    expect(merged.size).toBe(6);
    expect(merged.max_price).toBe(8000);
  });
  test('reset word clears prior', () => {
    expect(shouldReset('start over')).toBe(true);
    expect(shouldReset('reset it')).toBe(true);
    expect(shouldReset('show me more')).toBe(false);
  });
});
```

**Coverage target:** 95% line, 100% branch on `parser.js`. ~60 tests total.

**Fixture expansion:** keep a `fixtures/production_queries.json` of every real user message from Render logs. Re-run parser against it on every commit — if a query's `intent_hint` changes, tests fail. This is your regression net.

#### 3.2 `session.js` — in-memory store

```js
// session.test.js
const session = require('../session');

test('new session returns empty slots', () => {
  const s = session.get('test-1');
  expect(s.slots).toEqual({});
  expect(s.turns).toBe(0);
});

test('update merges slots across turns', () => {
  session.update('test-2', { slots: { size: 6 } });
  session.update('test-2', { slots: { max_price: 8000 } });
  const s = session.get('test-2');
  expect(s.slots).toEqual({ size: 6, max_price: 8000 });
});

test('reset clears session', () => {
  session.update('test-3', { slots: { size: 10 } });
  session.reset('test-3');
  expect(session.get('test-3').slots).toEqual({});
});

test('TTL eviction — sessions older than 30 min are swept');   // use fake timers
test('5000-session cap triggers LRU eviction');                 // seed and verify
```

**Coverage target:** 90% line. ~10 tests.

#### 3.3 `agents.js` — validator + price-bound extractors

The validator is defense-in-depth. It must never let a `₹X,XXX` leak or a price-cap violation through.

```js
// validator.test.js
const { validateResponse } = require('../agents');

test('blocks ₹X,XXX placeholder', () => {
  const r = validateResponse('shoe', 'Price: ₹X,XXX', 'shoe under 5k');
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('price_placeholder_leak');
});

test('blocks price over user cap', () => {
  const r = validateResponse('shoe', 'Price: ₹11,899', 'shoe size 11 under 6K');
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/price_cap_violation/);
});

test('allows price within cap', () => {
  const r = validateResponse('shoe', 'Price: ₹4,999', 'shoe under 5K');
  expect(r.ok).toBe(true);
});

test('catches wrong-category link on racquet intent', () => {
  const r = validateResponse('racquet', '[Wilson Tennis Ball](url)', 'show racquets');
  expect(r.ok).toBe(false);
});
```

**Coverage target:** 100% of the `validateResponse` switch branches. ~15 tests.

#### 3.4 `server.js` helpers — pure functions

- `buildProductUrl(urlKey, name, sku)` — slug trimming, `.html` enforcement.
- `applyPriceSizeFilters(products, {...})` — filter behavior on empty/null/edge prices.
- `extractCustomAttrs(item)` — shape mapping.
- `resolveAttr(code, value)` — option ID to label.
- `findCategoriesByKeyword(keyword)` — regex match on flat map.

**Coverage target:** 85% line. ~20 tests.

---

### TIER 2 — Integration with mocked Magento

Use `nock` to intercept Magento HTTP calls. Boot the Express app in-process, hit `/api/chat-agents` with fake Magento responses, assert on the final user-facing text.

**Example — "shoe size 11 under 6K" regression test:**

```js
// chat.integration.test.js
const request = require('supertest');
const nock = require('nock');
const app = require('../server');    // export app from server.js

test('shoe size 11 under 6K — does NOT return ₹11,899 products', async () => {
  nock('https://console.tennisoutlet.in')
    .get('/rest/V1/categories/24/products').query(true)
    .reply(200, [{ sku: 'shoe-a' }, { sku: 'shoe-b' }]);
  nock('https://console.tennisoutlet.in')
    .get('/rest/V1/products/shoe-a').reply(200, fakeShoe('shoe-a', 11899, '11'));
  nock('https://console.tennisoutlet.in')
    .get('/rest/V1/products/shoe-b').reply(200, fakeShoe('shoe-b', 4999, '11'));
  // ... mock stock and children ...

  const res = await request(app)
    .post('/api/chat-agents')
    .send({ messages: [{ role: 'user', content: 'shoe size 11 under 6K' }] });

  expect(res.body.message).not.toMatch(/11,?899/);
  expect(res.body.message).toMatch(/4,?999/);
  expect(res.body.agent_trace.validation).toBe('passed');
});
```

**Priority scenarios (every one is a real production bug):**

1. Price cap respected: "shoe under 5K" never returns items > ₹5000.
2. Size filter respected: "size 10" never returns products without a size-10 child in stock.
3. Zero-results honesty: tool returns `[]` → response says so, does NOT fall back to unfiltered list.
4. Session carry-over: two POSTs with same `x-session-id`, first "shoe 6 size", second "under 8K" → second response uses both slots.
5. Ball-machine query: `get_ball_machines` is called (not `search_products`).
6. Review query: `get_product_reviews` is called, not a flat refusal.
7. Out-of-stock filter: products with `qty=0` never appear in response.
8. Wrong-category link validation: racquet intent can never link to a ball.

**Coverage target:** one integration test per high-risk path (~15 tests). Run on every PR.

---

### TIER 3 — LLM contract tests (hardest, run weekly)

The LLM is non-deterministic. You can't assert exact output. You can assert invariants.

**Approach:** run the live `/api/chat-agents` endpoint against a fixed query bank, pipe each response through a set of assertions, count pass rate.

```js
const QUERIES = [
  { q: 'shoe size 11 under 6K', assert: r => !priceOver(r, 6000) },
  { q: 'tennis ball machine',   assert: r => r.match(/ball.machine|thrower/i) && r.match(/tennisoutlet.in/) },
  { q: 'review of ASICS Gel Resolution', assert: r => r.match(/product page|review/i) },
  { q: 'hi',                    assert: r => r.match(/welcome/i) && r.length < 400 },
  // ... ~30 queries covering all intents
];
```

**Metric:** "% of queries that pass invariants." Target: ≥95% on main. If it drops below 90%, block the next deploy.

**When to run:** nightly cron against production. Weekly before sprint review. Not on every commit — too slow and non-deterministic.

---

### TIER 4 — E2E smoke suite (every deploy)

8 curl commands, <30 seconds, runs from GitHub Actions after Render reports deploy complete. Hits the live URL.

```bash
# smoke.sh
URL="${CHATBOT_URL:-https://to-assistant-chatbot.onrender.com}"
fail=0
check() { local q="$1" pat="$2"
  r=$(curl -s -X POST "$URL/api/chat-agents" -H 'Content-Type: application/json' \
    -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$q\"}]}")
  echo "$r" | grep -qE "$pat" && echo "OK  $q" || { echo "FAIL $q"; fail=1; }
}
check "hi"                              "Welcome to TennisOutlet"
check "shoe size 11 under 6K"           '(tennisoutlet\.in|I couldn.t find)'
check "tennis ball machine"             "ball.machine|thrower|cannon"
check "tennis racquets under 5000"      "racquet"
check "what brands do you carry"        "Babolat|Wilson|Head"
check "what is your return policy"      "30.day|return"
check "review of Babolat Pure Drive"    "reviews|product page"
check "800002010"                       "order|track"
exit $fail
```

Wire this as a GitHub Actions job that runs on `push` to `main` after a 90-second sleep for Render deploy.

---

## 4. Gap analysis — what exists vs. what's needed

| Area | Exists | Needed | Priority |
|------|--------|--------|----------|
| Parser unit tests | ❌ none | ~60 tests | **P0** |
| Validator tests | ❌ none | ~15 tests | **P0** |
| Session tests | ❌ none | ~10 tests | P0 |
| Server helpers | ❌ none | ~20 tests | P1 |
| Integration /api/chat-agents | ❌ none | ~15 tests | **P0** |
| LLM contract suite | ❌ none | ~30 queries | P1 |
| E2E smoke | ❌ none | 8 curls | **P0** |
| CI pipeline | ❌ none | GitHub Actions workflow | **P0** |

No fixtures, no mocks, no CI config. The repo doesn't even have a `package.json` script for `test`.

---

## 5. 1-week implementation plan

**Day 1 — scaffolding (half day)**
- `npm i -D jest supertest nock`
- `package.json` `"test": "jest"`, `"test:integration": "jest --testPathPattern=integration"`
- `jest.config.js` with coverage threshold 80/70/70/80 on parser + validator + session.
- Create `__tests__/` with one sanity test.

**Day 2 — parser.test.js (full day)**
- ~60 tests covering every regex case and edge.
- Seed `fixtures/production_queries.json` from the last 100 Render log lines.
- Aim for 95% coverage on `parser.js`.

**Day 3 — validator + session (full day)**
- Validator tests (15).
- Session tests (10) including fake timers for TTL.
- Helpers tests (`applyPriceSizeFilters`, `buildProductUrl`).

**Day 4 — integration harness (full day)**
- Export `app` from `server.js` without `app.listen` in test mode.
- Mock `loadAttributeOptions` + `initCategoryMap` to synchronous stubs.
- Write the 8 priority integration scenarios listed in Tier 2.

**Day 5 — CI + smoke (half day)**
- `.github/workflows/ci.yml`: on PR, run `npm test` + `npm run test:integration`.
- `.github/workflows/smoke.yml`: on push to main, wait 90s, run smoke.sh.
- Block merge on red.

**End of week deliverable:** ~120 tests, <30s total, runs on every commit. Every production bug class from the last two weeks is now a blocking test.

---

## 6. What NOT to test

- The LLM's prose quality. Not deterministic, not worth chasing.
- Magento's behavior. We test *our* adapter, not their endpoints.
- Rate limiter internals. Framework code.
- Exact wording of system prompts. Assert on behavior, not strings.
- 100% line coverage. Diminishing returns past 85% on this codebase.

---

## 7. Coverage targets by file

| File | Line | Branch | Rationale |
|------|------|--------|-----------|
| parser.js | 95% | 100% | Pure, deterministic, high blast radius |
| session.js | 90% | 85% | Pure, small |
| agents.js validator block | 100% | 100% | Safety net, must be airtight |
| server.js helpers | 85% | 75% | Mix of pure + I/O |
| server.js Magento I/O | 60% | — | Mocked in integration, not unit |
| agents.js LLM orchestration | — | — | Covered only by contract tests |

---

## 8. One recommendation if you only do one thing this week

Ship **parser.test.js + validator.test.js + an 8-curl smoke.sh in GitHub Actions.** That's one day of work and it would have caught every bug you've shipped since v3.2. Everything else is a nice-to-have layered on top of that foundation.

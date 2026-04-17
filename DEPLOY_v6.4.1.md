# v6.4.1 Deploy Guide — resolver stemming + synonym fix

**What's in this release (v6.4.1):** "pickle bag" / "any shoes" / "tennis shoes" / "padel shoes" / "pickleball shoes" will now actually find the right category and return products. Root cause was NOT inventory — the resolver couldn't match singular/plural or user shorthand against the category index. Admin-screenshot verified there's real stock.

**Files changed since v6.4.0:**
- `server.js` — added `_stemVariants`, stemming-aware `buildCategoryIndex`, `QUERY_SYNONYMS` + `SAFETY_NET_NOUNS` + `KNOWN_SPORTS`, upgraded `resolveCategoriesFromQuery` to synonym + stem expansion with safety net, new `/api/stock-debug?category=<id>` mode.
- `package.json` — version bump 6.4.0 → 6.4.1.
- `PROJECT_MEMORY.md` — corrected v6.4.0 framing + v6.4.1 changelog.
- `DEPLOY_v6.4.1.md` — this file.
- `test-resolver.js` — local fixture test (22 assertions, all passing).

`agents.js` is unchanged from v6.4.0 — the OOS-aware prompts there are still correct.

---

## 0. Pre-flight (one-time, local)

```bash
cd ~/path/to/to-assistant-chatbot
git status
node --version          # Node 20+ recommended
```

Overwrite in your local repo with the v6.4.1 files from this session's output folder:

- `server.js`
- `package.json`
- `PROJECT_MEMORY.md`

(You can also copy `test-resolver.js` if you want to keep the fixture test. It's optional in production — feel free to `.gitignore` it.)

Verify syntax + run the fixture test:

```bash
node -c server.js && node -c agents.js && echo OK
node test-resolver.js
```

Expect `OK` and `=== 22 passed / 0 failed ===`. If either step fails, stop — don't push.

---

## 1. Commit & push

```bash
git add server.js package.json PROJECT_MEMORY.md DEPLOY_v6.4.1.md
git commit -m "v6.4.1: stemming + synonym expansion in CATEGORY_INDEX resolver

Root cause of the 'no output for pickle bag / any shoes' bug was the
resolver, not inventory. CATEGORY_INDEX indexed 'Pickleball Bags' as
{pickleball, bags, 'pickleball bags'} — user queries ('pickle bag',
'any shoes') never matched. Admin screenshot confirmed the catalog
has real stock (PIBG0021=5, PIBG0027=4, etc.).

- _stemVariants: plural<->singular English-ish stemmer
- buildCategoryIndex: indexes token + stem variants, bigram singular-right
- QUERY_SYNONYMS: pickle->pickleball, racket->racquet, footwear->shoes, etc.
- resolveCategoriesFromQuery: synonym + stem expansion, cross-product bigrams
- Safety net: bare product-noun fallback if resolver returns empty
- /api/stock-debug?category=<id> mode: admin-style category-scoped MSI view
"
git push origin main
```

Render auto-deploys on push to `main` (`render.yaml`). Build ~60–90 s.

---

## 2. Post-deploy smoke matrix

Replace `<APP>` with your Render URL.

### 2a. Health check (must pass first)

```bash
curl -s https://<APP>/api/health | jq
```

Expect:
- `"magento_bearer": "connected"`
- `"category_index_size"` > 100. If 0, hit `curl -s https://<APP>/api/refresh` once.

### 2b. Ultrareview — prove bags + shoes are reachable via real Magento calls

```bash
# Find the Pickleball Bags category id from /api/health or /api/list-categories.
# Substitute the real id below (example shown with id=23 — yours will differ).
curl -s "https://<APP>/api/stock-debug?category=23&pageSize=100" | jq '{total_count, returned, in_stock_count, out_of_stock_count, sample: (.items[0:5] | map({sku, name, type_id, msi_qty, stock_item_in_stock}))}'
```

**Pass criteria:**
- `in_stock_count` ≥ 5 (the screenshot showed at least PIBG0021/PIBG0027/PIBG0020/PIBG0028/PIBG0029).
- `sample` contains at least one SKU prefixed `PIBG*` with `msi_qty > 0`.

Repeat the same curl against your Pickleball Shoes, Tennis Shoes, and Padel Shoes category ids. If `in_stock_count` there is 0, that category IS a real stockout and the UX fallback from v6.4.0 will kick in cleanly.

### 2c. The two failing queries (core regression tests)

```bash
# "pickle bag" — should now resolve to Pickleball Bags and return product cards
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"pickle bag","session":{"sport":"pickleball"}}' | jq -r '.reply' | head -60

# "any shoes" — should now resolve to all three sports' shoe categories
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"any shoes","session":{"sport":"tennis"}}' | jq -r '.reply' | head -60

# "tennis shoes size 10"
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"tennis shoes size 10","session":{"sport":"tennis"}}' | jq -r '.reply' | head -60

# Synonym check — "racket" -> Racquets
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"best tennis racket under 10000","session":{"sport":"tennis"}}' | jq -r '.reply' | head -40
```

**Pass criteria:**
- Reply contains at least 3 clickable product links (markdown `[name](url)`).
- Reply does NOT contain "we don't have any" or "nothing is available" when the category has any products (in-stock or OOS).
- If an item is sold out, it still appears with the "currently sold out — get notified" note (v6.4.0 prompt rule).

### 2d. Regressions to watch

```bash
# Order status (OAuth path, unrelated)
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"where is order 300001234","session":{}}' | jq -r '.reply'

# Racquet specialist
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"best tennis racquet under 10000","session":{"sport":"tennis"}}' | jq -r '.reply' | head -40

# Tennis balls (catalog agent)
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"show tennis balls","session":{"sport":"tennis"}}' | jq -r '.reply' | head -40

# Tennis racquet bags (in-stock positive control)
curl -s -X POST https://<APP>/api/chat-agents \
  -H 'Content-Type: application/json' \
  -d '{"message":"show me tennis racquet bags","session":{"sport":"tennis"}}' | jq -r '.reply' | head -40
```

### 2e. Resolver dry-run via the index (sanity)

```bash
# Dumps a sample of CATEGORY_INDEX keys + counts. Must include "bag" and "shoe" (stemmed).
curl -s https://<APP>/api/index-debug | jq '{size, sample_keys: (.keys[0:40])}'
```

(If `/api/index-debug` doesn't exist yet, skip — resolver is independently verified by the local `node test-resolver.js` run from step 0.)

---

## 3. Rollback plan

If any smoke step fails:

1. Render → service → **Deploys** → previous green deploy → **Rollback** (~30 s).
2. Open a GitHub issue with the failing `curl` output.
3. No data migrations. Zero-risk rollback.

---

## 4. Follow-on work (not blocking)

- **Synonym map growth.** Current map covers the known customer shorthand. Add entries as we see them in logs (e.g. "paddle" for pickleball paddle vs. padel — currently mapped to padel, watch for drift).
- **Pinecone (Phase 2).** Only if query diversity grows past what a keyword + stem + synonym index can cover cleanly.
- **`/api/stock-debug` dashboard.** HTML wrapper around the new `category=` mode so ops can spot-check SKU stock without curl.
- **`agents.js` PRODUCT_FORMAT review.** The OOS messaging is strong; the next lever is showing in-stock SKU-size badges on shoes so "size 10 in Tennis Shoes" surfaces whether 10 is actually in stock.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { masterHandle } = require('./agents');
const slotParser = require('./parser');
const { normalizeQuery } = require('./normalizer');
const sessionStore = require('./session');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ==================== CONFIG ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
const MAGENTO_BASE_URL_RAW = process.env.MAGENTO_BASE_URL || 'https://console.tennisoutlet.in';
// Normalize: strip trailing slash, strip existing /rest/V1 if env already included it
const MAGENTO_ROOT = MAGENTO_BASE_URL_RAW.replace(/\/+$/, '').replace(/\/rest\/V1$/i, '');
const MAGENTO_BASE_URL = MAGENTO_ROOT;
const MAGENTO_REST = `${MAGENTO_ROOT}/rest/V1`;
const MAGENTO_TOKEN = process.env.MAGENTO_TOKEN;
const MAGENTO_STORE_URL = process.env.MAGENTO_STORE_URL || 'https://tennisoutlet.in';

// ==================== MULTI-STORE CONFIG (v5.0) ====================
// Each sport maps to its own storefront URL and (optionally) its own Magento backend.
// For now all 3 stores share a single Magento instance — when you split backends,
// just set the env vars (e.g. MAGENTO_PADEL_BASE_URL, MAGENTO_PICKLEBALL_BASE_URL).
const STORE_CONFIG = {
  tennis: {
    name: 'TennisOutlet.in',
    storeUrl: process.env.TENNIS_STORE_URL || 'https://tennisoutlet.in',
    magentoRest: process.env.TENNIS_MAGENTO_REST || MAGENTO_REST,
    magentoToken: process.env.TENNIS_MAGENTO_TOKEN || MAGENTO_TOKEN,
    phone: '+91 9502517700',
    emoji: '\u{1F3BE}'
  },
  padel: {
    name: 'PadelOutlet.in',
    storeUrl: process.env.PADEL_STORE_URL || 'https://padeloutlet.in',
    magentoRest: process.env.PADEL_MAGENTO_REST || MAGENTO_REST,
    magentoToken: process.env.PADEL_MAGENTO_TOKEN || MAGENTO_TOKEN,
    phone: '+91 9502517700',
    emoji: '\u{1F3BE}'
  },
  pickleball: {
    name: 'PickleballOutlet.in',
    storeUrl: process.env.PICKLEBALL_STORE_URL || 'https://pickleballoutlet.in',
    magentoRest: process.env.PICKLEBALL_MAGENTO_REST || MAGENTO_REST,
    magentoToken: process.env.PICKLEBALL_MAGENTO_TOKEN || MAGENTO_TOKEN,
    phone: '+91 9502517700',
    emoji: '\u{1F3D3}'
  }
};

function getStoreConfig(sport) {
  const s = String(sport || 'tennis').toLowerCase();
  return STORE_CONFIG[s] || STORE_CONFIG.tennis;
}

function getStoreUrl(sport) {
  return getStoreConfig(sport).storeUrl;
}

// OAuth 1.0a credentials (used for orders endpoint which requires admin OAuth)
const OAUTH_CONSUMER_KEY = process.env.MAGENTO_CONSUMER_KEY;
const OAUTH_CONSUMER_SECRET = process.env.MAGENTO_CONSUMER_SECRET;
const OAUTH_ACCESS_TOKEN = process.env.MAGENTO_ACCESS_TOKEN;
const OAUTH_ACCESS_TOKEN_SECRET = process.env.MAGENTO_ACCESS_TOKEN_SECRET;

// ==================== SYSTEM PROMPT ====================
const SYSTEM_PROMPT = `You are "TO Assistant" - the official Customer Support Assistant for Pro Sports Outlets, India's trusted online stores for racquet sports:
- Tennis: TennisOutlet.in (https://tennisoutlet.in)
- Pickleball: PickleballOutlet.in (https://pickleballoutlet.in)
- Padel: PadelOutlet.in (https://padeloutlet.in)
Route product links to the correct store based on the sport detected.

BRAND INFORMATION:
- Websites: https://tennisoutlet.in (Tennis) | https://pickleballoutlet.in (Pickleball) | https://padeloutlet.in (Padel)
- Parent Company: Pro Sports Outlets
- Store Address: Survey No. 47/A, near Sreenidhi International School, Aziznagar, Hyderabad, Telangana 500075
- Store Timings: 10:30 AM - 06:00 PM, Mon-Sat
- Phone: +91 9502517700 (Mon-Sat, 10 AM-6 PM) - NOT available on WhatsApp
- Sister Brands: PickleballOutlet.in, PadelOutlet.in

GREETING:
- Tennis: "Welcome to TennisOutlet! \u{1F3BE} How may I help you today?"
- Pickleball: "Welcome to PickleballOutlet! How may I help you today?"
- Padel: "Welcome to PadelOutlet! How may I help you today?"

ORDER MANAGEMENT:
- When a customer provides an Order ID, use get_order_status.
- Share only status, tracking info, delivery timeline.
- NEVER reveal amount, address, product items, or payment info.
- When AWB is available, ALWAYS share Blue Dart tracking link: https://bluedart.com/?{AWB}
- Orders dispatched within 8 hours. Delivery 2-5 business days (Blue Dart).

RETURNS/REFUNDS:
- 30-day return policy (unused, tags intact). https://tennisoutlet.in/return-cancellation-policy
- Play & Return: https://tennisoutlet.in/play-return-program
- Refunds: 48 hrs processing; bank credit up to 5 business days; TO Wallet instant.

PRODUCTS:
- Use get_products_by_category or search_products. ALWAYS return 4-5 products minimum when available.
- All products 100% authentic. Warranty: https://tennisoutlet.in/warranty-promise
- Buying Guide: https://tennisoutlet.in/buying-guide
- Pre-strung racquets typically strung at 55-56 tension.

PRODUCT PRESENTATION RULES (MANDATORY — NEVER SKIP):
- Return AT LEAST 4-5 products whenever the catalog has them.
- EVERY product MUST be a clickable markdown link using the product_url field from the tool response. This is the #1 most important rule.
- Use this EXACT markdown format — the UI renders it as clickable links:

1. **[Product Name](https://SPORT-STORE-URL/actual-product-slug.html)**
   Price: \u20B9X,XXX
   Coach's Take: <one-line reason / ideal user>

- The product_url is already in every product object the tool returns. Copy it exactly into the markdown link parentheses. The URL already points to the correct store (tennisoutlet.in, pickleballoutlet.in, or padeloutlet.in) based on the sport. Example: if the tool returns product_url: "https://pickleballoutlet.in/joola-hyperion-vision-16-mm-storm-blue.html", write: **[Joola Hyperion Vision 16 mm - Storm Blue](https://pickleballoutlet.in/joola-hyperion-vision-16-mm-storm-blue.html)**
- If you list a product WITHOUT a clickable link, the response is BROKEN and unusable. Always include the link.
- NEVER show quantity/stock numbers to the customer.
- ONLY recommend products where in_stock is true. If a product has in_stock: false or qty: 0, SKIP it entirely — do not mention it.
- NEVER use markdown images ![]().
- NEVER add target="_blank" or raw HTML attributes in your text.
- The tool returns products sorted highest-qty first. Feature the FIRST product prominently as the recommended upsell pick.
- After the list, add a short "Coach's Verdict" comparative insight (beginner vs. intermediate, power vs. control, etc.).

TERMINOLOGY MAP (CRITICAL - always apply BEFORE routing):
- "paddleball" / "paddle ball" / "pickle" / "pickball" / "pickleball" -> PICKLEBALL sport. Paddle product = pickleball paddle (category 250). Balls = 252. Shoes = 253.
- "padel" / "padel tennis" -> PADEL sport. Racket (not paddle) = category 272. Balls = 273. Shoes = 274.
- "ball machine" / "ball thrower" / "ball cannon" / "ball launcher" / "ball feeder" / "ai ball machine" / "smart ball machine" -> MUST call get_ball_machines. Never use get_products_by_category or search_products for these.
- If the customer uses ambiguous term "paddle": assume PICKLEBALL PADDLE unless they explicitly say "padel". If "racket" without sport, assume TENNIS.
- If a query mentions ANY product that exists in our catalog (tennis, pickleball, padel, ball machine, shoes, strings, bags, accessories), you MUST call the appropriate Magento tool. NEVER reply "we don't have that" or "I can't fetch" without first trying search_products as a fallback.

ROUTING RULES (STRICT - follow these exactly):
- ANY query about RACQUETS / RACKETS / PADDLES (tennis racquet, padel racket, pickleball paddle, paddleball paddle, brand-specific) -> MUST call get_racquets_with_specs with the correct sport (tennis/padel/pickleball). NEVER use get_products_by_category for racquets. NEVER use best-seller categories (338/434).
- ANY query about SHOES / FOOTWEAR -> MUST call get_shoes_with_specs (never get_products_by_category for shoes).
- ANY query about BRANDS carried by the store -> call list_brands.
- BALLS -> get_products_by_category (Tennis Balls=31, Pickleball Balls=252, Padel Balls=273).
- STRINGS -> get_products_by_category (29).
- BAGS -> get_products_by_category (115).
- ACCESSORIES -> get_products_by_category (37).
- USED racquets -> get_products_by_category (90).
- Sale/Wimbledon/Grand Slam offers -> get_products_by_category (292/349/437).
- RACQUET UPGRADE / TRADE-IN / SELL OLD RACQUET -> Direct customer to: https://tennisoutlet.in/racquet-upgrade-program — we purchase customer's old racquets through our Racquet Upgrade Program.
- FALLBACK: If no rule above matches the product type, call search_products with the customer's keywords. NEVER refuse a product query without trying at least one Magento tool.

SMART GUIDELINES:
- Beginner racquet -> get_racquets_with_specs({skill_level:"beginner"}) + add beginner advice (lighter, larger head size, forgiving).
- Brand-specific racquet -> get_racquets_with_specs({brand:"Babolat"|"Head"|"Wilson"|"YONEX"|"Prince"...}).
- Expensive items -> mention WELCOME10 coupon (10% off up to \u20B9300) for first-time buyers.
- Cross-sell: racquet -> suggest strings/bags/shoes.
- When recommending new racquets, mention the Racquet Upgrade Program (https://tennisoutlet.in/racquet-upgrade-program) — customers can trade in their old racquet.

SIZE / SIZE-SPECIFIC REQUESTS (IMPORTANT):
- Shoe sizes (UK/US/EU) and apparel sizes are VARIANTS selected on each product page — they are NOT separate products and NOT in product names.
- NEVER tell the customer "we don't have size X" or "no shoes in size X". Sizes are available on each product page.
- For shoe queries WITH a size: call get_shoes_with_specs with the size parameter. The tool will try to find exact size matches, and if none, will automatically fall back to showing all available shoes with a note about size selection.
- For shoe queries WITHOUT a size: call get_shoes_with_specs normally, show 4-5 products.
- ALWAYS show shoes with clickable links. After the list, add: "All sizes (including size X) can be selected on each product page. If a specific size is sold out, it will be marked on that page."
- If the customer says "sports shoes" or just "shoes" without specifying tennis/pickleball/padel, pass sport="all" to get_shoes_with_specs to search across all stores.
- Same rule for grip size on racquets, apparel sizes (S/M/L/XL), string tension, etc. — show the category, tell the user where to pick the variant on the product page.

PAYMENT:
- Cards, Net Banking, UPI, EMI, COD. EMI: "coming within a week".

COMMUNICATION:
- Warm, professional, empathetic. Short clear sentences. Sparing emojis (\u{1F3BE} \u2705 \u{1F4E6}).
- If unsure: "I'm connecting you with our support team for further assistance. Please hold on."
- Closing: "Thank you for contacting TennisOutlet! Have a great day! \u{1F3BE}"
- Always end with: "Is there anything else I can assist you with?"

BOUNDARIES:
- No competitor discussion, no medical/injury advice, no payment processing.
- Stay strictly within TennisOutlet / PickleballOutlet / PadelOutlet scope.
- We do NOT carry New Balance - recommend alternatives.

Use the sport-specific store URL for all product links: Tennis=https://tennisoutlet.in, Pickleball=https://pickleballoutlet.in, Padel=https://padeloutlet.in. The tool already returns the correct product_url — just use it.`;

// ==================== FUNCTION DEFINITIONS ====================
const FUNCTION_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "Fetch order details when customer gives an Order ID. Returns status, tracking, delivery timeline, and status history. Never expose amount/address/items/payment to the customer.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Customer's order ID (e.g., '400020695' or '#400020695')" }
        },
        required: ["order_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_products_by_category",
      description: `Fetch available (qty>=1) products from a category. Categories:
TENNIS: Racquets(25), Babolat(26), Wilson(34), Head(35), Yonex(66), Prince(336), Strings(29), Shoes(24), Balls(31), Bags(115), Accessories(37)
SKILL: Beginner(87), Intermediate(80), Advanced(79), Senior(88), Junior(81)
USED: 90
PICKLEBALL: Main(243), Paddles(250), Balls(252), Shoes(253)
PADEL: Main(245), Rackets(272), Balls(273), Shoes(274)
SALE: Wimbledon(292), GrandSlam(349), BoxingDay(437)
BEST SELLERS: 2024(338), 2025(434)
BRAND LINES: Pure Aero(44), Pure Drive(45), Pro Staff(50), Blade(52), Speed(57), EZONE(69), VCORE(67)`,
      parameters: {
        type: "object",
        properties: {
          category_id: { type: "integer" },
          min_price: { type: "number", description: "Optional minimum price in INR (resolved against enriched configurable-child price)." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand: '5K'->5000, '1L'/'1 lakh'->100000." },
          page_size: { type: "integer", description: "Max products (default 10, max 20)", default: 10 }
        },
        required: ["category_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_shoes_with_specs",
      description: "Return shoes from TennisOutlet with FULL resolved specs. Use this for ANY shoe query including brand, size availability, price caps, or spec filtering. All filters optional and AND-combined. Size filter checks child SKU stock — if the requested size is out of stock the product is excluded.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "pickleball", "padel"], default: "tennis" },
          brand: { type: "string", description: "Brand name like 'ASICS', 'Nike', 'Adidas'. Optional." },
          shoe_type: { type: "string", description: "Men's / Women's / Kid's. Optional." },
          court_type: { type: "string", description: "All Court / Clay Court / Hard Court / Padel Court / Pickleball Court. Optional." },
          width: { type: "string", description: "Narrow / Medium / Wide. Optional." },
          cushioning: { type: "string", description: "Low / Medium / High. Optional." },
          size: { type: "string", description: "Shoe size the customer wants (e.g. '10', '9.5'). Filters to products where that size's child SKU is in stock." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand before calling: '5K'->5000, '1L'->100000, 'under 8000'->8000." },
          page_size: { type: "integer", default: 10 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_racquets_with_specs",
      description: "Return RACQUETS (not balls, not accessories) from the correct racquet category with brand resolved. ALWAYS use this for any query about racquets/rackets/paddles - NEVER use get_products_by_category for racquet queries. Tennis Racquets=25, Padel Rackets=272, Pickleball Paddles=250. Supports brand, skill_level, and price filters.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "padel", "pickleball"], default: "tennis" },
          brand: { type: "string", description: "Brand name like Babolat, Head, Wilson, YONEX, Prince. Optional." },
          skill_level: { type: "string", enum: ["beginner", "intermediate", "advanced", "senior", "junior"], description: "Optional skill level filter." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand before calling: '5K'->5000." },
          page_size: { type: "integer", default: 10 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_brands",
      description: "List every brand carried by TennisOutlet.in with its internal brand id. Use when the customer asks 'which brands do you carry?' or to discover the exact spelling before filtering.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_ball_machines",
      description: "Return ALL ball-machine-type products (ball machines, throwers, cannons, launchers, feeders) from TennisOutlet.in with product links. Combines category lookup (discovered from Magento category tree at startup), free-text search across name/sku/url_key, and slug matching. Use this for ANY ball machine / ball thrower / ball cannon query — do NOT use get_products_by_category or search_products for these, because ball machines are not in the standard category IDs.",
      parameters: {
        type: "object",
        properties: {
          min_price: { type: "number", description: "Optional min price in INR." },
          max_price: { type: "number", description: "Optional max price in INR. '1L'->100000, '50K'->50000." },
          page_size: { type: "integer", default: 10 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_product_reviews",
      description: "Fetch customer reviews for a product from Magento. Pass either {sku} if you already know it, or {query} as free text (product name/keywords). Returns product link, review list with rating/title/detail/nickname, average rating percent, and a review_page_hint URL. If the endpoint isn't accessible, returns empty reviews with a message pointing to the product page reviews section.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string", description: "Product SKU if known." },
          query: { type: "string", description: "Free-text product name/keywords when SKU is unknown." },
          page_size: { type: "integer", default: 5 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "smart_product_search",
      description: "PREFERRED product discovery tool. Resolves natural-language queries to the best Magento categories using an in-memory index, fetches from those categories AND runs a keyword search, then merges and deduplicates. Use this FIRST for any general product query (e.g. 'tennis bags', 'padel balls', 'sale items', 'strings under 2000'). Falls back to keyword search if no category matches. Returns products with product_url, price, qty, and source info.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language product query (e.g. 'beginner tennis racquets', 'padel balls', 'used racquets', 'wimbledon sale')" },
          sport: { type: "string", enum: ["tennis", "pickleball", "padel"], description: "Sport context for URL generation." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. '5K'=5000, '1L'=100000." },
          page_size: { type: "integer", description: "Max products (default 10, max 20)", default: 10 }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_categories",
      description: "Search the Magento category tree by keyword and return matching category IDs + paths. Use when you need to discover the exact category ID for an unusual product type (e.g. 'pressureless balls', 'kids racquets').",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", description: "Keyword to match against category name or path." } },
        required: ["keyword"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_categories",
      description: "List every active Magento category as a flat array with id, name, full path, and product_count. Use when the user asks 'what categories do you have' or for catalog discovery.",
      parameters: {
        type: "object",
        properties: {
          min_level: { type: "integer", description: "Minimum tree level (1=root children, 2=sub, etc.). Default 1.", default: 1 },
          active_only: { type: "boolean", default: true }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search the full TennisOutlet.in catalog by name/keyword. Returns only available (qty>=1) items, sorted highest-qty first. Supports price filters.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand: '5K'->5000, '1L'->100000." },
          page_size: { type: "integer", default: 10 }
        },
        required: ["query"]
      }
    }
  }
];

// ==================== HELPERS ====================

// Build product URL: prefer url_key, else derive from name; drop trailing SKU-like suffixes; ensure .html
// ==================== PRODUCT URL (v5.3.0) ====================
// Uses Magento's own url_rewrites table via extension_attributes — the exact URL
// the storefront links to. Falls back to url_key + .html, then to the ID-based
// /catalog/product/view/id/ path which is guaranteed to resolve on every M2 install.
function buildProductUrl(item, sport = 'tennis') {
  const storeUrl = getStoreUrl(sport);
  const attrs = (item.custom_attributes || []).reduce((a, c) => { a[c.attribute_code] = c.value; return a; }, {});

  // 1st choice: Magento's url_rewrites — the authoritative storefront URL.
  // Requires the /products query to request `extension_attributes[url_rewrites]`.
  const rewrites = item.extension_attributes?.url_rewrites;
  if (Array.isArray(rewrites) && rewrites.length > 0) {
    const rewrite = rewrites.find(r => r && r.url) || rewrites[0];
    if (rewrite && rewrite.url) {
      const path = String(rewrite.url).replace(/^\/+/, '');
      return `${storeUrl}/${path}`;
    }
  }

  // 2nd choice: url_key + .html — works on stores with flat URL rewrites.
  if (attrs.url_key) {
    const clean = String(attrs.url_key).replace(/\.html?$/i, '').replace(/^-|-$/g, '');
    if (clean) return `${storeUrl}/${clean}.html`;
  }

  // 3rd choice: ID-based URL — guaranteed to 200 on every Magento install,
  // regardless of SEO config. Magento will 301 to the canonical URL.
  if (item.id) {
    return `${storeUrl}/catalog/product/view/id/${item.id}`;
  }

  // Absolute last resort: homepage (should never be hit).
  return storeUrl;
}

function extractCustomAttrs(item) {
  const attrs = {};
  (item.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
  return attrs;
}

// ==================== CATEGORY INDEX (v5.4.0) ====================
// CATEGORY_MAP = flat list; CATEGORY_INDEX = inverted keyword→[{id,name,score}] for O(1) resolution.
let CATEGORY_MAP = [];
const BALL_MACHINE_CATEGORY_IDS = [];
let CATEGORY_INDEX = {};  // keyword → [{ id, name, score }]

// Build the inverted index from the flat category list.
function buildCategoryIndex(cats) {
  const idx = {};
  const stopwords = new Set(['the','and','or','for','a','an','in','on','to','of','with','by','at','from','is','it','as']);
  for (const c of cats) {
    if (!c.is_active || c.level < 2) continue;
    // Tokenise: name tokens + path tokens (lower, alphanumeric only)
    const tokens = new Set();
    const raw = `${c.name} ${c.path || ''}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (const t of raw) {
      if (t.length >= 2 && !stopwords.has(t)) tokens.add(t);
    }
    // Also add bigrams from name (e.g. "pure aero", "ball machine")
    const nameTokens = c.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
    for (let i = 0; i < nameTokens.length - 1; i++) {
      tokens.add(`${nameTokens[i]} ${nameTokens[i + 1]}`);
    }
    for (const token of tokens) {
      if (!idx[token]) idx[token] = [];
      // Score: deeper = more specific = better; product_count as tiebreaker
      const score = c.level * 10 + Math.min(c.product_count || 0, 99);
      idx[token].push({ id: c.id, name: c.name, path: c.path, score, product_count: c.product_count });
    }
  }
  // Sort each bucket by score descending
  for (const key of Object.keys(idx)) {
    idx[key].sort((a, b) => b.score - a.score);
  }
  return idx;
}

// Resolve a natural-language query to the best category IDs using the inverted index.
function resolveCategoriesFromQuery(query, maxResults = 3) {
  if (!query || !CATEGORY_INDEX || Object.keys(CATEGORY_INDEX).length === 0) return [];
  const q = String(query).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const queryTokens = q.split(/\s+/).filter(t => t.length >= 2);
  if (queryTokens.length === 0) return [];

  // Score each category by how many query tokens it matches
  const catScores = {};  // catId → { ...catInfo, matchCount, totalScore }

  // Try bigrams first (more specific)
  for (let i = 0; i < queryTokens.length - 1; i++) {
    const bigram = `${queryTokens[i]} ${queryTokens[i + 1]}`;
    if (CATEGORY_INDEX[bigram]) {
      for (const cat of CATEGORY_INDEX[bigram]) {
        if (!catScores[cat.id]) catScores[cat.id] = { ...cat, matchCount: 0, totalScore: 0 };
        catScores[cat.id].matchCount += 2;  // bigram match counts double
        catScores[cat.id].totalScore += cat.score * 2;
      }
    }
  }

  // Then unigrams
  for (const token of queryTokens) {
    if (CATEGORY_INDEX[token]) {
      for (const cat of CATEGORY_INDEX[token]) {
        if (!catScores[cat.id]) catScores[cat.id] = { ...cat, matchCount: 0, totalScore: 0 };
        catScores[cat.id].matchCount += 1;
        catScores[cat.id].totalScore += cat.score;
      }
    }
  }

  // Rank by matchCount desc, then totalScore desc
  const ranked = Object.values(catScores)
    .sort((a, b) => b.matchCount - a.matchCount || b.totalScore - a.totalScore)
    .slice(0, maxResults);

  return ranked.map(c => ({ id: c.id, name: c.name, path: c.path, product_count: c.product_count, match_score: c.matchCount }));
}

async function initCategoryMap() {
  try {
    const res = await axios.get(`${MAGENTO_REST}/categories`, {
      headers: { 'Authorization': `Bearer ${MAGENTO_TOKEN}`, 'Accept': 'application/json' },
      timeout: 20000
    });
    const flat = [];
    const walk = (node, parentPath = '') => {
      if (!node) return;
      const current = {
        id: node.id,
        name: node.name,
        level: node.level,
        parent_id: node.parent_id,
        path: parentPath ? `${parentPath} > ${node.name}` : node.name,
        is_active: node.is_active !== false,
        product_count: node.product_count || 0
      };
      flat.push(current);
      (node.children_data || []).forEach(c => walk(c, current.path));
    };
    walk(res.data);
    CATEGORY_MAP = flat;

    // Build inverted index for O(1) query→category resolution
    CATEGORY_INDEX = buildCategoryIndex(flat);
    console.log(`[category-index] loaded ${flat.length} categories, ${Object.keys(CATEGORY_INDEX).length} index keys`);

    // Detect ball-machine-like categories by name
    BALL_MACHINE_CATEGORY_IDS.length = 0;
    const re = /ball.?machine|ball.?thrower|ball.?cannon|ball.?launcher|ball.?feeder|ai.?ball|smart.?ball/i;
    for (const c of flat) if (re.test(c.name)) BALL_MACHINE_CATEGORY_IDS.push(c.id);
    console.log(`[category-index] ball-machine category ids: ${JSON.stringify(BALL_MACHINE_CATEGORY_IDS)}`);
  } catch (e) {
    console.log(`[category-index] failed:`, e.response?.status || e.message);
  }
}

function findCategoriesByKeyword(keyword) {
  if (!keyword) return [];
  const re = new RegExp(String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return CATEGORY_MAP.filter(c => re.test(c.name) || re.test(c.path)).map(c => ({
    id: c.id, name: c.name, path: c.path, product_count: c.product_count
  }));
}

function listAllCategories({ min_level = 1, active_only = true } = {}) {
  return CATEGORY_MAP
    .filter(c => c.level >= min_level && (!active_only || c.is_active))
    .map(c => ({ id: c.id, name: c.name, path: c.path, product_count: c.product_count }));
}

// ==================== ATTRIBUTE OPTION CACHE ====================
// Maps attribute_code -> { optionValue: label }. Resolves IDs like 5452 -> "ASICS".
const ATTR_OPTIONS = {};
const ATTRS_TO_CACHE = ['brands', 'court_type', 'width', 'cushioning', 'shoe_type', 'shoe_size', 'color'];

async function loadAttributeOptions() {
  for (const code of ATTRS_TO_CACHE) {
    try {
      const res = await axios.get(`${MAGENTO_REST}/products/attributes/${code}/options`, {
        headers: { 'Authorization': `Bearer ${MAGENTO_TOKEN}`, 'Accept': 'application/json' },
        timeout: 15000
      });
      const map = {};
      (res.data || []).forEach(o => {
        if (o.value != null && String(o.value).trim() !== '') map[String(o.value)] = o.label;
      });
      ATTR_OPTIONS[code] = map;
      console.log(`[attr-cache] ${code}: ${Object.keys(map).length} options`);
    } catch (e) {
      console.log(`[attr-cache] ${code} failed:`, e.response?.status || e.message);
      ATTR_OPTIONS[code] = {};
    }
  }
}

function resolveAttr(code, value) {
  if (value == null || value === '') return null;
  const map = ATTR_OPTIONS[code];
  if (!map) return value;
  const vals = String(value).split(',').map(v => v.trim()).filter(Boolean);
  const labels = vals.map(v => map[v] || v);
  return labels.length === 1 ? labels[0] : labels;
}

// Reverse-lookup: brand name -> option id (case-insensitive, fuzzy)
function brandNameToId(name) {
  if (!name) return null;
  const map = ATTR_OPTIONS['brands'] || {};
  const target = String(name).trim().toLowerCase();
  for (const [id, label] of Object.entries(map)) {
    if (String(label).trim().toLowerCase() === target) return id;
  }
  // fuzzy contains
  for (const [id, label] of Object.entries(map)) {
    if (String(label).toLowerCase().includes(target)) return id;
  }
  return null;
}

// ==================== MAGENTO BEARER API (catalog) ====================
async function magentoGet(endpoint, params = {}) {
  const response = await axios.get(`${MAGENTO_REST}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${MAGENTO_TOKEN}`,
      'Accept': 'application/json'
    },
    params,
    timeout: 6000   // v5.6.1: 10s→6s — Render 30s budget is tight
  });
  return response.data;
}

// ==================== OAUTH 1.0a (orders) ====================
function oauthHeader(method, url, extraParams = {}) {
  const oauth = {
    oauth_consumer_key: OAUTH_CONSUMER_KEY,
    oauth_token: OAUTH_ACCESS_TOKEN,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0'
  };
  const all = { ...oauth, ...extraParams };
  const paramString = Object.keys(all).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
    .join('&');
  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(OAUTH_CONSUMER_SECRET)}&${encodeURIComponent(OAUTH_ACCESS_TOKEN_SECRET)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');
  oauth.oauth_signature = signature;
  return 'OAuth ' + Object.keys(oauth).sort()
    .map(k => `${k}="${encodeURIComponent(oauth[k])}"`)
    .join(', ');
}

async function oauthGet(endpoint, params = {}) {
  const url = `${MAGENTO_REST}${endpoint}`;
  const auth = oauthHeader('GET', url, params);
  const response = await axios.get(url, {
    headers: { 'Authorization': auth, 'Accept': 'application/json' },
    params,
    timeout: 20000
  });
  return response.data;
}

// ==================== ORDER STATUS ====================
function getStatusLabel(status) {
  const labels = {
    pending: 'Order Received - Awaiting Processing',
    pending_payment: 'Awaiting Payment Confirmation',
    processing: 'Order is Being Processed',
    complete: 'Order Delivered Successfully',
    shipped: 'Order Has Been Shipped',
    canceled: 'Order Has Been Cancelled',
    closed: 'Order Closed',
    holded: 'Order On Hold',
    payment_review: 'Payment Under Review'
  };
  return labels[status] || status;
}

async function getOrderStatus(orderId) {
  const cleanId = String(orderId).replace(/[^0-9]/g, '');
  try {
    let order = null;
    try {
      const searchParams = {
        'searchCriteria[filter_groups][0][filters][0][field]': 'increment_id',
        'searchCriteria[filter_groups][0][filters][0][value]': cleanId,
        'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq'
      };
      const searchRes = await oauthGet('/orders', searchParams);
      if (searchRes.items && searchRes.items.length > 0) order = searchRes.items[0];
    } catch (e) {
      console.log('increment_id search failed:', e.response?.status, e.message);
    }

    if (!order) {
      try { order = await oauthGet(`/orders/${cleanId}`); } catch (e) {
        console.log('entity_id lookup failed:', e.response?.status);
      }
    }

    if (!order || !order.entity_id) {
      return { error: true, message: `Could not find order with ID: ${orderId}. Please verify your order number.` };
    }

    const tracking = [];
    try {
      const shipParams = {
        'searchCriteria[filter_groups][0][filters][0][field]': 'order_id',
        'searchCriteria[filter_groups][0][filters][0][value]': order.entity_id,
        'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq'
      };
      const ship = await oauthGet('/shipments', shipParams);
      (ship.items || []).forEach(s => (s.tracks || []).forEach(t => {
        tracking.push({
          carrier: t.title || t.carrier_code || 'Blue Dart',
          tracking_number: t.track_number,
          tracking_url: t.track_number ? `https://bluedart.com/?${t.track_number}` : null
        });
      }));
    } catch (e) { console.log('shipments fetch failed:', e.response?.status); }

    const history = (order.status_histories || []).map(h => ({
      status: h.status,
      comment: h.comment,
      created_at: h.created_at
    }));

    return {
      order_id: order.increment_id,
      status: order.status,
      state: order.state,
      status_label: getStatusLabel(order.status),
      created_at: order.created_at,
      updated_at: order.updated_at,
      tracking,
      status_history: history
    };
  } catch (error) {
    console.error('getOrderStatus error:', error.response?.status, error.response?.data?.message || error.message);
    return { error: true, message: `Could not fetch order ${orderId}. Please verify the number or contact support at +91 9502517700.` };
  }
}

// ==================== STOCK RESOLUTION (v5.3.0) ====================
// Uses Magento 2's canonical condition_type=in filter — the same idiom Magento's
// own SearchCriteriaBuilder emits. Previous versions chained N eq-filters which
// triggers undefined behavior in M2 REST (silently returns empty or partial results).
// Works on MSI, legacy cataloginventory, single-source, multi-source — every variant.
// Returns: { [sku]: qty } where qty >= 1 means "customer can buy this right now".
async function fetchStockMap(skus) {
  const map = {};
  if (!skus || skus.length === 0) return map;

  // De-dupe and sanitize
  const uniqueSkus = [...new Set(skus.filter(s => s && typeof s === 'string'))];
  if (uniqueSkus.length === 0) return map;

  // Batch into groups of 40 — stays under URL length limits on every Magento install.
  const BATCH_SIZE = 40;
  const batches = [];
  for (let i = 0; i < uniqueSkus.length; i += BATCH_SIZE) {
    batches.push(uniqueSkus.slice(i, i + BATCH_SIZE));
  }

  // Canonical Magento 2 REST idiom for "sku IN (a,b,c)":
  // ONE filter, comma-joined value, condition_type=in. This is what Magento's
  // own SearchCriteriaBuilder emits. Chaining N eq-filters is undefined behavior.
  const fetchSourceItems = async (batch) => {
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
      'searchCriteria[filter_groups][0][filters][0][value]': batch.join(','),
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'in',
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      'searchCriteria[filter_groups][1][filters][0][condition_type]': 'eq',
      'searchCriteria[pageSize]': batch.length * 5
    };
    try {
      // OAuth first (admin access; source-items sometimes rejects bearer).
      let res;
      try { res = await oauthGet('/inventory/source-items', params); }
      catch (oauthErr) {
        if (oauthErr.response?.status === 401 || oauthErr.response?.status === 404) {
          res = await magentoGet('/inventory/source-items', params);
        } else { throw oauthErr; }
      }
      for (const it of (res?.items || [])) {
        // status=1 means source-item is enabled; don't count disabled warehouses.
        if (it.status === 0) continue;
        const s = it.sku;
        map[s] = (map[s] || 0) + parseFloat(it.quantity || 0);
      }
    } catch (e) {
      console.log(`[stockMap] MSI batch failed (${batch.length}):`, e.response?.status || e.message);
    }
  };

  // Run batches with bounded concurrency.
  const CONCURRENCY = 3;
  const queue = [...batches];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const batch = queue.shift();
        if (batch) await fetchSourceItems(batch);
      }
    })
  );

  // If EVERY SKU came back zero, the store likely runs legacy cataloginventory
  // (MSI not enabled or not populated). Fall back to /stockItems/{sku}
  // which works on both. This is Magento's own storefront check.
  const allZero = uniqueSkus.every(s => !map[s] || map[s] === 0);
  if (allZero) {
    console.log(`[stockMap] MSI empty — falling back to /stockItems for ${uniqueSkus.length} SKUs`);
    const CAP = 50;
    const subset = uniqueSkus.slice(0, CAP);
    await Promise.all(subset.map(async (sku) => {
      try {
        // /V1/stockItems/{sku} works with bearer on most installs and
        // returns the salable qty Magento uses on the storefront.
        const si = await magentoGet(`/stockItems/${encodeURIComponent(sku)}`);
        const qty = parseFloat(si?.qty || 0);
        const inStock = si?.is_in_stock === true;
        if (inStock && qty > 0) map[sku] = qty;
        else if (inStock && qty === 0) map[sku] = 1; // in-stock but no managed qty (backorder allowed)
      } catch (err) {
        // Last-ditch via OAuth if bearer 401'd
        if (err.response?.status === 401) {
          try {
            const si = await oauthGet(`/stockItems/${encodeURIComponent(sku)}`);
            const qty = parseFloat(si?.qty || 0);
            if (si?.is_in_stock && qty > 0) map[sku] = qty;
            else if (si?.is_in_stock) map[sku] = 1;
          } catch { /* give up silently for this SKU */ }
        }
      }
    }));
  }

  return map;
}

function shapeProduct(item, qty, sport = 'tennis') {
  const attrs = extractCustomAttrs(item);
  const brandLabel = attrs.brands ? resolveAttr('brands', attrs.brands) : (attrs.brand || null);
  // Capture Magento's native stock signal from extension_attributes (when present)
  const magentoStockItem = item.extension_attributes?.stock_item;
  const shaped = {
    name: item.name,
    sku: item.sku,
    type_id: item.type_id || 'simple',
    price: parseFloat(item.price || 0) || null,
    special_price: attrs.special_price ? parseFloat(attrs.special_price) : null,
    brand: brandLabel,
    short_description: attrs.short_description ? String(attrs.short_description).replace(/<[^>]*>/g, '').substring(0, 200) : null,
    product_url: buildProductUrl(item, sport),
    image: attrs.image ? `${getStoreUrl(sport)}/media/catalog/product${attrs.image}` : null,
    qty,
    magento_in_stock: magentoStockItem ? !!magentoStockItem.is_in_stock : null
  };
  // Shoe-specific specs, resolved where possible
  const shoeSpecs = {};
  if (attrs.court_type) shoeSpecs.court_type = resolveAttr('court_type', attrs.court_type);
  if (attrs.width) shoeSpecs.width = resolveAttr('width', attrs.width);
  if (attrs.cushioning) shoeSpecs.cushioning = resolveAttr('cushioning', attrs.cushioning);
  if (attrs.shoe_type) shoeSpecs.shoe_type = resolveAttr('shoe_type', attrs.shoe_type);
  if (attrs.shoe_weight) shoeSpecs.shoe_weight = attrs.shoe_weight;
  if (attrs.inner_material) shoeSpecs.inner_material = attrs.inner_material;
  if (attrs.outer_material) shoeSpecs.outer_material = attrs.outer_material;
  if (attrs.outsole) shoeSpecs.outsole = attrs.outsole;
  if (attrs.made_in_country) shoeSpecs.made_in_country = attrs.made_in_country;
  if (attrs.ean) shoeSpecs.ean = attrs.ean;
  if (attrs.article_code) shoeSpecs.article_code = attrs.article_code;
  // Configurable size options
  const sizeOpt = (item.extension_attributes?.configurable_product_options || [])
    .find(o => String(o.attribute_id) === '204' || /size/i.test(o.label || ''));
  if (sizeOpt) {
    shoeSpecs.available_sizes = (sizeOpt.values || [])
      .map(v => resolveAttr('shoe_size', v.value_index))
      .filter(Boolean);
  }
  if (Object.keys(shoeSpecs).length) shaped.specs = shoeSpecs;
  return shaped;
}

// STRICT availability check (v5.2.0):
// Simple products: qty >= 1.
// Configurable products: children must have been loaded AND summed qty >= 1.
// No fake-available fallback — we'd rather show fewer real products than dead links.
function isProductAvailable(p) {
  if (!p) return false;
  if (p.type_id === 'configurable') {
    // Must have verified children. If enrichment timed out, exclude.
    if (!p._children_loaded) return false;
    return (p.qty || 0) >= 1;
  }
  return (p.qty || 0) >= 1;
}

// applyFallbackStock removed in v5.2.0 — was creating false-positives on timed-out
// enrichment. Replacement strategy: tighter enrichment concurrency + cap (see CHANGE 4).

async function getProductsByCategory(categoryId, pageSize = 10, { min_price = null, max_price = null, sport = 'tennis' } = {}) {
  try {
    const fetchSize = Math.max(pageSize * 3, 30);
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'category_id',
      'searchCriteria[filter_groups][0][filters][0][value]': categoryId,
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      'searchCriteria[filter_groups][2][filters][0][field]': 'visibility',
      'searchCriteria[filter_groups][2][filters][0][value]': 4,
      // NOTE: removed quantity_and_stock_status pre-filter — unreliable on MSI for configurables.
      // Real stock verification happens downstream via fetchStockMap + enrichConfigurables.
      'searchCriteria[pageSize]': Math.min(fetchSize, 100),
      'searchCriteria[sortOrders][0][field]': 'created_at',
      'searchCriteria[sortOrders][0][direction]': 'DESC',
      // Request url_rewrites so buildProductUrl gets the canonical storefront URL.
      'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
    };
    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: "No products found in this category." };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    await enrichConfigurables(shaped);  // forceAll=true: verify child stock for ALL configurables

    const inStock = shaped.filter(isProductAvailable);
    let pool = inStock;  // SMART: configurables trusted via Magento salability, simples checked by qty
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price });
    const filtered_out = beforeCustomer - pool.length;
    const final = stripInternals(pool.sort((a, b) => b.qty - a.qty).slice(0, Math.min(pageSize, 20)));
    let message = null;
    if (final.length === 0 && beforeCustomer > 0) {
      const bits = [];
      if (max_price) bits.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) bits.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = `No products in this category match the price filter${bits.length ? ` (${bits.join(', ')})` : ''}.`;
    }
    return { products: final, total: result.total_count, showing: final.length, filtered_out, message };
  } catch (error) {
    console.error('getProductsByCategory error:', error.response?.status, error.message);
    return { error: true, message: "Unable to fetch products at this time. Please try again." };
  }
}

// Build Magento searchCriteria that ORs LIKE across name + sku + url_key.
// Magento treats filters inside the SAME filter_group as OR.
function buildSearchParams(pattern, pageSize) {
  return {
    // OR group: name LIKE %pattern% OR sku LIKE %pattern% OR url_key LIKE %pattern%
    'searchCriteria[filter_groups][0][filters][0][field]': 'name',
    'searchCriteria[filter_groups][0][filters][0][value]': `%${pattern}%`,
    'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
    'searchCriteria[filter_groups][0][filters][1][field]': 'sku',
    'searchCriteria[filter_groups][0][filters][1][value]': `%${pattern}%`,
    'searchCriteria[filter_groups][0][filters][1][condition_type]': 'like',
    'searchCriteria[filter_groups][0][filters][2][field]': 'url_key',
    'searchCriteria[filter_groups][0][filters][2][value]': `%${pattern}%`,
    'searchCriteria[filter_groups][0][filters][2][condition_type]': 'like',
    // AND status=1
    'searchCriteria[filter_groups][1][filters][0][field]': 'status',
    'searchCriteria[filter_groups][1][filters][0][value]': 1,
    // AND visibility=4 (catalog+search)
    'searchCriteria[filter_groups][2][filters][0][field]': 'visibility',
    'searchCriteria[filter_groups][2][filters][0][value]': 4,
    // NOTE: removed quantity_and_stock_status pre-filter — stock verified downstream.
    'searchCriteria[pageSize]': Math.min(pageSize, 100),
    'searchCriteria[sortOrders][0][field]': 'name',
    'searchCriteria[sortOrders][0][direction]': 'ASC',
    'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
  };
}

const SEARCH_STOPWORDS = new Set([
  'the','a','an','is','are','do','does','have','has','any','some','me','my','i','you',
  'please','show','find','get','give','tell','need','want','looking','for','buy','to',
  'about','of','on','in','under','over','below','above','with','and','or','vs','versus',
  'review','reviews','rating','ratings','feedback','price','cost','available','stock'
]);

async function searchProducts(query, pageSize = 10, { min_price = null, max_price = null, sport = 'tennis' } = {}) {
  try {
    const fetchSize = Math.max(pageSize * 3, 30);
    let result = await magentoGet('/products', buildSearchParams(query, fetchSize));

    // Multi-word fallback: if zero hits on the full phrase, try each significant
    // token individually and union the results. Fixes queries like "tennis ball
    // machine" that don't substring-match "Ball Machine" on the product.
    if (!result.items || result.items.length === 0) {
      const tokens = String(query).toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !SEARCH_STOPWORDS.has(t));
      const seen = new Map();
      for (const tok of tokens) {
        try {
          const r2 = await magentoGet('/products', buildSearchParams(tok, fetchSize));
          for (const it of (r2.items || [])) if (!seen.has(it.sku)) seen.set(it.sku, it);
        } catch {}
        if (seen.size >= fetchSize) break;
      }
      if (seen.size) result = { items: [...seen.values()], total_count: seen.size };
    }

    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No products found matching "${query}". Try simpler keywords or browse our categories.` };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
        const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    await enrichConfigurables(shaped);  // forceAll=true: verify child stock for ALL configurables

    const inStock = shaped.filter(isProductAvailable);
    let pool = inStock;  // SMART: configurables trusted via Magento salability, simples checked by qty
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price });
    const filtered_out = beforeCustomer - pool.length;
    const final = stripInternals(pool.sort((a, b) => b.qty - a.qty).slice(0, Math.min(pageSize, 20)));
    let message = null;
    if (final.length === 0 && beforeCustomer > 0) {
      const bits = [];
      if (max_price) bits.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) bits.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = `No matches for "${query}"${bits.length ? ` (${bits.join(', ')})` : ''}.`;
    }
    return { products: final, total: result.total_count, showing: final.length, filtered_out, message, query };
  } catch (error) {
    console.error('searchProducts error:', error.response?.status, error.message);
    return { error: true, message: "Unable to search products at this time. Please try again." };
  }
}

// ==================== SHOES WITH SPECS (ALL-IN-ONE) ====================
// Categories: Tennis Shoes=24, Pickleball Shoes=253, Padel Shoes=274
const SHOE_CATEGORIES = { tennis: 24, pickleball: 253, padel: 274 };

async function getShoesWithSpecs({ sport = 'tennis', brand = null, shoe_type = null, court_type = null, width = null, cushioning = null, size = null, min_price = null, max_price = null, page_size = 10 } = {}) {
  try {
    // If sport is generic/null/all, we'll search the primary sport category.
    // The "all sports" search is handled below as a multi-category merge.
    const sportKey = String(sport || 'tennis').toLowerCase();
    const catId = SHOE_CATEGORIES[sportKey] || 24;
    const filters = [];
    let idx = 0;
    filters.push({ group: idx++, field: 'category_id', value: catId });
    filters.push({ group: idx++, field: 'status', value: 1 });
    filters.push({ group: idx++, field: 'visibility', value: 4 });
    // NOTE: removed quantity_and_stock_status — stock verified via fetchStockMap + enrichConfigurables.

    if (brand) {
      const bid = brandNameToId(brand);
      if (bid) filters.push({ group: idx++, field: 'brands', value: bid });
    }
    const specMap = { shoe_type, court_type, width, cushioning };
    for (const [code, val] of Object.entries(specMap)) {
      if (!val) continue;
      const optMap = ATTR_OPTIONS[code] || {};
      // find matching option id
      const match = Object.entries(optMap).find(([, label]) => String(label).toLowerCase() === String(val).toLowerCase())
                 || Object.entries(optMap).find(([, label]) => String(label).toLowerCase().includes(String(val).toLowerCase()));
      if (match) filters.push({ group: idx++, field: code, value: match[0] });
    }

    const params = {
      'searchCriteria[pageSize]': Math.min(page_size * 2, 40),
      'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
    };
    filters.forEach(f => {
      params[`searchCriteria[filter_groups][${f.group}][filters][0][field]`] = f.field;
      params[`searchCriteria[filter_groups][${f.group}][filters][0][value]`] = f.value;
    });

    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No ${sport} shoes matched those filters.` };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
        const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    // Enrich configurable parents with child prices + summed child stock BEFORE filtering.
    await enrichConfigurables(shaped, true);  // ALWAYS forceAll for shoes — must verify child stock

    const inStock = shaped.filter(isProductAvailable);
    let pool = inStock;  // SMART: configurables trusted via Magento salability, simples checked by qty
    // Customer-requested filters: size, min_price, max_price.
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price, size });
    const filtered_out = beforeCustomer - pool.length;
    let available = stripInternals(pool.sort((a, b) => b.qty - a.qty).slice(0, Math.min(page_size, 20)));
    let message = null;
    // AUTO-FALLBACK: if size filter produced 0 results but we had products before filtering,
    // return shoes without size filter + a note that size availability varies per product.
    if (available.length === 0 && size && beforeCustomer > 0) {
      const fallback = applyPriceSizeFilters(inStock, { min_price, max_price, size: null });
      let fallbackAvail = stripInternals(fallback.sort((a, b) => b.qty - a.qty).slice(0, Math.min(page_size, 20)));
      if (fallbackAvail.length > 0) {
        message = `I couldn't confirm size ${size} stock for ${sport} shoes right now. Showing available ${sport} shoes — please select size ${size} on each product page to see if it's in stock.`;
        return {
          sport, filters_applied: { brand, shoe_type, court_type, width, cushioning, size: null, min_price, max_price },
          products: fallbackAvail, total: result.total_count, showing: fallbackAvail.length,
          filtered_out: 0, message, size_note: `Size ${size} availability varies per product — check the size dropdown on each PDP`
        };
      }
    }
    if (available.length === 0 && beforeCustomer > 0) {
      const reasons = [];
      if (size) reasons.push(`size ${size}`);
      if (max_price) reasons.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) reasons.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = `No ${sport} shoes match the requested filters${reasons.length ? ` (${reasons.join(', ')})` : ''}.`;
    }
    // If size was requested but we have results, add a helpful note
    if (available.length > 0 && size) {
      message = `Showing shoes with size ${size} in stock. All other sizes can be selected on each product page.`;
    }
    return {
      sport, filters_applied: { brand, shoe_type, court_type, width, cushioning, size, min_price, max_price },
      products: available, total: result.total_count, showing: available.length,
      filtered_out, message
    };
  } catch (error) {
    console.error('getShoesWithSpecs error:', error.response?.status, error.message);
    return { error: true, message: `Unable to fetch ${sport} shoes. ${error.message}` };
  }
}

// ==================== RACQUETS WITH SPECS ====================
// Tennis Racquets=25, Padel Rackets=272, Pickleball Paddles=250
const RACQUET_CATEGORIES = { tennis: 25, padel: 272, pickleball: 250 };

async function getRacquetsWithSpecs({ sport = 'tennis', brand = null, skill_level = null, min_price = null, max_price = null, page_size = 10 } = {}) {
  try {
    const catId = RACQUET_CATEGORIES[String(sport).toLowerCase()] || 25;
    const filters = [];
    let idx = 0;
    filters.push({ group: idx++, field: 'category_id', value: catId });
    filters.push({ group: idx++, field: 'status', value: 1 });
    filters.push({ group: idx++, field: 'visibility', value: 4 });
    // NOTE: removed quantity_and_stock_status — stock verified via fetchStockMap + enrichConfigurables.
    // v4.5.0: configurable-only restriction applies ONLY to tennis (grip-size variants).
    // Pickleball paddles & padel rackets are simple SKUs — restricting breaks them.
    if (String(sport).toLowerCase() === 'tennis') {
      filters.push({ group: idx++, field: 'type_id', value: 'configurable' });
    }

    if (brand) {
      const bid = brandNameToId(brand);
      if (bid) filters.push({ group: idx++, field: 'brands', value: bid });
    }
    // Skill-level mapping to Magento categories (intersect via multiple category filters)
    const SKILL_CATS = { beginner: 87, intermediate: 80, advanced: 79, senior: 88, junior: 81 };
    if (skill_level && SKILL_CATS[String(skill_level).toLowerCase()]) {
      filters.push({ group: idx++, field: 'category_id', value: SKILL_CATS[String(skill_level).toLowerCase()] });
    }

    const params = {
      'searchCriteria[pageSize]': Math.min(page_size * 2, 40),
      'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
    };
    filters.forEach(f => {
      params[`searchCriteria[filter_groups][${f.group}][filters][0][field]`] = f.field;
      params[`searchCriteria[filter_groups][${f.group}][filters][0][value]`] = f.value;
    });
    params['searchCriteria[sortOrders][0][field]'] = 'created_at';
    params['searchCriteria[sortOrders][0][direction]'] = 'DESC';

    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No ${sport} racquets matched those filters.` };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
        const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    await enrichConfigurables(shaped);  // forceAll=true: verify child stock for ALL configurables

    const inStock = shaped.filter(isProductAvailable);
    let pool = inStock;  // SMART: configurables trusted via Magento salability, simples checked by qty
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price });
    const filtered_out = beforeCustomer - pool.length;
    const available = stripInternals(pool.sort((a, b) => b.qty - a.qty).slice(0, Math.min(page_size, 20)));
    let message = null;
    if (available.length === 0 && beforeCustomer > 0) {
      const bits = [];
      if (max_price) bits.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) bits.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = `No ${sport} racquets match the requested filters${bits.length ? ` (${bits.join(', ')})` : ''}.`;
    }
    return {
      sport, filters_applied: { brand, skill_level, min_price, max_price },
      products: available, total: result.total_count, showing: available.length,
      filtered_out, message
    };
  } catch (error) {
    console.error('getRacquetsWithSpecs error:', error.response?.status, error.message);
    return { error: true, message: `Unable to fetch ${sport} racquets. ${error.message}` };
  }
}

// Resolve configurable-parent price AND aggregate stock from children, in parallel.
// Magento stores price=0 and qty=0 on configurable parents; real values live on children.
// After this runs, p.price / p.price_max / p.qty reflect the child aggregate, and
// p._children holds per-child {sku, price, qty, size} for downstream size/price filtering.
async function enrichConfigurables(products, forceAll = true) {
  // forceAll=true by default — we MUST verify child stock for every configurable product.
  // v5.2.0: quantity_and_stock_status removed; enrichment is the sole stock gate.
  const targets = forceAll
    ? products.filter(p => p != null)
    : products.filter(p => p && (!p.price || p.price === 0 || !p.qty || p.qty === 0));
  if (targets.length === 0) return products;
  // v5.2.0: wider concurrency, faster fail. With strict isProductAvailable,
  // dropped enrichments mean dropped products — so we must enrich more, faster.
  const CAP = 3;        // v5.6.1: slashed from 5→3 to fit Render 30s window
  const CONCURRENCY = 3;
  const queue = targets.slice(0, CAP);
  const enrichOne = async p => {
    try {
      const children = await magentoGet(`/configurable-products/${encodeURIComponent(p.sku)}/children`);
      if (!Array.isArray(children) || children.length === 0) return;
      // Price: lowest non-zero across children; keep a max for ranges.
      const prices = children.map(c => parseFloat(c.price || 0)).filter(v => v > 0);
      if (prices.length) {
        p.price = Math.min(...prices);
        const maxP = Math.max(...prices);
        if (maxP > p.price) p.price_max = maxP;
      }
      const sp = children.map(c => parseFloat(c.special_price || 0)).filter(v => v > 0);
      if (sp.length && !p.special_price) p.special_price = Math.min(...sp);
      // Stock: per-child and summed. ALWAYS override parent qty with children total.
      // This corrects false positives from /stockItems (is_in_stock=true but children OOS).
      let stockMap = {};
      try {
        const childSkus = children.map(c => c.sku);
        stockMap = await fetchStockMap(childSkus);
        const total = Object.values(stockMap).reduce((a, b) => a + (parseFloat(b) || 0), 0);
        p.qty = total;  // ALWAYS set: 0 means all children are OOS
      } catch { /* keep parent qty from fetchStockMap */ }
      p._children_loaded = true;  // Flag: children were successfully fetched
      // Per-child detail for size / price filtering
      p._children = children.map(c => {
        const attrs = {};
        (c.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
        const rawSize = attrs.shoe_size;
        const sizeLabel = rawSize ? resolveAttr('shoe_size', rawSize) : null;
        return {
          sku: c.sku,
          price: parseFloat(c.price || 0) || null,
          qty: parseFloat(stockMap[c.sku] || 0),
          size: Array.isArray(sizeLabel) ? sizeLabel.join(',') : sizeLabel
        };
      });
    } catch {
      // leave as-is; downstream filter will drop if qty<1
    }
  };
  // concurrency-limited pool
  // Per-item timeout: 8s max per product to avoid Render 30s request timeout
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('enrich-timeout')), ms))]);
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) {
        try { await withTimeout(enrichOne(item), 2000); }  // v5.6.1: 3s→2s per item
        catch (e) { console.log('[enrich] timeout/error for', item.sku, e.message); }
      }
    }
  });
  await Promise.all(workers);
  return products;
}

// Post-enrichment filters: price cap / floor, and shoe size availability.
// Size match is parsed as the first numeric token of each label so "10" matches
// "10 UK" or "10.0"; same parse applied to the customer's requested size.
function applyPriceSizeFilters(products, { min_price = null, max_price = null, size = null } = {}) {
  const min = (min_price != null && isFinite(parseFloat(min_price))) ? parseFloat(min_price) : null;
  const max = (max_price != null && isFinite(parseFloat(max_price))) ? parseFloat(max_price) : null;
  const want = size ? parseFloat(String(size).match(/[\d.]+/)?.[0] || '') : null;
  return products.filter(p => {
    const price = parseFloat(p.price || 0);
    if (max != null && price > 0 && price > max) return false;
    if (min != null && price > 0 && price < min) return false;
    if (want != null && !isNaN(want)) {
      if (!Array.isArray(p._children) || p._children.length === 0) return false;
      const hit = p._children.some(c => {
        const got = parseFloat(String(c.size || '').match(/[\d.]+/)?.[0] || '');
        return !isNaN(got) && got === want && (c.qty || 0) >= 1;
      });
      if (!hit) return false;
    }
    return true;
  });
}

// Strip internal-only fields + HARD stock gate before returning to the LLM.
// v5.2.0: returns a NEW array filtered by qty >= 1 — no zero-qty product can escape.
function stripInternals(products) {
  return (products || []).filter(p => {
    if (!p) return false;
    // HARD GATE: only products with real stock leave the server
    if ((p.qty || 0) < 1) return false;
    p.in_stock = true;
    delete p._children;
    delete p.type_id;
    delete p.magento_in_stock;
    delete p._children_loaded;
    delete p._stock_source;
    return true;
  });
}

function listBrands() {
  const map = ATTR_OPTIONS['brands'] || {};
  const brands = Object.entries(map).map(([id, label]) => ({ id, name: label })).filter(b => b.name && b.name.trim());
  return { total: brands.length, brands };
}

// ==================== BALL MACHINES (v3.3.2) ====================
// Combines three strategies (category → search tokens → url_key LIKE) and
// unions the results, so we return every ball-machine-shaped product the
// catalog has, even if a category wasn't indexed or the search stopped short.
async function getBallMachines({ page_size = 10, min_price = null, max_price = null, sport = 'tennis' } = {}) {
  // v4.7.2: FAST-PATH first (single Magento call), then parallel fallback only if needed.
  // Previous versions ran 15+ concurrent Magento calls which overwhelmed the server.
  const seen = new Map();
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('strat-timeout')), ms))]);

  // Helper: run a single LIKE query against Magento, shape results into seen map.
  const runLike = async (field, value) => {
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': field,
      'searchCriteria[filter_groups][0][filters][0][value]': value,
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      // NOTE: removed quantity_and_stock_status — stock verified downstream.
      'searchCriteria[pageSize]': 20
    };
    const result = await magentoGet('/products', params);
    if (result.items && result.items.length) {
      const skus = result.items.map(i => i.sku);
      const stockMap = await fetchStockMap(skus);
      const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
      // These are simple products — enrichConfigurables is a no-op, skip it to save time.
      for (const p of shaped) if (!seen.has(p.sku)) seen.set(p.sku, p);
    }
  };

  // === FAST PATH: sequential, lightweight — catches the known ball-machine products ===
  const fastQueries = [
    ['name', '%ball machine%'],
    ['name', '%tenniix%'],
    ['name', '%ai ball%'],
    ['url_key', '%ball%machine%']
  ];
  for (const [field, pattern] of fastQueries) {
    try { await runLike(field, pattern); } catch (e) { console.error('[BM fast]', field, pattern, e.message); }
    if (seen.size >= 2) break;   // got enough, skip remaining fast queries
  }

  // === FALLBACK: only if fast path found nothing, run heavier strategies with timeouts ===
  if (seen.size === 0) {
    console.log('[BM] fast path empty, running full parallel fallback');
    const stratA = (async () => {
      for (const catId of BALL_MACHINE_CATEGORY_IDS) {
        try {
          const byCat = await getProductsByCategory(catId, 20, { min_price, max_price });
          for (const p of (byCat.products || [])) if (!seen.has(p.sku)) seen.set(p.sku, p);
        } catch {}
      }
    })();
    const stratB = (async () => {
      const queries = ['ball machine', 'ball thrower', 'ball cannon', 'ball launcher', 'ball feeder', 'ai ball'];
      for (const q of queries) {
        try {
          const bySearch = await searchProducts(q, 10, { min_price, max_price });
          for (const p of (bySearch.products || [])) if (!seen.has(p.sku)) seen.set(p.sku, p);
        } catch {}
        if (seen.size >= 6) break;
      }
    })();
    const stratC = (async () => {
      const likeQueries = [['url_key','%ai%ball%'],['name','%ball cannon%'],['name','%ball thrower%'],['sku','%tenniix%']];
      for (const [f,v] of likeQueries) {
        try { await runLike(f, v); } catch {}
        if (seen.size >= 6) break;
      }
    })();
    await Promise.allSettled([withTimeout(stratA, 15000), withTimeout(stratB, 15000), withTimeout(stratC, 15000)]);
  }

  let pool = [...seen.values()].filter(isProductAvailable);  // SMART: configurables trusted, simples checked
  pool = applyPriceSizeFilters(pool, { min_price, max_price });
  const available = stripInternals(pool.sort((a, b) => b.qty - a.qty).slice(0, Math.min(page_size, 20)));

  let message = null;
  if (available.length === 0 && seen.size > 0) {
    message = `Found ${seen.size} ball-machine products, but none match the requested price filter.`;
  } else if (seen.size === 0) {
    message = `No ball machines found in the catalog right now. You can also browse https://tennisoutlet.in/other/ball-machine.html directly.`;
  }
  return {
    products: available,
    total: seen.size,
    showing: available.length,
    category_ids_used: BALL_MACHINE_CATEGORY_IDS,
    message
  };
}

// ==================== PRODUCT REVIEWS (v3.3.2) ====================
// Fetches Magento 2 product reviews. Requires the bearer token to have
// Magento_Review::reviews ACL (most integration tokens have it by default).
// Falls back gracefully to a product-page link if the endpoint 403s.
async function getProductReviews({ sku = null, query = null, page_size = 5 } = {}) {
  try {
    // Resolve to a SKU if the caller gave us free text.
    let resolvedSku = sku;
    let product = null;
    if (!resolvedSku && query) {
      const s = await searchProducts(query, 3);
      if (s.products && s.products.length) {
        product = s.products[0];
        resolvedSku = product.sku;
      }
    }
    if (!resolvedSku) {
      return { found: false, message: `Couldn't find a product matching "${query}". Try the exact product name or paste the product URL.` };
    }

    // Canonical product record for the link.
    if (!product) {
      try {
        const res = await magentoGet(`/products/${encodeURIComponent(resolvedSku)}`);
        const stock = await fetchStockMap([res.sku]);
        product = shapeProduct(res, stock[res.sku] || 0, 'tennis');
      } catch {}
    }

    // Try Magento review endpoint.
    let reviews = [];
    let avgRating = null;
    let endpointError = null;
    try {
      const res = await axios.get(`${MAGENTO_REST}/products/${encodeURIComponent(resolvedSku)}/reviews`, {
        headers: { 'Authorization': `Bearer ${MAGENTO_TOKEN}`, 'Accept': 'application/json' },
        timeout: 15000
      });
      reviews = (res.data || []).slice(0, page_size).map(r => ({
        title: r.title || null,
        detail: (r.detail || '').slice(0, 400),
        nickname: r.nickname || 'Verified Buyer',
        created_at: r.created_at || null,
        ratings: (r.ratings || []).map(rt => ({ name: rt.rating_name, value: rt.value, percent: rt.percent }))
      }));
      // Average rating from per-review rating percent values.
      const all = (res.data || []).flatMap(r => (r.ratings || []).map(rt => Number(rt.percent))).filter(n => isFinite(n));
      if (all.length) avgRating = Math.round(all.reduce((a, b) => a + b, 0) / all.length);
    } catch (e) {
      endpointError = e.response?.status || e.message;
    }

    return {
      found: true,
      product: product ? { name: product.name, sku: product.sku, product_url: product.product_url, price: product.price } : { sku: resolvedSku },
      reviews,
      total_reviews: reviews.length,
      average_rating_percent: avgRating,
      endpoint_error: endpointError,
      review_page_hint: product?.product_url ? `${product.product_url}#reviews` : null,
      message: reviews.length === 0
        ? `No reviews fetched from the API${endpointError ? ` (${endpointError})` : ''}. Customer reviews appear on the product page itself — direct the user to click the product link and scroll to the 'Customer Reviews' section.`
        : null
    };
  } catch (e) {
    return { error: true, message: `Review lookup failed: ${e.message}` };
  }
}

// ==================== SMART PRODUCT SEARCH (v5.4.0) ====================
// Primary product-discovery tool: resolves natural-language queries to category IDs
// via the in-memory CATEGORY_INDEX, then fetches from those categories.
// Falls back to keyword search_products if no category match is found.
async function smartProductSearch({ query, sport = 'tennis', min_price = null, max_price = null, page_size = 10 } = {}) {
  if (!query) return { products: [], message: 'No query provided.' };
  const startMs = Date.now();
  const resolved = resolveCategoriesFromQuery(query, 3);
  console.log(`[smart-search] query="${query}" resolved ${resolved.length} categories in ${Date.now() - startMs}ms:`, resolved.map(c => `${c.id}:${c.name}`).join(', '));

  let allProducts = [];
  let sources = [];

  // Strategy 1: Fetch from resolved categories (parallel)
  if (resolved.length > 0) {
    const catResults = await Promise.allSettled(
      resolved.map(cat => getProductsByCategory(cat.id, page_size, { min_price, max_price, sport }))
    );
    for (let i = 0; i < catResults.length; i++) {
      if (catResults[i].status === 'fulfilled') {
        const r = catResults[i].value;
        const prods = r.products || [];
        if (prods.length > 0) {
          sources.push({ category_id: resolved[i].id, category_name: resolved[i].name, count: prods.length });
          allProducts.push(...prods);
        }
      }
    }
  }

  // Strategy 2: Also run keyword search in parallel for coverage
  let searchResults = [];
  try {
    const sr = await searchProducts(query, page_size, { min_price, max_price, sport });
    searchResults = sr.products || [];
    if (searchResults.length > 0) {
      sources.push({ source: 'keyword_search', count: searchResults.length });
    }
  } catch (e) {
    console.log(`[smart-search] keyword search failed:`, e.message);
  }

  // Merge: de-duplicate by SKU, prefer category results (richer)
  const seen = new Set();
  const merged = [];
  for (const p of [...allProducts, ...searchResults]) {
    if (p && p.sku && !seen.has(p.sku)) {
      seen.add(p.sku);
      merged.push(p);
    }
  }

  // Sort by qty desc (in-stock first), then by price
  merged.sort((a, b) => (b.qty || 0) - (a.qty || 0) || (a.price || 99999) - (b.price || 99999));
  const final = merged.slice(0, Math.min(page_size, 20));

  return {
    products: final,
    total: merged.length,
    showing: final.length,
    sources,
    resolved_categories: resolved,
    took_ms: Date.now() - startMs,
    message: final.length === 0 ? `No in-stock products found for "${query}". Try broadening your search or ask for a specific category.` : null
  };
}

// ==================== EXECUTE ====================
async function executeFunction(name, args, sport = 'tennis') {
  switch (name) {
    case 'get_order_status': return await getOrderStatus(args.order_id);
    case 'get_products_by_category': return await getProductsByCategory(args.category_id, args.page_size, { min_price: args.min_price, max_price: args.max_price, sport });
    case 'search_products': return await searchProducts(args.query, args.page_size, { min_price: args.min_price, max_price: args.max_price, sport });
    case 'get_shoes_with_specs': {
      const shoeSport = args?.sport || sport || 'tennis';
      // If sport is 'all' or unspecified generic, search all 3 shoe categories and merge
      if (shoeSport === 'all') {
        const results = await Promise.all(['tennis', 'pickleball', 'padel'].map(s =>
          getShoesWithSpecs({ ...(args || {}), sport: s })
        ));
        const merged = { sport: 'all', products: [], total: 0, showing: 0, message: null };
        for (const r of results) {
          merged.products.push(...(r.products || []));
          merged.total += (r.total || 0);
        }
        merged.products.sort((a, b) => (b.qty || 0) - (a.qty || 0));
        merged.products = merged.products.slice(0, Math.min(args?.page_size || 10, 20));
        merged.showing = merged.products.length;
        if (merged.products.length === 0) merged.message = 'No shoes found across any sport category.';
        else merged.message = results.find(r => r.message)?.message || null;
        return merged;
      }
      return await getShoesWithSpecs({ ...(args || {}), sport: shoeSport });
    }
    case 'get_racquets_with_specs': return await getRacquetsWithSpecs({ ...(args || {}), sport: args?.sport || sport });
    case 'list_brands': return listBrands();
    case 'get_ball_machines': return await getBallMachines({ ...(args || {}), sport });
    case 'find_categories': return { matches: findCategoriesByKeyword(args.keyword) };
    case 'list_categories': return { categories: listAllCategories(args || {}) };
    case 'get_product_reviews': return await getProductReviews(args || {});
    case 'smart_product_search': return await smartProductSearch({ ...(args || {}), sport: args?.sport || sport });
    default: return { error: true, message: `Unknown function: ${name}` };
  }
}

// ==================== MULTI-AGENT PRE-PROCESSOR (v4.7.0) ====================
// Deterministic intent + entity extractor. Runs BEFORE the LLM so we can:
//   (a) force the right tool call when confidence is high (avoids LLM routing errors)
//   (b) inject structured hints into the system prompt
//   (c) catch specific product queries the LLM tends to phrase poorly to the API
// No extra LLM round-trip — pure regex/keyword scoring, so latency stays flat.
const INTENT_RULES = [
  // intent,            patterns (match any),                                     forceTool,                                        hint
  { intent: 'shoe',
    rx: [/\b(shoe|shoes|footwear|sneaker|sneakers|trainer|trainers)\b/i, /sports?\s+shoe/i, /court\s+shoe/i],
    force: 'get_shoes_with_specs' },
  { intent: 'ball_machine',
    rx: [/ball\s*machine/i, /ball\s*thrower/i, /ball\s*cannon/i, /ball\s*launcher/i, /ball\s*feeder/i, /\btenniix\b/i, /\bai\s*ball\b/i, /smart\s*ball/i],
    force: 'get_ball_machines' },
  { intent: 'pickleball_paddle',
    rx: [/pickle\s*ball.*paddle/i, /paddle.*pickle/i, /pickleball\s+paddle/i, /paddleball\s*paddle/i, /paddle\s*ball\s*paddle/i, /pickle\s*paddle/i, /paddleball/i],
    force: 'get_racquets_with_specs', hintArgs: { sport: 'pickleball' } },
  { intent: 'padel_racket',
    rx: [/\bpadel\b.*(racket|racquet)/i, /(racket|racquet).*\bpadel\b/i],
    force: 'get_racquets_with_specs', hintArgs: { sport: 'padel' } },
  { intent: 'tennis_racquet',
    rx: [/tennis.*(racquet|racket)/i, /(racquet|racket).*tennis/i],
    force: 'get_racquets_with_specs', hintArgs: { sport: 'tennis' } },
  { intent: 'order_status',
    rx: [/order\s*(id|number|#)?\s*[:#]?\s*\d{3,}/i, /track.*order/i, /where.*order/i, /my\s+order/i],
    force: 'get_order_by_id' },
  { intent: 'return_policy',
    rx: [/return\s*policy/i, /refund/i, /exchange\s+policy/i, /return.*product/i],
    force: null },
  { intent: 'shipping_policy',
    rx: [/shipping/i, /delivery\s+time/i, /when.*deliver/i, /courier/i],
    force: null },
  { intent: 'greeting',
    rx: [/^\s*(hi|hello|hey|namaste|good\s*(morning|evening|afternoon))\s*[!.?]?\s*$/i],
    force: null }
];

function classifyIntent(userText) {
  const text = String(userText || '');
  const results = [];
  for (const rule of INTENT_RULES) {
    let score = 0;
    for (const r of rule.rx) if (r.test(text)) score += 1;
    if (score > 0) results.push({ intent: rule.intent, score, force: rule.force, hintArgs: rule.hintArgs || {} });
  }
  results.sort((a, b) => b.score - a.score);
  const top = results[0] || null;

  // Simple entity extraction
  const entities = {};
  const priceMatch = text.match(/(?:under|below|<=?|less than)\s*₹?\s*(\d[\d,]*)/i);
  if (priceMatch) entities.max_price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
  const priceMatch2 = text.match(/(?:over|above|>=?|more than)\s*₹?\s*(\d[\d,]*)/i);
  if (priceMatch2) entities.min_price = parseInt(priceMatch2[1].replace(/,/g, ''), 10);
  const sizeMatch = text.match(/\bsize\s*(\d{1,2}(?:\.\d)?)/i) || text.match(/\b(uk|us|eu)\s*(\d{1,2}(?:\.\d)?)/i);
  if (sizeMatch) entities.size = sizeMatch[sizeMatch.length - 1];
  const orderMatch = text.match(/\b(\d{6,12})\b/);
  if (orderMatch && /order|track/i.test(text)) entities.order_id = orderMatch[1];
  const brands = ['wilson','babolat','head','yonex','prince','tecnifibre','dunlop','asics','nike','adidas','k-swiss','new balance','diadem','selkirk','joola','bullpadel','tenniix','bolt'];
  for (const b of brands) if (new RegExp('\\b'+b.replace(/\s+/g,'\\s+')+'\\b', 'i').test(text)) { entities.brand = b; break; }

  return { top, all: results, entities };
}

// Ring-buffer trace of last N chat turns for /api/debug/trace
const TRACE = [];
const TRACE_MAX = 50;
function pushTrace(entry) {
  TRACE.push({ ts: new Date().toISOString(), ...entry });
  while (TRACE.length > TRACE_MAX) TRACE.shift();
}

// ==================== CHAT API ====================
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Detect size-specific shoe/apparel queries and inject a strong directive + force a tool call
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const lowerUser = lastUser.toLowerCase();
    const mentionsSize = /\b(size|sz)\s*\d+|\bsize\b|\buk\s*\d+|\bus\s*\d+|\beu\s*\d+/i.test(lastUser);
    const mentionsShoe = /shoe|footwear|sneaker/i.test(lowerUser);
    const mentionsPickle = /pickleball|pickle|paddleball|paddle\s*ball/i.test(lowerUser);
    const mentionsPadel = /padel/i.test(lowerUser);

    let forceToolChoice = 'auto';
    let sizeDirective = null;
    if (mentionsSize && mentionsShoe) {
      const catId = mentionsPickle ? 253 : mentionsPadel ? 274 : 24;
      const sport = mentionsPickle ? 'pickleball' : mentionsPadel ? 'padel' : 'tennis';
      sizeDirective = {
        role: 'system',
        content: `SIZE QUERY DETECTED: The customer asked about ${sport} shoes with a specific size. You MUST immediately call get_products_by_category with category_id=${catId} and page_size=5. After listing the products, append: "All sizes (including the size you mentioned) can be selected on each product page. If a specific size is sold out, it will be marked on that page." NEVER say "we don't have that size".`
      };
      forceToolChoice = { type: 'function', function: { name: 'get_products_by_category' } };
    } else if (mentionsSize && /racquet|racket|grip/i.test(lowerUser)) {
      sizeDirective = {
        role: 'system',
        content: `GRIP SIZE QUERY: Call get_products_by_category (category_id 25 for tennis racquets) or search_products, then tell the user grip size is selected on the product page.`
      };
    }

    // Multi-agent pre-processor: classify intent BEFORE sending to LLM.
    const classification = classifyIntent(lastUser);
    const agentHint = classification.top ? {
      role: 'system',
      content: `INTENT DETECTED: ${classification.top.intent} (score=${classification.top.score}). ` +
        (classification.top.force ? `You MUST call ${classification.top.force} first` +
          (Object.keys(classification.top.hintArgs).length ? ` with ${JSON.stringify(classification.top.hintArgs)}` : '') + '.' :
          'Answer from policy/knowledge if no tool fits.') +
        (Object.keys(classification.entities).length ? ` Entities: ${JSON.stringify(classification.entities)}.` : '')
    } : null;
    // Promote intent force over size directive when both fire and intent is strong.
    if (classification.top && classification.top.force && !forceToolChoice?.function) {
      forceToolChoice = { type: 'function', function: { name: classification.top.force } };
    }
    const systemParts = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (sizeDirective) systemParts.push(sizeDirective);
    if (agentHint) systemParts.push(agentHint);
    const apiMessages = [...systemParts, ...messages];

    let response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: OPENROUTER_MODEL,
      messages: apiMessages,
      tools: FUNCTION_DEFINITIONS,
      tool_choice: forceToolChoice,
      temperature: 0.7,
      max_tokens: 1800
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': MAGENTO_STORE_URL,
        'X-Title': 'TO Assistant - TennisOutlet.in'
      },
      timeout: 45000
    });

    let assistantMessage = response.data.choices[0].message;
    let iterations = 0;
    const conversation = [...apiMessages];

    while (assistantMessage.tool_calls && iterations < 3) {
      iterations++;
      conversation.push(assistantMessage);
      const toolResults = [];

      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        let funcArgs = {};
        try { funcArgs = JSON.parse(toolCall.function.arguments); } catch {}
        // Override LLM args with deterministic hintArgs from INTENT_RULES (e.g. paddleball→pickleball)
        if (classification.top && classification.top.hintArgs && classification.top.force === funcName) {
          Object.assign(funcArgs, classification.top.hintArgs);
        }
        console.log(`[Call] ${funcName}(${JSON.stringify(funcArgs)})`);
        const result = await executeFunction(funcName, funcArgs);
        console.log(`[Result] ${funcName}: ${JSON.stringify(result).substring(0, 200)}...`);
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
      toolResults.forEach(t => conversation.push(t));

      response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: OPENROUTER_MODEL,
        messages: conversation,
        tools: FUNCTION_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 1800
      }, {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': MAGENTO_STORE_URL,
          'X-Title': 'TO Assistant - TennisOutlet.in'
        },
        timeout: 45000
      });
      assistantMessage = response.data.choices[0].message;
    }

    pushTrace({ user: lastUser, intent: classification?.top?.intent || null, entities: classification?.entities || {}, forced: forceToolChoice?.function?.name || null, iterations });
    res.json({ message: assistantMessage.content, usage: response.data.usage, intent: classification?.top?.intent || null });
  } catch (error) {
    console.error('Chat API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== MULTI-AGENT CHAT ====================
// GET conversation history for a session (for page reconnect / restore)
app.get('/api/session-history', (req, res) => {
  const sessionId = sessionStore.fallbackId(req);
  const history = sessionStore.getHistory(sessionId);
  const slots = sessionStore.get(sessionId).slots || {};
  res.json({ session_id: sessionId, history, slots });
});

app.post('/api/chat-agents', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // ===== v3.3: session + deterministic slot parsing =====
    const sessionId = sessionStore.fallbackId(req);
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    // Reset word? Drop prior session state.
    if (slotParser.shouldReset(lastUser)) {
      sessionStore.reset(sessionId);
    }

    const prior = sessionStore.get(sessionId).slots || {};

    // v5.6.0: Run deterministic parser first. If it already has high-confidence
    // intent (shoe, order, greeting, etc.), skip the normalizer to save ~1.5s.
    // Only call normalizer for ambiguous/messy queries where regex can't help.
    const fresh = slotParser.parseSlots(lastUser);
    let merged = slotParser.mergeSlots(prior, fresh);
    const skipNormalizer = !!(merged.intent_hint && ['shoe', 'order', 'greeting', 'brand', 'policy'].includes(merged.intent_hint));
    let normResult = { ok: false, spec: null, latency_ms: 0 };
    if (!skipNormalizer) {
      const conversationHistoryForNormalizer = sessionStore.getHistory(sessionId);
      normResult = await normalizeQuery(lastUser, conversationHistoryForNormalizer);
      if (normResult.ok && normResult.spec) {
        merged = slotParser.slotsFromSpec(normResult.spec, merged);
        merged._normalizer_spec = normResult.spec;
      }
    } else {
      console.log(`[normalizer] skipped — parser already has intent_hint=${merged.intent_hint}`);
    }

    // v5.5.0 + v5.6.0: Follow-up detection — prefer normalizer's is_follow_up flag.
    const followUp = slotParser.detectFollowUp(lastUser);
    let followUpHint = '';
    const lastIntent = sessionStore.getLastIntent(sessionId);
    const isFollowUpDetected = (normResult.spec?.is_follow_up) || !!followUp;

    if (isFollowUpDetected) {
      const refinementType = normResult.spec?.refinement_type || followUp?.type || 'more';
      followUpHint = `Follow-up refinement detected: ${refinementType}. Customer wants to refine/continue the PREVIOUS search — stay in the same product domain.`;
      if (lastIntent && !merged.intent_hint) {
        merged.intent_hint = lastIntent;
        console.log(`[session:${sessionId}] follow-up "${refinementType}" — inheriting intent=${lastIntent}`);
      }
      if (merged.quantity) {
        merged._page_size = merged.quantity;
        followUpHint += ` Use page_size=${merged.quantity}.`;
      } else if (followUp?.page_size) {
        merged._page_size = followUp.page_size;
        followUpHint += ` Use page_size=${followUp.page_size}.`;
      }
      merged._follow_up = refinementType;
    }

    merged._rendered = slotParser.renderSlotsHint(merged);
    sessionStore.update(sessionId, { slots: merged });

    // Retrieve last products so follow-ups like "the second one" have a reference.
    const lastProducts = sessionStore.getLastProducts(sessionId);

    // ===== v5.0.1: Smart order intent detection =====
    // If user says "order status" / "track" / "status" and session already has order_id,
    // force intent to 'order' even if the current message doesn't contain the ID.
    if (!merged.intent_hint && merged.order_id &&
        /\b(order|status|track|tracking|dispatch|shipment|delivery|where is)\b/i.test(lastUser)) {
      merged.intent_hint = 'order';
      merged._rendered = slotParser.renderSlotsHint(merged);
      console.log(`[session:${sessionId}] forced order intent — order_id=${merged.order_id} from session`);
    }

    // ===== v4.8: Server-side conversation memory =====
    // Build full conversation from server-side history + new message(s).
    // If client sends only the latest user message, we prepend stored history.
    // If client sends full history, we use it as-is and sync to server store.
    const serverHistory = sessionStore.getHistory(sessionId);
    let fullMessages;

    if (messages.length <= 2) {
      // Client sent only latest turn(s) — prepend server-side history
      fullMessages = [...serverHistory, ...messages];
    } else {
      // Client sent full history — use it and sync to server
      fullMessages = messages;
      sessionStore.setHistory(sessionId, messages.filter(m => m.role !== 'system'));
    }

    // Save the latest user message to server history
    if (lastUser) {
      sessionStore.addMessage(sessionId, 'user', lastUser);
    }

    // Humanized session hint for the LLM — includes slot context + brief conversation summary
    const turns = sessionStore.get(sessionId).turns || 0;
    let sessionHint = '';
    if (turns > 1) {
      const parts = [];
      // Slot context
      if (prior && Object.keys(prior).some(k => prior[k] != null && k !== '_rendered')) {
        parts.push(`Previous slots: ${slotParser.renderSlotsHint(prior) || '(none)'}. Current merged: ${merged._rendered || '(none)'}`);
      }
      // Brief conversation summary from last 2 assistant responses (so LLM knows what it just recommended)
      const recentAssistant = serverHistory.filter(m => m.role === 'assistant').slice(-2);
      if (recentAssistant.length > 0) {
        const summaries = recentAssistant.map(m => {
          // Truncate to first 300 chars to keep token usage reasonable
          const text = (m.content || '').slice(0, 300);
          return text.length >= 300 ? text + '...' : text;
        });
        parts.push(`Your recent responses to this customer: ${summaries.join(' | ')}`);
      }
      sessionHint = parts.join('. ');
    }

    console.log(`[session:${sessionId}] turn=${turns} history=${serverHistory.length}msgs slots={${merged._rendered}}`);

    // Bind sport to executeFunction so all tool calls get the right store URL
    const detectedSport = merged.sport || 'tennis';
    const sportBoundExecute = (name, args) => executeFunction(name, args, detectedSport);

    // v5.6.0: Build enriched session hint from normalized spec bits
    const specBits = [];
    if (merged.normalized_query) specBits.push(`query="${merged.normalized_query}"`);
    if (merged.brand) specBits.push(`brand=${merged.brand}`);
    if (merged.model) specBits.push(`model=${merged.model}`);
    if (merged.sport) specBits.push(`sport=${merged.sport}`);
    if (merged.skill_level) specBits.push(`skill_level=${merged.skill_level}`);
    if (merged.playing_style) specBits.push(`playing_style=${merged.playing_style}`);
    if (merged.size) specBits.push(`size=${merged.size}`);
    if (merged.min_price != null) specBits.push(`min_price=${merged.min_price}`);
    if (merged.max_price != null) specBits.push(`max_price=${merged.max_price}`);
    if (merged._page_size) specBits.push(`page_size=${merged._page_size}`);
    const enrichedSessionHint = specBits.length
      ? `${sessionHint || ''} [NORMALIZED SPEC — USE THESE VALUES VERBATIM] ${specBits.join(', ')}`
      : sessionHint;

    // v5.6.1: 28s deadline — pipeline is faster now with no retry, so we can use more of Render's 30s window.
    const DEADLINE_MS = 28000;
    const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error('deadline_exceeded')), DEADLINE_MS));
    const result = await Promise.race([
      masterHandle({
        userMessages: fullMessages,
        allTools: FUNCTION_DEFINITIONS,
        executeFunction: sportBoundExecute,
        slots: merged,
        sessionHint: enrichedSessionHint,
        followUpHint,
        lastProducts,
        normalizedSpec: normResult.spec || null
      }),
      deadline
    ]);

    // Save assistant response to server history
    if (result.message) {
      sessionStore.addMessage(sessionId, 'assistant', result.message);
    }

    // v5.5.0: Capture products + intent so next-turn follow-ups have context.
    try {
      if (result.agent_trace?.router?.intent && result.agent_trace.router.intent !== 'other') {
        sessionStore.setLastIntent(sessionId, result.agent_trace.router.intent);
      }
      const productLinks = [...(result.message || '').matchAll(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g)];
      if (productLinks.length > 0) {
        const products = productLinks.map(m => ({ name: m[1], product_url: m[2] }));
        sessionStore.setLastProducts(sessionId, products);
        console.log(`[session:${sessionId}] captured ${products.length} products + intent=${result.agent_trace?.router?.intent}`);
      }
    } catch (e) {
      console.warn(`[session:${sessionId}] product capture failed:`, e.message);
    }

    // Attach session id so clients can pin it across turns if they want.
    res.json({ ...result, session_id: sessionId, slots: merged, _normalizer: { ok: normResult.ok, latency_ms: normResult.latency_ms, error: normResult.error || null, spec: normResult.spec || null } });
  } catch (error) {
    console.error('Multi-agent error:', error.response?.data || error.message);
    // v5.5.0: Return 200 with a friendly message instead of 500 so the chat UI
    // stays alive. Session history is untouched — next turn resumes cleanly.
    const errSessionId = sessionStore.fallbackId(req);
    const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout/i.test(error.message || '');
    const friendlyMessage = isTimeout
      ? "Sorry, that took longer than usual. Could you send your last message once more? Your conversation context is saved so I'll pick up right where we left off."
      : "I hit a snag on that one — please try sending your message again. Everything we discussed is still in memory.";
    res.status(200).json({
      message: friendlyMessage,
      agent_trace: { error: true, reason: error.code || error.message, recoverable: true },
      session_id: errSessionId
    });
  }
});

// ==================== AUTO-REFRESH (v4.6.0) ====================
// Reloads category tree + attribute options every 30 min so newly-added
// products / categories are picked up automatically without a redeploy.
let lastCatalogRefresh = null;
async function refreshCatalog(reason = 'interval') {
  const started = Date.now();
  try {
    await Promise.allSettled([loadAttributeOptions(), initCategoryMap()]);
    lastCatalogRefresh = { at: new Date().toISOString(), reason, took_ms: Date.now() - started, categories: CATEGORY_MAP.length, ball_machine_ids: [...BALL_MACHINE_CATEGORY_IDS] };
    console.log(`[refresh] ${reason} ok - ${CATEGORY_MAP.length} cats in ${Date.now() - started}ms`);
  } catch (e) {
    lastCatalogRefresh = { at: new Date().toISOString(), reason, error: e.message };
    console.log(`[refresh] ${reason} FAILED:`, e.message);
  }
}
setInterval(() => refreshCatalog('interval'), 30 * 60 * 1000).unref?.();

// Webhook so Magento (or a cron) can force a reload on product/category change.
// Protect with a shared secret in REFRESH_SECRET env var (optional).
app.post('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET;
  if (secret && req.headers['x-refresh-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await refreshCatalog('webhook');
  res.json({ ok: true, ...lastCatalogRefresh });
});

// ==================== DEBUG TRACE (v4.7.0) ====================
app.get('/api/debug/trace', (req, res) => {
  res.json({ count: TRACE.length, trace: TRACE.slice().reverse() });
});

app.get('/api/debug/classify', (req, res) => {
  const q = String(req.query.q || '');
  res.json({ query: q, ...classifyIntent(q) });
});

// ==================== PRODUCT PROBE (v4.7.1) ====================
// Direct Magento lookup that skips status/visibility filters — for diagnosing
// missing products. Returns raw API response.
app.get('/api/debug/probe', async (req, res) => {
  const q = String(req.query.q || 'tenniix');
  try {
    // Strategy 1: name LIKE without status filter
    const r1 = await magentoGet('/products', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'name',
      'searchCriteria[filter_groups][0][filters][0][value]': '%' + q + '%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[pageSize]': 10
    });
    // Strategy 2: url_key LIKE without status filter
    const r2 = await magentoGet('/products', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'url_key',
      'searchCriteria[filter_groups][0][filters][0][value]': '%' + q + '%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[pageSize]': 10
    });
    // Strategy 3: sku LIKE without status filter
    const r3 = await magentoGet('/products', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
      'searchCriteria[filter_groups][0][filters][0][value]': '%' + q + '%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[pageSize]': 10
    });
    const fmt = items => (items || []).map(i => ({
      sku: i.sku, name: i.name, url_key: (i.custom_attributes||[]).find(a=>a.attribute_code==='url_key')?.value,
      status: i.status, visibility: i.visibility, type_id: i.type_id, price: i.price
    }));
    res.json({
      query: q,
      by_name: { total: r1.total_count, items: fmt(r1.items) },
      by_url_key: { total: r2.total_count, items: fmt(r2.items) },
      by_sku: { total: r3.total_count, items: fmt(r3.items) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== HEALTH ====================
app.get('/api/health', async (req, res) => {
  const pkg = require('./package.json');
  let magentoStatus = 'unknown';
  let oauthStatus = 'unknown';
  const errors = {};
  try { await magentoGet('/store/storeConfigs'); magentoStatus = 'connected'; }
  catch (e) { magentoStatus = 'disconnected'; errors.magento_bearer = e.response?.status ? `HTTP ${e.response.status}` : (e.code || e.message || 'unknown'); }
  try {
    if (OAUTH_CONSUMER_KEY) {
      await oauthGet('/orders', { 'searchCriteria[pageSize]': 1 });
      oauthStatus = 'connected';
    } else { oauthStatus = 'not-configured'; }
  } catch (e) { oauthStatus = 'disconnected'; errors.magento_oauth = e.response?.status ? `HTTP ${e.response.status}` : (e.code || e.message || 'unknown'); }

  res.json({
    status: 'running',
    version: pkg.version,
    last_refresh: lastCatalogRefresh,
    categories_loaded: CATEGORY_MAP.length,
    category_index_keys: Object.keys(CATEGORY_INDEX).length,
    magento_bearer: magentoStatus,
    magento_oauth: oauthStatus,
    errors: Object.keys(errors).length ? errors : undefined,
    model: OPENROUTER_MODEL,
    timestamp: new Date().toISOString()
  });
});

// ==================== STOCK DIAGNOSTIC (temporary) ====================
app.get('/api/stock-debug', async (req, res) => {
  const keyword = req.query.q || 'tennis racquet';
  const sport = req.query.sport || 'tennis';
  const sku = req.query.sku; // deep-dive a single configurable SKU
  try {
    // mode=scan: find ANY products with real stock in MSI
    if (req.query.mode === 'scan') {
      // Query MSI source-items with qty > 0
      const scanResult = {};
      try {
        const msiParams = {
          'searchCriteria[filter_groups][0][filters][0][field]': 'quantity',
          'searchCriteria[filter_groups][0][filters][0][value]': 0,
          'searchCriteria[filter_groups][0][filters][0][condition_type]': 'gt',
          'searchCriteria[filter_groups][1][filters][0][field]': 'status',
          'searchCriteria[filter_groups][1][filters][0][value]': 1,
          'searchCriteria[pageSize]': 20,
          'searchCriteria[sortOrders][0][field]': 'quantity',
          'searchCriteria[sortOrders][0][direction]': 'DESC'
        };
        let msiRes;
        try { msiRes = await oauthGet('/inventory/source-items', msiParams); }
        catch { msiRes = await magentoGet('/inventory/source-items', msiParams); }
        scanResult.total_in_stock = msiRes.total_count || 0;
        scanResult.top_stock = (msiRes.items || []).map(i => ({
          sku: i.sku, source: i.source_code, qty: i.quantity, status: i.status
        }));
      } catch (e) { scanResult.msi_error = e.message; }
      // Also try stockItems via OAuth for a known shoe child
      try {
        const si = await oauthGet(`/stockItems/TSH0011-10`);
        scanResult.oauth_stockItem_test = { sku: 'TSH0011-10', qty: si.qty, is_in_stock: si.is_in_stock };
      } catch (e) { scanResult.oauth_stockItem_error = e.message; }
      return res.json(scanResult);
    }
    // If a specific SKU is requested, do a deep stock analysis
    if (sku) {
      const deepResult = {};
      // 1. MSI source-items for this SKU
      try {
        const msiParams = {
          'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
          'searchCriteria[filter_groups][0][filters][0][value]': sku,
          'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
          'searchCriteria[pageSize]': 10
        };
        let msiRes;
        try { msiRes = await oauthGet('/inventory/source-items', msiParams); }
        catch { msiRes = await magentoGet('/inventory/source-items', msiParams); }
        deepResult.msi_parent = msiRes.items || [];
      } catch (e) { deepResult.msi_parent_error = e.message; }
      // 2. stockItems for this SKU
      try {
        const si = await magentoGet(`/stockItems/${encodeURIComponent(sku)}`);
        deepResult.stockItem_parent = { qty: si.qty, is_in_stock: si.is_in_stock, manage_stock: si.manage_stock };
      } catch (e) { deepResult.stockItem_parent_error = e.message; }
      // 3. Children
      try {
        const children = await magentoGet(`/configurable-products/${encodeURIComponent(sku)}/children`);
        const childSkus = children.map(c => c.sku);
        // MSI for children
        const childMsi = await fetchStockMap(childSkus);
        // Children stock_item from their own extension_attributes
        deepResult.children = children.map(c => {
          const si = c.extension_attributes?.stock_item;
          return {
            sku: c.sku,
            name: c.name,
            msi_qty: childMsi[c.sku] || 0,
            stock_item_qty: si ? si.qty : null,
            stock_item_in_stock: si ? si.is_in_stock : null
          };
        });
      } catch (e) { deepResult.children_error = e.message; }
      return res.json({ sku, deep: deepResult });
    }
    // Standard search debug
    const params = buildSearchParams(keyword, 8);
    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return res.json({ keyword, total: 0, message: 'No Magento results' });
    }
    const items = result.items.slice(0, 8);
    // Check if search results include extension_attributes.stock_item
    const rawStockSample = items.slice(0, 2).map(i => ({
      sku: i.sku,
      type_id: i.type_id,
      has_ext_attrs: !!i.extension_attributes,
      has_stock_item: !!i.extension_attributes?.stock_item,
      stock_item: i.extension_attributes?.stock_item ? {
        qty: i.extension_attributes.stock_item.qty,
        is_in_stock: i.extension_attributes.stock_item.is_in_stock
      } : null
    }));
    const skus = items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const shaped = items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    const enrichStart = Date.now();
    await enrichConfigurables(shaped);
    const enrichMs = Date.now() - enrichStart;
    // applyFallbackStock removed in v5.2.0
    const debugProducts = shaped.map(p => ({
      name: p.name,
      sku: p.sku,
      type_id: p.type_id,
      qty: p.qty,
      magento_in_stock: p.magento_in_stock,
      _children_loaded: p._children_loaded || false,
      _children_count: p._children ? p._children.length : 0,
      _children_stock: p._children ? p._children.map(c => ({ sku: c.sku, qty: c.qty, in_stock: c.in_stock })) : [],
      _stock_source: p._stock_source || (p._children_loaded ? 'children' : 'msi'),
      available: isProductAvailable(p)
    }));
    res.json({
      keyword,
      magento_total: result.total_count,
      checked: debugProducts.length,
      enrich_ms: enrichMs,
      raw_stock_sample: rawStockSample,
      msi_map_sample: Object.fromEntries(Object.entries(stockMap).slice(0, 5)),
      products: debugProducts
    });
  } catch (e) {
    res.json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`\n\u{1F3BE} TO Assistant running on :${PORT}`);
  console.log(`\u{1F916} Model: ${OPENROUTER_MODEL}`);
  console.log(`\u{1F517} Magento: ${MAGENTO_REST}`);
  console.log(`\u{1F510} OAuth configured: ${!!OAUTH_CONSUMER_KEY}`);
  console.log(`[startup] Loading Magento attribute options...`);
  await loadAttributeOptions();
  console.log(`[startup] Attribute cache ready.`);
  console.log(`[startup] Loading Magento category map...`);
  await initCategoryMap();
  console.log(`[startup] Category map ready.\n`);
});

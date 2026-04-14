require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { masterHandle } = require('./agents');
const slotParser = require('./parser');
const sessionStore = require('./session');        // v3.3 fallback (sync, in-memory)
const memory      = require('./memory');           // v4.0 Postgres-backed
const identity    = require('./identity');
const db          = require('./db');
const actions     = require('./actions');           // v4.1 transactional actions
const flags       = require('./flags');

const app = express();
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

// OAuth 1.0a credentials (used for orders endpoint which requires admin OAuth)
const OAUTH_CONSUMER_KEY = process.env.MAGENTO_CONSUMER_KEY;
const OAUTH_CONSUMER_SECRET = process.env.MAGENTO_CONSUMER_SECRET;
const OAUTH_ACCESS_TOKEN = process.env.MAGENTO_ACCESS_TOKEN;
const OAUTH_ACCESS_TOKEN_SECRET = process.env.MAGENTO_ACCESS_TOKEN_SECRET;

// ==================== SYSTEM PROMPT ====================
const SYSTEM_PROMPT = `You are "TO Assistant" - the official Customer Support Assistant for TennisOutlet.in, India's trusted online store for tennis, pickleball, and padel equipment.

BRAND INFORMATION:
- Website: https://tennisoutlet.in
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
- When a customer gives their email and asks for "my orders" / "recent orders" / "order history", call list_recent_orders.
- Share ONLY: order_id, status / status_label, created_at, and tracking (carrier + AWB + tracking_url).
- NEVER reveal amount, address, product line items, payment method, customer name, or any personal details.
- Use the tool's status_label text verbatim (it mirrors Magento's real status, e.g. "Delivered", "Processing", "Shipped"). Do NOT invent extra wording.
- Tracking links: the tool already returns the correct courier URL. Use tracking_url as-is. Blue Dart -> bluedart.com/?<AWB>. Delhivery -> delhivery.com/track-v2/package/<AWB>.
- Orders dispatched within 8 hours. Delivery 2-5 business days.

RETURNS/REFUNDS:
- Return policy: 30 days from delivery, item unused with tags intact. Link: https://tennisoutlet.in/return-cancellation-policy
- Play & Return program: ONLY eligible on RACQUETS priced ABOVE \u20B920,000. Do NOT suggest Play & Return for shoes, strings, balls, bags, accessories, or racquets \u2264 \u20B920,000. Link: https://tennisoutlet.in/play-return-program
- Refunds: 48 hrs processing; bank credit up to 5 business days; TO Wallet instant.

PRODUCTS:
- Use get_products_by_category or search_products. ALWAYS return 4-5 products minimum when available.
- All products 100% authentic. Warranty: https://tennisoutlet.in/warranty-promise
- Buying Guide: https://tennisoutlet.in/buying-guide
- Pre-strung racquets typically strung at 55-56 tension.

PRODUCT PRESENTATION RULES (VERY IMPORTANT):
- Return AT LEAST 4-5 products whenever the catalog has them.
- Present each product with name, price, short basic details (1 key benefit), and a clickable hyperlink.
- Use this exact markdown format - the UI will render it as clickable links:

1. **[Product Name](https://tennisoutlet.in/product-url.html)**
   Price: \u20B9X,XXX
   Why it's great: <one-line reason / ideal user>

- Use product_url exactly as returned by the tool (already cleaned, already ends with .html).
- NEVER show quantity/stock numbers to the customer.
- NEVER use markdown images ![]().
- NEVER add target="_blank" or raw HTML attributes in your text.
- The tool returns products sorted highest-qty first. Feature the FIRST product prominently as the recommended upsell pick.
- After the list, add a short comparative insight (beginner vs. intermediate, power vs. control, etc.).

ROUTING RULES (STRICT - follow these exactly):
- ANY query about RACQUETS / RACKETS / PADDLES (including "which racquet", "best racquet", "recommend a racquet", "beginner racquet", brand-specific racquets) -> MUST call get_racquets_with_specs. NEVER use get_products_by_category for racquets. NEVER use best-seller categories (338/434) for racquet queries - those categories include balls and accessories.
- ANY query about SHOES / FOOTWEAR -> MUST call get_shoes_with_specs (never get_products_by_category for shoes).
- ANY query about BRANDS carried by the store -> call list_brands.
- BALLS -> get_products_by_category (Tennis Balls=31, Pickleball Balls=252, Padel Balls=273).
- STRINGS -> get_products_by_category (29).
- BAGS -> get_products_by_category (115).
- ACCESSORIES -> get_products_by_category (37).
- USED racquets -> get_products_by_category (90).
- Sale/Wimbledon/Grand Slam offers -> get_products_by_category (292/349/437).

SMART GUIDELINES:
- Beginner racquet -> get_racquets_with_specs({skill_level:"beginner"}) + add beginner advice (lighter, larger head size, forgiving).
- Brand-specific racquet -> get_racquets_with_specs({brand:"Babolat"|"Head"|"Wilson"|"YONEX"|"Prince"...}).
- COUPONS (STRICT):
  * For TENNIS BALLS / PICKLEBALL BALLS / PADEL BALLS -> suggest coupon code "BALLS3" (NOT WELCOME10).
  * For first-time buyers on everything else -> suggest "WELCOME10" (10% off up to \u20B9300).
  * Never mix these up. If the cart / recommendation is balls, it is always BALLS3.
- Cross-sell: racquet -> suggest strings/bags/shoes.
- USED RACQUETS: When a customer asks about used / second-hand / pre-owned racquets, direct them to https://tennisoutlet.in/used-racquets AND also call get_products_by_category(90) to list current stock.
- PINCODE / DELIVERY DATE: If the customer asks when their delivery will arrive, asks for a delivery date, or shares a pincode, reply with: "Please enter your pincode on the product page to see the exact delivery date for that item." Do NOT attempt to predict delivery dates yourself.

SIZE / SIZE-SPECIFIC REQUESTS (IMPORTANT):
- Shoe sizes (UK/US/EU) and apparel sizes are selected on the product page - they are NOT in product names.
- NEVER tell the customer "we don't have size X". Instead, ALWAYS call get_products_by_category with the correct shoes category (Tennis Shoes 24, Pickleball Shoes 253, Padel Shoes 274) and show 4-5 products.
- After the list, add: "All sizes (including size X) can be selected on each product page. If a specific size is sold out, it will be marked on that page."
- Same rule for grip size on racquets, apparel sizes (S/M/L/XL), string tension, etc. - show the category, tell the user where to pick the variant on the product page.

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
- BRANDS WE DO NOT CARRY: New Balance, Adidas tennis, Puma tennis. If a customer asks for these, respond: "We don't currently stock that brand. Here are comparable options from brands we carry:" then call list_brands or recommend from Babolat / Wilson / Head / Yonex / ASICS / Prince / Nike as appropriate.

BUSINESS HOURS & ESCALATION:
- Store / Operator hours: 10:00 AM - 6:00 PM IST, Monday to Saturday. Closed Sunday and national holidays.
- During business hours you can say "I'm connecting you with our support team" when needed.
- Outside business hours or on closed days, if a customer needs a human, respond: "Our team is available 10 AM - 6 PM IST, Monday to Saturday. I've noted your query and a team member will follow up during business hours. For urgent help, please call +91 9502517700 during those hours."

Use ${MAGENTO_STORE_URL} as the store origin for all product links.`;

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
      name: "list_recent_orders",
      description: "Look up the customer's most recent orders by email (default last 3). Use when the customer provides their email and asks for order history or 'my recent orders'. Returns order_id, status, status_label, created_at. Never expose amount / payment / address / item details.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "Customer's registered email address." },
          limit: { type: "integer", description: "How many recent orders to return (default 3, max 10).", default: 3 }
        },
        required: ["email"]
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
          page_size: { type: "integer", description: "Max products (default 10, max 20)", default: 10 },
          offset: { type: "integer", default: 0, description: "Skip this many already-shown products. Use for 'more options' / 'next' — pass the previous call's next_offset." },
          exclude_skus: { type: "array", items: { type: "string" }, description: "SKUs already shown in this session. Prevents repeats when paginating." }
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
          page_size: { type: "integer", default: 5 },
          offset: { type: "integer", default: 0, description: "Skip this many already-shown products. Use for 'more options' / 'next' — pass the previous call's next_offset." },
          exclude_skus: { type: "array", items: { type: "string" }, description: "SKUs already shown to the user in this session. Prevents repeats when paginating." }
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
          page_size: { type: "integer", default: 10 },
          offset: { type: "integer", default: 0, description: "Skip this many already-shown racquets. Use for 'more options' / 'next' pagination." },
          exclude_skus: { type: "array", items: { type: "string" }, description: "SKUs already shown in this session. Prevents repeats when paginating." }
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
          page_size: { type: "integer", default: 10 },
          offset: { type: "integer", default: 0, description: "Skip this many already-shown products. Pagination." },
          exclude_skus: { type: "array", items: { type: "string" }, description: "SKUs already shown in this session. Prevents repeats." }
        },
        required: ["query"]
      }
    }
  }
];

// ==================== HELPERS ====================

// Build product URL: prefer url_key, else derive from name; drop trailing SKU-like suffixes; ensure .html
function buildProductUrl(urlKey, name, sku) {
  // Use Magento's canonical url_key as-is. It is the exact storefront slug.
  let key = urlKey;
  if (!key && name) {
    key = name.toLowerCase()
      .replace(/\+/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }
  if (!key) key = (sku || '').toLowerCase();
  key = key.replace(/\.html?$/i, '');
  key = key.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${MAGENTO_STORE_URL}/${key}.html`;
}

function extractCustomAttrs(item) {
  const attrs = {};
  (item.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
  return attrs;
}

// ==================== CATEGORY MAP (v3.3.2) ====================
// Walks the Magento category tree once at startup so we can discover
// categories by keyword instead of hard-coding IDs everywhere.
// CATEGORY_MAP = [{ id, name, level, parent_id, path, url_key }]
let CATEGORY_MAP = [];
const BALL_MACHINE_CATEGORY_IDS = [];

async function initCategoryMap() {
  try {
    // /V1/categories returns the root tree (recursive). Walk it.
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
    console.log(`[category-map] loaded ${flat.length} categories`);

    // Detect ball-machine-like categories by name.
    const re = /ball.?machine|ball.?thrower|ball.?cannon|ball.?launcher|ball.?feeder/i;
    for (const c of flat) if (re.test(c.name)) BALL_MACHINE_CATEGORY_IDS.push(c.id);
    console.log(`[category-map] ball-machine category ids: ${JSON.stringify(BALL_MACHINE_CATEGORY_IDS)}`);
  } catch (e) {
    console.log(`[category-map] failed:`, e.response?.status || e.message);
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
// Including common size-attribute fallbacks because Magento stores may use any
// of these codes for configurable shoe sizes (resolveAttr looks up the first
// one with populated options).
const ATTRS_TO_CACHE = ['brands', 'court_type', 'width', 'cushioning', 'shoe_type', 'shoe_size', 'size', 'us_size', 'uk_size', 'eu_size', 'color'];
const SIZE_ATTR_CANDIDATES = ['shoe_size', 'size', 'us_size', 'uk_size', 'eu_size'];

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
    timeout: 20000
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
  // v4.2: pass Magento's native status through, just title-cased.
  // Vinay asked for raw Magento labels (e.g. "Delivered" not "Order Delivered Successfully").
  if (!status) return 'Unknown';
  const s = String(status).replace(/_/g, ' ').trim();
  return s.replace(/\b\w/g, c => c.toUpperCase());
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
        const carrierRaw = (t.title || t.carrier_code || '').toString();
        const awb = t.track_number;
        const isDelhivery = /delh?ivery/i.test(carrierRaw);
        const carrier = isDelhivery ? 'Delhivery' : 'Blue Dart';
        let tracking_url = null;
        if (awb) {
          tracking_url = isDelhivery
            ? `https://www.delhivery.com/track-v2/package/${awb}`
            : `https://www.bluedart.com/tracking?trackFor=0&trackNo=${awb}`;
        }
        tracking.push({ carrier, tracking_number: awb, tracking_url });
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

// ==================== RECENT ORDERS BY EMAIL (v4.2) ====================
async function listRecentOrders({ email, limit = 3 } = {}) {
  if (!email) return { error: true, message: 'Email is required to look up orders.' };
  try {
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'customer_email',
      'searchCriteria[filter_groups][0][filters][0][value]': email,
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
      'searchCriteria[sortOrders][0][field]': 'created_at',
      'searchCriteria[sortOrders][0][direction]': 'DESC',
      'searchCriteria[pageSize]': Math.min(Math.max(limit, 1), 10)
    };
    const res = await oauthGet('/orders', params);
    const orders = (res.items || []).map(o => ({
      order_id: o.increment_id,
      status: o.status,
      status_label: getStatusLabel(o.status),
      created_at: o.created_at,
      item_count: (o.items || []).reduce((n, it) => n + (it.qty_ordered ? 1 : 0), 0)
    }));
    return { email, count: orders.length, orders };
  } catch (error) {
    console.error('listRecentOrders error:', error.response?.status, error.message);
    return { error: true, message: `Could not fetch orders for ${email}. Please verify and try again.` };
  }
}

// ==================== BULK STOCK ====================
async function fetchStockMap(skus) {
  const map = {};
  if (skus.length === 0) return map;

  try {
    const params = { 'searchCriteria[pageSize]': Math.min(skus.length * 3, 500) };
    skus.forEach((sku, i) => {
      params[`searchCriteria[filter_groups][0][filters][${i}][field]`] = 'sku';
      params[`searchCriteria[filter_groups][0][filters][${i}][value]`] = sku;
      params[`searchCriteria[filter_groups][0][filters][${i}][condition_type]`] = 'eq';
    });
    // Try OAuth first (admin scope), fallback to bearer
    let res;
    try { res = await oauthGet('/inventory/source-items', params); }
    catch { res = await magentoGet('/inventory/source-items', params); }
    if (res.items && res.items.length > 0) {
      res.items.forEach(it => {
        const s = it.sku;
        map[s] = (map[s] || 0) + parseFloat(it.quantity || 0);
      });
      return map;
    }
  } catch (e) {
    console.log('MSI bulk stock failed, falling back:', e.response?.status);
  }

  await Promise.all(skus.map(async sku => {
    try {
      let s;
      try { s = await oauthGet(`/stockItems/${encodeURIComponent(sku)}`); }
      catch { s = await magentoGet(`/stockItems/${encodeURIComponent(sku)}`); }
      map[sku] = s.is_in_stock ? parseFloat(s.qty || 0) : 0;
    } catch { map[sku] = 0; }
  }));
  return map;
}

function shapeProduct(item, qty) {
  const attrs = extractCustomAttrs(item);
  const brandLabel = attrs.brands ? resolveAttr('brands', attrs.brands) : (attrs.brand || null);
  const shaped = {
    name: item.name,
    sku: item.sku,
    _type_id: item.type_id || null,
    price: parseFloat(item.price || 0) || null,
    special_price: attrs.special_price ? parseFloat(attrs.special_price) : null,
    brand: brandLabel,
    short_description: attrs.short_description ? String(attrs.short_description).replace(/<[^>]*>/g, '').substring(0, 200) : null,
    product_url: buildProductUrl(attrs.url_key, item.name, item.sku),
    image: attrs.image ? `${MAGENTO_STORE_URL}/media/catalog/product${attrs.image}` : null,
    qty
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

// Fetches every product that matches the given filters, paginating across
// Magento pages up to maxItems. Used by discovery tools so the client-side
// size/price filters see the full catalog, not just the first 40-100 rows.
async function fetchProductsPaginated(filters, { maxItems = 300, sortField = 'created_at', sortDir = 'DESC' } = {}) {
  const items = [];
  const perPage = 100;
  const maxPages = Math.max(1, Math.ceil(maxItems / perPage));
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const params = {
      'searchCriteria[pageSize]': perPage,
      'searchCriteria[currentPage]': page
    };
    filters.forEach(f => {
      params[`searchCriteria[filter_groups][${f.group}][filters][0][field]`] = f.field;
      params[`searchCriteria[filter_groups][${f.group}][filters][0][value]`] = f.value;
      if (f.condition_type) params[`searchCriteria[filter_groups][${f.group}][filters][0][condition_type]`] = f.condition_type;
    });
    if (sortField) {
      params['searchCriteria[sortOrders][0][field]'] = sortField;
      params['searchCriteria[sortOrders][0][direction]'] = sortDir;
    }
    const result = await magentoGet('/products', params);
    const batch = result.items || [];
    total = result.total_count || batch.length;
    items.push(...batch);
    if (batch.length < perPage) break;
    if (items.length >= maxItems) break;
    if (items.length >= total) break;
  }
  return { items: items.slice(0, maxItems), total_count: total };
}

async function getProductsByCategory(categoryId, pageSize = 10, { min_price = null, max_price = null, offset = 0, exclude_skus = [] } = {}) {
  try {
    const filters = [
      { group: 0, field: 'category_id', value: categoryId },
      { group: 1, field: 'status', value: 1 },
      { group: 2, field: 'visibility', value: 4 }
    ];
    const result = await fetchProductsPaginated(filters, { maxItems: 300 });
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: "No products found in this category." };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    await enrichConfigurables(shaped);
    const inStock = shaped.filter(p => (p.qty || 0) >= 1);
    let pool = inStock.length ? inStock : (allZero ? shaped : []);
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price });
    const filtered_out = beforeCustomer - pool.length;
    pool.sort((a, b) => b.qty - a.qty);
    const excludeSet = new Set((Array.isArray(exclude_skus) ? exclude_skus : []).map(String));
    const poolFiltered = excludeSet.size ? pool.filter(p => !excludeSet.has(String(p.sku))) : pool;
    const available = poolFiltered.slice(offset, offset + Math.min(pageSize, 20));
    stripInternals(available);
    const shown_skus = available.map(p => String(p.sku));
    const has_more = poolFiltered.length > (offset + available.length);
    let message = null;
    if (available.length === 0 && beforeCustomer > 0) {
      const bits = [];
      if (max_price) bits.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) bits.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = `No products in this category match the price filter${bits.length ? ` (${bits.join(', ')})` : ''}.`;
    }
    return {
      products: available, total: result.total_count, showing: available.length,
      offset, next_offset: offset + available.length, has_more, shown_skus,
      pool_size_after_filters: poolFiltered.length, filtered_out, message
    };
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
    'searchCriteria[pageSize]': Math.min(pageSize, 100),
    'searchCriteria[sortOrders][0][field]': 'name',
    'searchCriteria[sortOrders][0][direction]': 'ASC'
  };
}

const SEARCH_STOPWORDS = new Set([
  'the','a','an','is','are','do','does','have','has','any','some','me','my','i','you',
  'please','show','find','get','give','tell','need','want','looking','for','buy','to',
  'about','of','on','in','under','over','below','above','with','and','or','vs','versus',
  'review','reviews','rating','ratings','feedback','price','cost','available','stock'
]);

async function searchProducts(query, pageSize = 10, { min_price = null, max_price = null, offset = 0, exclude_skus = [] } = {}) {
  try {
    const fetchSize = Math.max((pageSize + offset) * 3, 30);
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
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    await enrichConfigurables(shaped);
    const inStock = shaped.filter(p => (p.qty || 0) >= 1);
    let pool = inStock.length ? inStock : (allZero ? shaped : []);
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price });
    const filtered_out = beforeCustomer - pool.length;
    pool.sort((a, b) => b.qty - a.qty);
    const excludeSet = new Set((Array.isArray(exclude_skus) ? exclude_skus : []).map(String));
    const poolFiltered = excludeSet.size ? pool.filter(p => !excludeSet.has(String(p.sku))) : pool;
    const available = poolFiltered.slice(offset, offset + Math.min(pageSize, 20));
    stripInternals(available);
    const shown_skus = available.map(p => String(p.sku));
    const has_more = poolFiltered.length > (offset + available.length);
    let message = null;
    if (available.length === 0 && beforeCustomer > 0) {
      const bits = [];
      if (max_price) bits.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) bits.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = `No matches for "${query}"${bits.length ? ` (${bits.join(', ')})` : ''}.`;
    }
    return {
      products: available, total: result.total_count, showing: available.length,
      offset, next_offset: offset + available.length, has_more, shown_skus,
      pool_size_after_filters: poolFiltered.length, filtered_out, message, query
    };
  } catch (error) {
    console.error('searchProducts error:', error.response?.status, error.message);
    return { error: true, message: "Unable to search products at this time. Please try again." };
  }
}

// ==================== SHOES WITH SPECS (ALL-IN-ONE) ====================
// Categories: Tennis Shoes=24, Pickleball Shoes=253, Padel Shoes=274
const SHOE_CATEGORIES = { tennis: 24, pickleball: 253, padel: 274 };

async function getShoesWithSpecs({ sport = 'tennis', brand = null, shoe_type = null, court_type = null, width = null, cushioning = null, size = null, min_price = null, max_price = null, page_size = 5, offset = 0, exclude_skus = [] } = {}) {
  try {
    const catId = SHOE_CATEGORIES[String(sport).toLowerCase()] || 24;
    const filters = [];
    let idx = 0;
    filters.push({ group: idx++, field: 'category_id', value: catId });
    filters.push({ group: idx++, field: 'status', value: 1 });
    filters.push({ group: idx++, field: 'visibility', value: 4 });

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

    // Fetch the WHOLE category (up to 300) so client-side size/price filters
    // see every shoe, not just the first page. Size attribute can't be pushed
    // down to Magento (it lives on child SKUs), so we need the full pool.
    const result = await fetchProductsPaginated(filters, { maxItems: 300 });
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No ${sport} shoes matched those filters.`, has_more: false, offset, next_offset: offset };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    // Enrich configurable parents with child prices + summed child stock BEFORE filtering.
    // When a size filter is requested we MUST resolve children for every configurable
    // parent — not just the ones with missing price/qty — otherwise applyPriceSizeFilters
    // drops configurables whose parents already had price+qty set (false negatives).
    await enrichConfigurables(shaped, { forceAll: !!size });
    const inStock = shaped.filter(p => (p.qty || 0) >= 1);
    let pool = inStock.length ? inStock : (allZero ? shaped : []);
    // Customer-requested filters: size, min_price, max_price.
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price, size });
    const filtered_out = beforeCustomer - pool.length;
    // Diagnostic: if a size filter eliminated the pool, log what child-size
    // data we actually had so we can tune attribute-code detection in prod.
    if (size && pool.length === 0 && beforeCustomer > 0) {
      const sample = [];
      for (const p of inStock.slice(0, 3)) {
        for (const c of (p._children || []).slice(0, 4)) {
          sample.push({ sku: c.sku, size: c.size, tokens: c._size_tokens, qty: c.qty });
        }
      }
      console.log(`[size-filter miss] want=${size} parents=${beforeCustomer} sample=${JSON.stringify(sample)}`);
    }
    // Stable sort by stock; then honor exclude_skus + offset + page_size.
    pool.sort((a, b) => b.qty - a.qty);
    const excludeSet = new Set((Array.isArray(exclude_skus) ? exclude_skus : []).map(String));
    const poolFiltered = excludeSet.size ? pool.filter(p => !excludeSet.has(String(p.sku))) : pool;
    const windowed = poolFiltered.slice(offset, offset + Math.min(page_size, 20));
    const has_more = poolFiltered.length > (offset + windowed.length);
    const shown_skus = windowed.map(p => String(p.sku));
    stripInternals(windowed);
    let message = null;
    if (windowed.length === 0 && beforeCustomer > 0) {
      const reasons = [];
      if (size) reasons.push(`size ${size}`);
      if (max_price) reasons.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) reasons.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = offset > 0
        ? `No more ${sport} shoes beyond what was already shown${reasons.length ? ` (${reasons.join(', ')})` : ''}.`
        : `No ${sport} shoes match the requested filters${reasons.length ? ` (${reasons.join(', ')})` : ''}.`;
    }
    return {
      sport, filters_applied: { brand, shoe_type, court_type, width, cushioning, size, min_price, max_price },
      products: windowed, total: result.total_count, showing: windowed.length,
      offset, next_offset: offset + windowed.length, has_more, shown_skus,
      pool_size_after_filters: poolFiltered.length,
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

async function getRacquetsWithSpecs({ sport = 'tennis', brand = null, skill_level = null, min_price = null, max_price = null, page_size = 10, offset = 0, exclude_skus = [] } = {}) {
  try {
    const catId = RACQUET_CATEGORIES[String(sport).toLowerCase()] || 25;
    const filters = [];
    let idx = 0;
    filters.push({ group: idx++, field: 'category_id', value: catId });
    filters.push({ group: idx++, field: 'status', value: 1 });
    filters.push({ group: idx++, field: 'visibility', value: 4 });
    // CRITICAL: exclude grip-size child variants; only return parent products
    filters.push({ group: idx++, field: 'type_id', value: 'configurable' });

    if (brand) {
      const bid = brandNameToId(brand);
      if (bid) filters.push({ group: idx++, field: 'brands', value: bid });
    }
    // Skill-level mapping to Magento categories (intersect via multiple category filters)
    const SKILL_CATS = { beginner: 87, intermediate: 80, advanced: 79, senior: 88, junior: 81 };
    if (skill_level && SKILL_CATS[String(skill_level).toLowerCase()]) {
      filters.push({ group: idx++, field: 'category_id', value: SKILL_CATS[String(skill_level).toLowerCase()] });
    }

    // Fetch the entire racquet/paddle pool in one go (up to 300 across pages).
    const result = await fetchProductsPaginated(filters, { maxItems: 300 });
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No ${sport} racquets matched those filters.` };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    await enrichConfigurables(shaped);
    const inStock = shaped.filter(p => (p.qty || 0) >= 1);
    let pool = inStock.length ? inStock : (allZero ? shaped : []);
    const beforeCustomer = pool.length;
    pool = applyPriceSizeFilters(pool, { min_price, max_price });
    const filtered_out = beforeCustomer - pool.length;
    pool.sort((a, b) => b.qty - a.qty);
    const excludeSet = new Set((Array.isArray(exclude_skus) ? exclude_skus : []).map(String));
    const poolFiltered = excludeSet.size ? pool.filter(p => !excludeSet.has(String(p.sku))) : pool;
    const available = poolFiltered.slice(offset, offset + Math.min(page_size, 20));
    stripInternals(available);
    const shown_skus = available.map(p => String(p.sku));
    const has_more = poolFiltered.length > (offset + available.length);
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
      offset, next_offset: offset + available.length, has_more, shown_skus,
      pool_size_after_filters: poolFiltered.length, filtered_out, message
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
async function enrichConfigurables(products, { forceAll = false } = {}) {
  // By default we only enrich parents missing price/qty. But when a downstream
  // filter needs child-level data (e.g. shoe size availability), callers pass
  // forceAll:true so every configurable parent gets its children resolved.
  const targets = forceAll
    ? products.filter(p => p && (p._type_id === 'configurable' || !p.price || p.price === 0 || !p.qty || p.qty === 0))
    : products.filter(p => p && (!p.price || p.price === 0 || !p.qty || p.qty === 0));
  if (targets.length === 0) return products;
  await Promise.all(targets.map(async p => {
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
      // Stock: per-child and summed.
      let stockMap = {};
      try {
        const childSkus = children.map(c => c.sku);
        stockMap = await fetchStockMap(childSkus);
        const total = Object.values(stockMap).reduce((a, b) => a + (parseFloat(b) || 0), 0);
        if (total > 0) p.qty = total;
      } catch { /* keep parent qty */ }
      // Per-child detail for size / price filtering. We collect EVERY candidate
      // size signal (option label, SKU suffix, child name) so size filtering can
      // survive attribute-code mismatches and unpopulated option maps.
      p._children = children.map(c => {
        const attrs = {};
        (c.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
        const sizeTokens = new Set();
        for (const code of SIZE_ATTR_CANDIDATES) {
          const raw = attrs[code];
          if (!raw) continue;
          const resolved = resolveAttr(code, raw);
          const str = Array.isArray(resolved) ? resolved.join(',') : String(resolved);
          // Pull every numeric run out of the resolved string AND out of the raw
          // (in case the options map didn't resolve — raw may itself be "7" or
          // "UK 7" already on simple attributes).
          for (const src of [str, String(raw)]) {
            const matches = src.match(/\d+(?:\.\d+)?/g) || [];
            matches.forEach(m => sizeTokens.add(m));
          }
        }
        // Tennis-shoe SKUs at TO often end with the size, e.g. "...-7" or "-7UK".
        const skuTail = String(c.sku || '').match(/[-_](\d+(?:\.\d+)?)[A-Za-z]*$/);
        if (skuTail) sizeTokens.add(skuTail[1]);
        // Product name sometimes carries "Size 7" or "US 7".
        const nameSize = String(c.name || '').match(/\b(?:size|us|uk|eu)\s*(\d+(?:\.\d+)?)/i);
        if (nameSize) sizeTokens.add(nameSize[1]);
        // Choose a human label for display (first non-empty resolution).
        let sizeLabel = null;
        for (const code of SIZE_ATTR_CANDIDATES) {
          const raw = attrs[code];
          if (!raw) continue;
          const resolved = resolveAttr(code, raw);
          sizeLabel = Array.isArray(resolved) ? resolved.join(',') : resolved;
          if (sizeLabel) break;
        }
        return {
          sku: c.sku,
          price: parseFloat(c.price || 0) || null,
          qty: parseFloat(stockMap[c.sku] || 0),
          size: sizeLabel,
          _size_tokens: Array.from(sizeTokens)
        };
      });
    } catch {
      // leave as-is; downstream filter will drop if qty<1
    }
  }));
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
      // Match against the broadened _size_tokens set (labels, SKU suffixes,
      // name tokens). Legacy: also accept the first numeric in c.size.
      const hit = p._children.some(c => {
        if ((c.qty || 0) < 1) return false;
        const tokens = Array.isArray(c._size_tokens) ? c._size_tokens : [];
        if (tokens.some(t => parseFloat(t) === want)) return true;
        const got = parseFloat(String(c.size || '').match(/[\d.]+/)?.[0] || '');
        return !isNaN(got) && got === want;
      });
      if (!hit) return false;
    }
    return true;
  });
}

// Strip internal-only fields before returning to the LLM (keeps payload small).
function stripInternals(products) {
  (products || []).forEach(p => {
    if (!p) return;
    if (p._children) {
      (p._children || []).forEach(c => { if (c && c._size_tokens) delete c._size_tokens; });
      delete p._children;
    }
    if (p._type_id) delete p._type_id;
  });
  return products;
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
async function getBallMachines({ page_size = 10, min_price = null, max_price = null } = {}) {
  const seen = new Map();

  // Strategy A: any ball-machine categories discovered at startup.
  for (const catId of BALL_MACHINE_CATEGORY_IDS) {
    try {
      const byCat = await getProductsByCategory(catId, 20, { min_price, max_price });
      for (const p of (byCat.products || [])) if (!seen.has(p.sku)) seen.set(p.sku, p);
    } catch {}
  }

  // Strategy B: free-text search across name+sku+url_key with token fallback.
  const queries = ['ball machine', 'ball thrower', 'ball cannon', 'ball launcher', 'ball feeder'];
  for (const q of queries) {
    try {
      const bySearch = await searchProducts(q, 10, { min_price, max_price });
      for (const p of (bySearch.products || [])) if (!seen.has(p.sku)) seen.set(p.sku, p);
    } catch {}
    if (seen.size >= page_size * 2) break;
  }

  // Strategy C: direct url_key slug match (Magento url_key often is "ball-machine").
  try {
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'url_key',
      'searchCriteria[filter_groups][0][filters][0][value]': '%ball%machine%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      'searchCriteria[pageSize]': 20
    };
    const result = await magentoGet('/products', params);
    if (result.items && result.items.length) {
      const skus = result.items.map(i => i.sku);
      const stockMap = await fetchStockMap(skus);
      const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
      await enrichConfigurables(shaped);
      for (const p of shaped) if (!seen.has(p.sku)) seen.set(p.sku, p);
    }
  } catch {}

  let pool = [...seen.values()].filter(p => (p.qty || 0) >= 1);
  if (pool.length === 0) pool = [...seen.values()];
  pool = applyPriceSizeFilters(pool, { min_price, max_price });
  const available = pool.sort((a, b) => b.qty - a.qty).slice(0, Math.min(page_size, 20));
  stripInternals(available);

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
        product = shapeProduct(res, stock[res.sku] || 0);
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

// ==================== EXECUTE ====================
async function executeFunction(name, args) {
  switch (name) {
    case 'get_order_status': return await getOrderStatus(args.order_id);
    case 'list_recent_orders': return await listRecentOrders(args || {});
    case 'get_products_by_category': return await getProductsByCategory(args.category_id, args.page_size, { min_price: args.min_price, max_price: args.max_price, offset: args.offset, exclude_skus: args.exclude_skus });
    case 'search_products': return await searchProducts(args.query, args.page_size, { min_price: args.min_price, max_price: args.max_price, offset: args.offset, exclude_skus: args.exclude_skus });
    case 'get_shoes_with_specs': return await getShoesWithSpecs(args || {});
    case 'get_racquets_with_specs': return await getRacquetsWithSpecs(args || {});
    case 'list_brands': return listBrands();
    case 'get_ball_machines': return await getBallMachines(args || {});
    case 'find_categories': return { matches: findCategoriesByKeyword(args.keyword) };
    case 'list_categories': return { categories: listAllCategories(args || {}) };
    case 'get_product_reviews': return await getProductReviews(args || {});
    default: return { error: true, message: `Unknown function: ${name}` };
  }
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
    const mentionsPickle = /pickleball|pickle/i.test(lowerUser);
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

    const apiMessages = sizeDirective
      ? [{ role: 'system', content: SYSTEM_PROMPT }, sizeDirective, ...messages]
      : [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];

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

    res.json({ message: assistantMessage.content, usage: response.data.usage });
  } catch (error) {
    console.error('Chat API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== MULTI-AGENT CHAT ====================
app.post('/api/chat-agents', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // ===== v4.0: identity → memory → parser → master =====
    const sessionId = memory.fallbackId(req);
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    // Reset word? Drop prior session state (memory + legacy cache).
    if (slotParser.shouldReset(lastUser)) {
      await memory.reset(sessionId);
      sessionStore.reset(sessionId);
    }

    // 1) Load prior session state (Postgres-backed, with fallback to empty).
    const priorState = await memory.get(sessionId);
    const prior = priorState.slots || {};

    // 2) Parse this turn (adds email/phone/consent).
    const fresh = slotParser.parseSlots(lastUser);

    // 3) Resolve identity. Only hydrates preferences when consent=true.
    const idRes = await identity.resolveForTurn({
      sessionState: priorState,
      parsedSlots: fresh
    });

    // 4) Handle explicit consent changes.
    if (fresh.consent === 'grant' && idRes.customer_id) {
      await identity.grantConsent(idRes.customer_id);
    } else if (fresh.consent === 'revoke' && idRes.customer_id) {
      await identity.revokeConsent(idRes.customer_id);
    }

    // 5) Merge: prior < preferences (consent-gated) < fresh. Fresh always wins.
    const withPrefs = slotParser.mergeSlots(prior, idRes.preferences || {});
    const merged = slotParser.mergeSlots(withPrefs, fresh);
    merged._rendered = slotParser.renderSlotsHint(merged);

    // 6) Persist.
    await memory.update(sessionId, { slots: merged, customer_id: idRes.customer_id });

    const turns = (priorState.turns || 0) + 1;
    let sessionHint = (turns > 1 && prior && Object.keys(prior).some(k => prior[k] != null && k !== '_rendered'))
      ? `Previous turn slots: ${slotParser.renderSlotsHint(prior) || '(none)'}. Current merged slots: ${merged._rendered || '(none)'}`
      : '';

    // v4.1.3: carry last-search pagination state so "more options" works.
    // Stored inside slots._last_search (JSONB) to avoid a DB migration.
    const PAGINATED_TOOLS = new Set(['get_shoes_with_specs', 'get_racquets_with_specs', 'get_products_by_category', 'search_products']);
    const priorSearch = (priorState.slots && priorState.slots._last_search) || null;
    if (priorSearch && PAGINATED_TOOLS.has(priorSearch.tool)) {
      const shown = (priorSearch.shown_skus || []).length;
      const nextOffset = priorSearch.next_offset ?? shown;
      sessionHint += ` | LAST_SEARCH tool=${priorSearch.tool} args=${JSON.stringify(priorSearch.args || {})} shown_so_far=${shown} next_offset=${nextOffset} has_more=${!!priorSearch.has_more} exclude_skus=${JSON.stringify(priorSearch.shown_skus || [])}`;
    }

    console.log(`[session:${sessionId}] turn=${turns} cust=${idRes.customer_id || 'anon'} consent=${idRes.consent} slots={${merged._rendered}}`);

    // 7) Log the user turn (best-effort).
    memory.logMessage({
      session_id: sessionId, customer_id: idRes.customer_id,
      role: 'user', content: lastUser, intent: fresh.intent_hint, slots: merged
    }).catch(() => {});

    // Wrap executeFunction so we can capture pagination state per-turn.
    let captured = null;
    const wrappedExecute = async (name, args) => {
      const out = await executeFunction(name, args);
      if (PAGINATED_TOOLS.has(name) && out && !out.error) {
        // Accumulate already-shown SKUs across the turn so "more" never repeats.
        const priorSkus = (priorSearch && priorSearch.tool === name) ? (priorSearch.shown_skus || []) : [];
        const newSkus = out.shown_skus || [];
        const mergedSkus = Array.from(new Set([...priorSkus, ...newSkus]));
        captured = {
          tool: name,
          args: { ...(args || {}), offset: undefined, exclude_skus: undefined },
          shown_skus: mergedSkus,
          next_offset: (out.next_offset != null) ? out.next_offset : mergedSkus.length,
          has_more: !!out.has_more,
          pool_size_after_filters: out.pool_size_after_filters,
          at: Date.now()
        };
      }
      return out;
    };

    const result = await masterHandle({
      userMessages: messages,
      allTools: FUNCTION_DEFINITIONS,
      executeFunction: wrappedExecute,
      slots: merged,
      sessionHint
    });

    if (captured) {
      // Persist alongside existing slots so memory.get() returns it on next turn.
      memory.update(sessionId, { slots: { ...merged, _last_search: captured } }).catch(() => {});
    }

    // Log assistant reply (best-effort).
    memory.logMessage({
      session_id: sessionId, customer_id: idRes.customer_id,
      role: 'assistant', content: result?.message || result?.reply || ''
    }).catch(() => {});

    res.json({ ...result, session_id: sessionId, slots: merged, customer_id: idRes.customer_id, consent: idRes.consent });
  } catch (error) {
    console.error('Multi-agent error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ==================== HEALTH ====================
app.get('/api/health', async (req, res) => {
  let magentoStatus = 'unknown';
  let oauthStatus = 'unknown';
  try { await magentoGet('/store/storeConfigs'); magentoStatus = 'connected'; }
  catch { magentoStatus = 'disconnected'; }
  try {
    if (OAUTH_CONSUMER_KEY) {
      await oauthGet('/orders', { 'searchCriteria[pageSize]': 1 });
      oauthStatus = 'connected';
    } else { oauthStatus = 'not-configured'; }
  } catch { oauthStatus = 'disconnected'; }

  const supa = await db.ping();

  res.json({
    status: 'running',
    magento_bearer: magentoStatus,
    magento_oauth: oauthStatus,
    supabase: supa.ok ? 'connected' : `disconnected:${supa.reason}`,
    memory: memory.stats(),
    model: OPENROUTER_MODEL,
    version: '4.1-alpha',
    writes_enabled: flags.WRITES_ENABLED,
    action_dryrun: flags.ACTION_DRYRUN,
    timestamp: new Date().toISOString()
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// v4: give identity + actions modules handles to Magento/OAuth helpers here
// (not at top of file) to avoid any circular-require risks.
identity.init({ magentoGet });
actions.init({ magentoGet, oauthGet });

// ==================== v4.1 ACTIONS API ====================
// Two-turn confirmation protocol. The chat agent proposes, the client
// confirms through a separate endpoint. Proposals for READ actions execute
// inline. Writes return a confirmation_token that must be POSTed back.

app.get('/api/actions/catalogue', (req, res) => {
  res.json({
    writes_enabled: flags.WRITES_ENABLED,
    dryrun: flags.ACTION_DRYRUN,
    confirm_ttl_min: flags.CONFIRM_TTL_MIN,
    actions: actions.catalogue()
  });
});

app.post('/api/actions/propose', async (req, res) => {
  try {
    const { name, params, session_id, customer_id, customer } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    const out = await actions.propose({ name, params: params || {}, session_id, customer_id, customer });
    res.json(out);
  } catch (e) {
    console.error('[actions/propose]', e.message);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

app.post('/api/actions/confirm', async (req, res) => {
  try {
    const { confirmation_token, customer } = req.body || {};
    const out = await actions.confirm(confirmation_token, { customer });
    res.json(out);
  } catch (e) {
    console.error('[actions/confirm]', e.message);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

app.post('/api/actions/cancel', async (req, res) => {
  try {
    const { confirmation_token } = req.body || {};
    const out = await actions.cancel(confirmation_token);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

app.listen(PORT, async () => {
  console.log(`\n\u{1F3BE} TO Assistant v4.1-alpha running on :${PORT}`);
  console.log(`\u{1F511} Writes enabled: ${flags.WRITES_ENABLED} | DryRun: ${flags.ACTION_DRYRUN}`);
  console.log(`\u{1F916} Model: ${OPENROUTER_MODEL}`);
  console.log(`\u{1F517} Magento: ${MAGENTO_REST}`);
  console.log(`\u{1F510} OAuth configured: ${!!OAUTH_CONSUMER_KEY}`);
  console.log(`\u{1F4BE} Persistence: ${db.enabled ? 'Supabase' : 'memory-only (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set)'}`);
  console.log(`[startup] Loading Magento attribute options...`);
  await loadAttributeOptions();
  console.log(`[startup] Attribute cache ready.`);
  console.log(`[startup] Loading Magento category map...`);
  await initCategoryMap();
  console.log(`[startup] Category map ready.\n`);
});

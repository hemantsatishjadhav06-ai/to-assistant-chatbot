require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { masterHandle } = require('./agents');

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
- Expensive items -> mention WELCOME10 coupon (10% off up to \u20B9300) for first-time buyers.
- Cross-sell: racquet -> suggest strings/bags/shoes.

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
- We do NOT carry New Balance - recommend alternatives.

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
      description: "Return shoes from TennisOutlet with FULL resolved specs (brand, court_type, width, cushioning, shoe_type, shoe_weight, inner/outer material, outsole, made_in_country, available UK/INDIA sizes). Use this for ANY shoe query about brand, size availability, or spec filtering. Accepts optional filters.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "pickleball", "padel"], default: "tennis" },
          brand: { type: "string", description: "Brand name like 'ASICS', 'Nike', 'Babolat', 'Adidas'. Optional." },
          shoe_type: { type: "string", description: "Men's / Women's / Kid's. Optional." },
          court_type: { type: "string", description: "All Court / Clay Court / Hard Court / Padel Court / Pickleball Court. Optional." },
          width: { type: "string", description: "Narrow / Medium / Wide. Optional." },
          cushioning: { type: "string", description: "Low / Medium / High. Optional." },
          page_size: { type: "integer", default: 10 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_racquets_with_specs",
      description: "Return RACQUETS (not balls, not accessories) from the correct racquet category with brand resolved. ALWAYS use this for any query about racquets/rackets/paddles - NEVER use get_products_by_category for racquet queries. Tennis Racquets category=25, Padel Rackets=272, Pickleball Paddles=250. Optionally filter by brand and skill_level.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "padel", "pickleball"], default: "tennis" },
          brand: { type: "string", description: "Brand name like Babolat, Head, Wilson, YONEX, Prince. Optional." },
          skill_level: { type: "string", enum: ["beginner", "intermediate", "advanced", "senior", "junior"], description: "Optional skill level filter." },
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
      name: "search_products",
      description: "Search the full TennisOutlet.in catalog by name/keyword. Returns only available (qty>=1) items, sorted highest-qty first for upsell.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          page_size: { type: "integer", default: 10 }
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

async function getProductsByCategory(categoryId, pageSize = 10) {
  try {
    const fetchSize = Math.max(pageSize * 3, 30);
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'category_id',
      'searchCriteria[filter_groups][0][filters][0][value]': categoryId,
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      'searchCriteria[filter_groups][2][filters][0][field]': 'visibility',
      'searchCriteria[filter_groups][2][filters][0][value]': 4,
      'searchCriteria[pageSize]': Math.min(fetchSize, 100),
      'searchCriteria[sortOrders][0][field]': 'created_at',
      'searchCriteria[sortOrders][0][direction]': 'DESC'
    };
    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: "No products found in this category." };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    const available = (allZero ? shaped : shaped.filter(p => p.qty >= 1))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, Math.min(pageSize, 20));
    return { products: available, total: result.total_count, showing: available.length };
  } catch (error) {
    console.error('getProductsByCategory error:', error.response?.status, error.message);
    return { error: true, message: "Unable to fetch products at this time. Please try again." };
  }
}

async function searchProducts(query, pageSize = 10) {
  try {
    const fetchSize = Math.max(pageSize * 3, 30);
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'name',
      'searchCriteria[filter_groups][0][filters][0][value]': `%${query}%`,
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      'searchCriteria[pageSize]': Math.min(fetchSize, 100),
      'searchCriteria[sortOrders][0][field]': 'name',
      'searchCriteria[sortOrders][0][direction]': 'ASC'
    };
    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No products found matching "${query}".` };
    }
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    const available = (allZero ? shaped : shaped.filter(p => p.qty >= 1))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, Math.min(pageSize, 20));
    return { products: available, total: result.total_count, showing: available.length, query };
  } catch (error) {
    console.error('searchProducts error:', error.response?.status, error.message);
    return { error: true, message: "Unable to search products at this time. Please try again." };
  }
}

// ==================== SHOES WITH SPECS (ALL-IN-ONE) ====================
// Categories: Tennis Shoes=24, Pickleball Shoes=253, Padel Shoes=274
const SHOE_CATEGORIES = { tennis: 24, pickleball: 253, padel: 274 };

async function getShoesWithSpecs({ sport = 'tennis', brand = null, shoe_type = null, court_type = null, width = null, cushioning = null, page_size = 10 } = {}) {
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

    const params = { 'searchCriteria[pageSize]': Math.min(page_size * 4, 100) };
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
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    const available = (allZero ? shaped : shaped.filter(p => p.qty >= 1))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, Math.min(page_size, 20));
    await enrichConfigurablePrices(available);
    return {
      sport, filters_applied: { brand, shoe_type, court_type, width, cushioning },
      products: available, total: result.total_count, showing: available.length
    };
  } catch (error) {
    console.error('getShoesWithSpecs error:', error.response?.status, error.message);
    return { error: true, message: `Unable to fetch ${sport} shoes. ${error.message}` };
  }
}

// ==================== RACQUETS WITH SPECS ====================
// Tennis Racquets=25, Padel Rackets=272, Pickleball Paddles=250
const RACQUET_CATEGORIES = { tennis: 25, padel: 272, pickleball: 250 };

async function getRacquetsWithSpecs({ sport = 'tennis', brand = null, skill_level = null, page_size = 10 } = {}) {
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

    const params = { 'searchCriteria[pageSize]': Math.min(page_size * 4, 100) };
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
    const allZero = Object.values(stockMap).every(v => !v);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0));
    const available = (allZero ? shaped : shaped.filter(p => p.qty >= 1))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, Math.min(page_size, 20));
    await enrichConfigurablePrices(available);
    return {
      sport, filters_applied: { brand, skill_level },
      products: available, total: result.total_count, showing: available.length
    };
  } catch (error) {
    console.error('getRacquetsWithSpecs error:', error.response?.status, error.message);
    return { error: true, message: `Unable to fetch ${sport} racquets. ${error.message}` };
  }
}

// Resolve configurable-parent price from first in-stock child, in parallel.
// Magento often stores price=0 on configurable parents; children hold the real price.
async function enrichConfigurablePrices(products) {
  const needing = products.filter(p => !p.price || p.price === 0);
  if (needing.length === 0) return products;
  await Promise.all(needing.map(async p => {
    try {
      const children = await magentoGet(`/configurable-products/${encodeURIComponent(p.sku)}/children`);
      if (Array.isArray(children) && children.length) {
        // Pick the lowest non-zero price across children; fall back to first.
        const prices = children.map(c => parseFloat(c.price || 0)).filter(v => v > 0);
        if (prices.length) {
          p.price = Math.min(...prices);
          const maxP = Math.max(...prices);
          if (maxP > p.price) p.price_max = maxP;
        } else if (children[0].price) {
          p.price = parseFloat(children[0].price);
        }
        // Also pull a special_price if any child has one
        const sp = children.map(c => parseFloat(c.special_price || 0)).filter(v => v > 0);
        if (sp.length && !p.special_price) p.special_price = Math.min(...sp);
      }
    } catch (e) {
      // leave price as-is; the specialist will omit it gracefully
    }
  }));
  return products;
}

function listBrands() {
  const map = ATTR_OPTIONS['brands'] || {};
  const brands = Object.entries(map).map(([id, label]) => ({ id, name: label })).filter(b => b.name && b.name.trim());
  return { total: brands.length, brands };
}

// ==================== EXECUTE ====================
async function executeFunction(name, args) {
  switch (name) {
    case 'get_order_status': return await getOrderStatus(args.order_id);
    case 'get_products_by_category': return await getProductsByCategory(args.category_id, args.page_size);
    case 'search_products': return await searchProducts(args.query, args.page_size);
    case 'get_shoes_with_specs': return await getShoesWithSpecs(args || {});
    case 'get_racquets_with_specs': return await getRacquetsWithSpecs(args || {});
    case 'list_brands': return listBrands();
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
    const result = await masterHandle({
      userMessages: messages,
      allTools: FUNCTION_DEFINITIONS,
      executeFunction
    });
    res.json(result);
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

  res.json({
    status: 'running',
    magento_bearer: magentoStatus,
    magento_oauth: oauthStatus,
    model: OPENROUTER_MODEL,
    timestamp: new Date().toISOString()
  });
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
  console.log(`[startup] Attribute cache ready.\n`);
});

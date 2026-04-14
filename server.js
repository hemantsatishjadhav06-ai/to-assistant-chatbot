require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');

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
const MAGENTO_BASE_URL = process.env.MAGENTO_BASE_URL || 'https://console.tennisoutlet.in';
const MAGENTO_REST = `${MAGENTO_BASE_URL}/rest/V1`;
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

SMART GUIDELINES:
- "best racquets" / "best sellers" -> category_id 434 (2025) or 338 (2024).
- Beginner -> category_id 87 and add beginner advice (lighter, larger head size, forgiving).
- Brand questions -> brand-specific category (Babolat 26, Wilson 34, Head 35, Yonex 66, Prince 336).
- Expensive items -> mention WELCOME10 coupon (10% off up to \u20B9300) for first-time buyers.
- Cross-sell: racquet -> suggest strings/bags/shoes.

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
  // Strip trailing SKU-like suffixes like "-g2", "-3", "-l3-300g"
  key = key.replace(/-[a-z]?\d+(?:-\d+[a-z]*)*$/i, '');
  key = key.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${MAGENTO_STORE_URL}/${key}.html`;
}

function extractCustomAttrs(item) {
  const attrs = {};
  (item.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
  return attrs;
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
    const res = await magentoGet('/inventory/source-items', params);
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
      const s = await magentoGet(`/stockItems/${encodeURIComponent(sku)}`);
      map[sku] = s.is_in_stock ? parseFloat(s.qty || 0) : 0;
    } catch { map[sku] = 0; }
  }));
  return map;
}

function shapeProduct(item, qty) {
  const attrs = extractCustomAttrs(item);
  return {
    name: item.name,
    sku: item.sku,
    price: parseFloat(item.price || 0) || null,
    special_price: attrs.special_price ? parseFloat(attrs.special_price) : null,
    brand: attrs.brand || null,
    short_description: attrs.short_description ? String(attrs.short_description).replace(/<[^>]*>/g, '').substring(0, 200) : null,
    product_url: buildProductUrl(attrs.url_key, item.name, item.sku),
    qty
  };
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
    const available = result.items
      .map(item => shapeProduct(item, stockMap[item.sku] || 0))
      .filter(p => p.qty >= 1)
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
    const available = result.items
      .map(item => shapeProduct(item, stockMap[item.sku] || 0))
      .filter(p => p.qty >= 1)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, Math.min(pageSize, 20));
    return { products: available, total: result.total_count, showing: available.length, query };
  } catch (error) {
    console.error('searchProducts error:', error.response?.status, error.message);
    return { error: true, message: "Unable to search products at this time. Please try again." };
  }
}

// ==================== EXECUTE ====================
async function executeFunction(name, args) {
  switch (name) {
    case 'get_order_status': return await getOrderStatus(args.order_id);
    case 'get_products_by_category': return await getProductsByCategory(args.category_id, args.page_size);
    case 'search_products': return await searchProducts(args.query, args.page_size);
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

    const apiMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];

    let response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: OPENROUTER_MODEL,
      messages: apiMessages,
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

app.listen(PORT, () => {
  console.log(`\n\u{1F3BE} TO Assistant running on :${PORT}`);
  console.log(`\u{1F916} Model: ${OPENROUTER_MODEL}`);
  console.log(`\u{1F517} Magento: ${MAGENTO_REST}`);
  console.log(`\u{1F510} OAuth configured: ${!!OAUTH_CONSUMER_KEY}\n`);
});

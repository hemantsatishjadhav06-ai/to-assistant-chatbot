require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
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
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ==================== CONFIG ====================
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
const MAGENTO_BASE_URL = process.env.MAGENTO_BASE_URL || 'https://console.tennisoutlet.in/rest/V1';
const MAGENTO_TOKEN = process.env.MAGENTO_TOKEN;
const MAGENTO_STORE_URL = process.env.MAGENTO_STORE_URL || 'https://tennisoutlet.in';

// ==================== SYSTEM PROMPT ====================
const SYSTEM_PROMPT = `You are "TO Assistant" — the official Customer Support Assistant for TennisOutlet.in, India's trusted online store for tennis, pickleball, and padel equipment.

BRAND INFORMATION:
- Website: https://tennisoutlet.in
- Parent Company: Pro Sports Outlets
- Store Address: Survey No. 47/A, near Sreenidhi International School, Aziznagar, Hyderabad, Telangana 500075
- Store Timings: 10:30 AM to 06:00 PM, Monday to Saturday
- Google Maps: https://maps.app.goo.gl/p8osT584Tpa3s3337
- Customer Support Phone: +91 9502517700 (Mon–Sat, 10:00 AM – 06:00 PM)
- Sister Brands: PickleballOutlet.in, PadelOutlet.in
- IMPORTANT: Customer support is NOT available on WhatsApp

GREETING PROTOCOL:
- Standard: "Welcome to TennisOutlet! 🎾 How may I help you today?"
- Pickleball inquiries: "Welcome to PickleballOutlet! How may I help you today?"
- Padel inquiries: "Welcome to PadelOutlet! How may I help you today?"

ORDER MANAGEMENT:
- When customers ask about order status, returns, refunds, or share an Order ID, use the get_order_status function
- Orders are dispatched within 8 hours of receipt
- For order-specific actions (cancellation, address changes, refund processing), collect details and confirm you will pass them to the relevant team
- PRIVACY: Never display order amount, customer address, product details, or payment info. Only share general status, tracking info, and delivery timeline.
- ALWAYS provide Blue Dart tracking link when AWB number is available: https://bluedart.com/?{AWB_NUMBER}

SHIPPING & DELIVERY:
- Delivery Time: 2–5 business days depending on city
- Shipping Partner: Blue Dart (excellent TAT; delivery usually 1–2 business days after dispatch)
- Orders dispatched within 8 hours of receipt
- For delays: "Sincere apologies for the delay. We will follow up with our delivery partner and ensure the product reaches you at the earliest."

RETURNS, EXCHANGES & REFUNDS:
- 30-day hassle-free return policy
- Products must be unused with all stickers and tags intact
- Return Policy: https://tennisoutlet.in/return-cancellation-policy
- Play & Return Program: Try a racquet and return within 5 days — https://tennisoutlet.in/play-return-program
- Used Racquets: https://tennisoutlet.in/used-racquets
- Refunds processed within 48 hours after receiving returned product
- Bank credit may take up to 5 business days; TO Wallet refunds are instant

PRODUCT INFORMATION:
- When customers ask about products, use the get_products_by_category or search_products function
- All products are 100% authentic, sourced directly from brands or authorized distributors
- WARRANTY PROMISE: https://tennisoutlet.in/warranty-promise
- Buying Guide: https://tennisoutlet.in/buying-guide
- Pre-strung racquets are usually strung at 55–56 tension

PRODUCT PRESENTATION:
When presenting products, be professional and detailed:
- Include complete specs, technical features, performance characteristics
- Explain why each product suits specific needs/skill levels/playing styles
- Present in clean, organized format
- Highlight unique selling points and competitive advantages
- Include stock & pricing info
- Provide comparative insights for multiple products
- Include weight, string pattern, head size, balance point, etc.
- Mention brand reputation and professional endorsements when relevant

STOCK INFO:
- For out-of-stock: "Currently the product is not in stock. Unfortunately, we have not received a tentative restock date from the brand. It will be updated on our website as soon as it is back in stock."

PAYMENT METHODS:
- Credit/Debit cards, Net Banking, UPI, EMI, Cash on Delivery
- EMI not visible: "We're in the process of enabling the EMI payment option, which is anticipated to be live within a week."
- Extremely competitive pricing

FIRST-ORDER DISCOUNT:
- 10% off (up to ₹300)
- Coupon Code: WELCOME10
- How to Get: Subscribe via the pop-up at the bottom-right corner of the website using phone number and email

WEBSITE ISSUES:
"Please clear your cache and try again. Alternatively, press Ctrl+Shift+N to open an incognito window and try there. If the issue persists, please let us know."

COMMUNICATION STYLE:
- Warm, professional, empathetic
- Short, clear sentences
- Use emojis sparingly (🎾, ✅, 📦)
- Empathize first if customer reports a problem
- Never make up information
- If unsure, escalate: "I'm connecting you with our support team for further assistance. Please hold on."

CLOSING:
- When customer says thanks/goodbye: "Thank you for contacting TennisOutlet! Have a great day! 🎾"
- Always ask: "Is there anything else I can assist you with?"

BOUNDARIES:
- Do NOT discuss competitors or compare pricing
- Do NOT provide medical or injury advice
- Do NOT process payments or access sensitive data
- Do NOT answer questions unrelated to TennisOutlet
- Stay strictly within scope of TennisOutlet, PickleballOutlet, and PadelOutlet

AVAILABLE BRANDS: Yonex, Wilson, Babolat, Head, Prince, Dunlop, Tecnifibre, Solinco, Luxilon, Asics, Adidas, Nike, Joma, and more.
NOTE: We do NOT carry New Balance. Recommend alternatives if asked.

IMPORTANT FUNCTION USAGE:
- Use get_order_status when a customer provides an order ID or asks about their order
- Use get_products_by_category to browse products in a specific category
- Use search_products when customers ask about specific products by name or keyword
- Always present product links as clickable URLs from ${MAGENTO_STORE_URL}

RESPONSE FORMATTING RULES (VERY IMPORTANT):
- NEVER use markdown image syntax like ![text](url)
- NEVER add target="_blank" or any HTML attributes in your text responses
- For product links, use ONLY this format: https://tennisoutlet.in/product-name.html
- Present products in a clean numbered list with name, price, and URL on separate lines
- Use **bold** for product names only
- Use plain text URLs on their own line — they will auto-link
- Keep responses concise and scannable
- When showing products, use this exact format for each:

1. **Product Name**
   Price: ₹X,XXX
   https://tennisoutlet.in/product-url.html

SMART RESPONSE GUIDELINES:
- If a customer asks for "best racquets" or "best sellers", use category_id 434 (Best Sellers 2025) or 338 (Best Sellers 2024)
- If a customer asks for beginner recommendations, use category_id 87 and add personalized advice about what makes each racquet good for beginners (lightweight, larger head size, forgiving, etc.)
- If a customer asks about a brand, use the brand-specific category
- Always add helpful context: why a product is good, who it's best for, skill level suitability
- Cross-sell intelligently: if someone buys a racquet, suggest strings, bags, or shoes
- For order tracking: be empathetic, provide clear status, and proactive next steps
- If a product is expensive, mention the WELCOME10 coupon for first-time buyers
- Compare products when showing multiple options to help customers decide`;

// ==================== FUNCTION DEFINITIONS FOR AI ====================
const FUNCTION_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "Fetch order details from Magento when a customer provides their Order ID. Returns order status, shipping info, and tracking details. NEVER reveal order amount, address, product details, or payment info to the customer.",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The customer's order ID (e.g., '100012345' or '#100012345')"
          }
        },
        required: ["order_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_products_by_category",
      description: `Fetch in-stock products from a specific category on TennisOutlet.in. Use category IDs:
TENNIS: Racquets(25), Babolat(26), Wilson(34), Head(35), Yonex(66), Prince(336), Strings(29), Shoes(24), Balls(31), Bags(115), Accessories(37)
BY SKILL: Beginner(87), Intermediate(80), Advanced(79), Senior(88)
JUNIOR: Junior Racquets(81)
USED: Used Racquets(90)
PICKLEBALL: Main(243), Paddles(250), PB Balls(252), PB Shoes(253)
PADEL: Main(245), Padel Rackets(272), Padel Balls(273), Padel Shoes(274)
SALE: Wimbledon Sale(292), Grand Slam Sale(349), Boxing Day Sale(437)
BEST SELLERS: 2024(338), 2025(434)
BRAND-SPECIFIC: Babolat Racquets(26), Wilson Racquets(34), Head Racquets(35), Yonex Racquets(66), Pure Aero(44), Pure Drive(45), Pro Staff(50), Blade(52), Speed(57), EZONE(69), VCORE(67)`,
      parameters: {
        type: "object",
        properties: {
          category_id: {
            type: "integer",
            description: "The Magento category ID to fetch products from"
          },
          page_size: {
            type: "integer",
            description: "Number of products to return (default 10, max 20)",
            default: 10
          }
        },
        required: ["category_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search for products by name or keyword across the entire TennisOutlet.in catalog. Use when customers ask for specific product names, models, or general searches.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword or product name (e.g., 'Pure Aero', 'tennis shoes size 10', 'dampener')"
          },
          page_size: {
            type: "integer",
            description: "Number of results to return (default 10, max 20)",
            default: 10
          }
        },
        required: ["query"]
      }
    }
  }
];

// ==================== MAGENTO API FUNCTIONS ====================

async function magentoGet(endpoint) {
  try {
    const response = await axios.get(`${MAGENTO_BASE_URL}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${MAGENTO_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error(`Magento API error [${endpoint}]:`, error.response?.status, error.response?.data?.message || error.message);
    throw error;
  }
}

async function getOrderStatus(orderId) {
  // Clean the order ID
  const cleanId = orderId.replace(/[^0-9]/g, '');

  try {
    // Try fetching by increment_id first (the order number customers see)
    const searchResult = await magentoGet(
      `/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${cleanId}`
    );

    let order;
    if (searchResult.items && searchResult.items.length > 0) {
      order = searchResult.items[0];
    } else {
      // Try by entity_id
      order = await magentoGet(`/orders/${cleanId}`);
    }

    // Extract safe info (no sensitive data)
    const shipments = order.extension_attributes?.shipping_assignments || [];
    const tracking = [];

    // Try to get shipment tracking
    if (order.entity_id) {
      try {
        const shipmentsData = await magentoGet(
          `/shipments?searchCriteria[filter_groups][0][filters][0][field]=order_id&searchCriteria[filter_groups][0][filters][0][value]=${order.entity_id}`
        );
        if (shipmentsData.items) {
          shipmentsData.items.forEach(shipment => {
            if (shipment.tracks) {
              shipment.tracks.forEach(track => {
                tracking.push({
                  carrier: track.carrier_code || track.title || 'Blue Dart',
                  tracking_number: track.track_number,
                  title: track.title
                });
              });
            }
          });
        }
      } catch (e) {
        console.log('Could not fetch shipment tracking:', e.message);
      }
    }

    return {
      order_id: order.increment_id,
      status: order.status,
      state: order.state,
      created_at: order.created_at,
      updated_at: order.updated_at,
      total_items: order.total_item_count,
      tracking: tracking,
      status_label: getStatusLabel(order.status)
    };
  } catch (error) {
    return {
      error: true,
      message: `Could not find order with ID: ${orderId}. Please verify your order number and try again.`
    };
  }
}

function getStatusLabel(status) {
  const labels = {
    'pending': 'Order Received - Awaiting Processing',
    'pending_payment': 'Awaiting Payment Confirmation',
    'processing': 'Order is Being Processed',
    'complete': 'Order Delivered Successfully',
    'shipped': 'Order Has Been Shipped',
    'canceled': 'Order Has Been Cancelled',
    'closed': 'Order Closed',
    'holded': 'Order On Hold',
    'payment_review': 'Payment Under Review'
  };
  return labels[status] || status;
}

async function getProductsByCategory(categoryId, pageSize = 10) {
  try {
    const endpoint = `/products?searchCriteria[filter_groups][0][filters][0][field]=category_id&searchCriteria[filter_groups][0][filters][0][value]=${categoryId}&searchCriteria[filter_groups][1][filters][0][field]=status&searchCriteria[filter_groups][1][filters][0][value]=1&searchCriteria[filter_groups][2][filters][0][field]=visibility&searchCriteria[filter_groups][2][filters][0][value]=4&searchCriteria[pageSize]=${Math.min(pageSize, 20)}&searchCriteria[sortOrders][0][field]=created_at&searchCriteria[sortOrders][0][direction]=DESC`;

    const result = await magentoGet(endpoint);

    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: "No in-stock products found in this category." };
    }

    const products = result.items.map(item => {
      const customAttrs = {};
      if (item.custom_attributes) {
        item.custom_attributes.forEach(attr => {
          customAttrs[attr.attribute_code] = attr.value;
        });
      }

      // Get stock info
      const stockItem = item.extension_attributes?.stock_item;
      const inStock = stockItem ? stockItem.is_in_stock : true;
      const qty = stockItem ? stockItem.qty : null;

      return {
        name: item.name,
        sku: item.sku,
        price: item.price,
        special_price: customAttrs.special_price || null,
        url: `${MAGENTO_STORE_URL}/${customAttrs.url_key || item.sku}.html`,
        in_stock: inStock,
        qty: qty,
        short_description: customAttrs.short_description ? customAttrs.short_description.replace(/<[^>]*>/g, '').substring(0, 200) : null,
        brand: customAttrs.brand || null,
      };
    }).filter(p => p.in_stock && p.qty > 1);

    return {
      products: products,
      total: result.total_count,
      showing: products.length
    };
  } catch (error) {
    return { error: true, message: "Unable to fetch products at this time. Please try again." };
  }
}

async function searchProducts(query, pageSize = 10) {
  try {
    const endpoint = `/products?searchCriteria[filter_groups][0][filters][0][field]=name&searchCriteria[filter_groups][0][filters][0][value]=%25${encodeURIComponent(query)}%25&searchCriteria[filter_groups][0][filters][0][condition_type]=like&searchCriteria[filter_groups][1][filters][0][field]=status&searchCriteria[filter_groups][1][filters][0][value]=1&searchCriteria[pageSize]=${Math.min(pageSize, 20)}&searchCriteria[sortOrders][0][field]=name&searchCriteria[sortOrders][0][direction]=ASC`;

    const result = await magentoGet(endpoint);

    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No products found matching "${query}".` };
    }

    const products = result.items.map(item => {
      const customAttrs = {};
      if (item.custom_attributes) {
        item.custom_attributes.forEach(attr => {
          customAttrs[attr.attribute_code] = attr.value;
        });
      }

      const stockItem = item.extension_attributes?.stock_item;
      const inStock = stockItem ? stockItem.is_in_stock : true;
      const qty = stockItem ? stockItem.qty : null;

      return {
        name: item.name,
        sku: item.sku,
        price: item.price,
        special_price: customAttrs.special_price || null,
        url: `${MAGENTO_STORE_URL}/${customAttrs.url_key || item.sku}.html`,
        in_stock: inStock,
        qty: qty,
        short_description: customAttrs.short_description ? customAttrs.short_description.replace(/<[^>]*>/g, '').substring(0, 200) : null,
        brand: customAttrs.brand || null,
      };
    }).filter(p => p.in_stock && p.qty > 1);

    return {
      products: products,
      total: result.total_count,
      showing: products.length,
      query: query
    };
  } catch (error) {
    return { error: true, message: `Unable to search products at this time. Please try again.` };
  }
}

// ==================== EXECUTE FUNCTION CALLS ====================
async function executeFunction(name, args) {
  switch (name) {
    case 'get_order_status':
      return await getOrderStatus(args.order_id);
    case 'get_products_by_category':
      return await getProductsByCategory(args.category_id, args.page_size);
    case 'search_products':
      return await searchProducts(args.query, args.page_size);
    default:
      return { error: true, message: `Unknown function: ${name}` };
  }
}

// ==================== CHAT API ENDPOINT ====================
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Build messages with system prompt
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ];

    // Call OpenRouter
    let response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: OPENROUTER_MODEL,
      messages: apiMessages,
      tools: FUNCTION_DEFINITIONS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 1500
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': MAGENTO_STORE_URL,
        'X-Title': 'TO Assistant - TennisOutlet.in'
      },
      timeout: 30000
    });

    let assistantMessage = response.data.choices[0].message;

    // Handle function calls (loop for multiple calls)
    let iterations = 0;
    while (assistantMessage.tool_calls && iterations < 3) {
      iterations++;
      const toolResults = [];

      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        const funcArgs = JSON.parse(toolCall.function.arguments);

        console.log(`[Function Call] ${funcName}(${JSON.stringify(funcArgs)})`);

        const result = await executeFunction(funcName, funcArgs);

        console.log(`[Function Result] ${funcName}: ${JSON.stringify(result).substring(0, 200)}...`);

        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }

      // Send function results back to AI
      const followUpMessages = [
        ...apiMessages,
        assistantMessage,
        ...toolResults
      ];

      response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
        model: OPENROUTER_MODEL,
        messages: followUpMessages,
        tools: FUNCTION_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 1500
      }, {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': MAGENTO_STORE_URL,
          'X-Title': 'TO Assistant - TennisOutlet.in'
        },
        timeout: 30000
      });

      assistantMessage = response.data.choices[0].message;
    }

    res.json({
      message: assistantMessage.content,
      usage: response.data.usage
    });

  } catch (error) {
    console.error('Chat API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', async (req, res) => {
  let magentoStatus = 'unknown';
  try {
    await magentoGet('/store/storeConfigs');
    magentoStatus = 'connected';
  } catch {
    magentoStatus = 'disconnected';
  }

  res.json({
    status: 'running',
    magento: magentoStatus,
    model: OPENROUTER_MODEL,
    timestamp: new Date().toISOString()
  });
});

// Serve chat UI for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`\n🎾 TO Assistant is running!`);
  console.log(`📍 Open: http://localhost:${PORT}`);
  console.log(`🤖 Model: ${OPENROUTER_MODEL}`);
  console.log(`🔗 Magento: ${MAGENTO_BASE_URL}\n`);
});

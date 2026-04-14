// Multi-agent orchestration for TO Assistant.
// Pattern: RouterAgent classifies intent -> dispatches to specialist -> MasterAgent composes final reply.
// Each specialist sees only its own tools for tight routing.

const axios = require('axios');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
const OPENROUTER_ROUTER_MODEL = process.env.OPENROUTER_ROUTER_MODEL || 'openai/gpt-4o-mini';
const STORE_URL = process.env.MAGENTO_STORE_URL || 'https://tennisoutlet.in';

async function callLLM({ model, messages, tools, tool_choice = 'auto', temperature = 0.7, max_tokens = 1600, response_format = null }) {
  const body = { model, messages, temperature, max_tokens };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }
  if (response_format) body.response_format = response_format;
  const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', body, {
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': STORE_URL,
      'X-Title': 'TO Assistant (multi-agent)'
    },
    timeout: 45000
  });
  return res.data;
}

// ==================== AGENT 1: ROUTER ====================
const ROUTER_PROMPT = `You classify a customer message into exactly one intent bucket. Respond with ONLY a JSON object {"intent":"...","sport":"tennis|padel|pickleball","confidence":0.0-1.0}.

Intents:
- "order"        -> order status, tracking, delivery question, order ID mentioned
- "racquet"      -> racquet/racket/paddle recommendations or browsing
- "shoe"         -> shoes / footwear
- "brand"        -> which brands do you carry, brand list
- "catalog"      -> balls, strings, bags, accessories, sale items, anything else from the shop
- "policy"       -> returns, refunds, shipping, payment, store hours, warranty, contact info
- "greeting"     -> pure greeting ("hi", "hello", "hey", "good morning") with no question attached
- "other"        -> out of scope (weather, news, math, coding, jokes, anything unrelated to tennis/padel/pickleball shop)

Default sport = "tennis" unless pickleball/padel is clearly mentioned.`;

async function routeIntent(userText) {
  try {
    const data = await callLLM({
      model: OPENROUTER_ROUTER_MODEL,
      messages: [
        { role: 'system', content: ROUTER_PROMPT },
        { role: 'user', content: userText }
      ],
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(data.choices[0].message.content);
    return { intent: parsed.intent || 'other', sport: parsed.sport || 'tennis', confidence: parsed.confidence || 0 };
  } catch (e) {
    console.error('[router] failed:', e.message);
    return { intent: 'other', sport: 'tennis', confidence: 0 };
  }
}

// ==================== SPECIALIST SYSTEM PROMPTS ====================
const COMMON_RULES = `Brand voice: warm, professional, empathetic, short sentences, sparing emojis (\u{1F3BE} \u2705).
Present products in this exact markdown (one blank line between items):

1. **[Product Name](https://tennisoutlet.in/product-url.html)**
   Price: \u20B9X,XXX
   Why it's great: <one line>

Show 4-5 products minimum when catalog has them. Never show quantity/stock numbers. Never use markdown images. Use product_url exactly as returned by tools. Store origin: ${STORE_URL}.
PRICE RULE: If a product's price is null, 0, or missing, OMIT the "Price:" line entirely — never write "Unavailable", "N/A", "TBD", or any placeholder. If price_max is present and greater than price, render "Price: \u20B9X,XXX - \u20B9Y,YYY".
End with: "Is there anything else I can assist you with?"`;

const AGENT_PROMPTS = {
  order: `You are OrderAgent for TennisOutlet.in. You ONLY handle order status queries.
- Extract the order ID from the user's message and call get_order_status.
- Share ONLY: status, tracking (if any), delivery timeline, status history summary.
- NEVER reveal: amount, address, items, payment info.
- If tracking has AWB, ALWAYS include https://bluedart.com/?{AWB}.
- Orders dispatch within 8 hours. Blue Dart 2-5 business days.
- If order not found, politely ask the customer to verify and suggest contacting +91 9502517700.
${COMMON_RULES}`,

  racquet: `You are RacquetAgent for TennisOutlet.in. You ONLY recommend racquets/rackets/paddles.
- You MUST call get_racquets_with_specs for every query. Pass sport (tennis/padel/pickleball), brand if mentioned, skill_level if mentioned.
- After listing 4-5 products, add a one-line comparative insight (beginner vs intermediate, power vs control).
- Grip size is selected on the product page - mention this if the user asks about size.
${COMMON_RULES}`,

  shoe: `You are ShoeAgent for TennisOutlet.in. You ONLY recommend shoes.
- You MUST call get_shoes_with_specs. Pass sport, brand, shoe_type (Men's/Women's/Kid's), court_type, width, cushioning when mentioned.
- Include relevant resolved specs in the product lines when helpful (court type, cushioning, available sizes).
- NEVER say "we don't have size X". Instead show 4-5 products and add: "All sizes (including the size you mentioned) can be selected on each product page. If a specific size is sold out, it will be marked on that page."
- We do NOT carry New Balance - recommend alternatives.
${COMMON_RULES}`,

  brand: `You are BrandAgent for TennisOutlet.in.
- Call list_brands once, then present the answer grouped (Tennis brands, Padel brands, Pickleball brands) if the user asked for a specific sport, otherwise show the full list in a clean comma-separated sentence.
- Keep it short. End with an offer to help pick a product.
${COMMON_RULES}`,

  catalog: `You are CatalogAgent for TennisOutlet.in. You handle balls, strings, bags, accessories, sale items, or any non-racquet non-shoe product.
- Prefer search_products for free-text queries.
- Use get_products_by_category with these IDs: Tennis Balls=31, Pickleball Balls=252, Padel Balls=273, Strings=29, Bags=115, Accessories=37, Used Racquets=90, Wimbledon Sale=292, Grand Slam=349, Boxing Day=437.
- Show 4-5 products minimum.
${COMMON_RULES}`,

  policy: `You are PolicyAgent for TennisOutlet.in. You answer policy / support questions from the following knowledge (no tools available to you).

Store: Survey No. 47/A, near Sreenidhi International School, Aziznagar, Hyderabad, Telangana 500075. Mon-Sat 10:30-18:00. Phone +91 9502517700 (not on WhatsApp).
Returns: 30-day, unused, tags intact. https://tennisoutlet.in/return-cancellation-policy
Play & Return: https://tennisoutlet.in/play-return-program
Refunds: 48 hrs processing; bank credit up to 5 business days; TO Wallet instant.
Shipping: dispatched within 8 hrs, Blue Dart 2-5 business days.
Payment: Cards, Net Banking, UPI, EMI (coming within a week), COD.
Warranty: https://tennisoutlet.in/warranty-promise
Buying Guide: https://tennisoutlet.in/buying-guide
Pre-strung tension: 55-56.
WELCOME10 coupon: 10% off up to \u20B9300 for first-time buyers.

Answer directly; no tool calls. Keep under 8 lines. End with "Is there anything else I can assist you with?"`,

  greeting: `You are the TO Assistant greeter. The user said hello or similar. Reply with the appropriate brand greeting (tennis: "Welcome to TennisOutlet! \u{1F3BE} How may I help you today?", pickleball/padel use the matching brand line). Offer categories briefly (racquets, shoes, balls, order tracking). Keep to 2-3 lines.`,

  other: `You are the TO Assistant fallback handler. The request is out of scope (not tennis/padel/pickleball, not orders, not policy). Politely redirect: explain we're India's store for tennis/pickleball/padel gear and ask how we can help with those. Do not discuss competitors or off-topic subjects. 2-3 lines. End with "Is there anything else I can assist you with?"`
};

// ==================== SPECIALIST TOOL BINDINGS ====================
// Given full FUNCTION_DEFINITIONS from server.js, each agent sees only a subset.
function specialistTools(allTools, intent) {
  const pick = names => allTools.filter(t => names.includes(t.function.name));
  switch (intent) {
    case 'order':   return pick(['get_order_status']);
    case 'racquet': return pick(['get_racquets_with_specs']);
    case 'shoe':    return pick(['get_shoes_with_specs']);
    case 'brand':   return pick(['list_brands']);
    case 'catalog': return pick(['search_products', 'get_products_by_category']);
    default:        return [];
  }
}

// ==================== RUN A SPECIALIST ====================
async function runSpecialist({ intent, sport, userMessages, allTools, executeFunction }) {
  const system = AGENT_PROMPTS[intent] || AGENT_PROMPTS.other;
  const tools = specialistTools(allTools, intent);
  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: `Detected sport: ${sport}. Use this as the default if the user didn't specify otherwise.` },
    ...userMessages
  ];

  let data = await callLLM({ model: OPENROUTER_MODEL, messages, tools, tool_choice: tools.length ? 'auto' : 'none' });
  let msg = data.choices[0].message;
  let iters = 0;
  const convo = [...messages];

  while (msg.tool_calls && msg.tool_calls.length && iters < 3) {
    iters++;
    convo.push(msg);
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      console.log(`[${intent}] ${tc.function.name}(${JSON.stringify(args)})`);
      const result = await executeFunction(tc.function.name, args);
      convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
    data = await callLLM({ model: OPENROUTER_MODEL, messages: convo, tools, tool_choice: 'auto' });
    msg = data.choices[0].message;
  }
  return { content: msg.content, intent, iterations: iters, usage: data.usage };
}

// ==================== SAFETY VALIDATORS ====================
// Defense-in-depth: catch the racquet-as-balls bug class regardless of prompt.
function validateResponse(intent, content) {
  if (!content) return { ok: false, reason: 'empty_response' };
  const c = content.toLowerCase();
  if (intent === 'racquet') {
    // Product names in racquet responses must not contain "ball" or "string" etc.
    // We check markdown links: [Name](url). If any link text includes a banned token, fail.
    const linkTexts = [...content.matchAll(/\[([^\]]+)\]\(/g)].map(m => m[1].toLowerCase());
    const banned = ['ball', 'string', 'grip tape', 'bag', 'shoe', 'sock'];
    const bad = linkTexts.find(t => banned.some(b => t.includes(b)));
    if (bad) return { ok: false, reason: `racquet_response_contains_non_racquet: "${bad}"` };
  }
  if (intent === 'shoe') {
    const linkTexts = [...content.matchAll(/\[([^\]]+)\]\(/g)].map(m => m[1].toLowerCase());
    const banned = ['ball', 'racquet', 'racket', 'paddle', 'string ', 'grip'];
    const bad = linkTexts.find(t => banned.some(b => t.includes(b)));
    if (bad) return { ok: false, reason: `shoe_response_contains_non_shoe: "${bad}"` };
  }
  return { ok: true };
}

// ==================== MASTER ORCHESTRATOR ====================
async function masterHandle({ userMessages, allTools, executeFunction }) {
  const lastUser = [...userMessages].reverse().find(m => m.role === 'user')?.content || '';
  const route = await routeIntent(lastUser);
  console.log(`[router] intent=${route.intent} sport=${route.sport} conf=${route.confidence}`);
  let specialist = await runSpecialist({
    intent: route.intent, sport: route.sport,
    userMessages, allTools, executeFunction
  });
  let validation = validateResponse(route.intent, specialist.content);
  let retried = false;
  if (!validation.ok) {
    console.warn(`[validator] ${validation.reason} — retrying with stricter instruction`);
    retried = true;
    const stricter = [
      ...userMessages,
      { role: 'system', content: `PREVIOUS RESPONSE WAS REJECTED: ${validation.reason}. You MUST call the correct tool for this intent (${route.intent}) and ONLY list products of that type. Do not include balls, strings, accessories, or other categories.` }
    ];
    specialist = await runSpecialist({
      intent: route.intent, sport: route.sport,
      userMessages: stricter, allTools, executeFunction
    });
    validation = validateResponse(route.intent, specialist.content);
    if (!validation.ok) {
      console.error(`[validator] retry also failed: ${validation.reason}`);
      specialist.content = "I couldn't find the right products for that query — could you rephrase, or would you like me to connect you to +91 9502517700?";
    }
  }
  return {
    message: specialist.content,
    agent_trace: {
      router: route,
      specialist: { intent: specialist.intent, iterations: specialist.iterations },
      validation: validation.ok ? 'passed' : validation.reason,
      retried
    },
    usage: specialist.usage
  };
}

module.exports = { masterHandle, routeIntent };

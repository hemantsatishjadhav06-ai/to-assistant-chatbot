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
- "catalog"      -> balls, strings, bags, accessories, ball machines/throwers/cannons, sale items, anything else from the shop
- "review"       -> reviews, ratings, customer feedback, star reviews on a specific product
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
- PRICE FILTERS: parse any price cap/floor in the user's message into numbers and pass them.
  - "under 5K" / "below 5k" / "less than 5000" / "upto 5k" / "<5k" -> max_price: 5000
  - "5K" = 5000. "1L" or "1 lakh" = 100000.
  - "above 3k" / "over 3000" -> min_price: 3000
  - Ranges like "5-10k" -> min_price: 5000, max_price: 10000
- After listing 4-5 products, add a one-line comparative insight (beginner vs intermediate, power vs control).
- Grip size is selected on the product page - mention this if the user asks about size.
- ZERO-RESULTS HANDLING: if the tool returns products: [] with a message, DO NOT invent products and DO NOT silently drop the filter. Say honestly: "I don't have {sport} racquets in that price range. Our most affordable {sport} racquets start around \u20B9X,XXX — want me to show those?" You may re-call once without the price filter to quote the actual entry-level price.
${COMMON_RULES}`,

  shoe: `You are ShoeAgent for TennisOutlet.in. You ONLY recommend shoes.
- You MUST call get_shoes_with_specs. Pass sport, brand, shoe_type (Men's/Women's/Kid's), court_type, width, cushioning when mentioned.
- SIZE FILTER: if the user mentions a shoe size (e.g. "size 10", "UK 9", "9.5") pass it as size: "10". The tool only returns products whose requested-size child SKU is in stock.
- PRICE FILTERS: parse the user's price cap/floor into numbers and pass them.
  - "under 5K" / "below 5000" / "less than 5k" / "upto 5k" / "<5k" -> max_price: 5000
  - "5K" = 5000. "1L" = 100000.
  - "above 3k" / "over 3000" -> min_price: 3000
  - Ranges like "5-10k" -> min_price: 5000, max_price: 10000
- Include relevant resolved specs in the product lines when helpful (court type, cushioning, available sizes).
- ZERO-RESULTS HANDLING (critical): if products: [] with a message, DO NOT fall back to listing unfiltered shoes. Be honest: "I don't currently have {sport} shoes matching {size/price}. Our closest options start around \u20B9X,XXX — would you like to see those?" You may make one follow-up call without the failing filter to find that entry price.
- When the tool DOES return products, every item already passed the size/price filter — list as-is. Do NOT add the "sizes can be selected on the product page" disclaimer, because the tool already verified the requested size is in stock.
- We do NOT carry New Balance - recommend alternatives.
${COMMON_RULES}`,

  brand: `You are BrandAgent for TennisOutlet.in.
- Call list_brands once, then present the answer grouped (Tennis brands, Padel brands, Pickleball brands) if the user asked for a specific sport, otherwise show the full list in a clean comma-separated sentence.
- Keep it short. End with an offer to help pick a product.
${COMMON_RULES}`,

  catalog: `You are CatalogAgent for TennisOutlet.in. You handle balls, strings, bags, accessories, sale items, ball machines/throwers, or any non-racquet non-shoe product.
- Prefer search_products for free-text queries (ball machines, ball throwers, cannons, feeders, launchers — search for the keywords).
- Ball machines / throwers exist at https://tennisoutlet.in/other/ball-machine.html — if search returns zero matches, try simpler keywords ("machine", "thrower") or fall back to telling the user we have ball machines on the "other" page.
- Use get_products_by_category with these IDs: Tennis Balls=31, Pickleball Balls=252, Padel Balls=273, Strings=29, Bags=115, Accessories=37, Used Racquets=90, Wimbledon Sale=292, Grand Slam=349, Boxing Day=437.
- PRICE FILTERS: parse price caps/floors into numbers and pass min_price / max_price.
  - "under 500" -> max_price: 500. "below 2K" -> max_price: 2000. "1L" = 100000.
  - "above 1k" / "over 1000" -> min_price: 1000
  - Ranges like "500-2000" -> min_price: 500, max_price: 2000
- Show 4-5 products minimum when available.
- ZERO-RESULTS HANDLING: if products: [] with a message, do not invent items. Tell the user nothing matched and offer to show the closest options without the filter.
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

  review: `You are ReviewAgent for TennisOutlet.in. The user is asking about reviews/ratings/feedback for a specific product.
- STEP 1: Call search_products with the product name or key tokens ("TENNIIX Cliq", "ball machine", brand+model). Keep pageSize=5.
- STEP 2a: If the search returns matching products, present the matches using the standard markdown format and append this line verbatim after the list: "Customer reviews for each product are on the product page — click the product link above and scroll to the 'Customer Reviews' section."
- STEP 2b: If search returns zero products, be honest: "I couldn't locate that exact product in our catalog. Could you confirm the full name, or share a product URL if you have one?"
- Never fabricate star ratings, quote counts, or review text. We surface the product page, not scraped reviews.
${COMMON_RULES}`,

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
    case 'review':  return pick(['search_products']);
    default:        return [];
  }
}

// ==================== RUN A SPECIALIST ====================
async function runSpecialist({ intent, sport, userMessages, allTools, executeFunction, enforcedFilters = '', sessionHint = '' }) {
  const system = AGENT_PROMPTS[intent] || AGENT_PROMPTS.other;
  const tools = specialistTools(allTools, intent);
  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: `Detected sport: ${sport}. Use this as the default if the user didn't specify otherwise.` }
  ];
  if (enforcedFilters) {
    messages.push({
      role: 'system',
      content: `[ENFORCED FILTERS] The deterministic parser has extracted the following filters from the user's message. You MUST pass them verbatim to your tool call (do not re-parse, do not drop any): ${enforcedFilters}. If the tool returns zero products with these filters, DO NOT silently remove a filter — respond honestly and ask the user if they want to widen the search.`
    });
  }
  if (sessionHint) {
    messages.push({
      role: 'system',
      content: `[SESSION CONTEXT] ${sessionHint}. If the current user message is a short follow-up (e.g. just a size, just a price cap, just a brand), combine it with the filters above to continue the previous search rather than starting over.`
    });
  }
  messages.push(...userMessages);

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
// Parse a price cap from the user's message. Returns { min, max } in INR or nulls.
function extractPriceBounds(userText) {
  const out = { min: null, max: null };
  if (!userText) return out;
  const s = String(userText).toLowerCase();
  const unit = u => (u === 'k' ? 1000 : (u === 'l' || u === 'lakh' || u === 'lakhs') ? 100000 : 1);
  // Range: "5-10k", "5k-10k", "₹5000 - 10000"
  const range = s.match(/\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?\s*[-\u2013to]+\s*\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?/);
  if (range) {
    const lo = parseFloat(range[1].replace(/,/g, '')) * unit(range[2]);
    const hi = parseFloat(range[3].replace(/,/g, '')) * unit(range[4] || range[2]);
    if (isFinite(lo) && isFinite(hi) && lo >= 0 && hi > lo) { out.min = lo; out.max = hi; return out; }
  }
  const maxM = s.match(/(?:under|below|less than|upto|up to|<|within|max(?:imum)?)\s*\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?/);
  if (maxM) {
    const n = parseFloat(maxM[1].replace(/,/g, '')) * unit(maxM[2]);
    if (isFinite(n)) out.max = n;
  }
  const minM = s.match(/(?:above|over|more than|>|atleast|at least|min(?:imum)?)\s*\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?/);
  if (minM) {
    const n = parseFloat(minM[1].replace(/,/g, '')) * unit(minM[2]);
    if (isFinite(n)) out.min = n;
  }
  return out;
}

// Pull every rupee amount (or range) out of the response body.
function extractResponsePrices(content) {
  const prices = [];
  const re = /\u20B9\s*([\d,]+(?:\.\d+)?)(?:\s*-\s*\u20B9?\s*([\d,]+(?:\.\d+)?))?/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const lo = parseFloat(m[1].replace(/,/g, ''));
    const hi = m[2] ? parseFloat(m[2].replace(/,/g, '')) : lo;
    if (isFinite(lo)) prices.push({ lo, hi });
  }
  return prices;
}

// Defense-in-depth: catch wrong-category links, placeholder prices, and cap violations.
function validateResponse(intent, content, userText = '') {
  if (!content) return { ok: false, reason: 'empty_response' };
  if (intent === 'racquet') {
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
  // Placeholder price leak (bug class we fixed in v3.2.2; keep a guard).
  if (['shoe', 'racquet', 'catalog'].includes(intent) && /\u20B9\s*[xX],?[xX]{3}/.test(content)) {
    return { ok: false, reason: 'price_placeholder_leak' };
  }
  // Price-cap violation: if user said "under N", no listed rupee amount may exceed N.
  if (['shoe', 'racquet', 'catalog'].includes(intent)) {
    const { min, max } = extractPriceBounds(userText);
    if (max != null) {
      const over = extractResponsePrices(content).find(p => p.lo > max);
      if (over) return { ok: false, reason: `price_cap_violation_user_asked_under_${max}_response_has_${over.lo}` };
    }
    if (min != null) {
      const under = extractResponsePrices(content).find(p => (p.hi || p.lo) < min);
      if (under) return { ok: false, reason: `price_floor_violation_user_asked_over_${min}_response_has_${under.hi || under.lo}` };
    }
  }
  return { ok: true };
}

// ==================== MASTER ORCHESTRATOR ====================
async function masterHandle({ userMessages, allTools, executeFunction, slots = null, sessionHint = '' }) {
  const lastUser = [...userMessages].reverse().find(m => m.role === 'user')?.content || '';
  // If slots include an intent_hint from the deterministic parser, prefer it
  // over the LLM router (router is fine, but regex is free and always right
  // on unambiguous cases like "shoe size 11 under 6K").
  let route;
  if (slots && slots.intent_hint) {
    route = { intent: slots.intent_hint, sport: slots.sport || 'tennis', confidence: 0.99, source: 'deterministic' };
  } else {
    route = await routeIntent(lastUser);
    route.source = 'llm_router';
  }
  console.log(`[router] intent=${route.intent} sport=${route.sport} conf=${route.confidence} source=${route.source}`);
  const enforcedFilters = (slots && typeof slots._rendered === 'string') ? slots._rendered : '';
  let specialist = await runSpecialist({
    intent: route.intent, sport: route.sport,
    userMessages, allTools, executeFunction,
    enforcedFilters, sessionHint
  });
  let validation = validateResponse(route.intent, specialist.content, lastUser);
  let retried = false;
  if (!validation.ok) {
    console.warn(`[validator] ${validation.reason} — retrying with stricter instruction`);
    retried = true;
    const stricter = [
      ...userMessages,
      { role: 'system', content: `PREVIOUS RESPONSE WAS REJECTED: ${validation.reason}. Re-call the correct tool for intent=${route.intent}. If the user specified a size or price cap/floor, you MUST pass it (size, max_price, min_price). Only list products actually returned by the tool. If the tool returns products: [], do NOT fabricate items — tell the user honestly and offer to show the closest alternatives.` }
    ];
    specialist = await runSpecialist({
      intent: route.intent, sport: route.sport,
      userMessages: stricter, allTools, executeFunction,
      enforcedFilters, sessionHint
    });
    validation = validateResponse(route.intent, specialist.content, lastUser);
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

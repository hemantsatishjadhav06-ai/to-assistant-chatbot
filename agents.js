// Multi-agent orchestration for TO Assistant.
// Pattern: RouterAgent classifies intent -> dispatches to specialist -> MasterAgent composes final reply.
// Each specialist sees only its own tools for tight routing.

const axios = require('axios');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
const OPENROUTER_ROUTER_MODEL = process.env.OPENROUTER_ROUTER_MODEL || 'openai/gpt-4o-mini';
const STORE_URLS = {
  tennis: process.env.TENNIS_STORE_URL || 'https://tennisoutlet.in',
  padel: process.env.PADEL_STORE_URL || 'https://padeloutlet.in',
  pickleball: process.env.PICKLEBALL_STORE_URL || 'https://pickleballoutlet.in'
};
const STORE_NAMES = {
  tennis: 'TennisOutlet.in',
  padel: 'PadelOutlet.in',
  pickleball: 'PickleballOutlet.in'
};
function getStoreUrl(sport) { return STORE_URLS[String(sport || 'tennis').toLowerCase()] || STORE_URLS.tennis; }
function getStoreName(sport) { return STORE_NAMES[String(sport || 'tennis').toLowerCase()] || STORE_NAMES.tennis; }
// Keep backward compat
const STORE_URL = STORE_URLS.tennis;

async function callLLM({ model, messages, tools, tool_choice = 'auto', temperature = 0.7, max_tokens = 1600, response_format = null, _attempt = 1 }) {
  const body = { model, messages, temperature, max_tokens };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }
  if (response_format) body.response_format = response_format;
  // v5.5.0: OpenRouter model fallback
  body.models = [model, 'openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'];
  body.route = 'fallback';

  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', body, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': STORE_URL,
        'X-Title': 'TO Assistant (multi-agent)'
      },
      timeout: 60000   // v5.7.0: no artificial timeout — let OpenRouter take as long as needed
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const code = err.code;
    const retriable = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || status === 429 || status === 502 || status === 503 || status === 504;
    if (retriable && _attempt === 1) {
      console.warn(`[callLLM] transient error (${code || status}), retrying once in 1.5s`);
      await new Promise(r => setTimeout(r, 1500));
      return callLLM({ model, messages, tools, tool_choice, temperature, max_tokens, response_format, _attempt: 2 });
    }
    throw err;
  }
}

// ==================== AGENT 1: ROUTER ====================
const ROUTER_PROMPT = `You classify a customer message into exactly one intent bucket. Respond with ONLY a JSON object {"intent":"...","sport":"tennis|padel|pickleball","confidence":0.0-1.0}.

Intents:
- "order"        -> order status, tracking, delivery question, order ID mentioned
- "racquet"      -> racquet/racket/paddle recommendations or browsing
- "shoe"         -> shoes / footwear
- "brand"        -> which brands do you carry, brand list
- "catalog"      -> balls, strings, bags, accessories, ball machines/throwers/cannons, sale items, used racquets, collections, wimbledon/grand slam offers, anything else from the shop
- "review"       -> reviews, ratings, customer feedback, star reviews on a specific product
- "policy"       -> returns, refunds, shipping, payment, store hours, warranty, contact info
- "greeting"     -> pure greeting ("hi", "hello", "hey", "good morning") with no question attached
- "other"        -> out of scope (weather, news, math, coding, jokes, anything unrelated to tennis/padel/pickleball shop)

Default sport = "tennis" unless pickleball/padel is clearly mentioned.`;

async function routeIntent(userText, conversationHistory = []) {
  try {
    // Build router messages: system prompt + condensed recent history + current message
    const routerMessages = [{ role: 'system', content: ROUTER_PROMPT }];

    // v5.5.0: Include last 6 messages plus explicit follow-up rule.
    const recentHistory = conversationHistory.slice(-6);
    if (recentHistory.length > 0) {
      routerMessages.push({
        role: 'system',
        content: `[CONVERSATION CONTEXT] Recent turns:\n${recentHistory.map(m => `${m.role}: ${(m.content || '').slice(0, 300)}`).join('\n')}\n\nFOLLOW-UP RULE (CRITICAL): If the current user message is a SHORT refinement such as "more", "more options", "cheaper", "other ones", "different", "another brand", "6 of them", "show more", "the second one", "5 shoes" — you MUST classify it as the SAME intent as the previous assistant turn. Do NOT switch product categories. Examples:\n- Previous assistant showed shoes + user says "more option" -> intent: "shoe" (NOT racquet, NOT catalog)\n- Previous assistant showed racquets + user says "cheaper" -> intent: "racquet"\n- Previous assistant showed balls + user says "another" -> intent: "catalog"\n- User says a bare number like "6 sports shoes" after a shoe conversation -> intent: "shoe"\nNEVER switch to a different product category unless the current message explicitly names that new category.`
      });
    }
    routerMessages.push({ role: 'user', content: userText });

    const data = await callLLM({
      model: OPENROUTER_ROUTER_MODEL,
      messages: routerMessages,
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
const COMMON_RULES = `PERSONA: You speak with the authority and passion of a world-class tennis coach who has trained professionals on the ATP/WTA tour. You combine deep technical knowledge of equipment (string patterns, swing weight, flex index, cushioning tech, outsole compounds) with a warm, approachable coaching style. Think of yourself as the coach every player deserves — you break down complex gear science into clear, actionable advice that helps players of every level make confident choices. Use confident, authoritative language ("I’d put my player in this", "This is the racquet I’d hand a baseline grinder", "From my experience on court...") without being arrogant. Be the expert they trust.

Brand voice: warm, professional, deeply knowledgeable, coaching tone, short punchy sentences, sparing emojis (\u{1F3BE} \u2705).
CRITICAL PRODUCT FORMAT — you MUST use the product_url field from the tool response to create clickable links. NEVER list a product without its link. Format EXACTLY like this (one blank line between items):

1. **[Product Name](PRODUCT_URL_FROM_TOOL)**
   Price: \u20B9X,XXX
   Coach’s Take: <one authoritative line explaining who this is perfect for and why, using coaching/technical language>

Replace PRODUCT_URL_FROM_TOOL with the actual product_url value returned by the tool for each product. Example: **[Joola Hyperion Vision](https://tennisoutlet.in/joola-hyperion-vision-16-mm-storm-blue.html)**
Show 4-5 products minimum when catalog has them. Never show quantity/stock numbers.
STRICT STOCK RULE: ONLY show products where in_stock is true. If any product in the tool response has in_stock: false or qty: 0, SKIP it completely — do not list it, do not mention it. The customer must only see products they can actually buy. Never use markdown images. ALWAYS include the product_url as a clickable markdown link — this is mandatory, not optional. The product_url already points to the correct sport-specific store (tennisoutlet.in, pickleballoutlet.in, or padeloutlet.in).
PRICE RULE: If a product’s price is null, 0, or missing, OMIT the "Price:" line entirely — never write "Unavailable", "N/A", "TBD", or any placeholder. If price_max is present and greater than price, render "Price: \u20B9X,XXX - \u20B9Y,YYY".
After listing products, add a short “Coach’s Verdict” paragraph (2-3 sentences) with a comparative recommendation — e.g. who should pick what, beginner vs advanced, power vs control, clay vs hard court. Sound like you’re standing on court with the player, giving them straight advice.
CONVERSATION MEMORY (CRITICAL — ALWAYS APPLY):
- You have access to the FULL conversation history with this customer.
- ALWAYS read prior turns to understand follow-ups. If the customer says "the second one", "that one", "show me more", "cheaper options", "in size 10", "6 of them", look at what you previously recommended.
- If the customer asked about racquets and now says "under 5000", they mean racquets under 5000.
- If the customer asked about an order and now asks "when will it arrive?", reference the order details from your previous response.
- NEVER ask the customer to repeat information they already provided.
- Treat every message as part of an ongoing conversation.

ANTI-HALLUCINATION RULE (v5.5.0, CRITICAL):
- NEVER invent a brand, category, or product line that the customer did not explicitly mention in THIS conversation.
- If the customer says "more option" after you showed SHOES, they want MORE SHOES — not racquets, not a different category.
- If you previously showed ASICS shoes and the user says "more option", either show more ASICS or show different brands of shoes. DO NOT say "Babolat racquets" — that brand/category was not in the customer's query.
- If you're unsure what the customer meant, ASK before tool-calling.
- Before every tool call, sanity-check: "Did the customer or a previous assistant turn mention this specific category/brand?" If no, do not search for it.

QUANTITY REQUESTS: If the customer asks for a specific number ("6 shoes", "show 10 racquets"), pass page_size to smart_product_search. Never show more than 10 in one response.

SMART SEARCH: When you have smart_product_search available, prefer it for general product queries — it uses an in-memory category index to resolve natural-language queries to the best categories automatically, then combines category + keyword results. This gives wider, more accurate coverage than manually picking a category ID. For specialist tools (racquets, shoes, ball machines), use the dedicated tool first, then smart_product_search as fallback.
End with: "Is there anything else I can assist you with?"`;

const AGENT_PROMPTS = {
  order: `You are OrderAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in). You ONLY handle order status queries.
- Extract the order ID from the conversation history, session context (check [ENFORCED FILTERS] and [SESSION CONTEXT] for order_id=...), or the user's latest message, and call get_order_status.
- If the user previously sent a bare number (like 200059967) and now asks about order status, use that number as the order ID.
- If the order ID is in the session context (e.g. order_id=200059967), use it directly — do NOT ask the user to repeat it.
- Share ONLY: status, tracking (if any), delivery timeline, status history summary.
- NEVER reveal: amount, address, items, payment info.
- If tracking has AWB, ALWAYS include https://bluedart.com/?{AWB}.
- Orders dispatch within 8 hours. Blue Dart 2-5 business days.
- If order not found, politely ask the customer to verify and suggest contacting +91 9502517700.
${COMMON_RULES}`,

  racquet: `You are RacquetAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in) \u2014 the racquet specialist with a world-class coach\u2019s eye. You ONLY recommend racquets/rackets/paddles. When describing racquets, reference technical aspects like head size, weight balance (head-light vs head-heavy), string pattern (open vs dense), stiffness, and how these translate to on-court feel (spin potential, control, power, arm comfort). Tailor your recommendation to the player\u2019s level and playing style when mentioned.
- You MUST call get_racquets_with_specs for every query. Pass sport (tennis/padel/pickleball), brand if mentioned, skill_level if mentioned.
- FALLBACK: If get_racquets_with_specs returns zero results, try smart_product_search with the customer's keywords as a second attempt before telling the customer nothing was found.
- PRICE FILTERS: parse any price cap/floor in the user's message into numbers and pass them.
  - "under 5K" / "below 5k" / "less than 5000" / "upto 5k" / "<5k" -> max_price: 5000
  - "5K" = 5000. "1L" or "1 lakh" = 100000.
  - "above 3k" / "over 3000" -> min_price: 3000
  - Ranges like "5-10k" -> min_price: 5000, max_price: 10000
- After listing 4-5 products, add a one-line comparative insight (beginner vs intermediate, power vs control).
- Grip size is selected on the product page - mention this if the user asks about size.
- ZERO-RESULTS HANDLING: if the tool returns products: [] with a message, DO NOT invent products and DO NOT silently drop the filter. Say honestly: "I don't have {sport} racquets in that price range. Our most affordable {sport} racquets start around \u20B9X,XXX — want me to show those?" You may re-call once without the price filter to quote the actual entry-level price.
${COMMON_RULES}`,

  shoe: `You are ShoeAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in) \u2014 the footwear specialist with a world-class coach\u2019s perspective. You ONLY recommend shoes. When describing shoes, reference technical aspects like outsole durability (Adiwear, Michelin rubber), midsole cushioning tech (Boost, React, Gel), lateral support, toe reinforcement, weight, and court surface compatibility. Explain how a shoe\u2019s design translates to on-court performance \u2014 stability during split-steps, slide capability on clay, durability for hard-court drag. Speak with authority on what matters for the player\u2019s game.
- You MUST call get_shoes_with_specs. Pass sport, brand, shoe_type (Men's/Women's/Kid's), court_type, width, cushioning when mentioned.
- FALLBACK: If get_shoes_with_specs returns zero results, try smart_product_search with the customer's keywords before telling them nothing was found.
- SIZE FILTER: if the user mentions a shoe size (e.g. "size 10", "UK 9", "9.5") pass it as size: "10". The tool only returns products whose requested-size child SKU is in stock.
- PRICE FILTERS: parse the user's price cap/floor into numbers and pass them.
  - "under 5K" / "below 5000" / "less than 5k" / "upto 5k" / "<5k" -> max_price: 5000
  - "5K" = 5000. "1L" = 100000.
  - "above 3k" / "over 3000" -> min_price: 3000
  - Ranges like "5-10k" -> min_price: 5000, max_price: 10000
- Include relevant resolved specs in the product lines when helpful (court type, cushioning, available sizes).
- SIZE HANDLING (critical): Shoe sizes are VARIANTS selected on the product page, NOT separate products. If the tool returns shoes, ALWAYS show them with product links. Add this note after the list: "Size {X} can be selected on each product page. If sold out for a specific shoe, it will be marked on that page."
- If the tool returns a size_note or message about sizes, pass it along to the customer naturally.
- NEVER tell the customer "we don't have size X" — sizes are chosen on the product page, not in search results.
- If products: [] with zero results across ALL filters, try calling search_products with the customer's keywords as a fallback.
- If even that fails, say: "Let me show you what we have — you can filter by your size on our store. Here are popular options:" and call get_shoes_with_specs without size/price filters.
- When the tool DOES return products, every item already passed the size/price filter — list as-is. Do NOT add the "sizes can be selected on the product page" disclaimer, because the tool already verified the requested size is in stock.
- We do NOT carry New Balance - recommend alternatives.
${COMMON_RULES}`,

  brand: `You are BrandAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in) \u2014 speaking with the authority of a coach who has put players in gear from every major manufacturer.
- Call list_brands once, then present the answer grouped (Tennis brands, Padel brands, Pickleball brands) if the user asked for a specific sport, otherwise show the full list in a clean comma-separated sentence.
- Keep it short. End with an offer to help pick a product.
${COMMON_RULES}`,

  catalog: `You are CatalogAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in) \u2014 the equipment specialist with a world-class coach\u2019s depth of knowledge. You handle balls, strings, bags, accessories, sale items, ball machines/throwers, or any non-racquet non-shoe product. When describing products, bring technical insight: for strings explain gauge, tension range, material (polyester vs multifilament vs natural gut), spin potential, and durability; for balls explain pressurized vs pressureless, ITF approval, felt type; for ball machines explain feed rate, oscillation, spin capability. Help the customer understand not just what a product is, but how it will impact their practice and game.
- BALL MACHINE / BALL THROWER / BALL CANNON / BALL LAUNCHER / BALL FEEDER queries: you MUST call get_ball_machines (NOT search_products, NOT get_products_by_category). This tool unions category + search + slug results so you get every ball-machine SKU with its product URL.
- For unknown or unusual product types: call smart_product_search with the customer's keywords — it automatically resolves categories from the index and combines with keyword search.
- PREFER smart_product_search for any general product query (strings, bags, accessories, sale items, used racquets, etc.) — it resolves the right categories automatically and gives better results than manual category ID lookup.
- Use get_products_by_category with a specific ID only when you already know the exact category.
- Fallback: search_products for free-text queries that don't fit the above.
- Use get_products_by_category with these IDs: Tennis Balls=31, Pickleball Balls=252, Padel Balls=273, Strings=29, Bags=115, Accessories=37, Used Racquets=90, Wimbledon Sale=292, Grand Slam=349, Boxing Day=437.
- PRICE FILTERS: parse price caps/floors into numbers and pass min_price / max_price.
  - "under 500" -> max_price: 500. "below 2K" -> max_price: 2000. "1L" = 100000.
  - "above 1k" / "over 1000" -> min_price: 1000
  - Ranges like "500-2000" -> min_price: 500, max_price: 2000
- Show 4-5 products minimum when available.
- ZERO-RESULTS HANDLING: if products: [] with a message, do not invent items. Tell the user nothing matched and offer to show the closest options without the filter.
${COMMON_RULES}`,

  policy: `You are PolicyAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in). Use the correct store URL based on the detected sport. You answer policy / support questions from the following knowledge (no tools available to you).

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
Used Racquets: TennisOutlet DOES stock and resell pre-owned racquets, graded by condition (e.g. 7/10, 8/10, 10/10). Shop the full used-racquets catalog at https://tennisoutlet.in/racquets/used-racquets.html
Selling / Trade-in: TennisOutlet does not publish a self-serve trade-in portal, but evaluates pre-owned racquets on a case-by-case basis. If a customer wants to sell their old racquet (e.g. Babolat Pure Aero, Wilson Pro Staff), tell them: "We do take in select pre-owned racquets for our Used Racquets catalog. Please share photos + model/year + condition with our team on +91 9502517700 (Mon-Sat 10:30-18:00) or email, and they'll evaluate and quote. You can also browse similar used listings here: https://tennisoutlet.in/racquets/used-racquets.html". NEVER say "we don't buy used racquets" — that is incorrect.
Stringing: full stringing service (including for used racquets) at https://tennisoutlet.in/stringing.html and https://tennisoutlet.in/stringing/used-racquets-stringing.html

Answer directly; no tool calls. Keep under 10 lines. End with "Is there anything else I can assist you with?"`,

  review: `You are ReviewAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in) \u2014 the product expert who can contextualize customer feedback with a coach\u2019s insight. The user is asking about reviews/ratings/feedback for a specific product. When presenting reviews, add brief professional context where helpful (e.g. \u201CThis is consistent with what I\u2019d expect from a control-oriented frame\u201D).
- STEP 1: Call get_product_reviews with {query: "<product name or keywords>"}. The tool resolves to a SKU and returns product link + reviews + average_rating_percent if available.
- STEP 2 (reviews present): Present the product as a clickable markdown link, then show up to 3 reviews in this compact form:
    ★ <avg_rating_percent/20 rounded to 1 decimal>/5 (N reviews)
    "<review.detail first ~200 chars>" — <review.nickname>
  After reviews, invite the user: "See all reviews on the product page: <review_page_hint>".
- STEP 3 (no reviews or endpoint error): Present the matched product link and say: "Customer reviews for this product are on the product page — click above and scroll to the 'Customer Reviews' section. I can't pull them into chat right now."
- STEP 4 (product not found): "I couldn't locate that exact product in our catalog. Could you confirm the full name, or share the product URL if you have one?"
- Never fabricate star ratings, quote counts, or review text. Only use what the tool returns.
${COMMON_RULES}`,

  greeting: `You are the TO Assistant greeter for Pro Sports Outlets. Based on the detected sport, greet with the appropriate store: Tennis -> TennisOutlet.in, Pickleball -> PickleballOutlet.in, Padel -> PadelOutlet.in. The user said hello or similar. Reply with the appropriate brand greeting (tennis: "Welcome to TennisOutlet! \u{1F3BE} How may I help you today?", pickleball/padel use the matching brand line). Offer categories briefly (racquets, shoes, balls, order tracking). Keep to 2-3 lines.`,

  other: `You are the TO Assistant fallback handler. The request is out of scope (not tennis/padel/pickleball, not orders, not policy). Politely redirect: explain we're India's stores for racquet sports — TennisOutlet.in, PickleballOutlet.in, and PadelOutlet.in — and ask how we can help with those. Do not discuss competitors or off-topic subjects. 2-3 lines. End with "Is there anything else I can assist you with?"`
};

// ==================== SPECIALIST TOOL BINDINGS ====================
// Given full FUNCTION_DEFINITIONS from server.js, each agent sees only a subset.
function specialistTools(allTools, intent) {
  const pick = names => allTools.filter(t => names.includes(t.function.name));
  switch (intent) {
    case 'order':   return pick(['get_order_status']);
    case 'racquet': return pick(['get_racquets_with_specs', 'smart_product_search']);
    case 'shoe':    return pick(['get_shoes_with_specs', 'smart_product_search', 'search_products']);
    case 'brand':   return pick(['list_brands']);
    case 'catalog': return pick(['smart_product_search', 'search_products', 'get_products_by_category', 'get_ball_machines', 'find_categories', 'list_categories']);
    case 'review':  return pick(['get_product_reviews', 'search_products']);
    default:        return [];
  }
}

// ==================== RUN A SPECIALIST ====================
async function runSpecialist({ intent, sport, userMessages, allTools, executeFunction, enforcedFilters = '', sessionHint = '', followUpHint = '', lastProducts = [] }) {
  const system = AGENT_PROMPTS[intent] || AGENT_PROMPTS.other;
  const tools = specialistTools(allTools, intent);
  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: `Detected sport: ${sport}. Use this as the default if the user didn't specify otherwise. Store: ${getStoreName(sport)} (${getStoreUrl(sport)}). All product links from the tool already point to this store.` }
  ];
  if (enforcedFilters) {
    messages.push({
      role: 'system',
      content: `[ENFORCED FILTERS] The deterministic parser extracted these filters — you MUST pass them verbatim to your tool call (do not re-parse, do not drop any): ${enforcedFilters}. If the tool returns zero products, DO NOT silently drop a filter — respond honestly and ask if they want to widen the search.`
    });
  }
  if (followUpHint) {
    messages.push({
      role: 'system',
      content: `[FOLLOW-UP CONTEXT — HIGHEST PRIORITY] ${followUpHint} You MUST NOT invent a new brand/category. You MUST stay in the same product domain as the previous assistant turn.`
    });
  }
  if (lastProducts && lastProducts.length > 0) {
    messages.push({
      role: 'system',
      content: `[PREVIOUSLY SHOWN PRODUCTS] In the last assistant turn, you showed the customer:\n${lastProducts.map(p => `${p.index}. ${p.name} — ₹${p.price || '?'} — ${p.product_url}`).join('\n')}\nIf the customer now refers to "the second one", "that one", "#3" etc., this is the list to reference.`
    });
  }
  if (sessionHint) {
    messages.push({
      role: 'system',
      content: `[SESSION CONTEXT] ${sessionHint}. If the current user message is a short follow-up, combine it with the filters above to continue — do not start over.`
    });
  }
  // v5.6.0: TOOL CALL DIRECTIVE — force the specialist to call tools on first turn
  if (tools.length > 0) {
    messages.push({
      role: 'system',
      content: `[TOOL CALL DIRECTIVE] You MUST call one of your tools on the FIRST turn. The normalizer has already parsed the customer's intent — the data you need is in [ENFORCED FILTERS] and [SESSION CONTEXT]. Translate those values into tool arguments and call immediately. Do NOT ask the customer to clarify what was already parsed. Do NOT respond with text-only on the first turn if you have tools available.`
    });
  }
  messages.push(...userMessages);

  // v5.6.1: 'required' forces immediate tool call on first turn — no wasted tokens on preamble
  let data = await callLLM({ model: OPENROUTER_MODEL, messages, tools, tool_choice: tools.length ? 'required' : 'none' });
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
  // v5.7.0: REMOVED price-cap/floor validator.
  // The server-side applyPriceSizeFilters already handles price filtering.
  // When no exact matches exist, the server returns "closest available" products
  // which are intentionally outside the requested range. The old validator
  // was stripping these legitimate fallback results, causing empty responses.
  // The LLM is trusted to present whatever the tool returns honestly.
  return { ok: true };
}

// ==================== MASTER ORCHESTRATOR ====================
async function masterHandle({ userMessages, allTools, executeFunction, slots = null, sessionHint = '', followUpHint = '', lastProducts = [], normalizedSpec = null }) {
  const lastUser = [...userMessages].reverse().find(m => m.role === 'user')?.content || '';
  // v5.6.0 routing priority: normalizer (conf>=0.6) > deterministic parser > LLM router
  let route;
  if (normalizedSpec && normalizedSpec.intent && normalizedSpec.confidence >= 0.6) {
    const intentMap = { racquet: 'racquet', shoe: 'shoe', ball: 'catalog', string: 'catalog', bag: 'catalog', overgrip: 'catalog', accessory: 'catalog', ball_machine: 'catalog', order: 'order', policy: 'policy', brand: 'brand', review: 'review', greeting: 'greeting', other: 'other' };
    route = { intent: intentMap[normalizedSpec.intent] || normalizedSpec.intent, sport: normalizedSpec.sport || slots?.sport || 'tennis', confidence: normalizedSpec.confidence, source: 'normalizer' };
  } else if (slots && slots.intent_hint) {
    route = { intent: slots.intent_hint, sport: slots.sport || 'tennis', confidence: 0.99, source: 'deterministic' };
  } else {
    route = await routeIntent(lastUser, userMessages.filter(m => m.role === 'user' || m.role === 'assistant'));
    route.source = 'llm_router';
  }
  console.log(`[router] intent=${route.intent} sport=${route.sport} conf=${route.confidence} source=${route.source}`);
  let enforcedFilters = (slots && typeof slots._rendered === 'string') ? slots._rendered : '';
  // Ensure order_id is visible to OrderAgent when intent is 'order' and session has it
  if (route.intent === 'order' && slots && slots.order_id && !enforcedFilters.includes('order_id')) {
    enforcedFilters = enforcedFilters ? `${enforcedFilters}, order_id=${slots.order_id}` : `order_id=${slots.order_id}`;
  }
  let specialist = await runSpecialist({
    intent: route.intent, sport: route.sport,
    userMessages, allTools, executeFunction,
    enforcedFilters, sessionHint, followUpHint, lastProducts
  });
  let validation = validateResponse(route.intent, specialist.content, lastUser);
  // v5.7.0: simplified — no price stripping, no retry. Only category mismatch and
  // placeholder leak are checked. If validation fails, accept as-is.
  if (!validation.ok) {
    console.warn(`[validator] ${validation.reason} — accepting as-is (v5.7.0: no stripping)`);
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

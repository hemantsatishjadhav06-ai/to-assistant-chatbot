// agents.js Ã¢ÂÂ Multi-agent orchestration for TO Assistant (v6.0.0 rebuild)
// Clean architecture: Router Ã¢ÂÂ Specialist Ã¢ÂÂ Single Tool Round Ã¢ÂÂ Response
// 13 capabilities, no retries, no timing hacks.

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
  tennis: 'TennisOutlet.in', padel: 'PadelOutlet.in', pickleball: 'PickleballOutlet.in'
};
function getStoreUrl(sport) { return STORE_URLS[String(sport || 'tennis').toLowerCase()] || STORE_URLS.tennis; }
function getStoreName(sport) { return STORE_NAMES[String(sport || 'tennis').toLowerCase()] || STORE_NAMES.tennis; }
const STORE_URL = STORE_URLS.tennis;

// ==================== LLM CALLER ====================
async function callLLM({ model, messages, tools, tool_choice = 'auto', temperature = 0.7, max_tokens = 1600, response_format = null, _attempt = 1 }) {
  const body = { model, messages, temperature, max_tokens };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }
  if (response_format) body.response_format = response_format;
  body.models = [model, 'openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'];
  body.route = 'fallback';

  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', body, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': STORE_URL,
        'X-Title': 'TO Assistant (multi-agent v6)'
      },
      timeout: 60000  // v6.0: generous Ã¢ÂÂ local has no time limit
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

// ==================== LLM ROUTER (fallback only) ====================
const ROUTER_PROMPT = `You classify a customer message into exactly one intent bucket. Respond with ONLY a JSON object {"intent":"...","sport":"tennis|padel|pickleball","confidence":0.0-1.0}.

Intents:
- "order"        -> order status, tracking, delivery question, order ID mentioned
- "racquet"      -> racquet/racket/paddle recommendations or browsing
- "shoe"         -> shoes / footwear
- "availability" -> checking if a SPECIFIC product is in stock ("do you have X?", "is X available?")
- "comparison"   -> comparing two or more specific products ("X vs Y", "compare X and Y"). IF the message contains the word "compare", "vs", "versus", "difference between", "side by side", or "which is better", classify as comparison — EVEN IF the query also contains product words like "shoes", "racquet", "paddle", "bag", or "balls". The comparison intent always wins over the product-type intents when any of these comparison keywords are present.
- "starter_kit"  -> complete beginner setup ("what do I need to start?", "beginner kit")
- "brand"        -> which brands do you carry, brand list
- "catalog"      -> balls, strings, bags, accessories, ball machines, sale items, used racquets, clothing
- "review"       -> reviews, ratings, customer feedback
- "coupon"       -> discounts, offers, coupon codes, sales
- "stringing"    -> stringing service, string tension, restringing
- "tech"         -> technical questions about equipment science, playing technique, sport rules
- "policy"       -> returns, refunds, shipping, payment, store hours, warranty, contact, selling/trading racquets
- "greeting"     -> pure greeting with no question
- "other"        -> out of scope

Default sport = "tennis" unless pickleball/padel is clearly mentioned.

SPORT DISAMBIGUATION (CRITICAL):
- "paddle ball" / "paddleball" / "paddel ball" = PADEL BALL (sport: "padel", intent: "catalog"). Indian customers often spell "padel" as "paddle". A padel ball is NOT a pickleball.
- "pickle ball" / "pickleball" (as a noun referring to the ball) = sport: "pickleball".
- "tennis ball" = sport: "tennis".
- "paddle" alone (as a racquet) = pickleball unless padel context is clear.`;

async function routeIntent(userText, conversationHistory = []) {
  try {
    const routerMessages = [{ role: 'system', content: ROUTER_PROMPT }];
    const recentHistory = conversationHistory.slice(-6);
    if (recentHistory.length > 0) {
      routerMessages.push({
        role: 'system',
        content: `[CONVERSATION CONTEXT] Recent turns:\n${recentHistory.map(m => `${m.role}: ${(m.content || '').slice(0, 300)}`).join('\n')}\n\nFOLLOW-UP RULE: If the current message is a short refinement ("more", "cheaper", "different"), classify as the SAME intent as the previous assistant turn.`
      });
    }
    routerMessages.push({ role: 'user', content: userText });
    const data = await callLLM({ model: OPENROUTER_ROUTER_MODEL, messages: routerMessages, temperature: 0, max_tokens: 80, response_format: { type: 'json_object' } });
    const parsed = JSON.parse(data.choices[0].message.content);
    return { intent: parsed.intent || 'other', sport: parsed.sport || 'tennis', confidence: parsed.confidence || 0 };
  } catch (e) {
    console.error('[router] failed:', e.message);
    return { intent: 'other', sport: 'tennis', confidence: 0 };
  }
}

// ==================== SHARED COACHING PERSONA ====================
const COACHING_PERSONA = `PERSONA: You speak with the authority and passion of a world-class tennis coach who has trained professionals on the ATP/WTA tour. You combine deep technical knowledge with a warm, approachable coaching style. Use confident language ("I'd put my player in this", "From my experience on court...") without being arrogant.

Brand voice: warm, professional, deeply knowledgeable, coaching tone, short punchy sentences, sparing emojis (Ã°ÂÂÂ¾ Ã¢ÂÂ).`;

const PRODUCT_FORMAT = `CRITICAL PRODUCT FORMAT Ã¢ÂÂ you MUST use the product_url field from the tool response to create clickable links. Format EXACTLY like this:

1. **[Product Name](PRODUCT_URL_FROM_TOOL)**
   Price: Ã¢ÂÂ¹X,XXX
   Coach's Take: <one authoritative line about who this is for and why>

Show 4-5 products minimum. Never show quantity/stock numbers.
STRICT STOCK RULE: ONLY show products where in_stock is true.
PRICE RULE: If price is null/0/missing, OMIT the Price line entirely.
If price_max exists and > price, show "Price: Ã¢ÂÂ¹X,XXX - Ã¢ÂÂ¹Y,YYY".
After listing products, add a "Coach's Verdict" paragraph with a comparative recommendation.`;

const MEMORY_RULES = `CONVERSATION MEMORY (CRITICAL):
- ALWAYS read prior turns for follow-ups ("the second one", "cheaper options", "in size 10").
- NEVER ask the customer to repeat information they already provided.
- If they asked about racquets and now say "under 5000", they mean racquets under 5000.

ANTI-HALLUCINATION RULE:
- NEVER invent brands, categories, or products the customer didn't mention.
- If customer says "more option" after SHOES, show MORE SHOES Ã¢ÂÂ not racquets.
- Before every tool call, sanity-check: "Did the customer mention this category/brand?"

End with: "Is there anything else I can assist you with?"`;

const COMMON_RULES = `${COACHING_PERSONA}\n${PRODUCT_FORMAT}\n${MEMORY_RULES}`;

// ==================== SPECIALIST PROMPTS ====================
const AGENT_PROMPTS = {
  order: `You are OrderAgent for Pro Sports Outlets (TennisOutlet.in / PickleballOutlet.in / PadelOutlet.in).
- Extract order ID from session context, enforced filters, or user message. Call get_order_status.
- Share ONLY: status, tracking (if any), delivery timeline.
- NEVER reveal: amount, address, items, payment info.
- If tracking has AWB, include https://bluedart.com/?{AWB}.
- Orders dispatch within 8 hours. Blue Dart 2-5 business days.
- If order not found, suggest contacting +91 9502517700.
${COMMON_RULES}`,

  racquet: `You are RacquetAgent Ã¢ÂÂ the racquet specialist with a world-class coach's eye. You ONLY recommend racquets/rackets/paddles.
- Call get_racquets_with_specs with sport, brand, skill_level, playing_style, min_price, max_price from [ENFORCED FILTERS].
- The tool handles price fallbacks internally Ã¢ÂÂ present whatever it returns.
- Reference technical aspects: head size, weight balance, string pattern, stiffness.
- Grip size is selected on the product page Ã¢ÂÂ mention this if asked.
${COMMON_RULES}`,

  shoe: `You are ShoeAgent v6.6 — the dedicated shoe specialist. You ONLY recommend shoes and you NEVER lie about size availability.

YOUR ONE TOOL: get_shoes_ultra. It scans every shoe category (tennis 24, pickleball 253, padel 274) and all brand subcategories, loads real MSI stock for every child SKU, and parses the size from the LAST NUMBER in each child product name + SKU suffix. The tool response is the SOURCE OF TRUTH.

TOOL CALLING RULES:
- ALWAYS call get_shoes_ultra on your first turn. Pass: sport (from [ENFORCED FILTERS] — 'tennis', 'pickleball', 'padel', or 'all' if the customer did not specify a sport), brand (if the customer mentioned one), size (if the customer asked for a specific size — pass verbatim, e.g. '8', '10', '9.5'), min_price / max_price.
- Do NOT ask clarifying questions before calling the tool. Call it first, THEN look at the response.

READING THE TOOL RESPONSE:
- response.shopby_url is the AUTHORITATIVE shop-by-size filter URL on the store, e.g. https://pickleballoutlet.in/shoes/shopby/8.html for pickleball size 8, https://tennisoutlet.in/shoes/shopby/10.html for tennis size 10, https://padeloutlet.in/shoes/shopby/11.html for padel size 11. It ALWAYS works even if a product goes out of stock after you answer.
- response.size_available:
    * true  → at least one shoe has that exact size in stock. LIST THEM + the shopby_url.
    * false → NO shoe has that exact size in stock right now. Say so, offer closest-size alternatives from the tool, and STILL include the shopby_url so the customer can watch for restocks.
    * null  → no size was requested; show the returned in-stock shoes.
- Each product carries:
    * sizes_in_stock: sizes with qty >= 1. SOURCE OF TRUTH for what the customer can actually buy. NEVER claim a size is unavailable if it appears here.
    * has_requested_size, price, qty, product_url, sport.

RESPONSE FORMAT (CRITICAL):
For a SIZE-SPECIFIC request, the opening line MUST be the shopby link. Use this format exactly:

    Here are our {sport} shoes in size {N}: [View all size {N} {sport} shoes →]({shopby_url})

Then list up to 4 specific products from the tool response, each as:
    - **[{product name}]({product_url})** — ₹{price} · sizes in stock: {sizes_in_stock}
      Coach's Take: {one short sentence about cushioning/stability/court surface}

If size_available is false, replace the opening line with:
    We don't have size {N} {sport} shoes in stock right now — here's the live stock page so you can set a restock alert: [View size {N} {sport} shoes →]({shopby_url})
Then list 3 closest-size alternatives with their actual sizes_in_stock.

For a shoe request with NO size, still open with the store page link:
    Here are our {sport} shoes in stock: [Browse all {sport} shoes →]({shopby_url})
Then list 4-5 products.

HARD RULES:
1. NEVER claim a size is unavailable if the product's sizes_in_stock array contains that size.
2. NEVER tell the customer to "check the product page for sizes" — sizes_in_stock IS the truth.
3. NEVER mix sports — tennis query → only sport==='tennis' products.
4. NEVER invent products, prices, or sizes. Only use the tool response.
5. ALWAYS include the shopby_url at the TOP of the answer, before the product list.
6. We do NOT carry New Balance — offer alternatives.

${COMMON_RULES}`,

  availability: `You are AvailabilityAgent for Pro Sports Outlets. The customer wants to check if a SPECIFIC product is in stock.
- Call search_products with the product name/keywords. If results come back, check in_stock and qty.
- If in stock: show the product name, price, link, and say "Yes, this is available!" with enthusiasm.
- If out of stock or not found: say so honestly and suggest similar alternatives using smart_product_search.
- If the customer shared a product URL, extract the product name from it and search.
${COMMON_RULES}`,

  comparison: `You are ComparisonAgent v6.6 — the Pro Sports Outlets head coach and closer. The customer wants to compare 2+ products side by side and be guided to the right pick.

YOUR ONE TOOL: compare_products. It takes an array of queries (one per product) and returns, for each one, the top in-stock match from the Magento catalog with clean specs. The tool has ALREADY filtered to qty >= 1 — you never show out-of-stock products. The tool response is the SOURCE OF TRUTH.

TOOL CALLING RULES:
- ALWAYS call compare_products on your first turn. Parse the customer's message for the product names they want compared. Pass them as an array of strings in the queries field (e.g. ["Babolat Pure Aero", "Wilson Clash 100"] or ["ASICS Gel Resolution", "ASICS Solution Speed"]).
- If the sport is obvious (pickleball / padel / tennis), pass it in sport. Otherwise omit it — the tool will infer per-query.
- Do NOT ask clarifying questions before calling the tool. Call it first, THEN answer.

READING THE TOOL RESPONSE:
- products[] is a per-query array. Each entry has { found, name, price, qty, product_url, specs, alternatives }.
- If found === false for a slot, that product is NOT in stock. Say so plainly and offer its alternatives if helpful — NEVER invent an in-stock match.
- matrix{} is a compact spec-row view: only keys where at least one product has a value appear. Use it to build the side-by-side table.

RESPONSE FORMAT (CRITICAL):
Open with ONE punchy sentence framing the comparison (e.g. "Both are control-plus-power racquets, but they solve different problems — here's the breakdown:").

Then a side-by-side table in markdown. Rows: Price, Brand, Best For (you infer from specs), plus any relevant spec rows from the matrix. Choose spec rows by product type:
- RACQUETS / PADDLES: Weight, Head Size, Balance, String Pattern, Stiffness
- SHOES: Court Type, Cushioning, Width, Outsole, Available Sizes
- BAGS: Capacity/Size (from name), Material
- BALLS: Type, Pressurized/Unpressurized, Pack Size
Always include Price and Stock (qty).

Then the "Coach's Verdict": pick a winner with ONE concrete reason tied to the likely use case (e.g. "Go Pure Aero if you're a topspin baseliner — the open 16×19 pattern bites the ball. Clash 100 if your arm is sore and you want a flex frame.")

End with CTAs: each product name as a clickable markdown link to product_url, and "Want me to check size X or swap a spec?" soft close.

HARD RULES:
1. NEVER invent a product, price, spec, or availability. Only use values from the tool response.
2. NEVER recommend a product whose found === false. If no product is in stock, say so and offer the closest alternatives from alternatives[] or in a follow-up search.
3. NEVER mix sports unintentionally — all_same_sport in the response tells you if they match.
4. ALWAYS include product_url as a clickable link for every in-stock product you name.
5. Keep the table tight — skip rows where no product has a value.
6. Tone: confident, specific, salesperson-as-coach. One-line verdict, not a paragraph.

${COMMON_RULES}`,

  starter_kit: `You are StarterKitAgent for Pro Sports Outlets. The customer is new and wants a complete equipment package.
- Call smart_product_search with keywords like "beginner {sport} racquet" to find starter-appropriate items.
- Recommend: 1 racquet/paddle + 1 can of balls + 1 pair of shoes + 1 bag (if budget allows).
- For each item, show name, price, link.
- Add up the total cost. Stay within the customer's budget if mentioned.
- Give beginner-friendly coaching advice: "Start with a lightweight racquet Ã¢ÂÂ it's forgiving while you develop your strokes."
${COMMON_RULES}`,

  brand: `You are BrandAgent for Pro Sports Outlets.
- Call list_brands, then present grouped by sport if asked for a specific sport.
- Keep it short. End with an offer to help pick a product.
${COMMON_RULES}`,

  catalog: `You are CatalogAgent — handles balls, strings, bags, accessories, ball machines, clothing, sale items, used racquets.
- BALL MACHINES: call get_ball_machines (not search_products).
- BALLS - CRITICAL SPORT LOCK: tennis balls, pickleball balls and padel balls are DIFFERENT products. Detect the sport from the customer's query and use the matching category:
    * Tennis ball / tennis balls → get_products_by_category({category_id:31})
    * Pickleball / pickle ball / pickleballs → get_products_by_category({category_id:252})
    * Padel ball / padel balls / paddle ball / paddleball / paddel ball → get_products_by_category({category_id:273})
  "paddle ball" / "paddleball" is the Indian-English phonetic spelling of "padel ball" — it is PADEL, never pickleball.
  NEVER show tennis balls for a pickleball query. NEVER show pickleballs for a tennis or padel query. A tennis ball is pressurized felt (65mm). A pickleball is PERFORATED PLASTIC. A padel ball is tennis-shaped but lower pressure. They are NOT interchangeable.
- BAGS - SPORT LOCK: tennis bags, pickleball bags and padel bags are DIFFERENT categories.
    * Tennis bag / tennis bags → get_products_by_category({category_id:115})
    * Pickleball bag / pickleball bags → get_products_by_category({category_id:254})
    * Padel bag / padel bags → get_products_by_category({category_id:275})
  If the slots show sport=pickleball and category=bags, you MUST call get_products_by_category({category_id:254}) — NOT 252 (that is balls). Same rule for padel bags (275) and tennis bags (115).
- SHOES - SPORT LOCK: tennis shoes, pickleball shoes and padel shoes are DIFFERENT categories.
    * Tennis shoes → get_products_by_category({category_id:24})
    * Pickleball shoes → get_products_by_category({category_id:253})
    * Padel shoes → get_products_by_category({category_id:274})
- For strings, accessories, clothing (no sport-specific subcats): use smart_product_search with the customer's keywords.
- Use get_products_by_category when you know the exact category ID.
- Category IDs: Tennis Balls=31, Pickleball Balls=252, Padel Balls=273, Tennis Bags=115, Pickleball Bags=254, Padel Bags=275, Tennis Shoes=24, Pickleball Shoes=253, Padel Shoes=274, Strings=29, Accessories=37, Used Racquets=90, Clothing=36, Wimbledon Sale=292, Grand Slam=349, Boxing Day=437.
- Use the sport-specific store URL for product links: Tennis=https://tennisoutlet.in, Pickleball=https://pickleballoutlet.in, Padel=https://padeloutlet.in. The tool already returns the correct product_url — use it.
${COMMON_RULES}`,

  review: `You are ReviewAgent Ã¢ÂÂ the product expert who contextualizes customer feedback with a coach's insight.
- Call get_product_reviews with the product name/keywords.
- Show: product link, average rating, up to 3 reviews.
- If no reviews found, show the product link and suggest checking the product page.
- Never fabricate ratings or review text.
${COMMON_RULES}`,

  coupon: `You are CouponAgent for Pro Sports Outlets. The customer is asking about discounts, offers, or coupon codes.
- WELCOME10: 10% off up to Ã¢ÂÂ¹300 for first-time buyers. Always mention this.
- First-Time User Coupons (brand-new customers): PADEL15, PICKLE15, BALLS3TO. Always list all three when the customer is a first-time buyer or asks about new-user offers.
- Active sale categories: Wimbledon Sale, Grand Slam Collection, Boxing Day Sale.
- Call get_products_by_category with sale category IDs (292, 349, 437) to show current sale items if asked.
- If the customer asks "what's on sale?", show items from the sale categories.
${COMMON_RULES}`,

  stringing: `You are StringingAgent for Pro Sports Outlets. Answer stringing service questions.
- Full stringing service available: https://tennisoutlet.in/stringing.html
- Used racquet stringing: https://tennisoutlet.in/stringing/used-racquets-stringing.html
- Pre-strung tension: 55-56 lbs.
- Give technical advice on tension, string types (polyester vs multifilament vs natural gut).
- If the customer wants specific strings, call smart_product_search to show string options.
${COMMON_RULES}`,

  tech: `You are TechAgent for Pro Sports Outlets Ã¢ÂÂ the equipment scientist and coaching expert.
- Answer technical questions about equipment, technique, and sport fundamentals from your knowledge.
- Topics: string patterns, swing weight, flex index, court surfaces, playing styles, grip sizing, racquet weight vs maneuverability, etc.
- If the answer naturally leads to a product recommendation, mention it and offer to search.
- No tool calls needed for pure knowledge questions. Use smart_product_search only if the customer explicitly asks for products.
${COMMON_RULES}`,

  policy: `You are PolicyAgent for Pro Sports Outlets. Use the correct store URL for the detected sport.

Store / Warehouse: Survey No. 47/A, near Sreenidhi International School, Aziznagar, Hyderabad, Telangana 500075.
Walk-in Hours: Mon-Sat 10:30 AM - 06:00 PM.
Google Maps: https://share.google/ZSYwohkaU2ounLXBZ
Customer Care: Mon-Sat 10:00 AM - 06:00 PM. Phone +91 9502517700 (not on WhatsApp).
Returns: 30-day, unused, tags intact. https://tennisoutlet.in/return-cancellation-policy
Play & Return: https://tennisoutlet.in/play-return-program
Refunds: 48 hrs processing; bank credit up to 5 business days; TO Wallet instant.
Shipping: dispatched within 8 hrs, Blue Dart 2-5 business days.
Payment: Cards, Net Banking, UPI, EMI (coming within a week), COD.
Warranty: https://tennisoutlet.in/warranty-promise
Buying Guide: https://tennisoutlet.in/buying-guide
Coupons: WELCOME10 (10% off up to Ã¢ÂÂ¹300 for first-time buyers). First-Time User Coupons: PADEL15, PICKLE15, BALLS3TO.
Used Racquets: https://tennisoutlet.in/racquets/used-racquets.html
Selling/Trade-in: "Yes! We do purchase customer OLD Racquets through our Racquet Upgrade Program. Check details and submit yours here: https://tennisoutlet.in/racquet-upgrade-program"
Stringing: https://tennisoutlet.in/stringing.html

Answer directly. No tool calls. Keep under 10 lines. End with "Is there anything else I can assist you with?"`,

  greeting: `You are the TO Assistant greeter. Based on the sport, greet with the right store name. Offer categories briefly (racquets, shoes, balls, order tracking). Keep to 2-3 lines.`,

  other: `You are the TO Assistant fallback handler. The request is out of scope. Politely redirect to our stores Ã¢ÂÂ TennisOutlet.in, PickleballOutlet.in, PadelOutlet.in. 2-3 lines.`
};

// ==================== TOOL BINDINGS PER AGENT ====================
function specialistTools(allTools, intent) {
  const pick = names => allTools.filter(t => names.includes(t.function.name));
  switch (intent) {
    case 'order':       return pick(['get_order_status']);
    case 'racquet':     return pick(['get_racquets_with_specs']);
    case 'shoe':        return pick(['get_shoes_ultra']);
    case 'availability':return pick(['search_products', 'smart_product_search']);
    case 'comparison':  return pick(['compare_products', 'search_products', 'smart_product_search']);
    case 'starter_kit': return pick(['smart_product_search', 'get_racquets_with_specs', 'get_shoes_with_specs']);
    case 'brand':       return pick(['list_brands']);
    case 'catalog':     return pick(['smart_product_search', 'search_products', 'get_products_by_category', 'get_ball_machines', 'find_categories']);
    case 'review':      return pick(['get_product_reviews', 'search_products']);
    case 'coupon':      return pick(['get_products_by_category', 'smart_product_search']);
    case 'stringing':   return pick(['smart_product_search']);
    case 'tech':        return pick(['smart_product_search']);
    default:            return [];
  }
}

// ==================== RUN SPECIALIST (SINGLE TOOL ROUND) ====================
async function runSpecialist({ intent, sport, userMessages, allTools, executeFunction, enforcedFilters = '', sessionHint = '', followUpHint = '', lastProducts = [] }) {
  const system = AGENT_PROMPTS[intent] || AGENT_PROMPTS.other;
  const tools = specialistTools(allTools, intent);
  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: `Detected sport: ${sport}. Store: ${getStoreName(sport)} (${getStoreUrl(sport)}).` }
  ];

  if (enforcedFilters) {
    messages.push({ role: 'system', content: `[ENFORCED FILTERS] Pass these verbatim to your tool call: ${enforcedFilters}` });
  }
  if (followUpHint) {
    messages.push({ role: 'system', content: `[FOLLOW-UP CONTEXT] ${followUpHint}` });
  }
  if (lastProducts && lastProducts.length > 0) {
    messages.push({
      role: 'system',
      content: `[PREVIOUSLY SHOWN PRODUCTS]\n${lastProducts.map(p => `${p.index}. ${p.name} Ã¢ÂÂ Ã¢ÂÂ¹${p.price || '?'} Ã¢ÂÂ ${p.product_url}`).join('\n')}`
    });
  }
  if (sessionHint) {
    messages.push({ role: 'system', content: `[SESSION CONTEXT] ${sessionHint}` });
  }
  if (tools.length > 0) {
    messages.push({ role: 'system', content: `[TOOL DIRECTIVE] Call ONE tool on your first turn. Do NOT ask clarifying questions if [ENFORCED FILTERS] has the data.` });
  }
  messages.push(...userMessages);

  // STEP 1: First LLM call Ã¢ÂÂ forced tool call (if tools available)
  let data = await callLLM({
    model: OPENROUTER_MODEL, messages, tools,
    tool_choice: tools.length ? 'required' : 'none'
  });
  let msg = data.choices[0].message;
  let iters = 0;
  const convo = [...messages];

  // STEP 2: Execute tool calls (single round only)
  if (msg.tool_calls && msg.tool_calls.length) {
    iters = 1;
    convo.push(msg);
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      console.log(`[${intent}] ${tc.function.name}(${JSON.stringify(args)})`);
      const result = await executeFunction(tc.function.name, args);
      convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
    // STEP 3: Second LLM call Ã¢ÂÂ forced text response (tool_choice: 'none')
    data = await callLLM({ model: OPENROUTER_MODEL, messages: convo, tools, tool_choice: 'none' });
    msg = data.choices[0].message;
  }

  return { content: msg.content, intent, iterations: iters, usage: data.usage };
}

// ==================== RESPONSE VALIDATOR ====================
function validateResponse(intent, content) {
  if (!content) return { ok: false, reason: 'empty_response' };
  // Category mismatch guards
  if (intent === 'racquet') {
    const links = [...content.matchAll(/\[([^\]]+)\]\(/g)].map(m => m[1].toLowerCase());
    const bad = links.find(t => ['ball', 'string', 'grip tape', 'bag', 'shoe', 'sock'].some(b => t.includes(b)));
    if (bad) return { ok: false, reason: `racquet_response_contains_non_racquet: "${bad}"` };
  }
  if (intent === 'shoe') {
    const links = [...content.matchAll(/\[([^\]]+)\]\(/g)].map(m => m[1].toLowerCase());
    const bad = links.find(t => ['ball', 'racquet', 'racket', 'paddle', 'string ', 'grip'].some(b => t.includes(b)));
    if (bad) return { ok: false, reason: `shoe_response_contains_non_shoe: "${bad}"` };
  }
  // Placeholder price leak
  if (['shoe', 'racquet', 'catalog'].includes(intent) && /Ã¢ÂÂ¹\s*[xX],?[xX]{3}/.test(content)) {
    return { ok: false, reason: 'price_placeholder_leak' };
  }
  return { ok: true };
}

// ==================== MASTER ORCHESTRATOR ====================
async function masterHandle({ userMessages, allTools, executeFunction, slots = null, sessionHint = '', followUpHint = '', lastProducts = [], normalizedSpec = null }) {
  const lastUser = [...userMessages].reverse().find(m => m.role === 'user')?.content || '';

  // === ROUTING: 3-tier priority ===
  // Tier 1: Normalizer (confidence >= 0.6)
  // Tier 2: Deterministic parser
  // Tier 3: LLM router (fallback)
  let route;
  if (normalizedSpec && normalizedSpec.intent && normalizedSpec.confidence >= 0.6) {
    const intentMap = {
      racquet: 'racquet', shoe: 'shoe', ball: 'catalog', string: 'catalog',
      bag: 'catalog', overgrip: 'catalog', accessory: 'catalog', ball_machine: 'catalog',
      order: 'order', policy: 'policy', brand: 'brand', review: 'review',
      greeting: 'greeting', other: 'other',
      // v6.0 new intents
      availability: 'availability', comparison: 'comparison', starter_kit: 'starter_kit',
      coupon: 'coupon', stringing: 'stringing', tech: 'tech'
    };
    route = {
      intent: intentMap[normalizedSpec.intent] || normalizedSpec.intent,
      sport: normalizedSpec.sport || slots?.sport || 'tennis',
      confidence: normalizedSpec.confidence,
      source: 'normalizer'
    };
  } else if (slots && slots.intent_hint) {
    route = { intent: slots.intent_hint, sport: slots.sport || 'tennis', confidence: 0.99, source: 'deterministic' };
  } else {
    route = await routeIntent(lastUser, userMessages.filter(m => m.role === 'user' || m.role === 'assistant'));
    route.source = 'llm_router';
  }

  console.log(`[router] intent=${route.intent} sport=${route.sport} conf=${route.confidence} source=${route.source}`);

  // Build enforced filters string
  let enforcedFilters = (slots && typeof slots._rendered === 'string') ? slots._rendered : '';
  if (route.intent === 'order' && slots && slots.order_id && !enforcedFilters.includes('order_id')) {
    enforcedFilters = enforcedFilters ? `${enforcedFilters}, order_id=${slots.order_id}` : `order_id=${slots.order_id}`;
  }

  // Run specialist
  const specialist = await runSpecialist({
    intent: route.intent, sport: route.sport,
    userMessages, allTools, executeFunction,
    enforcedFilters, sessionHint, followUpHint, lastProducts
  });

  // Validate (lightweight Ã¢ÂÂ only category mismatch + placeholder leak)
  const validation = validateResponse(route.intent, specialist.content);
  if (!validation.ok) {
    console.warn(`[validator] ${validation.reason} Ã¢ÂÂ accepting as-is`);
  }

  return {
    message: specialist.content,
    agent_trace: {
      router: route,
      specialist: { intent: specialist.intent, iterations: specialist.iterations },
      validation: validation.ok ? 'passed' : validation.reason
    },
    usage: specialist.usage
  };
}

module.exports = { masterHandle, routeIntent };

// parser.js — deterministic NLU preprocessor for TO Assistant.
// Extracts typed slots from raw user text BEFORE the LLM sees it, so filters
// can be enforced in code rather than relying on the model to parse shorthand
// like "size 10 under 5K" correctly.
//
// Output shape:
//   {
//     category: 'shoes' | 'racquets' | 'balls' | 'strings' | 'bags' | 'accessories' | 'used' | 'sale' | null,
//     sport:    'tennis' | 'pickleball' | 'padel' | null,
//     size:     number | null,         // shoe size (numeric)
//     grip:     string | null,         // racquet grip like 'L2', '4 1/4'
//     min_price, max_price: number | null (INR),
//     brand:    string | null,         // canonical brand e.g. 'ASICS', 'Babolat'
//     skill_level: 'beginner' | 'intermediate' | 'advanced' | null,
//     gender:   "Men's" | "Women's" | "Kid's" | null,
//     court_type: string | null,
//     order_id: string | null,         // numeric order like '400020695'
//     intent_hint: 'order'|'shoe'|'racquet'|'brand'|'catalog'|'policy'|'greeting'|null,
//     compare: boolean,                // 'compare X vs Y' style
//     sort:    'price_asc'|'price_desc'|'newest'|null
//   }

const BRAND_ALIASES = {
  asics: 'ASICS', nike: 'Nike', adidas: 'Adidas', puma: 'Puma', reebok: 'Reebok',
  babolat: 'Babolat', wilson: 'Wilson', head: 'Head', yonex: 'YONEX', prince: 'Prince',
  tecnifibre: 'Tecnifibre', dunlop: 'Dunlop', volkl: 'Volkl', pacific: 'Pacific',
  solinco: 'Solinco', luxilon: 'Luxilon', k_swiss: "K-Swiss", mizuno: 'Mizuno',
  selkirk: 'Selkirk', joola: 'JOOLA', paddletek: 'Paddletek', onix: 'Onix',
  bullpadel: 'Bullpadel', nox: 'NOX', siux: 'Siux'
};

const CATEGORY_HINTS = {
  // v6.4.3: Category routing. The `balls` regex intentionally matches the bare
  // word "pickleball" (because "pickleballs" IS the ball). That caused
  // "pickleball bags" to match balls first and bags never won. Fix: check
  // SPECIFIC accessory categories (bags, shoes, machine, strings, accessories)
  // BEFORE `balls`. `balls` still precedes `racquets` so "paddle ball" routes
  // to balls (v6.3.3 invariant, preserved).
  bags:        /\b(bag|bags|backpack|kitbag|duffel|duffle)\b/i,
  shoes:       /\b(shoe|shoes|footwear|sneaker|sneakers|trainer)\b/i,
  machine:     /\b(ball ?machine|ball ?thrower|ball ?launcher|ball ?cannon|ball ?feeder)\b/i,
  strings:     /\b(string|strings|gut|polyester)\b/i,
  accessories: /\b(accessor|grip tape|overgrip|dampener|wristband|headband|cap|sock)\b/i,
  // v6.3.3 invariant: balls BEFORE racquets so "paddle ball" -> balls.
  balls:       /\b(ball|balls|tennis ball|padel ball|paddle ball|paddleball|pickleball|pickleballs)\b/i,
  // Racquets: match racquet/racket and "paddle(s)" BUT NOT when followed by " ball"
  // (that's a ball query, handled above).
  racquets:    /\b(racquet|racquets|racket|rackets|paddles?(?!\s*ball\b))\b/i,
  used:        /\b(used|second[- ]?hand|preowned|pre[- ]?owned)\b/i,
  sale:        /\b(sale|discount|offer|wimbledon|grand ?slam|boxing ?day|clearance)\b/i
};

const SPORTS = {
  tennis:     /\btennis\b/i,
  // Check padel BEFORE pickleball so "padel" doesn't ever match pickleball regex.
  // v6.3.3: "paddle ball" / "paddleball" is a common India-English alias for padel ball.
  padel:      /\b(padel|paddle\s?ball|paddleball|paddle\s+racket|paddle\s+racquet)\b/i,
  pickleball: /\bpickle ?ball\b/i
};

const SKILL_LEVELS = {
  beginner:     /\b(beginner|starter|novice|newbie|just starting|new to)\b/i,
  intermediate: /\b(intermediate|club player|recreational)\b/i,
  advanced:     /\b(advanced|pro|professional|tournament|expert)\b/i
};

const GENDER = {
  "Men's":   /\b(men|mens|men's|male|gents|boys?|guy|guys)\b/i,
  "Women's": /\b(women|womens|women's|female|ladies|girls?|lady)\b/i,
  "Kid's":   /\b(kid|kids|kid's|children|child|junior|youth)\b/i
};

const COURT_TYPES = {
  'All Court':        /\ball[- ]?court\b/i,
  'Clay Court':       /\bclay\b/i,
  'Hard Court':       /\bhard[- ]?court\b/i,
  'Padel Court':      /\bpadel court\b/i,
  'Pickleball Court': /\bpickleball court\b/i
};

function unit(u) {
  u = (u || '').toLowerCase();
  if (u === 'k') return 1000;
  if (u === 'l' || u === 'lakh' || u === 'lakhs') return 100000;
  return 1;
}

function extractPrice(text) {
  const s = text.toLowerCase();
  let min = null, max = null;

  // Range: "5-10k", "5k-10k", "500 to 2000", "₹5000 - 10000"
  const rangeRe = /\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?\s*(?:-|\u2013|to|till|until)\s*\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?/i;
  const r = s.match(rangeRe);
  if (r) {
    const lo = parseFloat(r[1].replace(/,/g, '')) * unit(r[2]);
    const hi = parseFloat(r[3].replace(/,/g, '')) * unit(r[4] || r[2]);
    if (isFinite(lo) && isFinite(hi) && hi > lo) { min = lo; max = hi; }
  }

  if (max == null) {
    const m = s.match(/(?:under|below|less than|upto|up to|<=?|within|max(?:imum)?|not more than)\s*\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?/i);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, '')) * unit(m[2]);
      if (isFinite(n)) max = n;
    }
  }
  if (min == null) {
    const m = s.match(/(?:above|over|more than|>=?|at ?least|min(?:imum)?|starting|from)\s*\u20B9?\s*([\d.,]+)\s*(k|l|lakh|lakhs)?/i);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, '')) * unit(m[2]);
      if (isFinite(n)) min = n;
    }
  }
  return { min_price: min, max_price: max };
}

function extractSize(text) {
  // "size 10", "shoe 11", "UK 9.5", "US 10", "size-6"
  const m = text.match(/\b(?:size|sz|shoe|uk|us|eu)[- ]?(\d{1,2}(?:\.\d)?)\b/i);
  if (m) {
    const n = parseFloat(m[1]);
    if (n >= 1 && n <= 15) return n;
  }
  // Standalone "size 10" or "10 size"
  const m2 = text.match(/\b(\d{1,2}(?:\.\d)?)\s*size\b/i);
  if (m2) {
    const n = parseFloat(m2[1]);
    if (n >= 1 && n <= 15) return n;
  }
  return null;
}

function extractCategory(text) {
  for (const [k, re] of Object.entries(CATEGORY_HINTS)) if (re.test(text)) return k;
  return null;
}

function extractSport(text) {
  for (const [k, re] of Object.entries(SPORTS)) if (re.test(text)) return k;
  // "sports shoe", "sport shoes" without specific sport => 'all' (search all stores)
  if (/\bsports?\s+(shoe|shoes|footwear|sneaker)/i.test(text)) return 'all';
  return null;
}

function extractBrand(text) {
  const s = text.toLowerCase();
  for (const [k, canonical] of Object.entries(BRAND_ALIASES)) {
    const re = new RegExp('\\b' + k.replace('_', '[- ]?') + '\\b', 'i');
    if (re.test(s)) return canonical;
  }
  return null;
}

function extractSkill(text) {
  for (const [k, re] of Object.entries(SKILL_LEVELS)) if (re.test(text)) return k;
  return null;
}

function extractGender(text) {
  for (const [k, re] of Object.entries(GENDER)) if (re.test(text)) return k;
  return null;
}

function extractCourt(text) {
  for (const [k, re] of Object.entries(COURT_TYPES)) if (re.test(text)) return k;
  return null;
}

function extractOrderId(text) {
  // Numeric order like 400020695 or #400020695 or "order 400..."
  const m = text.match(/(?:order|#)\s*[:\-]?\s*(\d{7,12})/i) || text.match(/\b(\d{9})\b/);
  return m ? m[1] : null;
}

function extractIntentHint(text) {
  const s = text.toLowerCase().trim();
  if (/^(hi|hello|hey|hii|good (morning|afternoon|evening)|namaste)\s*\W*$/i.test(s)) return 'greeting';
  if (/\b(review|reviews|rating|ratings|customer feedback|star|stars)\b/i.test(s)) return 'review';
  // Order detection: keyword+ID together, OR bare 9-digit number (very likely an order ID in a shopping chatbot)
  if (/\b(order|tracking|track|dispatch|shipment|delivery|status)\b/i.test(s) && extractOrderId(s)) return 'order';
  if (/^\s*\d{7,12}\s*$/.test(s)) return 'order';  // bare numeric ID => assume order
  if (/\b(return|refund|shipping|warranty|policy|contact|store hours|phone|address|location|situated|situtated|timing|timings|walk[- ]?in|visit|open|opening|close|closing|hours|directions|maps|where are you|where is (your|the) (store|shop|warehouse|office))|payment|emi|cod|coupon|welcome10|padel15|pickle15|balls3to\b/i.test(s)) return 'policy';
  // "sell my old racquet", "trade-in my aero", "buyback", "exchange my racquet" -> policy (TO evaluates case-by-case)
  if (/\b(sell (my|the|an?|old|used) |trade[- ]?in|buy[- ]?back|exchange (my|the|an?|old|used)|give away my|part exchange)\b/i.test(s)) return 'policy';
  if (/\b(brands?|which brands?|what brands?)\b/i.test(s) && !/racquet|shoe|ball/i.test(s)) return 'brand';
  const cat = extractCategory(s);
  if (cat === 'shoes') return 'shoe';
  if (cat === 'racquets') return 'racquet';
  if (cat) return 'catalog';
  return null;
}

function extractSort(text) {
  if (/\b(cheapest|lowest|low to high|ascending|budget)\b/i.test(text)) return 'price_asc';
  if (/\b(most expensive|highest|premium|top end|high to low|descending)\b/i.test(text)) return 'price_desc';
  if (/\b(newest|latest|new arrival|just released)\b/i.test(text)) return 'newest';
  return null;
}

function parseSlots(text) {
  if (!text || typeof text !== 'string') return {};
  const t = text.trim();
  const { min_price, max_price } = extractPrice(t);
  return {
    category:    extractCategory(t),
    sport:       extractSport(t),
    size:        extractSize(t),
    min_price, max_price,
    brand:       extractBrand(t),
    skill_level: extractSkill(t),
    gender:      extractGender(t),
    court_type:  extractCourt(t),
    order_id:    extractOrderId(t),
    intent_hint: extractIntentHint(t),
    sort:        extractSort(t),
    compare:     /\b(vs|versus|compare|comparison|difference between)\b/i.test(t)
  };
}

// Merge session slots with freshly parsed ones. Fresh values win where present.
// "reset words" clear prior state.
function mergeSlots(prior = {}, fresh = {}) {
  const merged = { ...prior };

  // v6.0.1: INTENT CHANGE DETECTION — when the user switches topics
  // (e.g. racquet -> bag, shoe -> order), wipe stale filters that would
  // pollute the new query. Price, brand, size, skill, style, playing style
  // are all topic-specific and must not carry over to a different intent.
  const priorIntent = prior.intent_hint || prior.category;
  const freshIntent = fresh.intent_hint || fresh.category;
  const intentChanged = freshIntent && priorIntent && freshIntent !== priorIntent;

  if (intentChanged) {
    // Wipe product-specific slots — keep session-level ones (order_id, sport)
    const wipeKeys = ['brand', 'model', 'size', 'min_price', 'max_price',
      'skill_level', 'playing_style', 'gender', 'court_type', 'quantity',
      'sort', 'normalized_query', '_page_size', '_follow_up'];
    for (const k of wipeKeys) { delete merged[k]; }
    console.log(`[mergeSlots] intent changed ${priorIntent} -> ${freshIntent}, wiped stale filters`);
  }

  for (const [k, v] of Object.entries(fresh)) {
    if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      merged[k] = v;
    }
  }
  return merged;
}

function shouldReset(text) {
  return /\b(reset|start over|new search|clear|forget (it|that)|different thing|something else)\b/i.test(text || '');
}

// Render enforced filters as a compact hint string for the LLM specialist.
function renderSlotsHint(slots) {
  if (!slots) return '';
  const parts = [];
  if (slots.category)    parts.push(`category=${slots.category}`);
  if (slots.sport)       parts.push(`sport=${slots.sport}`);
  if (slots.brand)       parts.push(`brand=${slots.brand}`);
  if (slots.size != null) parts.push(`size=${slots.size}`);
  if (slots.min_price != null) parts.push(`min_price=${slots.min_price}`);
  if (slots.max_price != null) parts.push(`max_price=${slots.max_price}`);
  if (slots.skill_level) parts.push(`skill_level=${slots.skill_level}`);
  if (slots.gender)      parts.push(`gender=${slots.gender}`);
  if (slots.court_type)  parts.push(`court_type=${slots.court_type}`);
  if (slots.sort)        parts.push(`sort=${slots.sort}`);
  if (slots.order_id)    parts.push(`order_id=${slots.order_id}`);
  return parts.join(', ');
}

// ==================== FOLLOW-UP DETECTION (v5.5.0) ====================
// Recognizes short refinement utterances that must REUSE the last search
// instead of being routed as fresh queries. Fixes the "more option" ->
// hallucinated-Babolat-racquets bug.
function detectFollowUp(text) {
  const s = String(text || '').toLowerCase().trim();
  if (!s || s.length > 80) return null;

  // "more" family — same category, different results
  if (/^(show (me )?)?(more|other|another|additional|next|few more)\s*(option|options|product|products|result|results|shoe|shoes|racquet|racquets|paddle|paddles|one|ones)?\.?\s*$/i.test(s)) {
    return { type: 'more', hint: 'Customer wants MORE products of the SAME category/type as the previous response. Re-call the same tool with the same filters. Do NOT change category. Do NOT invent a brand the customer did not name.' };
  }

  // "cheaper/costlier/better" — price refinement on same category
  if (/^(any )?(cheaper|costlier|pricier|budget|affordable|premium|better|higher end|lower end)\s*(one|ones|option|options)?\.?\s*$/i.test(s)) {
    return { type: 'price_refine', hint: 'Customer wants the SAME category but at a different price tier. Keep category/brand/sport; adjust min_price or max_price accordingly.' };
  }

  // "the first/second/third one" — selection from last list
  if (/^(the |that |this )?(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*\d)\s*(one|option|product|shoe|racquet)?\.?\s*$/i.test(s)) {
    return { type: 'select', hint: 'Customer is referring to a product from the PREVIOUS list. Do NOT re-search. Look at the previous assistant turn and elaborate on the chosen product.' };
  }

  // Bare numeric quantity: "6 shoes", "show me 10", "10 racquets"
  const qty = s.match(/^(?:show (?:me )?)?(\d{1,2})\s+(.{0,40})$/i);
  if (qty) {
    const n = parseInt(qty[1], 10);
    const remainder = qty[2].trim();
    if (n >= 1 && n <= 20) {
      return { type: 'quantity', hint: `Customer wants ${n} products. Pass page_size=${n} to smart_product_search. Keep all previous filters.`, page_size: n, remainder };
    }
  }

  // Bare single number (often a misinterpreted quantity)
  if (/^\d{1,2}\s*$/.test(s)) {
    const n = parseInt(s, 10);
    if (n >= 1 && n <= 20) return { type: 'quantity', hint: `Customer probably wants ${n} of the previous items. Pass page_size=${n}.`, page_size: n };
  }

  return null;
}

// ==================== NORMALIZER SPEC -> SLOT MAPPER (v5.6.0) ====================
// Takes a QuerySpec from the LLM normalizer and converts it to the slot shape
// the rest of the pipeline expects. Fills gaps the regex parser missed.
function slotsFromSpec(spec, existingSlots = {}) {
  if (!spec || typeof spec !== 'object') return existingSlots;
  const out = { ...existingSlots };

  // Intent hint: prefer spec's intent (more flexible categories)
  if (spec.intent && !out.intent_hint) {
    const intentMap = {
      racquet: 'racquet', shoe: 'shoe', ball: 'catalog', string: 'catalog',
      bag: 'catalog', overgrip: 'catalog', accessory: 'catalog',
      ball_machine: 'catalog', order: 'order', policy: 'policy',
      brand: 'brand', review: 'review', greeting: 'greeting', other: 'other',
      // v6.0.0: new intents
      availability: 'availability', comparison: 'comparison', starter_kit: 'starter_kit',
      coupon: 'coupon', stringing: 'stringing', tech: 'tech'
    };
    out.intent_hint = intentMap[spec.intent] || out.intent_hint;
  }

  // v6.0.1: When normalizer says this is NOT a follow-up (confidence >= 0.7),
  // treat the spec as authoritative — OVERWRITE stale slots, including nulls.
  // This fixes the "Adidas Multigame Bag" bug where old price filters persisted.
  const isNewQuery = !spec.is_follow_up && (spec.confidence || 0) >= 0.7;

  if (isNewQuery) {
    // v6.4.3: Authoritative category from spec.intent. Previously the regex
    // parser could mis-route "pickleball bags" to category='balls' (because
    // the balls regex matched "pickleball"). Even after fixing the regex
    // order, a stale session category can linger; spec.intent is the LLM's
    // authoritative signal and must win on new queries.
    const INTENT_TO_CATEGORY = {
      racquet: 'racquets', shoe: 'shoes', ball: 'balls', string: 'strings',
      bag: 'bags', overgrip: 'accessories', accessory: 'accessories',
      ball_machine: 'machine'
    };
    if (spec.intent && INTENT_TO_CATEGORY[spec.intent]) {
      out.category = INTENT_TO_CATEGORY[spec.intent];
    }
    // Authoritative overwrite — spec wins for ALL fields, including nulls that clear old values
    if (spec.sport) out.sport = spec.sport;
    if (spec.brand) out.brand = spec.brand; else delete out.brand;
    if (spec.model) out.model = spec.model; else delete out.model;
    if (spec.skill_level) out.skill_level = spec.skill_level; else delete out.skill_level;
    if (spec.playing_style) out.playing_style = spec.playing_style; else delete out.playing_style;
    if (spec.size) out.size = spec.size; else delete out.size;
    if (spec.gender) out.gender = spec.gender; else delete out.gender;
    if (spec.min_price != null) out.min_price = spec.min_price; else delete out.min_price;
    if (spec.max_price != null) out.max_price = spec.max_price; else delete out.max_price;
    if (spec.quantity != null) out.quantity = spec.quantity; else delete out.quantity;
    if (spec.order_id) out.order_id = spec.order_id;
  } else {
    // Follow-up mode — spec fills gaps only (original behavior)
    if (spec.sport && !out.sport) out.sport = spec.sport;
    if (spec.brand && !out.brand) out.brand = spec.brand;
    if (spec.model && !out.model) out.model = spec.model;
    if (spec.skill_level && !out.skill_level) out.skill_level = spec.skill_level;
    if (spec.playing_style && !out.playing_style) out.playing_style = spec.playing_style;
    if (spec.size && !out.size) out.size = spec.size;
    if (spec.gender && !out.gender) out.gender = spec.gender;
    if (spec.min_price != null && out.min_price == null) out.min_price = spec.min_price;
    if (spec.max_price != null && out.max_price == null) out.max_price = spec.max_price;
    if (spec.quantity != null && out.quantity == null) out.quantity = spec.quantity;
    if (spec.order_id && !out.order_id) out.order_id = spec.order_id;
  }

  // Follow-up metadata
  if (spec.is_follow_up) {
    out._is_follow_up = true;
    out._refinement_type = spec.refinement_type;
  }

  // The canonical normalized query for downstream tool calls
  if (spec.normalized_query) out.normalized_query = spec.normalized_query;
  if (typeof spec.confidence === 'number') out._normalizer_confidence = spec.confidence;

  return out;
}

module.exports = { parseSlots, mergeSlots, shouldReset, renderSlotsHint, detectFollowUp, slotsFromSpec };

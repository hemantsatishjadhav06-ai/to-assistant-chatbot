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
  shoes:       /\b(shoe|shoes|footwear|sneaker|sneakers|trainer)\b/i,
  racquets:    /\b(racquet|racquets|racket|rackets|paddle|paddles)\b/i,
  balls:       /\b(ball|balls|tennis ball|padel ball|pickleball)\b/i,
  strings:     /\b(string|strings|gut|polyester)\b/i,
  bags:        /\b(bag|bags|backpack|kitbag)\b/i,
  accessories: /\b(accessor|grip tape|overgrip|dampener|wristband|headband|cap|sock)\b/i,
  machine:     /\b(ball ?machine|ball ?thrower|ball ?launcher|ball ?cannon|ball ?feeder)\b/i,
  used:        /\b(used|second[- ]?hand|preowned|pre[- ]?owned)\b/i,
  sale:        /\b(sale|discount|offer|wimbledon|grand ?slam|boxing ?day|clearance)\b/i
};

const SPORTS = {
  tennis:     /\btennis\b/i,
  pickleball: /\bpickle ?ball\b/i,
  padel:      /\bpadel\b/i
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

// v4: identity extractors. Email is the primary customer key; phone secondary.
function extractEmail(text) {
  const m = text.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/);
  return m ? m[0].toLowerCase() : null;
}

function extractPhone(text) {
  // Indian mobile: optional +91, optional space/dash, 10 digits starting 6-9.
  const m = text.match(/(?:\+?91[\s-]?)?\b([6-9]\d{9})\b/);
  return m ? m[1] : null;
}

// Explicit consent phrases. Used by identity.grantConsent when true.
function detectConsentIntent(text) {
  const s = (text || '').toLowerCase();
  if (/\b(remember me|save my (preferences|details|profile)|keep my (size|details)|you can remember|save for next time)\b/.test(s)) return 'grant';
  if (/\b(forget me|delete my (data|profile|preferences)|don'?t remember|wipe my (data|profile))\b/.test(s)) return 'revoke';
  return null;
}

function extractIntentHint(text) {
  const s = text.toLowerCase().trim();
  if (/^(hi|hello|hey|hii|good (morning|afternoon|evening)|namaste)\s*\W*$/i.test(s)) return 'greeting';
  if (/\b(review|reviews|rating|ratings|customer feedback|star|stars)\b/i.test(s)) return 'review';
  if (/\b(order|tracking|track|dispatch|shipment|delivery)\b/i.test(s) && extractOrderId(s)) return 'order';
  if (/\b(return|refund|shipping|warranty|policy|contact|store hours|phone|address|payment|emi|cod|coupon|welcome10)\b/i.test(s)) return 'policy';
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
    email:       extractEmail(t),
    phone:       extractPhone(t),
    consent:     detectConsentIntent(t),
    intent_hint: extractIntentHint(t),
    sort:        extractSort(t),
    compare:     /\b(vs|versus|compare|comparison|difference between)\b/i.test(t)
  };
}

// Merge session slots with freshly parsed ones. Fresh values win where present.
// "reset words" clear prior state.
function mergeSlots(prior = {}, fresh = {}) {
  const RESET = /\b(reset|start over|new search|clear|forget|different)\b/i;
  const merged = { ...prior };
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
  return parts.join(', ');
}

module.exports = { parseSlots, mergeSlots, shouldReset, renderSlotsHint };

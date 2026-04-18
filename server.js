require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { masterHandle } = require('./agents');
const slotParser = require('./parser');
const { normalizeQuery } = require('./normalizer');
const sessionStore = require('./session');

const app = express();
app.set('trust proxy', 1);
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

// ==================== MULTI-STORE CONFIG (v5.0) ====================
// Each sport maps to its own storefront URL and (optionally) its own Magento backend.
// For now all 3 stores share a single Magento instance ÃÂ¢ÃÂÃÂ when you split backends,
// just set the env vars (e.g. MAGENTO_PADEL_BASE_URL, MAGENTO_PICKLEBALL_BASE_URL).
const STORE_CONFIG = {
  tennis: {
    name: 'TennisOutlet.in',
    storeUrl: process.env.TENNIS_STORE_URL || 'https://tennisoutlet.in',
    magentoRest: process.env.TENNIS_MAGENTO_REST || MAGENTO_REST,
    magentoToken: process.env.TENNIS_MAGENTO_TOKEN || MAGENTO_TOKEN,
    phone: '+91 9502517700',
    emoji: '\u{1F3BE}'
  },
  padel: {
    name: 'PadelOutlet.in',
    storeUrl: process.env.PADEL_STORE_URL || 'https://padeloutlet.in',
    magentoRest: process.env.PADEL_MAGENTO_REST || MAGENTO_REST,
    magentoToken: process.env.PADEL_MAGENTO_TOKEN || MAGENTO_TOKEN,
    phone: '+91 9502517700',
    emoji: '\u{1F3BE}'
  },
  pickleball: {
    name: 'PickleballOutlet.in',
    storeUrl: process.env.PICKLEBALL_STORE_URL || 'https://pickleballoutlet.in',
    magentoRest: process.env.PICKLEBALL_MAGENTO_REST || MAGENTO_REST,
    magentoToken: process.env.PICKLEBALL_MAGENTO_TOKEN || MAGENTO_TOKEN,
    phone: '+91 9502517700',
    emoji: '\u{1F3D3}'
  }
};

function getStoreConfig(sport) {
  const s = String(sport || 'tennis').toLowerCase();
  return STORE_CONFIG[s] || STORE_CONFIG.tennis;
}

function getStoreUrl(sport) {
  return getStoreConfig(sport).storeUrl;
}

// v6.1.2: COMPLETE category-to-sport mapping from Magento category tree.
// Every category ID mapped to its correct store URL.
// Padel categories -> padeloutlet.in | Pickleball -> pickleballoutlet.in | Tennis -> tennisoutlet.in
const CATEGORY_TO_SPORT = {
  // ===== PADEL OUTLET (padeloutlet.in) =====
  // Padel Outlet root
  245: 'padel',
  // Rackets (272) + brand subcats
  272: 'padel', 277: 'padel', 278: 'padel', 279: 'padel', 280: 'padel',
  303: 'padel', 329: 'padel', 331: 'padel', 339: 'padel', 427: 'padel',
  // Balls (273) + brand subcats
  273: 'padel', 281: 'padel', 282: 'padel', 283: 'padel', 284: 'padel',
  313: 'padel', 360: 'padel', 428: 'padel', 453: 'padel',
  // Shoes (274) + brand subcats
  274: 'padel', 287: 'padel', 288: 'padel', 289: 'padel', 290: 'padel',
  291: 'padel', 314: 'padel', 367: 'padel', 424: 'padel',
  // Bags (275) + brand subcats
  275: 'padel', 304: 'padel', 305: 'padel', 306: 'padel', 318: 'padel',
  330: 'padel', 369: 'padel',
  // Accessories, Sale, Collections, Best Sellers
  276: 'padel', 363: 'padel', 375: 'padel', 432: 'padel', 436: 'padel', 452: 'padel',

  // ===== PICKLEBALL OUTLET (pickleballoutlet.in) =====
  // Pickle Ball Outlet root
  243: 'pickleball',
  // Paddles (250) + brand subcats
  250: 'pickleball', 257: 'pickleball', 258: 'pickleball', 259: 'pickleball',
  260: 'pickleball', 261: 'pickleball', 262: 'pickleball', 302: 'pickleball',
  307: 'pickleball', 332: 'pickleball', 333: 'pickleball', 345: 'pickleball',
  351: 'pickleball', 354: 'pickleball', 355: 'pickleball', 356: 'pickleball',
  357: 'pickleball', 394: 'pickleball', 400: 'pickleball', 407: 'pickleball',
  426: 'pickleball', 438: 'pickleball', 439: 'pickleball', 441: 'pickleball',
  445: 'pickleball', 447: 'pickleball',
  // Balls (252) + brand subcats
  252: 'pickleball', 263: 'pickleball', 264: 'pickleball', 265: 'pickleball',
  266: 'pickleball', 311: 'pickleball', 312: 'pickleball', 350: 'pickleball',
  388: 'pickleball', 403: 'pickleball', 440: 'pickleball', 448: 'pickleball',
  // Shoes (253) + brand subcats
  253: 'pickleball', 267: 'pickleball', 268: 'pickleball', 269: 'pickleball',
  270: 'pickleball', 271: 'pickleball', 365: 'pickleball', 404: 'pickleball',
  // Bags (254) + brand subcats
  254: 'pickleball', 308: 'pickleball', 309: 'pickleball', 310: 'pickleball',
  334: 'pickleball', 340: 'pickleball', 352: 'pickleball', 405: 'pickleball',
  // Net & Post, Accessories, Promotional, Sale, Bloom, Best Sellers, etc.
  255: 'pickleball', 256: 'pickleball', 328: 'pickleball', 353: 'pickleball',
  389: 'pickleball', 393: 'pickleball', 399: 'pickleball', 406: 'pickleball',
  429: 'pickleball', 431: 'pickleball', 435: 'pickleball', 446: 'pickleball',
  455: 'pickleball',
  // Syxx (401) — pickleball brand with own root
  401: 'pickleball', 402: 'pickleball', 408: 'pickleball', 409: 'pickleball',
  410: 'pickleball', 411: 'pickleball', 412: 'pickleball', 413: 'pickleball',
  414: 'pickleball', 415: 'pickleball', 416: 'pickleball', 417: 'pickleball',
  418: 'pickleball', 419: 'pickleball', 420: 'pickleball', 421: 'pickleball',
  433: 'pickleball',

  // ===== TENNIS OUTLET (tennisoutlet.in) =====
  // Racquets (25) + all brand/level subcats
  25: 'tennis', 26: 'tennis', 34: 'tennis', 35: 'tennis', 44: 'tennis', 45: 'tennis',
  46: 'tennis', 47: 'tennis', 48: 'tennis', 49: 'tennis', 50: 'tennis', 51: 'tennis',
  52: 'tennis', 53: 'tennis', 54: 'tennis', 55: 'tennis', 56: 'tennis', 57: 'tennis',
  58: 'tennis', 59: 'tennis', 60: 'tennis', 61: 'tennis', 62: 'tennis', 63: 'tennis',
  64: 'tennis', 65: 'tennis', 66: 'tennis', 67: 'tennis', 69: 'tennis', 70: 'tennis',
  71: 'tennis', 72: 'tennis', 73: 'tennis', 74: 'tennis', 75: 'tennis', 76: 'tennis',
  77: 'tennis', 78: 'tennis', 79: 'tennis', 80: 'tennis', 81: 'tennis', 82: 'tennis',
  83: 'tennis', 84: 'tennis', 85: 'tennis', 86: 'tennis', 87: 'tennis', 88: 'tennis',
  89: 'tennis', 90: 'tennis', 166: 'tennis', 173: 'tennis', 178: 'tennis', 179: 'tennis',
  180: 'tennis', 181: 'tennis', 210: 'tennis', 211: 'tennis', 212: 'tennis', 213: 'tennis',
  214: 'tennis', 239: 'tennis', 248: 'tennis', 319: 'tennis', 324: 'tennis', 325: 'tennis',
  326: 'tennis', 327: 'tennis', 336: 'tennis', 337: 'tennis', 346: 'tennis', 347: 'tennis',
  348: 'tennis', 358: 'tennis', 359: 'tennis', 364: 'tennis', 370: 'tennis', 376: 'tennis',
  422: 'tennis', 423: 'tennis',
  // Strings (29) + brand subcats
  29: 'tennis', 30: 'tennis', 33: 'tennis', 122: 'tennis', 123: 'tennis', 124: 'tennis',
  125: 'tennis', 126: 'tennis', 127: 'tennis', 177: 'tennis', 182: 'tennis', 185: 'tennis',
  186: 'tennis', 187: 'tennis', 188: 'tennis', 189: 'tennis', 190: 'tennis', 191: 'tennis',
  192: 'tennis', 193: 'tennis', 194: 'tennis', 195: 'tennis', 196: 'tennis', 223: 'tennis',
  224: 'tennis', 233: 'tennis', 235: 'tennis', 236: 'tennis', 321: 'tennis', 341: 'tennis',
  342: 'tennis', 343: 'tennis', 344: 'tennis', 371: 'tennis', 372: 'tennis', 373: 'tennis',
  374: 'tennis',
  // Shoes (24) + brand subcats
  24: 'tennis', 28: 'tennis', 103: 'tennis', 104: 'tennis', 105: 'tennis', 106: 'tennis',
  107: 'tennis', 237: 'tennis', 322: 'tennis',
  // Balls (31) + brand subcats
  31: 'tennis', 32: 'tennis', 91: 'tennis', 92: 'tennis', 93: 'tennis', 94: 'tennis',
  95: 'tennis', 96: 'tennis', 97: 'tennis', 98: 'tennis', 99: 'tennis', 100: 'tennis',
  101: 'tennis', 102: 'tennis', 361: 'tennis',
  // Bags (115) + brand subcats
  115: 'tennis', 116: 'tennis', 117: 'tennis', 118: 'tennis', 119: 'tennis', 120: 'tennis',
  121: 'tennis',
  // Clothing (36) + subcats
  36: 'tennis', 108: 'tennis', 109: 'tennis', 110: 'tennis', 111: 'tennis', 112: 'tennis',
  113: 'tennis', 114: 'tennis', 368: 'tennis',
  // Accessories (37) + subcats
  37: 'tennis', 128: 'tennis', 129: 'tennis', 130: 'tennis', 131: 'tennis', 132: 'tennis',
  133: 'tennis', 134: 'tennis', 135: 'tennis', 136: 'tennis', 183: 'tennis', 390: 'tennis',
  // Other (137) + subcats
  137: 'tennis', 184: 'tennis', 138: 'tennis', 139: 'tennis', 140: 'tennis', 450: 'tennis',
  // Stringing (38) + all subcats
  38: 'tennis', 39: 'tennis', 40: 'tennis', 41: 'tennis', 42: 'tennis', 43: 'tennis',
  197: 'tennis', 198: 'tennis', 199: 'tennis', 200: 'tennis', 201: 'tennis', 202: 'tennis',
  203: 'tennis', 204: 'tennis', 205: 'tennis', 206: 'tennis', 207: 'tennis', 209: 'tennis',
  315: 'tennis', 316: 'tennis', 320: 'tennis', 442: 'tennis', 443: 'tennis', 444: 'tennis',
  // Pro Store, Brands, Clearance, Sales, Best Sellers, Promotions
  164: 'tennis', 165: 'tennis', 240: 'tennis', 241: 'tennis', 242: 'tennis', 249: 'tennis',
  292: 'tennis', 293: 'tennis', 294: 'tennis', 295: 'tennis', 296: 'tennis', 297: 'tennis',
  298: 'tennis', 299: 'tennis', 335: 'tennis', 338: 'tennis', 349: 'tennis', 362: 'tennis',
  377: 'tennis', 378: 'tennis', 379: 'tennis', 380: 'tennis', 381: 'tennis', 382: 'tennis',
  383: 'tennis', 384: 'tennis', 386: 'tennis', 387: 'tennis', 391: 'tennis', 392: 'tennis',
  395: 'tennis', 396: 'tennis', 397: 'tennis', 398: 'tennis', 425: 'tennis', 430: 'tennis',
  434: 'tennis', 437: 'tennis', 449: 'tennis', 451: 'tennis', 454: 'tennis'
};

// v6.4.5: CATEGORY_SUBTREE — parent → [self, ...all known descendants].
// Derived from the authoritative Magento category tree (admin-confirmed).
// Used by getProductsByCategory so a query for "pickleball shoes" (253) traverses
// brand subcats 267/268/269/270/271/365/404 too. Without this, cross-listed tennis
// shoes dominate category 253 and in-stock PISH* items get paginated out.
const CATEGORY_SUBTREE = {
  // ===== PICKLEBALL (root 243) =====
  243: [243,
        250, 257, 258, 259, 260, 261, 262, 302, 307, 332, 333, 345, 351, 354, 355, 356, 357,
        394, 400, 407, 426, 438, 439, 441, 445, 447,
        252, 263, 264, 265, 266, 311, 312, 350, 388, 403, 440, 448,
        253, 267, 268, 269, 270, 271, 365, 404,
        254, 308, 309, 310, 334, 340, 352, 405,
        255, 256, 328, 353, 389, 393, 399, 406, 429, 431, 435, 446, 455],
  250: [250, 257, 258, 259, 260, 261, 262, 302, 307, 332, 333, 345, 351, 354, 355, 356, 357,
        394, 400, 407, 426, 438, 439, 441, 445, 447],           // Pickleball Paddles
  252: [252, 263, 264, 265, 266, 311, 312, 350, 388, 403, 440, 448], // Pickleball Balls
  253: [253, 267, 268, 269, 270, 271, 365, 404],                    // Pickleball Shoes (ASICS/Nike/Joma/Yonex/Babolat/Adidas/Hundred)
  254: [254, 308, 309, 310, 334, 340, 352, 405],                    // Pickleball Bags
  255: [255],                                                        // Pickleball Net & Post
  256: [256, 328, 353, 389, 393, 399, 406, 429, 431, 435, 446, 455], // Pickleball Accessories

  // ===== PADEL (root 245) =====
  245: [245,
        272, 277, 278, 279, 280, 303, 329, 331, 339, 427,
        273, 281, 282, 283, 284, 313, 360, 428, 453,
        274, 287, 288, 289, 290, 291, 314, 367, 424,
        275, 304, 305, 306, 318, 330, 369,
        276, 363, 375, 432, 436, 452],
  272: [272, 277, 278, 279, 280, 303, 329, 331, 339, 427],           // Padel Rackets
  273: [273, 281, 282, 283, 284, 313, 360, 428, 453],                // Padel Balls
  274: [274, 287, 288, 289, 290, 291, 314, 367, 424],                // Padel Shoes
  275: [275, 304, 305, 306, 318, 330, 369],                          // Padel Bags
  276: [276, 363, 375, 432, 436, 452],                               // Padel Accessories

  // ===== TENNIS (root) =====
  24: [24, 28, 103, 104, 105, 106, 107, 237, 322],                   // Tennis Shoes
  29: [29, 30, 33, 122, 123, 124, 125, 126, 127, 177, 182, 185, 186, 187, 188, 189, 190,
       191, 192, 193, 194, 195, 196, 223, 224, 235, 236, 321, 341, 342, 343, 344, 371, 372, 373, 374], // Tennis Strings
  31: [31, 32, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 361], // Tennis Balls
  36: [36, 108, 109, 110, 111, 112, 113, 114, 368],                  // Tennis Clothing
  37: [37, 128, 129, 130, 131, 132, 133, 134, 135, 136, 183, 390],   // Tennis Accessories
  115: [115, 116, 117, 118, 119, 120, 121, 233],                     // Tennis Bags (incl. Asics 233 per admin tree)
  25: [25, 26, 34, 35, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
       61, 62, 63, 64, 65, 66, 67, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82,
       83, 84, 85, 86, 87, 88, 89, 166, 173, 178, 179, 180, 181, 210, 211, 212, 213, 214,
       239, 248, 319, 324, 325, 326, 327, 336, 337, 346, 347, 348, 358, 359, 364, 370, 376,
       422, 423],                                                    // Tennis Racquets
  90: [90],                                                          // Tennis Used Racquets
  38: [38, 39, 40, 41, 42, 43, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 209,
       315, 316, 320, 442, 443, 444]                                 // Tennis Stringing Machines/Supplies
};

// Helper: return the category IDs to search for a given parent.
// Defaults to [categoryId] when parent is not in the subtree map.
function expandCategorySubtree(categoryId) {
  const id = parseInt(categoryId);
  if (!Number.isFinite(id)) return [];
  return CATEGORY_SUBTREE[id] || [id];
}

function detectSportFromProduct(item, fallbackSport = 'tennis') {
  // v6.4.5: PRIORITY 0 — SKU prefix is the MOST reliable signal.
  // Magento instance convention:
  //   TSH*  = tennis shoe          |  PISH* = pickleball shoe  |  PDSH* = padel shoe
  //   TBG*  = tennis bag           |  PIBG* = pickleball bag   |  PDBG* = padel bag
  //   TBL*  = tennis ball          |  PIBL* = pickleball ball  |  PDBL* = padel ball
  //   TRA*  = tennis racquet       |  PIPD* = pickleball paddle |  PDRA* = padel racket
  //   TST*  = tennis string
  // When a product name omits the sport word (e.g. "ASICS Solution Speed FF 2"),
  // the SKU is the ONLY way to know which catalog it really belongs to.
  const skuUpper = String(item.sku || '').toUpperCase();
  if (/^PISH/.test(skuUpper) || /^PIBG/.test(skuUpper) || /^PIBL/.test(skuUpper) ||
      /^PIPD/.test(skuUpper) || /^PIAC/.test(skuUpper) || /^PINP/.test(skuUpper)) {
    return 'pickleball';
  }
  if (/^PDSH/.test(skuUpper) || /^PDBG/.test(skuUpper) || /^PDBL/.test(skuUpper) ||
      /^PDRA/.test(skuUpper) || /^PDAC/.test(skuUpper)) {
    return 'padel';
  }
  if (/^TSH/.test(skuUpper) || /^TBG/.test(skuUpper) || /^TBL/.test(skuUpper) ||
      /^TRA/.test(skuUpper) || /^TST/.test(skuUpper) || /^TAC/.test(skuUpper) ||
      /^TCL/.test(skuUpper)) {
    return 'tennis';
  }

  // v6.1.5: PRIORITY 1 — Detect sport from product NAME / url_key.
  const nameLower = String(item.name || '').toLowerCase();
  const skuLower = String(item.sku || '').toLowerCase();
  const attrs = (item.custom_attributes || []).reduce((a, c) => { a[c.attribute_code] = c.value; return a; }, {});
  const urlKeyLower = String(attrs.url_key || '').toLowerCase();
  const combined = `${nameLower} ${skuLower} ${urlKeyLower}`;

  // Check for padel indicators (must check before tennis because "padel" is unambiguous)
  if (combined.includes('padel')) return 'padel';
  // Check for pickleball indicators
  if (combined.includes('pickleball') || combined.includes('pickle ball')) return 'pickleball';

  // PRIORITY 2 — Try category_ids if available (rarely works on this Magento instance)
  const catIds = attrs.category_ids;
  if (catIds) {
    const ids = Array.isArray(catIds) ? catIds : String(catIds).split(',').map(s => s.trim());
    for (const id of ids) {
      const sport = CATEGORY_TO_SPORT[parseInt(id)];
      if (sport) return sport;
    }
  }

  // PRIORITY 3 — Fallback to the sport parameter passed by the caller
  return String(fallbackSport || 'tennis').toLowerCase();
}

// OAuth 1.0a credentials (used for orders endpoint which requires admin OAuth)
const OAUTH_CONSUMER_KEY = process.env.MAGENTO_CONSUMER_KEY;
const OAUTH_CONSUMER_SECRET = process.env.MAGENTO_CONSUMER_SECRET;
const OAUTH_ACCESS_TOKEN = process.env.MAGENTO_ACCESS_TOKEN;
const OAUTH_ACCESS_TOKEN_SECRET = process.env.MAGENTO_ACCESS_TOKEN_SECRET;

// ==================== LAYER 1: SPORT DETECTION (v6.3.0) ====================
// Sport-specific keyword map. Brand names are sport-distinctive for many brands
// (Selkirk / Joola = pickleball; Bullpadel / Nox = padel; Babolat Pure Drive =
// tennis, etc.) so querying by brand alone disambiguates the sport without the
// customer having to say it. Any brand that is cross-sport (e.g. "Wilson" is sold
// in all three) is intentionally omitted — it would poison disambiguation.
const SPORT_KEYWORDS = {
  tennis: [
    // direct sport words
    'tennis', 'atp', 'wta', 'grand slam', 'wimbledon', 'roland garros', 'us open',
    // tennis-only brand/model signals
    'pro staff', 'pure drive', 'pure aero', 'blade 98', 'head speed', 'head radical', 'head gravity',
    'yonex ezone', 'yonex vcore', 'yonex percept', 'prince textreme', 'tecnifibre tfight',
    'solinco', 'dunlop cx', 'dunlop fx', 'slazenger', 'penn championship', 'wilson triniti'
  ],
  pickleball: [
    // direct sport words (cover common typos/variants)
    'pickleball', 'pickle ball', 'pickle-ball', 'pickleballs', 'pickle', 'pickball',
    'paddleball', 'paddle ball',
    // pickleball-only brand/model signals
    'selkirk', 'joola', 'paddletek', 'onix', 'gamma pickleball', 'engage',
    'franklin x-40', 'franklin x40', 'dura fast 40', 'hyper ball',
    'vatic pro', 'crbn', 'proxr', 'six zero', 'diadem pickleball'
  ],
  padel: [
    // direct sport words (cover typos)
    'padel', 'padle', 'padell', 'paddel',
    // padel-only brand/model signals
    'bullpadel', 'nox ', 'nox at', 'nox ml10', 'nox x-one',
    'head padel', 'head delta', 'babolat padel', 'babolat technical',
    'adidas padel', 'adidas adipower', 'wilson padel', 'star vie', 'starvie',
    'siux', 'varlion', 'dunlop padel', 'asics padel'
  ]
};

// v6.3.0: Central sport detector. Returns 'tennis'|'pickleball'|'padel' when the
// sport is resolvable from either (a) the current query, or (b) any recent user
// turn in the provided history. Returns null when ambiguous — the caller MUST
// then invoke the clarification gate rather than guess.
function detectSport(query, conversationHistory = []) {
  const q = String(query || '').toLowerCase();
  // Check current query first — most specific signal.
  for (const [sport, keywords] of Object.entries(SPORT_KEYWORDS)) {
    if (keywords.some(kw => q.includes(kw))) return sport;
  }
  // Sticky-context fallback: walk history newest→oldest so a sport mentioned on
  // the previous turn still resolves follow-ups like "any under 500?".
  if (Array.isArray(conversationHistory)) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const m = conversationHistory[i];
      if (!m || m.role !== 'user') continue;
      const s = String(m.content || '').toLowerCase();
      for (const [sport, keywords] of Object.entries(SPORT_KEYWORDS)) {
        if (keywords.some(kw => s.includes(kw))) return sport;
      }
    }
  }
  return null;
}

// ==================== LAYER 3: SPORT COACHING NOTES (v6.3.0) ====================
// Injected into the LLM's system message once a sport is resolved. Scopes the
// "Coach" persona to that sport's product lore so the LLM never cross-contaminates
// (e.g. never recommends a tennis ball for padel, never calls a pickleball felt).
const SPORT_COACHING_NOTES = {
  tennis: [
    'Tennis balls are pressurized, felt-covered, ~65mm diameter, yellow.',
    'Pressurized tournament balls (Wilson US Open, Head Championship, Dunlop Fort) for matches; pressureless (Tretorn Micro X) for practice/ball-machines.',
    'A tennis ball is NOT a padel ball (padel is lower-pressure) and NOT a pickleball (pickleball is perforated plastic).',
    'Tennis shoes have reinforced toes and lateral support for baseline sliding on hard/clay courts.'
  ].join(' '),
  pickleball: [
    'Pickleballs are PERFORATED PLASTIC (not felt), ~74mm, with an indoor variant (smaller holes, softer) and outdoor variant (larger holes, harder).',
    'USAPA-approved standards include Franklin X-40 (outdoor), Dura Fast 40 (outdoor), Onix Fuse, Joola Primo.',
    'A tennis ball or padel ball is NOT a pickleball substitute — different sport, different physics.',
    'Pickleball shoes prioritize lateral quickness and court feel; they are lighter than full tennis shoes.'
  ].join(' '),
  padel: [
    'Padel balls look like tennis balls but have SLIGHTLY LOWER pressure (lower bounce) per FIP regulations.',
    'Key padel ball brands: Head Padel Pro, Bullpadel Next, Wilson Padel, Babolat Padel Team, Adidas Padel.',
    'Never recommend a standard tennis ball for padel — it bounces too high for the glass-walled court game.',
    'Padel shoes have a herringbone / clay-court style tread for artificial grass + sand courts.'
  ].join(' ')
};

// ==================== SYSTEM PROMPT ====================
const SYSTEM_PROMPT = `You are "TO Assistant" - the official Customer Support Assistant for Pro Sports Outlets, India's trusted online stores for racquet sports:
- Tennis: TennisOutlet.in (https://tennisoutlet.in)
- Pickleball: PickleballOutlet.in (https://pickleballoutlet.in)
- Padel: PadelOutlet.in (https://padeloutlet.in)
Route product links to the correct store based on the sport detected.

BRAND INFORMATION:
- Websites: https://tennisoutlet.in (Tennis) | https://pickleballoutlet.in (Pickleball) | https://padeloutlet.in (Padel)
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

PRODUCT PRESENTATION RULES (MANDATORY ÃÂ¢ÃÂÃÂ NEVER SKIP):
- Return AT LEAST 4-5 products whenever the catalog has them.
- EVERY product MUST be a clickable markdown link using the product_url field from the tool response. This is the #1 most important rule.
- Use this EXACT markdown format ÃÂ¢ÃÂÃÂ the UI renders it as clickable links:

1. **[Product Name](https://SPORT-STORE-URL/actual-product-slug.html)**
   Price: \u20B9X,XXX
   Coach's Take: <one-line reason / ideal user>

- The product_url is already in every product object the tool returns. Copy it exactly into the markdown link parentheses. The URL already points to the correct store (tennisoutlet.in, pickleballoutlet.in, or padeloutlet.in) based on the sport. Example: if the tool returns product_url: "https://pickleballoutlet.in/joola-hyperion-vision-16-mm-storm-blue.html", write: **[Joola Hyperion Vision 16 mm - Storm Blue](https://pickleballoutlet.in/joola-hyperion-vision-16-mm-storm-blue.html)**
- If you list a product WITHOUT a clickable link, the response is BROKEN and unusable. Always include the link.
- NEVER show quantity/stock numbers to the customer.
- ONLY recommend products where in_stock is true. If a product has in_stock: false or qty: 0, SKIP it entirely ÃÂ¢ÃÂÃÂ do not mention it.
- NEVER use markdown images ![]().
- NEVER add target="_blank" or raw HTML attributes in your text.
- The tool returns products sorted highest-qty first. Feature the FIRST product prominently as the recommended upsell pick.
- After the list, add a short "Coach's Verdict" comparative insight (beginner vs. intermediate, power vs. control, etc.).

TERMINOLOGY MAP (CRITICAL - always apply BEFORE routing):
- "paddleball" / "paddle ball" / "pickle" / "pickball" / "pickleball" -> PICKLEBALL sport. Paddle product = pickleball paddle (category 250). Balls = 252. Shoes = 253.
- "padel" / "padel tennis" -> PADEL sport. Racket (not paddle) = category 272. Balls = 273. Shoes = 274.
- "ball machine" / "ball thrower" / "ball cannon" / "ball launcher" / "ball feeder" / "ai ball machine" / "smart ball machine" -> MUST call get_ball_machines. Never use get_products_by_category or search_products for these.
- If the customer uses ambiguous term "paddle": assume PICKLEBALL PADDLE unless they explicitly say "padel". If "racket" without sport, assume TENNIS.
- If a query mentions ANY product that exists in our catalog (tennis, pickleball, padel, ball machine, shoes, strings, bags, accessories), you MUST call the appropriate Magento tool. NEVER reply "we don't have that" or "I can't fetch" without first trying search_products as a fallback.

SPORT CLARIFICATION (v6.2.1 — ALWAYS CHECK FIRST):
- Before calling any product tool, confirm which SPORT the customer is shopping for: tennis, pickleball, or padel.
- If the query is a generic "shoes", "balls", "racquet", "racket", or "paddle" WITHOUT naming a sport AND no sport was mentioned earlier in the conversation: DO NOT call any tool. Instead reply with: "Happy to help you find the right [shoes/balls/racquet or paddle]! Which sport are you shopping for — tennis, pickleball, or padel? Once you tell me, I'll pull the in-stock options for that sport." Then wait for the customer to answer.
- Once the customer names a sport (or if the sport is clear from earlier in the conversation), proceed with the appropriate tool and pass sport=<their answer>.

CROSS-SPORT HARD RULES (v6.3.0 — NEVER VIOLATE):
- Every product returned by tools now carries a "sport" field (tennis / pickleball / padel). This is AUTHORITATIVE and derived from the product's own Magento categories.
- When the conversation is locked to a sport (either the customer named it, or a coaching directive system message specifies SPORT SCOPE), you MUST ONLY recommend products whose sport matches that locked sport. Drop any product whose sport differs — do not mention it, do not link it, do not justify it.
- NEVER suggest a tennis ball for padel play, a tennis ball for pickleball play, a pickleball for tennis, or vice-versa. These are different balls with different physics (tennis = pressurized felt, pickleball = perforated plastic, padel = lower-pressure felt).
- NEVER suggest tennis shoes for pickleball or padel play, or vice-versa, once the sport is locked.
- If a product's "sport" field disagrees with the conversation's locked sport, treat it as a retrieval miss — tell the customer the in-stock list for their sport is empty or slim, and offer to widen the search. Do NOT silently substitute the wrong-sport item.
- Product names, prices, and product_url MUST be copied verbatim from the tool response. NEVER invent, guess, or reconstruct a URL/SKU/price.

ROUTING RULES (STRICT - follow these exactly):
- ANY query about RACQUETS / RACKETS / PADDLES (tennis racquet, padel racket, pickleball paddle, paddleball paddle, brand-specific) -> MUST call get_racquets_with_specs with the correct sport (tennis/padel/pickleball). If the customer didn't specify a sport and none is in conversation history, ASK FIRST (see SPORT CLARIFICATION above). NEVER use get_products_by_category for racquets. NEVER use best-seller categories (338/434).
- ANY query about SHOES / FOOTWEAR -> MUST call get_shoes_ultra (v6.5 — dedicated shoe tool). NEVER use get_products_by_category or get_shoes_with_specs for shoes. Pass the sport ('tennis'/'pickleball'/'padel') or 'all' if unknown, and pass size verbatim when the customer mentioned one.
- ANY query about BRANDS carried by the store -> call list_brands.
- BALLS -> get_balls. Pass sport='tennis' for tennis balls, sport='pickleball' for pickleball balls, sport='padel' for padel balls. If the customer just says 'balls' (no sport) AND no sport is in conversation history, ASK FIRST rather than calling the tool. Only products with real quantity >= 1 are returned. NEVER use get_products_by_category for balls.
- STRINGS -> get_products_by_category (29).
- BAGS -> get_products_by_category (115).
- ACCESSORIES -> get_products_by_category (37).
- USED racquets -> get_products_by_category (90).
- Sale/Wimbledon/Grand Slam offers -> get_products_by_category (292/349/437).
- RACQUET UPGRADE / TRADE-IN / SELL OLD RACQUET -> Direct customer to: https://tennisoutlet.in/racquet-upgrade-program ÃÂ¢ÃÂÃÂ we purchase customer's old racquets through our Racquet Upgrade Program.
- COMPARISON / "compare X vs Y" / "difference between X and Y" / "X or Y, which is better" -> MUST call compare_products with queries=[productA, productB, ...] (2-6 items). The tool auto-resolves each product, filters qty>=1, and returns specs for a side-by-side answer. Use this for ALL product types (racquets, shoes, paddles, bags, balls). NEVER try to stitch together a comparison from multiple search_products calls — compare_products does it in one hop.
- FALLBACK: If no rule above matches the product type, call search_products with the customer's keywords. NEVER refuse a product query without trying at least one Magento tool.

SMART GUIDELINES:
- Beginner racquet -> get_racquets_with_specs({skill_level:"beginner"}) + add beginner advice (lighter, larger head size, forgiving).
- Brand-specific racquet -> get_racquets_with_specs({brand:"Babolat"|"Head"|"Wilson"|"YONEX"|"Prince"...}).
- Expensive items -> mention WELCOME10 coupon (10% off up to \u20B9300) for first-time buyers.
- Cross-sell: racquet -> suggest strings/bags/shoes.
- When recommending new racquets, mention the Racquet Upgrade Program (https://tennisoutlet.in/racquet-upgrade-program) ÃÂ¢ÃÂÃÂ customers can trade in their old racquet.

SIZE / SIZE-SPECIFIC REQUESTS (CRITICAL - READ CAREFULLY):
- Shoe size is encoded as the LAST NUMBER in the product name (e.g. "Asics Gel Resolution 9 - 10" = size 10; "Nike Vapor Pro 11.5" = size 11.5). Every shoe product name ends with its size.
- When a customer asks for shoes in size X: call get_shoes_ultra with sport and size=X. The tool response tells you size_available (boolean). Trust size_available and each product's sizes_in_stock — do NOT claim a size is unavailable if sizes_in_stock lists it.
- After the tool returns, YOU must filter the products list: read the LAST NUMBER in each product name and only present the shoes whose trailing number equals the requested size.
- If one or more products match size X: present those products only, with their clickable links, and a short note: "Here are the size X shoes we have in stock."
- If NO products in the returned list match size X: tell the customer PLAINLY: "We don't have size X [sport] shoes in stock right now." Then look at the trailing numbers in the returned product names, pick the 2-3 closest available sizes, and offer them by name ("We do have these in size 9 and size 10: <product A>, <product B>").
- NEVER say "check size availability on the product page". NEVER say "you can select size on each product page". NEVER tell the customer to go hunt for their size on the website - that is the whole reason they are chatting with you.
- NEVER mix sports. If the customer asked for tennis shoes, do not show padel or pickleball shoes, even if the padel/pickleball shoes happen to be in the requested size.
- The tool response includes a "customer_query" object that echoes what you asked for - use it to stay grounded on sport and size.
- For shoe queries WITHOUT a size: call get_shoes_ultra normally, show 4-5 products, and you do NOT need to filter by size.
- If the customer says "sports shoes" or just "shoes" without specifying tennis/pickleball/padel, ONLY THEN pass sport="all".
- Same size-from-name logic applies to apparel sizes (S/M/L/XL) and racquet grip sizes when present in product names.

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

Use the sport-specific store URL for all product links: Tennis=https://tennisoutlet.in, Pickleball=https://pickleballoutlet.in, Padel=https://padeloutlet.in. The tool already returns the correct product_url ÃÂ¢ÃÂÃÂ just use it.`;

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
          min_price: { type: "number", description: "Optional minimum price in INR (resolved against enriched configurable-child price)." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand: '5K'->5000, '1L'/'1 lakh'->100000." },
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
      description: "Return shoes from TennisOutlet with FULL resolved specs. Use this for ANY shoe query including brand, size availability, price caps, or spec filtering. All filters optional and AND-combined. No server-side size filtering - LLM determines sizes from product names/SKUs ÃÂ¢ÃÂÃÂ if the requested size is out of stock the product is excluded.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "pickleball", "padel", "all"], default: "all" },
          brand: { type: "string", description: "Brand name like 'ASICS', 'Nike', 'Adidas'. Optional." },
          shoe_type: { type: "string", description: "Men's / Women's / Kid's. Optional." },
          court_type: { type: "string", description: "All Court / Clay Court / Hard Court / Padel Court / Pickleball Court. Optional." },
          width: { type: "string", description: "Narrow / Medium / Wide. Optional." },
          cushioning: { type: "string", description: "Low / Medium / High. Optional." },
          size: { type: "string", description: "Shoe size the customer wants (e.g. '10', '9.5'). Filters to products where that size's child SKU is in stock." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand before calling: '5K'->5000, '1L'->100000, 'under 8000'->8000." },
          page_size: { type: "integer", default: 10 }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_shoes_ultra",
      description: "NEW v6.5.0 — purpose-built shoe lookup that NEVER lies about size availability. Scans every shoe category (tennis 24, pickleball 253, padel 274) and all brand subcategories, loads configurable children + real MSI stock for each parent, parses shoe size from the LAST NUMBER in every child product name AND SKU suffix, and filters by qty >= 1. If a size is requested the tool only returns parents whose exact-size child is in stock; otherwise it returns every shoe with at least one in-stock size (with sizes_in_stock). Prefer this tool for ANY shoe query including size-specific asks like 'size 8 shoes' / 'any shoe in size 10'. Returns {products:[{name,sku,price,qty,sizes_in_stock,has_requested_size,...}], size_requested, size_available, message}.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "pickleball", "padel", "all"], default: "all", description: "Which sport's shoe catalog to scan. Use 'all' when the customer did not specify a sport." },
          brand: { type: "string", description: "Optional brand name (ASICS, Nike, Adidas, Yonex, Babolat, Joma, Hundred)." },
          size: { type: "string", description: "The customer's shoe size (e.g. '8', '10', '9.5'). Pass exactly what the customer said. Omit if no size mentioned." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand: '5K'->5000, '1L'->100000." },
          page_size: { type: "integer", default: 10, description: "Max products to return (1-20)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_racquets_with_specs",
      description: "Return RACQUETS (not balls, not accessories) from the correct racquet category with brand resolved. ALWAYS use this for any query about racquets/rackets/paddles - NEVER use get_products_by_category for racquet queries. Tennis Racquets=25, Padel Rackets=272, Pickleball Paddles=250. Supports brand, skill_level, playing_style, and price filters. For 'best balance' / 'balanced' queries use playing_style='balance'.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "padel", "pickleball"], default: "tennis" },
          brand: { type: "string", description: "Brand name like Babolat, Head, Wilson, YONEX, Prince. Optional." },
          skill_level: { type: "string", enum: ["beginner", "intermediate", "advanced", "senior", "junior"], description: "Optional skill level filter." },
          playing_style: { type: "string", enum: ["control", "power", "spin", "all-court", "balance", "comfort"], description: "Optional playing style. 'balance'=balanced control+power, 'power'=aggressive, 'control'=precise, 'spin'=topspin focused, 'comfort'=arm-friendly." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. Convert shorthand before calling: '5K'->5000, '20K'->20000, '1L'->100000." },
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
      name: "get_balls",
      description: "Return BALLS (not ball machines, not accessories) from the correct sport store. Use this for ANY ball query — tennis balls, pickleball balls, padel balls, or a generic 'balls' ask. Tennis Balls cat=31 (tennisoutlet.in), Pickleball Balls cat=252 (pickleballoutlet.in), Padel Balls cat=273 (padeloutlet.in). If the customer did NOT specify a sport OR said 'all balls', omit the sport param (or pass 'all') and this tool will merge results from all three stores. Only products with REAL quantity >= 1 are returned.",
      parameters: {
        type: "object",
        properties: {
          sport: { type: "string", enum: ["tennis", "pickleball", "padel", "all"], description: "Which sport's ball catalog. Omit or use 'all' to merge tennis + pickleball + padel balls." },
          brand: { type: "string", description: "Optional brand filter (e.g. Wilson, Head, Babolat, Joola, Franklin)." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR." },
          page_size: { type: "number", default: 10, description: "Max items to return (1-20)." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_ball_machines",
      description: "Return ALL ball-machine-type products (ball machines, throwers, cannons, launchers, feeders) from TennisOutlet.in with product links. Combines category lookup (discovered from Magento category tree at startup), free-text search across name/sku/url_key, and slug matching. Use this for ANY ball machine / ball thrower / ball cannon query ÃÂ¢ÃÂÃÂ do NOT use get_products_by_category or search_products for these, because ball machines are not in the standard category IDs.",
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
      name: "smart_product_search",
      description: "PREFERRED product discovery tool. Resolves natural-language queries to the best Magento categories using an in-memory index, fetches from those categories AND runs a keyword search, then merges and deduplicates. Use this FIRST for any general product query (e.g. 'tennis bags', 'padel balls', 'sale items', 'strings under 2000'). Falls back to keyword search if no category matches. Returns products with product_url, price, qty, and source info.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language product query (e.g. 'beginner tennis racquets', 'padel balls', 'used racquets', 'wimbledon sale')" },
          sport: { type: "string", enum: ["tennis", "pickleball", "padel"], description: "Sport context for URL generation." },
          min_price: { type: "number", description: "Optional minimum price in INR." },
          max_price: { type: "number", description: "Optional maximum price in INR. '5K'=5000, '1L'=100000." },
          page_size: { type: "integer", description: "Max products (default 10, max 20)", default: 10 }
        },
        required: ["query"]
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
          page_size: { type: "integer", default: 10 }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "compare_products",
      description: "v6.6.0 — Side-by-side in-stock comparison for 2-6 products. Pass one natural-language query per product (e.g. ['Babolat Pure Aero', 'Wilson Clash 100']). Each query is resolved via Magento catalog search, filtered to qty>=1, and returned with clean specs so the LLM can pick a winner like the best salesperson. Works for racquets, shoes, paddles, bags, balls — any catalog item.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            description: "2 to 6 natural-language product queries. One per product the customer wants compared.",
            items: { type: "string" },
            minItems: 2,
            maxItems: 6
          },
          sport: { type: "string", enum: ["tennis","pickleball","padel"], description: "Optional sport scope. If omitted, inferred per query from the query text." },
          min_price: { type: "number" },
          max_price: { type: "number" }
        },
        required: ["queries"]
      }
    }
  }
];

// ==================== HELPERS ====================

// Build product URL: prefer url_key, else derive from name; drop trailing SKU-like suffixes; ensure .html
// ==================== PRODUCT URL (v5.3.0) ====================
// Uses Magento's own url_rewrites table via extension_attributes ÃÂ¢ÃÂÃÂ the exact URL
// the storefront links to. Falls back to url_key + .html, then to the ID-based
// /catalog/product/view/id/ path which is guaranteed to resolve on every M2 install.
function buildProductUrl(item, sport = 'tennis') {
  const storeUrl = getStoreUrl(sport);
  const attrs = (item.custom_attributes || []).reduce((a, c) => { a[c.attribute_code] = c.value; return a; }, {});

  // 1st choice: Magento's url_rewrites ÃÂ¢ÃÂÃÂ the authoritative storefront URL.
  // Requires the /products query to request `extension_attributes[url_rewrites]`.
  const rewrites = item.extension_attributes?.url_rewrites;
  if (Array.isArray(rewrites) && rewrites.length > 0) {
    const rewrite = rewrites.find(r => r && r.url) || rewrites[0];
    if (rewrite && rewrite.url) {
      const path = String(rewrite.url).replace(/^\/+/, '');
      return `${storeUrl}/${path}`;
    }
  }

  // 2nd choice: url_key + .html ÃÂ¢ÃÂÃÂ works on stores with flat URL rewrites.
  if (attrs.url_key) {
    const clean = String(attrs.url_key).replace(/\.html?$/i, '').replace(/^-|-$/g, '');
    if (clean) return `${storeUrl}/${clean}.html`;
  }

  // 3rd choice: ID-based URL ÃÂ¢ÃÂÃÂ guaranteed to 200 on every Magento install,
  // regardless of SEO config. Magento will 301 to the canonical URL.
  if (item.id) {
    return `${storeUrl}/catalog/product/view/id/${item.id}`;
  }

  // Absolute last resort: homepage (should never be hit).
  return storeUrl;
}

function extractCustomAttrs(item) {
  const attrs = {};
  (item.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
  return attrs;
}

// ==================== CATEGORY INDEX (v5.4.0) ====================
// CATEGORY_MAP = flat list; CATEGORY_INDEX = inverted keywordÃÂ¢ÃÂÃÂ[{id,name,score}] for O(1) resolution.
let CATEGORY_MAP = [];
const BALL_MACHINE_CATEGORY_IDS = [];
let CATEGORY_INDEX = {};  // keyword ÃÂ¢ÃÂÃÂ [{ id, name, score }]

// v6.4.1: lightweight English-ish stemmer. Input: token. Output: Set of
// equivalent forms (at minimum the original + its singular/plural counterpart).
// No external lib — we deliberately cover just the cases this catalog hits
// (bags<->bag, shoes<->shoe, balls<->ball, racquets<->racquet, accessories<->accessory).
function _stemVariants(token) {
  const out = new Set();
  if (!token) return out;
  const t = String(token).toLowerCase();
  out.add(t);
  if (t.length < 3) return out;  // don't stem 2-letter tokens

  // Plural -> singular
  if (/ies$/.test(t) && t.length > 4) {
    out.add(t.slice(0, -3) + 'y');           // accessories -> accessory
  } else if (/(ches|shes|sses|xes)$/.test(t)) {
    out.add(t.slice(0, -2));                  // matches -> match, dresses -> dress
  } else if (/es$/.test(t) && t.length > 4) {
    out.add(t.slice(0, -2));                  // shoes -> sho (noisy fallback)
    out.add(t.slice(0, -1));                  // shoes -> shoe (the real win)
  } else if (/s$/.test(t) && !/ss$/.test(t) && t.length > 3) {
    out.add(t.slice(0, -1));                  // bags -> bag, balls -> ball
  }

  // Singular -> plural (covers user typing "bag" when index has "bags")
  if (!/s$/.test(t)) {
    if (/(s|x|z|ch|sh)$/.test(t)) out.add(t + 'es');
    else if (/[^aeiou]y$/.test(t)) out.add(t.slice(0, -1) + 'ies');
    else out.add(t + 's');
  }

  return out;
}

// Build the inverted index from the flat category list.
function buildCategoryIndex(cats) {
  const idx = {};
  const stopwords = new Set(['the','and','or','for','a','an','in','on','to','of','with','by','at','from','is','it','as']);
  for (const c of cats) {
    if (!c.is_active || c.level < 2) continue;
    // Tokenise: name tokens + path tokens (lower, alphanumeric only)
    const tokens = new Set();
    const raw = `${c.name} ${c.path || ''}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (const t of raw) {
      if (t.length >= 2 && !stopwords.has(t)) {
        // v6.4.1: index the token AND its singular/plural variants so
        // "Pickleball Bags" is reachable from "pickle bag" / "bag" etc.
        for (const v of _stemVariants(t)) tokens.add(v);
      }
    }
    // Also add bigrams from name (e.g. "pure aero", "ball machine"). For each
    // bigram also add a singular-right variant: "pickleball bags" -> "pickleball bag".
    const nameTokens = c.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
    for (let i = 0; i < nameTokens.length - 1; i++) {
      const left = nameTokens[i];
      const right = nameTokens[i + 1];
      tokens.add(`${left} ${right}`);
      for (const rv of _stemVariants(right)) {
        if (rv !== right) tokens.add(`${left} ${rv}`);
      }
    }
    for (const token of tokens) {
      if (!idx[token]) idx[token] = [];
      // Score: deeper = more specific = better; product_count as tiebreaker
      const score = c.level * 10 + Math.min(c.product_count || 0, 99);
      idx[token].push({ id: c.id, name: c.name, path: c.path, score, product_count: c.product_count });
    }
  }
  // Sort each bucket by score descending
  for (const key of Object.keys(idx)) {
    idx[key].sort((a, b) => b.score - a.score);
  }
  return idx;
}

// v6.4.1: explicit synonym/alias map. Small, deterministic, easy to audit.
// Applied per-token BEFORE index lookup in resolveCategoriesFromQuery.
const QUERY_SYNONYMS = {
  // Sport shortcuts and typos
  'pickle': 'pickleball',
  'pickball': 'pickleball',
  'pickel': 'pickleball',
  'padle': 'padel',
  'paddel': 'padel',
  'paddle': 'padel',
  // Product-noun aliases
  'racket': 'racquet',
  'rackets': 'racquets',
  'footwear': 'shoes',
  'sneaker': 'shoes',
  'sneakers': 'shoes',
  'trainer': 'shoes',
  'trainers': 'shoes',
  'kitbag': 'bag',
  'kitbags': 'bags',
  'pouch': 'bag',
  'pouches': 'bags',
  'carrier': 'bag',
  'carriers': 'bags',
  'backpack': 'bag',
  'backpacks': 'bags',
  'duffel': 'bag',
  'duffels': 'bags',
  'duffle': 'bag',
  'duffles': 'bags'
};

// Known product-noun safety net: if the resolver misses entirely but the user
// clearly asked for a category that MUST exist, fall back to these keywords.
// Index keys are checked as-is after synonym expansion + stemming.
const SAFETY_NET_NOUNS = new Set([
  'bag','bags','shoe','shoes','ball','balls','racquet','racquets',
  'grip','grips','string','strings','apparel','accessories','accessory'
]);
const KNOWN_SPORTS = new Set(['tennis','pickleball','padel']);

// v6.4.0: Track the last lazy-reload attempt so we don't hammer Magento when
// initCategoryMap() fails at boot. If the index is still empty N seconds later,
// fire one reload in the background.
let _lastLazyCategoryReload = 0;
function _maybeLazyReloadCategoryMap() {
  if (Object.keys(CATEGORY_INDEX).length > 0) return;
  const now = Date.now();
  if (now - _lastLazyCategoryReload < 30000) return;  // throttle: at most once per 30s
  _lastLazyCategoryReload = now;
  console.log('[category-index] empty — triggering lazy reload');
  initCategoryMap().catch(e => console.log('[category-index] lazy reload failed:', e.message));
}

// Resolve a natural-language query to the best category IDs using the inverted index.
function resolveCategoriesFromQuery(query, maxResults = 3) {
  if (!query || !CATEGORY_INDEX || Object.keys(CATEGORY_INDEX).length === 0) {
    _maybeLazyReloadCategoryMap();
    return [];
  }
  const q = String(query).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const rawTokens = q.split(/\s+/).filter(t => t.length >= 2);
  if (rawTokens.length === 0) return [];

  // v6.4.1: expand each token through QUERY_SYNONYMS then add stem variants
  // (singular + plural). So "pickle bag" -> [["pickleball"],["bag","bags"]]
  // and "any shoes" -> [["any","anys"],["shoes","shoe"]].
  const queryTokens = rawTokens.map(t => QUERY_SYNONYMS[t] || t);
  const expanded = queryTokens.map(t => {
    const vs = _stemVariants(t);
    vs.add(t);
    return Array.from(vs);
  });

  // Score each category by how many query tokens it matches
  const catScores = {};  // catId ÃÂ¢ÃÂÃÂ { ...catInfo, matchCount, totalScore }

  // Try bigrams first (more specific). Cross-product expanded forms at
  // positions i and i+1 so "pickle bag" tries "pickleball bag" AND "pickleball bags".
  for (let i = 0; i < expanded.length - 1; i++) {
    const seen = new Set();
    for (const l of expanded[i]) {
      for (const r of expanded[i + 1]) {
        const bigram = `${l} ${r}`;
        if (seen.has(bigram)) continue;
        seen.add(bigram);
        if (CATEGORY_INDEX[bigram]) {
          for (const cat of CATEGORY_INDEX[bigram]) {
            if (!catScores[cat.id]) catScores[cat.id] = { ...cat, matchCount: 0, totalScore: 0 };
            catScores[cat.id].matchCount += 2;  // bigram match counts double
            catScores[cat.id].totalScore += cat.score * 2;
          }
        }
      }
    }
  }

  // Then unigrams — count each category at most once per query position so
  // plural+singular variants don't inflate the match score.
  for (const variants of expanded) {
    const countedCats = new Set();
    for (const tok of variants) {
      if (!CATEGORY_INDEX[tok]) continue;
      for (const cat of CATEGORY_INDEX[tok]) {
        if (countedCats.has(cat.id)) continue;
        countedCats.add(cat.id);
        if (!catScores[cat.id]) catScores[cat.id] = { ...cat, matchCount: 0, totalScore: 0 };
        catScores[cat.id].matchCount += 1;
        catScores[cat.id].totalScore += cat.score;
      }
    }
  }

  // v6.4.1 safety net: if we still got nothing but the query names a known
  // product noun or sport, try bare-token lookups. Covers tokenizer edge cases.
  if (Object.keys(catScores).length === 0) {
    const allVariants = new Set();
    for (const vs of expanded) for (const v of vs) allVariants.add(v);
    for (const v of allVariants) {
      if (!SAFETY_NET_NOUNS.has(v) && !KNOWN_SPORTS.has(v)) continue;
      if (!CATEGORY_INDEX[v]) continue;
      for (const cat of CATEGORY_INDEX[v]) {
        if (!catScores[cat.id]) catScores[cat.id] = { ...cat, matchCount: 0, totalScore: 0 };
        catScores[cat.id].matchCount += 1;
        catScores[cat.id].totalScore += cat.score;
      }
    }
  }

  // Rank by matchCount desc, then totalScore desc
  const ranked = Object.values(catScores)
    .sort((a, b) => b.matchCount - a.matchCount || b.totalScore - a.totalScore)
    .slice(0, maxResults);

  return ranked.map(c => ({ id: c.id, name: c.name, path: c.path, product_count: c.product_count, match_score: c.matchCount }));
}

async function initCategoryMap() {
  try {
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

    // Build inverted index for O(1) queryÃÂ¢ÃÂÃÂcategory resolution
    CATEGORY_INDEX = buildCategoryIndex(flat);
    console.log(`[category-index] loaded ${flat.length} categories, ${Object.keys(CATEGORY_INDEX).length} index keys`);

    // Detect ball-machine-like categories by name
    BALL_MACHINE_CATEGORY_IDS.length = 0;
    const re = /ball.?machine|ball.?thrower|ball.?cannon|ball.?launcher|ball.?feeder|ai.?ball|smart.?ball/i;
    for (const c of flat) if (re.test(c.name)) BALL_MACHINE_CATEGORY_IDS.push(c.id);
    console.log(`[category-index] ball-machine category ids: ${JSON.stringify(BALL_MACHINE_CATEGORY_IDS)}`);
  } catch (e) {
    console.log(`[category-index] failed:`, e.response?.status || e.message);
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
    timeout: 10000   // v5.7.2: balanced ÃÂ¢ÃÂÃÂ generous but fits Render 30s
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

// ==================== STOCK RESOLUTION (v5.3.0) ====================
// Uses Magento 2's canonical condition_type=in filter ÃÂ¢ÃÂÃÂ the same idiom Magento's
// own SearchCriteriaBuilder emits. Previous versions chained N eq-filters which
// triggers undefined behavior in M2 REST (silently returns empty or partial results).
// Works on MSI, legacy cataloginventory, single-source, multi-source ÃÂ¢ÃÂÃÂ every variant.
// Returns: { [sku]: qty } where qty >= 1 means "customer can buy this right now".
async function fetchStockMap(skus) {
  const map = {};
  if (!skus || skus.length === 0) return map;

  // De-dupe and sanitize
  const uniqueSkus = [...new Set(skus.filter(s => s && typeof s === 'string'))];
  if (uniqueSkus.length === 0) return map;

  // Batch into groups of 40 ÃÂ¢ÃÂÃÂ stays under URL length limits on every Magento install.
  const BATCH_SIZE = 40;
  const batches = [];
  for (let i = 0; i < uniqueSkus.length; i += BATCH_SIZE) {
    batches.push(uniqueSkus.slice(i, i + BATCH_SIZE));
  }

  // Canonical Magento 2 REST idiom for "sku IN (a,b,c)":
  // ONE filter, comma-joined value, condition_type=in. This is what Magento's
  // own SearchCriteriaBuilder emits. Chaining N eq-filters is undefined behavior.
  const fetchSourceItems = async (batch) => {
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
      'searchCriteria[filter_groups][0][filters][0][value]': batch.join(','),
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'in',
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      'searchCriteria[filter_groups][1][filters][0][condition_type]': 'eq',
      'searchCriteria[pageSize]': batch.length * 5
    };
    try {
      // OAuth first (admin access; source-items sometimes rejects bearer).
      let res;
      try { res = await oauthGet('/inventory/source-items', params); }
      catch (oauthErr) {
        if (oauthErr.response?.status === 401 || oauthErr.response?.status === 404) {
          res = await magentoGet('/inventory/source-items', params);
        } else { throw oauthErr; }
      }
      for (const it of (res?.items || [])) {
        // status=1 means source-item is enabled; don't count disabled warehouses.
        if (it.status === 0) continue;
        const s = it.sku;
        map[s] = (map[s] || 0) + parseFloat(it.quantity || 0);
      }
    } catch (e) {
      console.log(`[stockMap] MSI batch failed (${batch.length}):`, e.response?.status || e.message);
    }
  };

  // Run batches with bounded concurrency.
  const CONCURRENCY = 3;
  const queue = [...batches];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const batch = queue.shift();
        if (batch) await fetchSourceItems(batch);
      }
    })
  );

  // If EVERY SKU came back zero, the store likely runs legacy cataloginventory
  // (MSI not enabled or not populated). Fall back to /stockItems/{sku}
  // which works on both. This is Magento's own storefront check.
  const allZero = uniqueSkus.every(s => !map[s] || map[s] === 0);
  if (allZero) {
    console.log(`[stockMap] MSI empty ÃÂ¢ÃÂÃÂ falling back to /stockItems for ${uniqueSkus.length} SKUs`);
    const CAP = 50;
    const subset = uniqueSkus.slice(0, CAP);
    await Promise.all(subset.map(async (sku) => {
      try {
        // /V1/stockItems/{sku} works with bearer on most installs and
        // returns the salable qty Magento uses on the storefront.
        const si = await magentoGet(`/stockItems/${encodeURIComponent(sku)}`);
        const qty = parseFloat(si?.qty || 0);
        const inStock = si?.is_in_stock === true;
        if (inStock && qty > 0) map[sku] = qty;
        else if (inStock && qty === 0) map[sku] = 1; // in-stock but no managed qty (backorder allowed)
      } catch (err) {
        // Last-ditch via OAuth if bearer 401'd
        if (err.response?.status === 401) {
          try {
            const si = await oauthGet(`/stockItems/${encodeURIComponent(sku)}`);
            const qty = parseFloat(si?.qty || 0);
            if (si?.is_in_stock && qty > 0) map[sku] = qty;
            else if (si?.is_in_stock) map[sku] = 1;
          } catch { /* give up silently for this SKU */ }
        }
      }
    }));
  }

  return map;
}

function shapeProduct(item, qty, sport = 'tennis') {
  const attrs = extractCustomAttrs(item);
  const brandLabel = attrs.brands ? resolveAttr('brands', attrs.brands) : (attrs.brand || null);
  // v6.1.1: Detect correct sport from product's categories — ensures correct store URL
  // A padel shoe (cat 274) gets padeloutlet.in, even if the query said sport='tennis'
  const resolvedSport = detectSportFromProduct(item, sport);
  // Capture Magento's native stock signal from extension_attributes (when present)
  const magentoStockItem = item.extension_attributes?.stock_item;
  const shaped = {
    name: item.name,
    sku: item.sku,
    type_id: item.type_id || 'simple',
    price: parseFloat(item.price || 0) || null,
    special_price: attrs.special_price ? parseFloat(attrs.special_price) : null,
    brand: brandLabel,
    short_description: attrs.short_description ? String(attrs.short_description).replace(/<[^>]*>/g, '').substring(0, 200) : null,
    product_url: buildProductUrl(item, resolvedSport),
    image: attrs.image ? `${getStoreUrl(resolvedSport)}/media/catalog/product${attrs.image}` : null,
    qty,
    magento_in_stock: magentoStockItem ? !!magentoStockItem.is_in_stock : null,
    // v6.3.0 LAYER 2: stamp sport on every shaped product so the LLM (and any
    // downstream deduper) can verify the returned list never mixes sports.
    // detectSportFromProduct uses the product's own categories — authoritative.
    sport: resolvedSport
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
  // v6.0.5: Show lowest selling price — if special_price exists and is lower, use it as main price
  if (shaped.special_price && shaped.special_price > 0 && (!shaped.price || shaped.special_price < shaped.price)) {
    shaped.original_price = shaped.price;
    shaped.price = shaped.special_price;
  }
  delete shaped.special_price;  // LLM only sees one price field — the lowest
  return shaped;
}

// STRICT availability check (v5.2.0):
// Simple products: qty >= 1.
// Configurable products: children must have been loaded AND summed qty >= 1.
// No fake-available fallback ÃÂ¢ÃÂÃÂ we'd rather show fewer real products than dead links.
function isProductAvailable(p) {
  if (!p) return false;
  if (p.type_id === 'configurable') {
    // v6.4.0: If children loaded, trust the enriched qty (sum of child stock).
    // If children NOT loaded (timeout OR Magento returned an empty children
    // array — e.g. PISH0008 has MSI qty but no configurable link), fall back
    // to parent MSI qty instead of silently dropping the product.
    if (p._children_loaded) return (p.qty || 0) >= 1;
    // Unenriched configurable with parent MSI qty>=1 is still worth surfacing.
    return (p.qty || 0) >= 1;
  }
  return (p.qty || 0) >= 1;
}

// applyFallbackStock removed in v5.2.0 ÃÂ¢ÃÂÃÂ was creating false-positives on timed-out
// enrichment. Replacement strategy: tighter enrichment concurrency + cap (see CHANGE 4).

async function getProductsByCategory(categoryId, pageSize = 10, { min_price = null, max_price = null, sport = 'tennis' } = {}) {
  try {
    // v6.1.4: Detect correct sport from the CATEGORY ID itself — overrides LLM's sport param
    // This ensures padel category 273 always gets padeloutlet.in URLs, etc.
    const detectedSport = CATEGORY_TO_SPORT[parseInt(categoryId)] || sport || 'tennis';
    sport = detectedSport;

    // v6.4.5: Expand parent category to full subtree (self + all brand subcategories).
    // A query for "pickleball shoes" (253) now searches 253,267,268,269,270,271,365,404.
    // Magento filter uses condition_type=in with a comma-joined list.
    const subtree = expandCategorySubtree(categoryId);
    const catValue = subtree.join(',');

    // v6.4.5: Bump fetchSize to 200. Category 253 alone has 1700+ cross-listings
    // (tennis shoes assigned to pickleball category). With the previous fetchSize=30,
    // in-stock PISH* SKUs were paginated out. 200 gives enough headroom to reach
    // the real in-stock sport-specific products before the sport post-filter drops
    // cross-listed wrong-sport items.
    const fetchSize = Math.max(pageSize * 20, 200);
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': 'category_id',
      'searchCriteria[filter_groups][0][filters][0][value]': catValue,
      'searchCriteria[filter_groups][0][filters][0][condition_type]': subtree.length > 1 ? 'in' : 'eq',
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      'searchCriteria[filter_groups][2][filters][0][field]': 'visibility',
      'searchCriteria[filter_groups][2][filters][0][value]': 4,
      // NOTE: removed quantity_and_stock_status pre-filter — unreliable on MSI for configurables.
      // Real stock verification happens downstream via fetchStockMap + enrichConfigurables.
      'searchCriteria[pageSize]': Math.min(fetchSize, 300),
      'searchCriteria[sortOrders][0][field]': 'created_at',
      'searchCriteria[sortOrders][0][direction]': 'DESC',
      // Request url_rewrites so buildProductUrl gets the canonical storefront URL.
      'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
    };
    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: "No products found in this category." };
    }

    // v6.4.5: SPORT LOCK post-filter. Category 253 (pickleball shoes) is polluted
    // with tennis shoes assigned to pickleball website. Drop any item whose own
    // SKU/name/url_key says it's a different sport than the category root.
    const rawItems = result.items.filter(it => {
      const productSport = detectSportFromProduct(it, sport);
      return productSport === sport;
    });
    const effectiveItems = rawItems.length > 0 ? rawItems : result.items;

    const skus = effectiveItems.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const shaped = effectiveItems.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    await enrichConfigurables(shaped);  // forceAll=true: verify child stock for ALL configurables

    // v6.4.0: tag availability, keep OOS as fallback tier.
    let pool = applyPriceSizeFilters(shaped, { min_price, max_price });
    const beforeCustomer = pool.length;
    const filtered_out = shaped.length - pool.length;
    pool = pool.sort((a, b) => {
      const aIn = ((a.qty || 0) >= 1 && isProductAvailable(a)) ? 1 : 0;
      const bIn = ((b.qty || 0) >= 1 && isProductAvailable(b)) ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
      return (b.qty || 0) - (a.qty || 0);
    });
    const tagged = stripInternals(pool);
    const final = mergeAvailability(tagged, pageSize);
    let message = null;
    if (final.length === 0 && beforeCustomer > 0) {
      const bits = [];
      if (max_price) bits.push(`under ₹${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) bits.push(`over ₹${Number(min_price).toLocaleString('en-IN')}`);
      message = `No products in this category match the price filter${bits.length ? ` (${bits.join(', ')})` : ''}.`;
    }
    return { products: final, total: result.total_count, showing: final.length, filtered_out, message, _subtree: subtree, _sport_locked: rawItems.length };
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
    // AND visibility=4 (catalog+search)
    'searchCriteria[filter_groups][2][filters][0][field]': 'visibility',
    'searchCriteria[filter_groups][2][filters][0][value]': 4,
    // NOTE: removed quantity_and_stock_status pre-filter ÃÂ¢ÃÂÃÂ stock verified downstream.
    'searchCriteria[pageSize]': Math.min(pageSize, 100),
    'searchCriteria[sortOrders][0][field]': 'name',
    'searchCriteria[sortOrders][0][direction]': 'ASC',
    'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
  };
}

const SEARCH_STOPWORDS = new Set([
  'the','a','an','is','are','do','does','have','has','any','some','me','my','i','you',
  'please','show','find','get','give','tell','need','want','looking','for','buy','to',
  'about','of','on','in','under','over','below','above','with','and','or','vs','versus',
  'review','reviews','rating','ratings','feedback','price','cost','available','stock'
]);

async function searchProducts(query, pageSize = 10, { min_price = null, max_price = null, sport = 'tennis' } = {}) {
  try {
    // v6.1.4: Detect sport from query keywords if LLM didn't set it correctly
    const qLower = String(query || '').toLowerCase();
    if (qLower.includes('padel')) sport = 'padel';
    else if (qLower.includes('pickleball') || qLower.includes('pickle')) sport = 'pickleball';
    const fetchSize = Math.max(pageSize * 3, 30);
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
        const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    await enrichConfigurables(shaped);  // forceAll=true: verify child stock for ALL configurables

    // v6.4.0: tag availability, keep OOS as fallback tier.
    let pool = applyPriceSizeFilters(shaped, { min_price, max_price });
    const beforeCustomer = pool.length;
    const filtered_out = shaped.length - pool.length;
    pool = pool.sort((a, b) => {
      const aIn = ((a.qty || 0) >= 1 && isProductAvailable(a)) ? 1 : 0;
      const bIn = ((b.qty || 0) >= 1 && isProductAvailable(b)) ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
      return (b.qty || 0) - (a.qty || 0);
    });
    const tagged = stripInternals(pool);
    const final = mergeAvailability(tagged, pageSize);
    let message = null;
    if (final.length === 0 && beforeCustomer > 0) {
      const bits = [];
      if (max_price) bits.push(`under \u20B9${Number(max_price).toLocaleString('en-IN')}`);
      if (min_price) bits.push(`over \u20B9${Number(min_price).toLocaleString('en-IN')}`);
      message = `No matches for "${query}"${bits.length ? ` (${bits.join(', ')})` : ''}.`;
    }
    return { products: final, total: result.total_count, showing: final.length, filtered_out, message, query };
  } catch (error) {
    console.error('searchProducts error:', error.response?.status, error.message);
    return { error: true, message: "Unable to search products at this time. Please try again." };
  }
}

// ==================== SHOES WITH SPECS (ALL-IN-ONE) ====================
// Categories: Tennis Shoes=24, Pickleball Shoes=253, Padel Shoes=274
const SHOE_CATEGORIES = { tennis: 24, pickleball: 253, padel: 274 };

async function getShoesWithSpecs({ sport = 'tennis', brand = null, shoe_type = null, court_type = null, width = null, cushioning = null, size = null, min_price = null, max_price = null, page_size = 10 } = {}) {
  try {
    // ==================== v6.1.0: ALL-SHOES-TO-LLM APPROACH ====================
    // STRATEGY: Fetch ALL shoe configurables from ALL 3 categories (tennis + padel + pickleball).
    // NO server-side size filtering. Return every shoe with qty >= 1.
    // The LLM reads the last number in child product names to determine sizes.
    // This avoids all Magento API limitations with child products & categories.

    // v6.3.1: RESPECT THE SPORT LOCK. Only search across categories when sport
    // is explicitly 'all'. A tennis query must only hit the tennis category —
    // even when a size is requested — or we cross-pollute with padel/pickleball.
    const sportKey = String(sport || 'tennis').toLowerCase();
    const searchAllCats = sportKey === 'all';

    // v6.1.5: When fetching ALL categories, fetch each SEPARATELY so we can
    // tag each product with the correct sport for URL generation.
    // Magento REST API doesn't return category_ids, so this is the only way
    // to know which sport a shoe belongs to.
    const _sportForSku = {};  // sku -> sport

    // v6.4.5: buildShoeParams accepts a single catId and internally expands
    // to the subtree (brand subcats) via expandCategorySubtree.
    // - Uses condition_type=in with comma-joined IDs
    // - Bumps pageSize 50 -> 200 so in-stock SKUs aren't paginated out of
    //   categories with 1000+ cross-listed wrong-sport items.
    const buildShoeParams = (catId) => {
      const f = [];
      let i = 0;
      const subtree = expandCategorySubtree(catId);
      f.push({
        group: i++,
        field: 'category_id',
        value: subtree.join(','),
        conditionType: subtree.length > 1 ? 'in' : undefined
      });
      f.push({ group: i++, field: 'status', value: 1 });
      f.push({ group: i++, field: 'visibility', value: 4 });
      if (brand) {
        const bid = brandNameToId(brand);
        if (bid) f.push({ group: i++, field: 'brands', value: bid });
      }
      const specMap = { shoe_type, court_type, width, cushioning };
      for (const [code, val] of Object.entries(specMap)) {
        if (!val) continue;
        const optMap = ATTR_OPTIONS[code] || {};
        const match = Object.entries(optMap).find(([, label]) => String(label).toLowerCase() === String(val).toLowerCase())
                   || Object.entries(optMap).find(([, label]) => String(label).toLowerCase().includes(String(val).toLowerCase()));
        if (match) f.push({ group: i++, field: code, value: match[0] });
      }
      const p = {
        'searchCriteria[pageSize]': 200,
        'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
      };
      f.forEach(ff => {
        p[`searchCriteria[filter_groups][${ff.group}][filters][0][field]`] = ff.field;
        p[`searchCriteria[filter_groups][${ff.group}][filters][0][value]`] = ff.value;
        if (ff.conditionType) p[`searchCriteria[filter_groups][${ff.group}][filters][0][condition_type]`] = ff.conditionType;
      });
      return p;
    };

    let result;
    if (searchAllCats) {
      // Fetch each category separately in parallel — tag each SKU with its sport
      const catEntries = Object.entries(SHOE_CATEGORIES); // [['tennis',24],['pickleball',253],['padel',274]]
      const catResults = await Promise.allSettled(
        catEntries.map(([, catId]) => magentoGet('/products', buildShoeParams(catId)))
      );
      const allItems = [];
      const seen = new Set();
      for (let ci = 0; ci < catEntries.length; ci++) {
        const [catSport] = catEntries[ci];
        if (catResults[ci].status === 'fulfilled') {
          for (const item of (catResults[ci].value.items || [])) {
            if (!seen.has(item.sku)) {
              seen.add(item.sku);
              _sportForSku[item.sku] = catSport;
              allItems.push(item);
            }
          }
        }
      }
      result = { items: allItems, total_count: allItems.length };
    } else {
      const catId = SHOE_CATEGORIES[sportKey] || 24;
      result = await magentoGet('/products', buildShoeParams(catId));
    }

    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No ${sport} shoes found.` };
    }

    // v6.4.5: SPORT LOCK. Category 253 (pickleball shoes) is cross-listed with
    // hundreds of tennis shoe SKUs (TSH*). Same problem in reverse across
    // categories. Drop any item whose OWN SKU prefix / name says it's a
    // different sport than the one requested. The searchAllCats branch already
    // tags each SKU with its category's sport, so skip the filter there.
    if (!searchAllCats) {
      const before = result.items.length;
      const locked = result.items.filter(it => detectSportFromProduct(it, sportKey) === sportKey);
      if (locked.length > 0) {
        result = { items: locked, total_count: locked.length };
      }
      console.log(`[getShoesWithSpecs] sport=${sportKey} sport-lock: ${before} -> ${result.items.length}`);
    }

    // v6.3.5: STRICT QTY — shoes follow the same honesty rule as racquets.
    // Never fake stock: if MSI + /stockItems fallback both return 0 for a
    // parent's children, the shoe is OOS and will be dropped at the qty>=1
    // gate below. This reverts the v6.3.4 visibility compensation which was
    // producing false positives (product page showed OOS while we were
    // returning them as available).
    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const shaped = result.items.map(item => {
      const qty = stockMap[item.sku] || 0;
      const itemSport = _sportForSku[item.sku] || sport;
      return shapeProduct(item, qty, itemSport);
    });

    // Enrich configurables to get child prices (CAP=15)
    // Even if child stock is 0, we still get prices from children
    await enrichConfigurables(shaped, true);

    // v6.4.0: TAG availability (don't pre-drop OOS). `mergeAvailability` picks
    // the final tier mix — in-stock first, OOS as graceful fallback when the
    // catalog is sold out. This replaces the v6.2.0 hard qty>=1 gate that was
    // making the assistant say "no shoes" when every SKU was simply sold out.

    // Apply price filters to SHAPED (need _children for size logic downstream).
    const beforePriceFilter = shaped.length;
    let pool = applyPriceSizeFilters(shaped, { min_price, max_price }); // size deliberately NOT passed
    const filtered_out = beforePriceFilter - pool.length;

    // If a size was asked for, enrich products with `sizes_available` (from children).
    if (size) {
      for (const p of pool) {
        if (Array.isArray(p._children) && p._children.length > 0) {
          const allSizes = p._children
            .map(c => {
              const skuMatch = c.sku.match(/-([^-]+)$/);
              return skuMatch ? skuMatch[1] : null;
            })
            .filter(Boolean);
          if (allSizes.length > 0) {
            p.sizes_available = [...new Set(allSizes)].sort((a, b) => parseFloat(a) - parseFloat(b));
          }
        }
        if (p.specs && Array.isArray(p.specs.available_sizes) && p.specs.available_sizes.length > 0) {
          p.sizes_available = p.specs.available_sizes;
        }
      }
    }

    // Sort: in-stock first, then qty desc so the LLM sees available SKUs at the top.
    pool = pool.sort((a, b) => {
      const aIn = ((a.qty || 0) >= 1) ? 1 : 0;
      const bIn = ((b.qty || 0) >= 1) ? 1 : 0;
      if (aIn !== bIn) return bIn - aIn;
      return (b.qty || 0) - (a.qty || 0);
    });

    const tagged = stripInternals(pool.slice(0, 40));
    let available = mergeAvailability(tagged, page_size);

    // Price-range fallback: if price filter wiped in-stock results but other
    // in-stock shoes exist outside the band, show the closest-priced ones.
    let message = null;
    const inStockExist = shaped.some(p => (p.qty || 0) >= 1);
    const inStockInPool = available.some(p => p && p.in_stock);
    if (!inStockInPool && inStockExist && (min_price || max_price)) {
      const mid = (min_price && max_price) ? (parseFloat(min_price) + parseFloat(max_price)) / 2
                : max_price ? parseFloat(max_price) * 0.8
                : min_price ? parseFloat(min_price) * 1.2 : 5000;
      const inStockSorted = shaped
        .filter(p => (p.qty || 0) >= 1)
        .sort((a, b) => Math.abs((a.price || 0) - mid) - Math.abs((b.price || 0) - mid));
      available = mergeAvailability(stripInternals(inStockSorted.slice(0, 20)), page_size);
      const bits = [];
      if (min_price) bits.push(`₹${Number(min_price).toLocaleString('en-IN')}`);
      if (max_price) bits.push(`₹${Number(max_price).toLocaleString('en-IN')}`);
      message = `No exact matches in the ${bits.join(' to ')} range. Showing the closest available shoes by price.`;
    }

    if (size && available.length > 0) {
      message = `LLM INSTRUCTION: Customer asked for ${sport} shoes in size ${size}. The size of each shoe is the LAST NUMBER in its product name (e.g. "Asics Gel Resolution 9 - 10" = size 10, "Nike Court Vapor 11.5" = size 11.5). Read each product name, identify the trailing size number, and show ONLY the shoes that match size ${size}. If no products in this list match size ${size} exactly, tell the customer plainly: "We don\'t have size ${size} in ${sport} shoes right now" and then offer the 2-3 closest available sizes from THIS list by name. Do NOT tell the customer to check on the product page. Do NOT mix in shoes from other sports.`;
    } else if (!message) {
      const inStockCount = available.filter(p => p && p.in_stock).length;
      if (inStockCount > 0) {
        message = `Showing ${inStockCount} ${searchAllCats ? '' : sport + ' '}shoes in stock${available.length > inStockCount ? ' (+' + (available.length - inStockCount) + ' currently sold out shown as fallback)' : ''}.`;
      } else if (available.length > 0) {
        message = `All ${searchAllCats ? '' : sport + ' '}shoes matching your request are currently sold out. Showing ${available.length} options — let the customer know they are out of stock and offer to notify them when restocked.`;
      } else {
        message = `No ${searchAllCats ? '' : sport + ' '}shoes found for those filters.`;
      }
    }

    return {
      // v6.3.1: Echo the customer's resolved query so the LLM has full context
      // when presenting results. This is the source of truth for what was asked.
      customer_query: {
        sport: searchAllCats ? 'all' : sport,
        size: size || null,
        brand: brand || null,
        shoe_type: shoe_type || null,
        court_type: court_type || null,
        width: width || null,
        cushioning: cushioning || null,
        min_price: min_price || null,
        max_price: max_price || null
      },
      sport: searchAllCats ? 'all' : sport,
      filters_applied: { brand, shoe_type, court_type, width, cushioning, size, min_price, max_price },
      products: available,
      total: result.total_count,
      showing: available.length,
      filtered_out,
      message
    };
  } catch (error) {
    console.error('getShoesWithSpecs error:', error.response?.status, error.message);
    return { error: true, message: `Unable to fetch ${sport} shoes. ${error.message}` };
  }
}

// v6.6.0: Build a size-filter shopby URL that the LLM can surface to customers.
// Pattern: https://{sport}outlet.in/shoes/shopby/{size}.html
// When sport is 'all' or size is missing, fall back to the /shoes.html index.
function buildShopbyUrl(sport, size) {
  const sportKey = String(sport || 'tennis').toLowerCase();
  const storeMap = {
    tennis: 'https://tennisoutlet.in',
    pickleball: 'https://pickleballoutlet.in',
    padel: 'https://padeloutlet.in'
  };
  const base = storeMap[sportKey] || storeMap.tennis;
  if (!size) return `${base}/shoes.html`;
  // Sanitize size for URL path
  const sz = String(size).trim().replace(/[^\d.]/g, '');
  if (!sz) return `${base}/shoes.html`;
  return `${base}/shoes/shopby/${sz}.html`;
}

// ==================== SHOES ULTRA (v6.5.0) ====================
// Purpose-built shoe lookup that NEVER lies about size availability.
// - Expands full category subtree for every shoe category (tennis 24, pickleball 253, padel 274)
// - Uses condition_type=in to search the whole subtree in a single query
// - SKU-prefix sport-lock so category cross-listing cannot leak wrong-sport shoes
// - Fetches configurable-children + MSI stock per parent in parallel (higher CAP than legacy)
// - Parses size from the LAST NUMBER in each child's product name AND SKU suffix — authoritative
// - Filters children by qty >= 1. A parent only surfaces if it has >= 1 size in real stock.
// - If the customer asks for size X, a parent only surfaces if its size-X child has qty >= 1.
// - Never claims "no size X" unless the subtree fetch actually returned zero size-X matches.
async function getShoesUltra({ sport = 'all', brand = null, size = null, min_price = null, max_price = null, page_size = 10 } = {}) {
  try {
    const sportKey = String(sport || 'all').toLowerCase();
    const wantSize = size != null ? String(size).trim() : null;
    const wantSizeNum = wantSize ? parseFloat(String(wantSize).match(/[\d.]+/)?.[0] || '') : null;
    const minPrice = min_price != null && isFinite(parseFloat(min_price)) ? parseFloat(min_price) : null;
    const maxPrice = max_price != null && isFinite(parseFloat(max_price)) ? parseFloat(max_price) : null;
    const brandId = brand ? brandNameToId(brand) : null;

    // Resolve which shoe categories to scan
    const sportsToScan = sportKey === 'all'
      ? Object.keys(SHOE_CATEGORIES)     // tennis, pickleball, padel
      : (SHOE_CATEGORIES[sportKey] ? [sportKey] : Object.keys(SHOE_CATEGORIES));

    // Build /products params for one shoe category id (expands subtree)
    const buildParams = (catId) => {
      const subtree = expandCategorySubtree(catId);
      const p = {
        'searchCriteria[pageSize]': 200,
        'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]]],total_count'
      };
      p['searchCriteria[filter_groups][0][filters][0][field]'] = 'category_id';
      p['searchCriteria[filter_groups][0][filters][0][value]'] = subtree.join(',');
      if (subtree.length > 1) p['searchCriteria[filter_groups][0][filters][0][condition_type]'] = 'in';
      p['searchCriteria[filter_groups][1][filters][0][field]'] = 'status';
      p['searchCriteria[filter_groups][1][filters][0][value]'] = 1;
      p['searchCriteria[filter_groups][2][filters][0][field]'] = 'visibility';
      p['searchCriteria[filter_groups][2][filters][0][value]'] = 4;
      if (brandId) {
        p['searchCriteria[filter_groups][3][filters][0][field]'] = 'brands';
        p['searchCriteria[filter_groups][3][filters][0][value]'] = brandId;
      }
      return p;
    };

    // Fetch each shoe category in parallel, dedupe by SKU, tag sport
    const _sportForSku = {};
    const catResults = await Promise.allSettled(
      sportsToScan.map(s => magentoGet('/products', buildParams(SHOE_CATEGORIES[s])).then(r => ({ s, r })))
    );
    const parents = [];
    const seen = new Set();
    for (const cr of catResults) {
      if (cr.status !== 'fulfilled') continue;
      const { s, r } = cr.value;
      for (const item of (r.items || [])) {
        if (!item.sku || seen.has(item.sku)) continue;
        // SOFT sport-lock: only drop if SKU prefix clearly says ANOTHER sport.
        // If detectSportFromProduct returns the expected sport OR the fallback
        // (meaning SKU didn't encode a sport), keep the item — the category
        // itself is the truth.
        if (sportKey !== 'all') {
          const sku = String(item.sku || '').toUpperCase();
          const isTennisSku = /^TSH|^TBG|^TBL|^TRA|^TST|^TAC|^TCL/.test(sku);
          const isPickleSku = /^PISH|^PIBG|^PIBL|^PIPD|^PIAC|^PINP/.test(sku);
          const isPadelSku = /^PDSH|^PDBG|^PDBL|^PDRA|^PDAC/.test(sku);
          const wrong = (
            (sportKey === 'tennis' && (isPickleSku || isPadelSku)) ||
            (sportKey === 'pickleball' && (isTennisSku || isPadelSku)) ||
            (sportKey === 'padel' && (isTennisSku || isPickleSku))
          );
          if (wrong) continue;
        }
        seen.add(item.sku);
        _sportForSku[item.sku] = s;
        parents.push(item);
      }
    }
    console.log(`[getShoesUltra] sport=${sportKey} brand=${brand || '-'} size=${wantSize || '-'} parents=${parents.length}`);

    if (parents.length === 0) {
      return {
        customer_query: { sport: sportKey, size: wantSize, brand },
        products: [],
        total: 0,
        showing: 0,
        message: `No ${sportKey === 'all' ? '' : sportKey + ' '}shoes found.`
      };
    }

    // Shape parents (price/in-stock placeholder — will be overwritten from children)
    const shaped = parents.map(item => shapeProduct(item, 0, _sportForSku[item.sku] || 'tennis'));

    // Enrich EVERY parent with children + MSI stock in parallel.
    // Higher CAP than legacy enrichConfigurables (which caps at 15) — we want
    // the full picture so size-X queries never lose a match to pagination.
    const ULTRA_CAP = 60;        // ~60 parents per sport is ample — exceeds any real shoe catalog slice
    const ULTRA_CONC = 10;
    const queue = shaped.slice(0, ULTRA_CAP);
    const enrichOne = async (p) => {
      try {
        const children = await magentoGet(`/configurable-products/${encodeURIComponent(p.sku)}/children`);
        if (!Array.isArray(children) || children.length === 0) return;
        // Prices
        const prices = children.map(c => parseFloat(c.price || 0)).filter(v => v > 0);
        if (prices.length) {
          p.price = Math.min(...prices);
          const maxP = Math.max(...prices);
          if (maxP > p.price) p.price_max = maxP;
        }
        // Stock (MSI)
        const childSkus = children.map(c => c.sku);
        const stockMap = await fetchStockMap(childSkus);
        // Build child rows with authoritative size (last number in child NAME first, then SKU suffix fallback)
        const kids = children.map(c => {
          const nameSizeMatch = String(c.name || '').match(/([\d]+(?:\.[\d]+)?)\s*$/);
          let sizeStr = nameSizeMatch ? nameSizeMatch[1] : null;
          if (!sizeStr) {
            const skuTail = String(c.sku || '').match(/-([\d]+(?:\.[\d]+)?)$/);
            if (skuTail) sizeStr = skuTail[1];
          }
          const qty = parseFloat(stockMap[c.sku] || 0);
          return {
            sku: c.sku,
            name: c.name,
            price: parseFloat(c.price || 0) || null,
            qty,
            size: sizeStr,
            size_num: sizeStr ? parseFloat(sizeStr) : null,
            in_stock: qty >= 1
          };
        });
        p._children_ultra = kids;
        p.qty = kids.reduce((a, b) => a + (b.qty || 0), 0);
      } catch (e) {
        // leave as-is — parent will be dropped at qty>=1 gate
      }
    };
    const withTimeout = (pr, ms) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error('ultra-enrich-timeout')), ms))]);
    const workers = Array.from({ length: Math.min(ULTRA_CONC, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item) {
          try { await withTimeout(enrichOne(item), 8000); } catch (e) { /* drop silently */ }
        }
      }
    });
    await Promise.all(workers);

    // For each parent, derive available_sizes_in_stock (qty >= 1 only) + has_requested_size flag
    const enriched = shaped.map(p => {
      const kids = p._children_ultra || [];
      const inStockKids = kids.filter(c => c.in_stock);
      const sizesInStock = inStockKids.map(c => c.size).filter(Boolean);
      const sizeSet = [...new Set(sizesInStock)].sort((a, b) => parseFloat(a) - parseFloat(b));
      p.sizes_available = sizeSet;
      p.sizes_in_stock = sizeSet;
      // Size match
      let hasSize = false;
      let sizeQty = 0;
      if (wantSizeNum != null) {
        const match = inStockKids.find(c => c.size_num != null && Math.abs(c.size_num - wantSizeNum) < 0.001);
        hasSize = !!match;
        sizeQty = match ? match.qty : 0;
      }
      p.has_requested_size = hasSize;
      p.requested_size_qty = sizeQty;
      return p;
    });

    // Apply price filters
    let pool = enriched.filter(p => {
      const pr = parseFloat(p.price || 0);
      if (maxPrice != null && pr > 0 && pr > maxPrice) return false;
      if (minPrice != null && pr > 0 && pr < minPrice) return false;
      return true;
    });

    // Gate 1: must have at least one in-stock child
    pool = pool.filter(p => (p.sizes_in_stock || []).length > 0);

    // Gate 2: if a size was requested, require that exact size in stock
    let sizeGatedPool = pool;
    if (wantSizeNum != null) {
      sizeGatedPool = pool.filter(p => p.has_requested_size);
    }

    // Sort
    sizeGatedPool.sort((a, b) => (b.qty || 0) - (a.qty || 0));

    // Prepare customer-facing shape
    const toOut = (p) => ({
      name: p.name,
      sku: p.sku,
      brand: p.brand || null,
      price: p.price || null,
      price_max: p.price_max || null,
      qty: p.qty || 0,
      in_stock: (p.qty || 0) >= 1,
      sport: p.sport || _sportForSku[p.sku] || 'tennis',
      product_url: p.product_url,
      sizes_available: p.sizes_available || [],
      sizes_in_stock: p.sizes_in_stock || [],
      has_requested_size: !!p.has_requested_size,
      image: p.image || null
    });

    const outSized = sizeGatedPool.slice(0, page_size).map(toOut);

    // Build message
    let message;
    const totalSizeMatches = sizeGatedPool.length;
    if (wantSizeNum != null) {
      if (outSized.length > 0) {
        message = `Found ${totalSizeMatches} ${sportKey === 'all' ? '' : sportKey + ' '}shoe(s) in size ${wantSize} with qty >= 1. Showing ${outSized.length}.`;
      } else {
        // Show closest-size alternatives from pool (has stock, wrong size)
        const alt = pool
          .map(p => {
            const nearest = (p.sizes_in_stock || [])
              .map(s => ({ s, diff: Math.abs(parseFloat(s) - wantSizeNum) }))
              .sort((a, b) => a.diff - b.diff)[0];
            return nearest ? { p, nearestSize: nearest.s, diff: nearest.diff } : null;
          })
          .filter(Boolean)
          .sort((a, b) => a.diff - b.diff)
          .slice(0, page_size);
        const altOut = alt.map(a => toOut(a.p));
        message = `NO size ${wantSize} ${sportKey === 'all' ? '' : sportKey + ' '}shoes are in stock. Showing ${altOut.length} closest-size alternatives. LLM MUST: (1) Tell the customer plainly "We don't have size ${wantSize} in stock right now." (2) List these alternatives with their actual available sizes (see sizes_in_stock for each product). (3) NEVER tell the customer to check the product page for sizes — sizes_in_stock is the source of truth.`;
        const shopby = buildShopbyUrl(sportKey, wantSize);
        return {
          customer_query: { sport: sportKey, size: wantSize, brand },
          shopby_url: shopby,
          products: altOut,
          total: pool.length,
          showing: altOut.length,
          size_requested: wantSize,
          size_available: false,
          message
        };
      }
    } else {
      message = `Showing ${outSized.length} ${sportKey === 'all' ? '' : sportKey + ' '}shoe(s) in stock.`;
    }

    const shopby = buildShopbyUrl(sportKey, wantSize);
    return {
      customer_query: { sport: sportKey, size: wantSize, brand },
      shopby_url: shopby,
      products: outSized,
      total: sizeGatedPool.length,
      showing: outSized.length,
      size_requested: wantSize,
      size_available: wantSizeNum == null ? null : (outSized.length > 0),
      message
    };
  } catch (err) {
    console.error('getShoesUltra error:', err.response?.status, err.message);
    return { error: true, message: `Unable to fetch shoes. ${err.message}` };
  }
}


// ==================== RACQUETS WITH SPECS ====================
// Tennis Racquets=25, Padel Rackets=272, Pickleball Paddles=250
const RACQUET_CATEGORIES = { tennis: 25, padel: 272, pickleball: 250 };

async function getRacquetsWithSpecs({ sport = 'tennis', brand = null, skill_level = null, playing_style = null, min_price = null, max_price = null, page_size = 10 } = {}) {
  try {
    const sportKey = String(sport).toLowerCase();
    const catId = RACQUET_CATEGORIES[sportKey] || 25;
    // v6.4.5: Expand to full subtree so brand subcategories are searched too.
    const subtree = expandCategorySubtree(catId);
    const filters = [];
    let idx = 0;
    filters.push({
      group: idx++,
      field: 'category_id',
      value: subtree.join(','),
      conditionType: subtree.length > 1 ? 'in' : undefined
    });
    filters.push({ group: idx++, field: 'status', value: 1 });
    filters.push({ group: idx++, field: 'visibility', value: 4 });
    // v4.5.0: configurable-only restriction applies ONLY to tennis (grip-size variants).
    if (String(sport).toLowerCase() === 'tennis') {
      filters.push({ group: idx++, field: 'type_id', value: 'configurable' });
    }

    if (brand) {
      const bid = brandNameToId(brand);
      if (bid) filters.push({ group: idx++, field: 'brands', value: bid });
    }
    // Skill-level mapping
    const SKILL_CATS = { beginner: 87, intermediate: 80, advanced: 79, senior: 88, junior: 81 };
    if (skill_level && SKILL_CATS[String(skill_level).toLowerCase()]) {
      filters.push({ group: idx++, field: 'category_id', value: SKILL_CATS[String(skill_level).toLowerCase()] });
    }

    // v5.7.0: Fetch a large pool (up to 50) so we have enough after enrichment + price filter.
    // Configurable parents have price=0 in Magento ÃÂ¢ÃÂÃÂ real prices come from enrichConfigurables.
    // We MUST over-fetch to ensure we find products in the requested price range.
    // v6.4.5: bump fetch pool to 200 so cross-listed wrong-sport products don't
    // push real sport-specific results out of the window before sport-lock.
    const fetchSize = 200;
    const params = {
      'searchCriteria[pageSize]': fetchSize,
      'fields': 'items[id,sku,name,type_id,price,status,visibility,custom_attributes,extension_attributes[stock_item,url_rewrites[url]],configurable_product_options],total_count'
    };
    filters.forEach(f => {
      params[`searchCriteria[filter_groups][${f.group}][filters][0][field]`] = f.field;
      params[`searchCriteria[filter_groups][${f.group}][filters][0][value]`] = f.value;
      if (f.conditionType) {
        params[`searchCriteria[filter_groups][${f.group}][filters][0][condition_type]`] = f.conditionType;
      }
    });
    params['searchCriteria[sortOrders][0][field]'] = 'created_at';
    params['searchCriteria[sortOrders][0][direction]'] = 'DESC';

    let result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return { products: [], total: 0, message: `No ${sport} racquets matched those filters.` };
    }

    // v6.4.5: SPORT LOCK post-filter (drop cross-listed wrong-sport items).
    {
      const before = result.items.length;
      const locked = result.items.filter(it => detectSportFromProduct(it, sportKey) === sportKey);
      if (locked.length > 0) result = { items: locked, total_count: locked.length };
      console.log(`[getRacquetsWithSpecs] sport=${sportKey} sport-lock: ${before} -> ${result.items.length}`);
    }

    const skus = result.items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));

    // v5.7.0: Enrich ALL configurables ÃÂ¢ÃÂÃÂ this is critical for correct pricing.
    // Configurable parents store price=0; child enrichment reveals real prices.
    await enrichConfigurables(shaped);

    // v6.4.0: Tag availability; merge in-stock + OOS fallback so users always see options.
    let pool = applyPriceSizeFilters(shaped, { min_price, max_price });
    const beforeCustomer = pool.length;
    const filtered_out = shaped.length - pool.length;
    const inStockShaped = shaped.filter(isProductAvailable);

    // If price filter eliminates everything (but in-stock racquets DO exist
    // outside the price range), fall back to the closest-priced in-stock items.
    let available;
    let message = null;
    if (pool.length === 0 && inStockShaped.length > 0) {
      const mid = (min_price && max_price) ? (min_price + max_price) / 2
                : max_price ? max_price * 0.8
                : min_price ? min_price * 1.2
                : 15000;
      const sorted = inStockShaped.sort((a, b) => Math.abs((a.price || 0) - mid) - Math.abs((b.price || 0) - mid));
      available = mergeAvailability(stripInternals(sorted.slice(0, Math.min(page_size, 20))), page_size);
      const bits = [];
      if (min_price) bits.push(`above ₹${Number(min_price).toLocaleString('en-IN')}`);
      if (max_price) bits.push(`under ₹${Number(max_price).toLocaleString('en-IN')}`);
      message = `No exact matches in the ${bits.join(' and ')} range. Showing the closest available ${sport} racquets by price.`;
    } else {
      const sorted = pool.sort((a, b) => {
        const aIn = ((a.qty || 0) >= 1 && isProductAvailable(a)) ? 1 : 0;
        const bIn = ((b.qty || 0) >= 1 && isProductAvailable(b)) ? 1 : 0;
        if (aIn !== bIn) return bIn - aIn;
        return (b.qty || 0) - (a.qty || 0);
      });
      available = mergeAvailability(stripInternals(sorted), page_size);
    }
    return {
      sport, filters_applied: { brand, skill_level, playing_style, min_price, max_price },
      products: available, total: result.total_count, showing: available.length,
      filtered_out, message
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
async function enrichConfigurables(products, forceAll = true) {
  // forceAll=true by default ÃÂ¢ÃÂÃÂ we MUST verify child stock for every configurable product.
  // v5.2.0: quantity_and_stock_status removed; enrichment is the sole stock gate.
  const targets = forceAll
    ? products.filter(p => p != null)
    : products.filter(p => p && (!p.price || p.price === 0 || !p.qty || p.qty === 0));
  if (targets.length === 0) return products;
  // v5.2.0: wider concurrency, faster fail. With strict isProductAvailable,
  // dropped enrichments mean dropped products ÃÂ¢ÃÂÃÂ so we must enrich more, faster.
  const CAP = 15;       // v6.0.4: 15 products enriched — get ALL shoes their children ÃÂ¢ÃÂÃÂ fits Render 30s
  const CONCURRENCY = 8; // v6.0.4: 8 concurrent — 2 rounds max for 15 products ÃÂ¢ÃÂÃÂ 3-5s
  const queue = targets.slice(0, CAP);
  const enrichOne = async p => {
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
      // v6.0.5: resolve to lowest selling price after enrichment
      if (p.special_price && p.special_price > 0 && (!p.price || p.special_price < p.price)) {
        p.original_price = p.price;
        p.price = p.special_price;
      }
      delete p.special_price;
      // Stock: per-child and summed. ALWAYS override parent qty with children total.
      // This corrects false positives from /stockItems (is_in_stock=true but children OOS).
      let stockMap = {};
      try {
        const childSkus = children.map(c => c.sku);
        stockMap = await fetchStockMap(childSkus);
        const total = Object.values(stockMap).reduce((a, b) => a + (parseFloat(b) || 0), 0);
        // v6.3.5: STRICT — parent qty is the true sum of child stock.
        // No visibility compensation, no fake fallbacks. If total === 0,
        // the downstream qty>=1 gate will (correctly) drop this product.
        p.qty = total;
      } catch { /* keep parent qty from fetchStockMap */ }
      p._children_loaded = true;  // Flag: children were successfully fetched
      // Per-child detail for size / price filtering
      p._children = children.map(c => {
        const attrs = {};
        (c.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
        const rawSize = attrs.shoe_size;
        const sizeLabel = rawSize ? resolveAttr('shoe_size', rawSize) : null;
        return {
          sku: c.sku,
          price: parseFloat(c.price || 0) || null,
          qty: parseFloat(stockMap[c.sku] || 0),
          size: Array.isArray(sizeLabel) ? sizeLabel.join(',') : sizeLabel
        };
      });
    } catch {
      // leave as-is; downstream filter will drop if qty<1
    }
  };
  // concurrency-limited pool
  // Per-item timeout: 8s max per product to avoid Render 30s request timeout
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('enrich-timeout')), ms))]);
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) {
        try { await withTimeout(enrichOne(item), 8000); }  // v6.0.4: 8s per item — more time for children fetch ÃÂ¢ÃÂÃÂ balanced
        catch (e) { console.log('[enrich] timeout/error for', item.sku, e.message); }
      }
    }
  });
  await Promise.all(workers);
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
      const hit = p._children.some(c => {
        const got = parseFloat(String(c.size || '').match(/[\d.]+/)?.[0] || '');
        return !isNaN(got) && got === want && (c.qty || 0) >= 1;
      });
      if (!hit) return false;
    }
    return true;
  });
}

// Strip internal-only fields and tag availability before returning to the LLM.
// v6.4.0: graceful OOS — returns ALL shaped products, each tagged with
// in_stock + availability. Caller uses mergeAvailability() to pick the final
// tier mix. This lets the assistant show "currently sold out" cards instead of
// a flat "we don't have any" when every SKU is OOS.
function stripInternals(products) {
  return (products || []).map(p => {
    if (!p) return null;
    const hasStock = (p.qty || 0) >= 1;
    p.in_stock = hasStock;
    p.availability = hasStock ? 'in_stock' : 'out_of_stock';
    delete p._children;
    delete p.type_id;
    delete p.magento_in_stock;
    delete p._children_loaded;
    delete p._stock_source;
    return p;
  }).filter(Boolean);
}

// v6.4.0: Pick the final response tier mix.
// - Always prefer in-stock (up to pageSize).
// - If in-stock is non-empty but < 3, backfill with up to (3 - inStockCount)
//   OOS items so users see alternatives instead of a single card.
// - If in-stock == 0, return up to 5 OOS items so the assistant can say
//   "currently sold out — notify me / see alternatives".
function mergeAvailability(tagged, pageSize = 10) {
  const list = Array.isArray(tagged) ? tagged : [];
  const inStock = list.filter(p => p && p.in_stock);
  const oos = list.filter(p => p && !p.in_stock);
  if (inStock.length >= pageSize) return inStock.slice(0, pageSize);
  if (inStock.length === 0) return oos.slice(0, Math.min(5, pageSize));
  const need = Math.max(0, Math.min(pageSize, 3) - inStock.length);
  return [...inStock, ...oos.slice(0, need)].slice(0, pageSize);
}
function listBrands() {
  const map = ATTR_OPTIONS['brands'] || {};
  const brands = Object.entries(map).map(([id, label]) => ({ id, name: label })).filter(b => b.name && b.name.trim());
  return { total: brands.length, brands };
}

// ==================== BALLS (sport-aware, v6.2.0) ====================
// Categories: Tennis Balls=31, Pickleball Balls=252, Padel Balls=273
// Mirrors getShoesWithSpecs: honors an explicit sport, or merges ALL three
// stores when sport is omitted / 'all' so a generic "balls" query returns
// every ball product (tennis + pickleball + padel) with real qty >= 1.
const BALL_CATEGORIES = { tennis: 31, pickleball: 252, padel: 273 };

async function getBalls({ sport = null, brand = null, min_price = null, max_price = null, page_size = 10 } = {}) {
  try {
    const sportKey = String(sport || 'all').toLowerCase();
    const searchAllCats = !sport || sportKey === 'all';
    const cats = searchAllCats
      ? Object.entries(BALL_CATEGORIES)               // [[sport, catId], ...]
      : [[sportKey, BALL_CATEGORIES[sportKey] || BALL_CATEGORIES.tennis]];

    // Fetch every sport category in parallel, tagging each product with its store.
    const results = await Promise.allSettled(
      cats.map(([, catId]) => getProductsByCategory(
        catId,
        Math.max(page_size * 3, 20),
        { min_price, max_price, sport: CATEGORY_TO_SPORT[catId] || 'tennis' }
      ))
    );

    const merged = [];
    const seen = new Set();
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value || !Array.isArray(r.value.products)) continue;
      for (const p of r.value.products) {
        if (!p || seen.has(p.sku)) continue;
        // Optional brand filter — case-insensitive contains on resolved brand label.
        if (brand && !String(p.brand || '').toLowerCase().includes(String(brand).toLowerCase())) continue;
        seen.add(p.sku);
        merged.push(p);
      }
    }

    // v6.4.0: getProductsByCategory now tags in_stock/OOS and already applies
    // mergeAvailability internally. Balls arrive pre-tagged — just re-apply
    // mergeAvailability across the merged set to re-balance the in-stock/OOS mix.
    const sorted = (min_price || max_price)
      ? merged.slice().sort((a, b) => {
          const aIn = a.in_stock ? 1 : 0;
          const bIn = b.in_stock ? 1 : 0;
          if (aIn !== bIn) return bIn - aIn;
          return (a.price || 0) - (b.price || 0);
        })
      : merged.slice().sort((a, b) => (b.in_stock ? 1 : 0) - (a.in_stock ? 1 : 0));
    const showing = mergeAvailability(sorted, page_size);
    const inStockCount = showing.filter(p => p && p.in_stock).length;

    const message = showing.length === 0
      ? `No ${searchAllCats ? '' : sportKey + ' '}balls match those filters.`
      : inStockCount === 0
        ? `All ${searchAllCats ? '' : sportKey + ' '}balls matching your request are currently sold out. Showing ${showing.length} options — tell the customer they are out of stock and offer to notify them when restocked.`
        : (searchAllCats
            ? `Showing ${inStockCount} in-stock balls across tennis, pickleball and padel${showing.length > inStockCount ? ' (+' + (showing.length - inStockCount) + ' sold out)' : ''}.`
            : `Showing ${inStockCount} in-stock ${sportKey} balls${showing.length > inStockCount ? ' (+' + (showing.length - inStockCount) + ' sold out)' : ''}.`);

    return {
      sport: searchAllCats ? 'all' : sportKey,
      filters_applied: { brand, min_price, max_price },
      products: showing,
      total: merged.length,
      showing: showing.length,
      message
    };
  } catch (error) {
    console.error('getBalls error:', error.response?.status, error.message);
    return { error: true, message: `Unable to fetch balls. ${error.message}` };
  }
}

// ==================== BALL MACHINES (v3.3.2) ====================
// Combines three strategies (category ÃÂ¢ÃÂÃÂ search tokens ÃÂ¢ÃÂÃÂ url_key LIKE) and
// unions the results, so we return every ball-machine-shaped product the
// catalog has, even if a category wasn't indexed or the search stopped short.
async function getBallMachines({ page_size = 10, min_price = null, max_price = null, sport = 'tennis' } = {}) {
  // v4.7.2: FAST-PATH first (single Magento call), then parallel fallback only if needed.
  // Previous versions ran 15+ concurrent Magento calls which overwhelmed the server.
  const seen = new Map();
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('strat-timeout')), ms))]);

  // Helper: run a single LIKE query against Magento, shape results into seen map.
  const runLike = async (field, value) => {
    const params = {
      'searchCriteria[filter_groups][0][filters][0][field]': field,
      'searchCriteria[filter_groups][0][filters][0][value]': value,
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[filter_groups][1][filters][0][field]': 'status',
      'searchCriteria[filter_groups][1][filters][0][value]': 1,
      // NOTE: removed quantity_and_stock_status ÃÂ¢ÃÂÃÂ stock verified downstream.
      'searchCriteria[pageSize]': 20
    };
    const result = await magentoGet('/products', params);
    if (result.items && result.items.length) {
      const skus = result.items.map(i => i.sku);
      const stockMap = await fetchStockMap(skus);
      const shaped = result.items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
      // These are simple products ÃÂ¢ÃÂÃÂ enrichConfigurables is a no-op, skip it to save time.
      for (const p of shaped) if (!seen.has(p.sku)) seen.set(p.sku, p);
    }
  };

  // === FAST PATH: sequential, lightweight ÃÂ¢ÃÂÃÂ catches the known ball-machine products ===
  const fastQueries = [
    ['name', '%ball machine%'],
    ['name', '%tenniix%'],
    ['name', '%ai ball%'],
    ['url_key', '%ball%machine%']
  ];
  for (const [field, pattern] of fastQueries) {
    try { await runLike(field, pattern); } catch (e) { console.error('[BM fast]', field, pattern, e.message); }
    if (seen.size >= 2) break;   // got enough, skip remaining fast queries
  }

  // === FALLBACK: only if fast path found nothing, run heavier strategies with timeouts ===
  if (seen.size === 0) {
    console.log('[BM] fast path empty, running full parallel fallback');
    const stratA = (async () => {
      for (const catId of BALL_MACHINE_CATEGORY_IDS) {
        try {
          const byCat = await getProductsByCategory(catId, 20, { min_price, max_price });
          for (const p of (byCat.products || [])) if (!seen.has(p.sku)) seen.set(p.sku, p);
        } catch {}
      }
    })();
    const stratB = (async () => {
      const queries = ['ball machine', 'ball thrower', 'ball cannon', 'ball launcher', 'ball feeder', 'ai ball'];
      for (const q of queries) {
        try {
          const bySearch = await searchProducts(q, 10, { min_price, max_price });
          for (const p of (bySearch.products || [])) if (!seen.has(p.sku)) seen.set(p.sku, p);
        } catch {}
        if (seen.size >= 6) break;
      }
    })();
    const stratC = (async () => {
      const likeQueries = [['url_key','%ai%ball%'],['name','%ball cannon%'],['name','%ball thrower%'],['sku','%tenniix%']];
      for (const [f,v] of likeQueries) {
        try { await runLike(f, v); } catch {}
        if (seen.size >= 6) break;
      }
    })();
    await Promise.allSettled([withTimeout(stratA, 15000), withTimeout(stratB, 15000), withTimeout(stratC, 15000)]);
  }

  let pool = [...seen.values()].filter(isProductAvailable);  // SMART: configurables trusted, simples checked
  pool = applyPriceSizeFilters(pool, { min_price, max_price });
  const sortedPool = pool.sort((a, b) => {
    const aIn = ((a.qty || 0) >= 1 && isProductAvailable(a)) ? 1 : 0;
    const bIn = ((b.qty || 0) >= 1 && isProductAvailable(b)) ? 1 : 0;
    if (aIn !== bIn) return bIn - aIn;
    return (b.qty || 0) - (a.qty || 0);
  });
  const available = mergeAvailability(stripInternals(sortedPool), page_size);
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
        product = shapeProduct(res, stock[res.sku] || 0, 'tennis');
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
        ? `No reviews fetched from the API${endpointError ? ` (${endpointError})` : ''}. Customer reviews appear on the product page itself ÃÂ¢ÃÂÃÂ direct the user to click the product link and scroll to the 'Customer Reviews' section.`
        : null
    };
  } catch (e) {
    return { error: true, message: `Review lookup failed: ${e.message}` };
  }
}

// ==================== SMART PRODUCT SEARCH (v5.4.0) ====================
// Primary product-discovery tool: resolves natural-language queries to category IDs
// via the in-memory CATEGORY_INDEX, then fetches from those categories.
// Falls back to keyword search_products if no category match is found.
async function smartProductSearch({ query, sport = 'tennis', min_price = null, max_price = null, page_size = 10 } = {}) {
  if (!query) return { products: [], message: 'No query provided.' };
  // v6.1.4: Detect sport from query keywords — overrides LLM default
  const qLower = String(query || '').toLowerCase();
  if (qLower.includes('padel')) sport = 'padel';
  else if (qLower.includes('pickleball') || qLower.includes('pickle')) sport = 'pickleball';
  const startMs = Date.now();
  const resolved = resolveCategoriesFromQuery(query, 3);
  console.log(`[smart-search] query="${query}" resolved ${resolved.length} categories in ${Date.now() - startMs}ms:`, resolved.map(c => `${c.id}:${c.name}`).join(', '));

  let allProducts = [];
  let sources = [];

  // Strategy 1: Fetch from resolved categories (parallel)
  // v6.1.4: Each category uses its OWN sport (from CATEGORY_TO_SPORT) — getProductsByCategory handles this
  if (resolved.length > 0) {
    const catResults = await Promise.allSettled(
      resolved.map(cat => getProductsByCategory(cat.id, page_size, { min_price, max_price, sport }))
    );
    for (let i = 0; i < catResults.length; i++) {
      if (catResults[i].status === 'fulfilled') {
        const r = catResults[i].value;
        const prods = r.products || [];
        if (prods.length > 0) {
          sources.push({ category_id: resolved[i].id, category_name: resolved[i].name, count: prods.length });
          allProducts.push(...prods);
        }
      }
    }
  }

  // Strategy 2: Also run keyword search in parallel for coverage
  let searchResults = [];
  try {
    const sr = await searchProducts(query, page_size, { min_price, max_price, sport });
    searchResults = sr.products || [];
    if (searchResults.length > 0) {
      sources.push({ source: 'keyword_search', count: searchResults.length });
    }
  } catch (e) {
    console.log(`[smart-search] keyword search failed:`, e.message);
  }

  // Merge: de-duplicate by SKU, prefer category results (richer)
  const seen = new Set();
  const merged = [];
  for (const p of [...allProducts, ...searchResults]) {
    if (p && p.sku && !seen.has(p.sku)) {
      seen.add(p.sku);
      merged.push(p);
    }
  }

  // v6.4.2: Sport-scope filter. When the query/session established a sport
  // (pickleball/padel/tennis), drop cross-sport products that the keyword
  // search union pulled in via generic tokens (e.g. %bag%, %shoe%). Every
  // shaped product carries `sport` from detectSportFromProduct(categories);
  // that is the authoritative signal — not the query text. Fixes the
  // "pickleball bags → tennis bags surface instead" class of bug: a tennis
  // bag with qty=30 no longer outranks a pickleball Engage bag with qty=5.
  // Fallback: if no product matches the requested sport, keep the full list
  // so downstream narrative can still honestly say "no X-sport products,
  // here's closest match" instead of going empty.
  const KNOWN_SPORT_SET = new Set(['tennis', 'pickleball', 'padel']);
  let scoped = merged;
  if (sport && KNOWN_SPORT_SET.has(sport)) {
    const inSport = merged.filter(p => p && p.sport === sport);
    if (inSport.length > 0) scoped = inSport;
  }

  // v6.4.2: In-stock first (hard priority), then qty desc, then price asc.
  // The previous sort was qty-only, which pushed OOS=0 products to the end
  // only incidentally and did nothing to guarantee in-stock-first ordering
  // across a mixed pool. isProductAvailable handles configurables correctly.
  scoped.sort((a, b) => {
    const aIn = ((a.qty || 0) >= 1 && isProductAvailable(a)) ? 1 : 0;
    const bIn = ((b.qty || 0) >= 1 && isProductAvailable(b)) ? 1 : 0;
    if (aIn !== bIn) return bIn - aIn;
    const dq = (b.qty || 0) - (a.qty || 0);
    if (dq !== 0) return dq;
    return (a.price || 99999) - (b.price || 99999);
  });
  const final = scoped.slice(0, Math.min(page_size, 20));

  return {
    products: final,
    total: merged.length,
    showing: final.length,
    sources,
    resolved_categories: resolved,
    took_ms: Date.now() - startMs,
    message: final.length === 0 ? `No in-stock products found for "${query}". Try broadening your search or ask for a specific category.` : null
  };
}

// ==================== COMPARE PRODUCTS (v6.6.0) ====================
// Salesperson-grade product comparison. For each query string:
//   1. Run smartProductSearch to resolve it into a ranked in-stock product list
//   2. Take the top in-stock hit (qty >= 1) for that query — the "match"
//   3. Pull clean specs from attrs + configurable metadata
// Returns a single structured block the ComparisonAgent can turn into a
// side-by-side table + a clear "winner" call. NEVER invents products or
// specs — if Magento has no match with qty >= 1, the slot is marked missing.
async function compareProducts({ queries = [], sport = null, min_price = null, max_price = null } = {}) {
  const qList = (Array.isArray(queries) ? queries : [])
    .map(q => String(q || '').trim())
    .filter(Boolean)
    .slice(0, 6);

  if (qList.length === 0) {
    return { error: true, message: 'compare_products requires at least 1 query string.' };
  }

  // Resolve each query in parallel — each result is the top in-stock shaped product
  const perQuery = await Promise.all(qList.map(async (q) => {
    const qLower = q.toLowerCase();
    let scopedSport = sport;
    if (!scopedSport) {
      if (qLower.includes('padel')) scopedSport = 'padel';
      else if (qLower.includes('pickle')) scopedSport = 'pickleball';
      else scopedSport = 'tennis';
    }
    try {
      const r = await smartProductSearch({ query: q, sport: scopedSport, min_price, max_price, page_size: 6 });
      const prods = (r.products || []).filter(p => (p.qty || 0) >= 1 && isProductAvailable(p));
      if (prods.length === 0) {
        return { query: q, found: false, candidates_total: (r.products || []).length, message: 'No in-stock match.' };
      }
      const pick = prods[0];
      const specs = pick.specs || {};
      const row = {
        query: q,
        found: true,
        name: pick.name,
        sku: pick.sku,
        brand: pick.brand || null,
        price: pick.price || null,
        original_price: pick.original_price || null,
        qty: pick.qty || 0,
        in_stock: true,
        sport: pick.sport || scopedSport,
        product_url: pick.product_url,
        image: pick.image || null,
        short_description: pick.short_description || null,
        specs: {
          // shoes
          court_type: specs.court_type || null,
          cushioning: specs.cushioning || null,
          width: specs.width || null,
          shoe_type: specs.shoe_type || null,
          shoe_weight: specs.shoe_weight || null,
          outsole: specs.outsole || null,
          outer_material: specs.outer_material || null,
          inner_material: specs.inner_material || null,
          available_sizes: specs.available_sizes || null,
          // racquets / paddles (may be on root attrs — pull from short_description if needed)
          weight: specs.weight || null,
          head_size: specs.head_size || null,
          balance: specs.balance || null,
          string_pattern: specs.string_pattern || null,
          stiffness: specs.stiffness || null,
          made_in_country: specs.made_in_country || null
        },
        // Alternatives if the LLM wants to mention a runner-up for this slot
        alternatives: prods.slice(1, 3).map(a => ({
          name: a.name, sku: a.sku, price: a.price || null, qty: a.qty || 0, product_url: a.product_url
        }))
      };
      return row;
    } catch (err) {
      return { query: q, found: false, error: err.message || String(err) };
    }
  }));

  const found = perQuery.filter(r => r.found);
  const missing = perQuery.filter(r => !r.found);
  const allSameSport = found.length > 0 && found.every(r => r.sport === found[0].sport);

  // Build a lightweight comparison matrix that the LLM can render as a table.
  // Only include keys where at least one product has a value.
  const SPEC_KEYS = [
    'price', 'brand', 'sport',
    'court_type', 'cushioning', 'width', 'shoe_type', 'shoe_weight', 'outsole', 'outer_material', 'available_sizes',
    'weight', 'head_size', 'balance', 'string_pattern', 'stiffness',
    'qty'
  ];
  const matrix = {};
  for (const key of SPEC_KEYS) {
    const vals = found.map(r => {
      if (key === 'price' || key === 'qty' || key === 'brand' || key === 'sport') return r[key];
      return r.specs ? r.specs[key] : null;
    });
    if (vals.some(v => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))) {
      matrix[key] = vals;
    }
  }

  return {
    customer_request: { queries: qList, sport },
    products: perQuery,
    matrix,
    in_stock_count: found.length,
    missing_count: missing.length,
    all_same_sport: allSameSport,
    message: found.length === 0
      ? `None of the ${qList.length} requested product(s) are currently in stock. LLM MUST tell the customer plainly, not invent products.`
      : (missing.length > 0
          ? `${found.length} of ${qList.length} found in stock. LLM should mention which query had no match and offer alternatives if useful.`
          : `All ${found.length} products resolved — present a side-by-side comparison and pick a winner using the customer's likely use case.`)
  };
}

// ==================== EXECUTE ====================
async function executeFunction(name, args, sport = 'tennis') {
  switch (name) {
    case 'get_order_status': return await getOrderStatus(args.order_id);
    case 'get_products_by_category': return await getProductsByCategory(args.category_id, args.page_size, { min_price: args.min_price, max_price: args.max_price, sport });
    case 'search_products': return await searchProducts(args.query, args.page_size, { min_price: args.min_price, max_price: args.max_price, sport });
    case 'get_shoes_ultra': {
      const ultraSport = args?.sport || sport || 'all';
      return await getShoesUltra({ ...(args || {}), sport: ultraSport });
    }
    case 'get_shoes_with_specs': {
      const shoeSport = args?.sport || sport || 'tennis';
      // If sport is 'all' or unspecified generic, search all 3 shoe categories and merge
      if (shoeSport === 'all') {
        const results = await Promise.all(['tennis', 'pickleball', 'padel'].map(s =>
          getShoesWithSpecs({ ...(args || {}), sport: s })
        ));
        const merged = { sport: 'all', products: [], total: 0, showing: 0, message: null };
        for (const r of results) {
          merged.products.push(...(r.products || []));
          merged.total += (r.total || 0);
        }
        merged.products.sort((a, b) => (b.qty || 0) - (a.qty || 0));
        merged.products = merged.products.slice(0, Math.min(args?.page_size || 10, 20));
        merged.showing = merged.products.length;
        if (merged.products.length === 0) merged.message = 'No shoes found across any sport category.';
        else merged.message = results.find(r => r.message)?.message || null;
        return merged;
      }
      return await getShoesWithSpecs({ ...(args || {}), sport: shoeSport });
    }
    case 'get_racquets_with_specs': return await getRacquetsWithSpecs({ ...(args || {}), sport: args?.sport || sport });
    case 'list_brands': return listBrands();
    case 'get_balls': return await getBalls({ ...(args || {}) });
    case 'get_ball_machines': return await getBallMachines({ ...(args || {}), sport });
    case 'find_categories': return { matches: findCategoriesByKeyword(args.keyword) };
    case 'list_categories': return { categories: listAllCategories(args || {}) };
    case 'get_product_reviews': return await getProductReviews(args || {});
    case 'smart_product_search': return await smartProductSearch({ ...(args || {}), sport: args?.sport || sport });
    case 'compare_products': return await compareProducts({ ...(args || {}), sport: args?.sport || sport });
    default: return { error: true, message: `Unknown function: ${name}` };
  }
}

// ==================== MULTI-AGENT PRE-PROCESSOR (v4.7.0) ====================
// Deterministic intent + entity extractor. Runs BEFORE the LLM so we can:
//   (a) force the right tool call when confidence is high (avoids LLM routing errors)
//   (b) inject structured hints into the system prompt
//   (c) catch specific product queries the LLM tends to phrase poorly to the API
// No extra LLM round-trip ÃÂ¢ÃÂÃÂ pure regex/keyword scoring, so latency stays flat.
const INTENT_RULES = [
  // intent,            patterns (match any),                                     forceTool,                                        hint
  // v6.6.0: Comparison intent wins over product-type intents — "compare X vs Y" / "X or Y?" / "difference between X and Y"
  { intent: 'comparison',
    rx: [/\bcompare\b/i, /\bvs\.?\b/i, /\bversus\b/i, /\bdifference\s+between\b/i, /\bside\s*by\s*side\b/i, /which\s+is\s+better/i, /\bor\b.*\?$/i],
    force: null },
  // v6.1.5: Sport-specific shoe intents BEFORE generic shoe — more specific wins
  { intent: 'padel_shoe',
    rx: [/\bpadel\b.*(shoe|shoes|footwear|sneaker)/i, /(shoe|shoes|footwear|sneaker).*\bpadel\b/i],
    force: 'get_shoes_ultra', hintArgs: { sport: 'padel' } },
  { intent: 'pickleball_shoe',
    rx: [/pickle\s*ball.*(shoe|shoes|footwear|sneaker)/i, /(shoe|shoes|footwear|sneaker).*pickle/i],
    force: 'get_shoes_ultra', hintArgs: { sport: 'pickleball' } },
  { intent: 'shoe',
    rx: [/\b(shoe|shoes|footwear|sneaker|sneakers|trainer|trainers)\b/i, /sports?\s+shoe/i, /court\s+shoe/i],
    force: 'get_shoes_ultra' },
  { intent: 'ball_machine',
    rx: [/ball\s*machine/i, /ball\s*thrower/i, /ball\s*cannon/i, /ball\s*launcher/i, /ball\s*feeder/i, /\btenniix\b/i, /\bai\s*ball\b/i, /smart\s*ball/i],
    force: 'get_ball_machines' },
  // v6.2.0: sport-specific ball intents must win over the generic ball rule.
  { intent: 'pickleball_ball',
    rx: [/pickle\s*ball\s*balls?/i, /balls?\s+for\s+pickle/i, /pickleball\s+ball/i],
    force: 'get_balls', hintArgs: { sport: 'pickleball' } },
  { intent: 'padel_ball',
    rx: [/\bpadel\b.*balls?/i, /balls?.*\bpadel\b/i],
    force: 'get_balls', hintArgs: { sport: 'padel' } },
  { intent: 'tennis_ball',
    rx: [/tennis\s+balls?/i, /balls?\s+for\s+tennis/i],
    force: 'get_balls', hintArgs: { sport: 'tennis' } },
  { intent: 'ball',
    rx: [/\bballs?\b/i],
    force: 'get_balls' },
  { intent: 'pickleball_paddle',
    rx: [/pickle\s*ball.*paddle/i, /paddle.*pickle/i, /pickleball\s+paddle/i, /paddleball\s*paddle/i, /paddle\s*ball\s*paddle/i, /pickle\s*paddle/i, /paddleball/i],
    force: 'get_racquets_with_specs', hintArgs: { sport: 'pickleball' } },
  { intent: 'padel_racket',
    rx: [/\bpadel\b.*(racket|racquet)/i, /(racket|racquet).*\bpadel\b/i],
    force: 'get_racquets_with_specs', hintArgs: { sport: 'padel' } },
  { intent: 'tennis_racquet',
    rx: [/tennis.*(racquet|racket)/i, /(racquet|racket).*tennis/i],
    force: 'get_racquets_with_specs', hintArgs: { sport: 'tennis' } },
  // v6.2.1: Generic racquet/paddle intent — triggers ONLY when no sport word is present.
  // Sport-specific rules above score higher when the user names a sport, so this stays as
  // the fallback that fires the "which sport?" clarification gate in /api/chat.
  { intent: 'racquet',
    rx: [/\b(racquet|racquets|racket|rackets)\b/i, /\b(paddle|paddles)\b/i],
    force: 'get_racquets_with_specs' },
  { intent: 'order_status',
    rx: [/order\s*(id|number|#)?\s*[:#]?\s*\d{3,}/i, /track.*order/i, /where.*order/i, /my\s+order/i],
    force: 'get_order_by_id' },
  { intent: 'return_policy',
    rx: [/return\s*policy/i, /refund/i, /exchange\s+policy/i, /return.*product/i],
    force: null },
  { intent: 'shipping_policy',
    rx: [/shipping/i, /delivery\s+time/i, /when.*deliver/i, /courier/i],
    force: null },
  { intent: 'greeting',
    rx: [/^\s*(hi|hello|hey|namaste|good\s*(morning|evening|afternoon))\s*[!.?]?\s*$/i],
    force: null }
];

function classifyIntent(userText) {
  const text = String(userText || '');
  const results = [];
  for (const rule of INTENT_RULES) {
    let score = 0;
    for (const r of rule.rx) if (r.test(text)) score += 1;
    if (score > 0) results.push({ intent: rule.intent, score, force: rule.force, hintArgs: rule.hintArgs || {} });
  }
  results.sort((a, b) => b.score - a.score);
  const top = results[0] || null;

  // Simple entity extraction
  const entities = {};
  const priceMatch = text.match(/(?:under|below|<=?|less than)\s*ÃÂ¢ÃÂÃÂ¹?\s*(\d[\d,]*)/i);
  if (priceMatch) entities.max_price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
  const priceMatch2 = text.match(/(?:over|above|>=?|more than)\s*ÃÂ¢ÃÂÃÂ¹?\s*(\d[\d,]*)/i);
  if (priceMatch2) entities.min_price = parseInt(priceMatch2[1].replace(/,/g, ''), 10);
  const sizeMatch = text.match(/\bsize\s*(\d{1,2}(?:\.\d)?)/i) || text.match(/\b(uk|us|eu)\s*(\d{1,2}(?:\.\d)?)/i);
  if (sizeMatch) entities.size = sizeMatch[sizeMatch.length - 1];
  const orderMatch = text.match(/\b(\d{6,12})\b/);
  if (orderMatch && /order|track/i.test(text)) entities.order_id = orderMatch[1];
  const brands = ['wilson','babolat','head','yonex','prince','tecnifibre','dunlop','asics','nike','adidas','k-swiss','new balance','diadem','selkirk','joola','bullpadel','tenniix','bolt'];
  for (const b of brands) if (new RegExp('\\b'+b.replace(/\s+/g,'\\s+')+'\\b', 'i').test(text)) { entities.brand = b; break; }

  return { top, all: results, entities };
}

// Ring-buffer trace of last N chat turns for /api/debug/trace
const TRACE = [];
const TRACE_MAX = 50;
function pushTrace(entry) {
  TRACE.push({ ts: new Date().toISOString(), ...entry });
  while (TRACE.length > TRACE_MAX) TRACE.shift();
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
    const mentionsPickle = /pickleball|pickle|paddleball|paddle\s*ball/i.test(lowerUser);
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

    // Multi-agent pre-processor: classify intent BEFORE sending to LLM.
    const classification = classifyIntent(lastUser);

    // v6.3.0: LAYER 1 — single authoritative sport detector. Pulls sport from the
    // current query (incl. brand signals like "Bullpadel", "Selkirk", "Pro Staff")
    // and falls back to the most recent user turn that mentions a sport. Replaces
    // the previous scattered mentionsPickle / mentionsPadel / sportInRecent trio.
    const detectedSportForTurn = detectSport(lastUser, messages.filter(m => m && m.role === 'user'));

    // v6.1.5 + v6.2.1 + v6.3.0: SPORT INJECTION — inject the detected sport into
    // the tool hintArgs so deterministic routing (not the LLM's guess) picks the
    // right store. If detectSport returns null we fall through to the clarification
    // gate below.
    if (classification.top && classification.top.force) {
      if (!classification.top.hintArgs) classification.top.hintArgs = {};
      if (!classification.top.hintArgs.sport && detectedSportForTurn) {
        classification.top.hintArgs.sport = detectedSportForTurn;
      }
    }

    // v6.2.1: SPORT CLARIFICATION GATE — if the query is a generic shoe/ball/racquet
    // request with no sport anywhere in recent context, don't guess. Ask first. This
    // prevents the bot from dumping the wrong sport's catalogue or defaulting to tennis
    // when the customer meant pickleball/padel.
    const AMBIGUOUS_GENERIC_INTENTS = new Set(['shoe', 'ball', 'racquet']);
    if (
      classification.top &&
      AMBIGUOUS_GENERIC_INTENTS.has(classification.top.intent) &&
      !classification.top.hintArgs?.sport
    ) {
      const nounMap = { shoe: 'shoes', ball: 'balls', racquet: 'racquet or paddle' };
      const noun = nounMap[classification.top.intent] || classification.top.intent;
      const clarifyingReply =
        `Happy to help you find the right ${noun}! Which sport are you shopping for — ` +
        `tennis, pickleball, or padel? Once you tell me, I'll pull the in-stock options ` +
        `for that sport.`;
      pushTrace({
        user: lastUser,
        intent: classification.top.intent,
        entities: classification.entities || {},
        forced: null,
        iterations: 0,
        action: 'sport_clarification'
      });
      return res.json({
        message: clarifyingReply,
        intent: classification.top.intent,
        action: 'sport_clarification'
      });
    }

    const agentHint = classification.top ? {
      role: 'system',
      content: `INTENT DETECTED: ${classification.top.intent} (score=${classification.top.score}). ` +
        (classification.top.force ? `You MUST call ${classification.top.force} first` +
          (Object.keys(classification.top.hintArgs).length ? ` with ${JSON.stringify(classification.top.hintArgs)}` : '') + '.' :
          'Answer from policy/knowledge if no tool fits.') +
        (Object.keys(classification.entities).length ? ` Entities: ${JSON.stringify(classification.entities)}.` : '')
    } : null;
    // Promote intent force over size directive when both fire and intent is strong.
    if (classification.top && classification.top.force && !forceToolChoice?.function) {
      forceToolChoice = { type: 'function', function: { name: classification.top.force } };
    }
    // v6.3.0: LAYER 3 — inject sport-specific "Coach" notes when sport is resolved.
    // Also add a hard cross-sport rule so the LLM cannot recommend off-sport products
    // even if something slips through the retrieval filter.
    const coachingDirective = detectedSportForTurn && SPORT_COACHING_NOTES[detectedSportForTurn] ? {
      role: 'system',
      content:
        `SPORT SCOPE FOR THIS CONVERSATION: ${detectedSportForTurn.toUpperCase()}.\n` +
        `You are answering as a ${detectedSportForTurn} coach. HARD RULES:\n` +
        `1) Only recommend products returned by the tool calls in this turn. Do not invent products, SKUs, prices, or URLs.\n` +
        `2) Do NOT reference tennis/pickleball/padel gear other than ${detectedSportForTurn}. If retrieval returns a product stamped with a different sport, ignore it.\n` +
        `3) Every product you mention MUST use the exact name, price, and product_url from the tool result, verbatim.\n` +
        `4) If the retrieved list is empty or does not match the user's ask, say so honestly and offer the closest in-stock option — do not pretend.\n` +
        `COACHING CONTEXT: ${SPORT_COACHING_NOTES[detectedSportForTurn]}`
    } : null;

    const systemParts = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (sizeDirective) systemParts.push(sizeDirective);
    if (agentHint) systemParts.push(agentHint);
    if (coachingDirective) systemParts.push(coachingDirective);
    const apiMessages = [...systemParts, ...messages];

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
        // Override LLM args with deterministic hintArgs from INTENT_RULES (e.g. paddleballÃÂ¢ÃÂÃÂpickleball)
        if (classification.top && classification.top.hintArgs && classification.top.force === funcName) {
          Object.assign(funcArgs, classification.top.hintArgs);
        }
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

    pushTrace({ user: lastUser, intent: classification?.top?.intent || null, entities: classification?.entities || {}, forced: forceToolChoice?.function?.name || null, iterations });
    res.json({ message: assistantMessage.content, usage: response.data.usage, intent: classification?.top?.intent || null });
  } catch (error) {
    console.error('Chat API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Something went wrong. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== MULTI-AGENT CHAT ====================
// GET conversation history for a session (for page reconnect / restore)
app.get('/api/session-history', (req, res) => {
  const sessionId = sessionStore.fallbackId(req);
  const history = sessionStore.getHistory(sessionId);
  const slots = sessionStore.get(sessionId).slots || {};
  res.json({ session_id: sessionId, history, slots });
});

app.post('/api/chat-agents', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // ===== v3.3: session + deterministic slot parsing =====
    const sessionId = sessionStore.fallbackId(req);
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    // Reset word? Drop prior session state.
    if (slotParser.shouldReset(lastUser)) {
      sessionStore.reset(sessionId);
    }

    const prior = sessionStore.get(sessionId).slots || {};

    // v5.6.0: Run deterministic parser first. If it already has high-confidence
    // intent (shoe, order, greeting, etc.), skip the normalizer to save ~1.5s.
    // Only call normalizer for ambiguous/messy queries where regex can't help.
    const fresh = slotParser.parseSlots(lastUser);
    let merged = slotParser.mergeSlots(prior, fresh);
    const skipNormalizer = !!(merged.intent_hint && ['shoe', 'order', 'greeting', 'brand', 'policy'].includes(merged.intent_hint));
    let normResult = { ok: false, spec: null, latency_ms: 0 };
    if (!skipNormalizer) {
      const conversationHistoryForNormalizer = sessionStore.getHistory(sessionId);
      normResult = await normalizeQuery(lastUser, conversationHistoryForNormalizer);
      if (normResult.ok && normResult.spec) {
        merged = slotParser.slotsFromSpec(normResult.spec, merged);
        merged._normalizer_spec = normResult.spec;
      }
    } else {
      console.log(`[normalizer] skipped ÃÂ¢ÃÂÃÂ parser already has intent_hint=${merged.intent_hint}`);
    }

    // v5.5.0 + v5.6.0: Follow-up detection ÃÂ¢ÃÂÃÂ prefer normalizer's is_follow_up flag.
    const followUp = slotParser.detectFollowUp(lastUser);
    let followUpHint = '';
    const lastIntent = sessionStore.getLastIntent(sessionId);
    // v6.0.1: If normalizer confidently says this is a NEW topic (not follow-up),
    // trust it over the regex detectFollowUp(). Fixes "Adidas Multigame Bag" being
    // misrouted as a follow-up to the prior racquet query.
    const normSaysNewTopic = normResult.ok && normResult.spec && !normResult.spec.is_follow_up && normResult.spec.confidence >= 0.7;
    const isFollowUpDetected = normSaysNewTopic ? false : ((normResult.spec?.is_follow_up) || !!followUp);

    if (isFollowUpDetected) {
      const refinementType = normResult.spec?.refinement_type || followUp?.type || 'more';
      followUpHint = `Follow-up refinement detected: ${refinementType}. Customer wants to refine/continue the PREVIOUS search ÃÂ¢ÃÂÃÂ stay in the same product domain.`;
      if (lastIntent && !merged.intent_hint) {
        merged.intent_hint = lastIntent;
        console.log(`[session:${sessionId}] follow-up "${refinementType}" ÃÂ¢ÃÂÃÂ inheriting intent=${lastIntent}`);
      }
      if (merged.quantity) {
        merged._page_size = merged.quantity;
        followUpHint += ` Use page_size=${merged.quantity}.`;
      } else if (followUp?.page_size) {
        merged._page_size = followUp.page_size;
        followUpHint += ` Use page_size=${followUp.page_size}.`;
      }
      merged._follow_up = refinementType;
    }

        merged._rendered = slotParser.renderSlotsHint(merged);
    sessionStore.update(sessionId, { slots: merged });

    // Retrieve last products so follow-ups like "the second one" have a reference.
    const lastProducts = sessionStore.getLastProducts(sessionId);

    // ===== v5.0.1: Smart order intent detection =====
    // If user says "order status" / "track" / "status" and session already has order_id,
    // force intent to 'order' even if the current message doesn't contain the ID.
    if (!merged.intent_hint && merged.order_id &&
        /\b(order|status|track|tracking|dispatch|shipment|delivery|where is)\b/i.test(lastUser)) {
      merged.intent_hint = 'order';
      merged._rendered = slotParser.renderSlotsHint(merged);
      console.log(`[session:${sessionId}] forced order intent ÃÂ¢ÃÂÃÂ order_id=${merged.order_id} from session`);
    }

    // ===== v4.8: Server-side conversation memory =====
    // Build full conversation from server-side history + new message(s).
    // If client sends only the latest user message, we prepend stored history.
    // If client sends full history, we use it as-is and sync to server store.
    const serverHistory = sessionStore.getHistory(sessionId);
    let fullMessages;

    if (messages.length <= 2) {
      // Client sent only latest turn(s) ÃÂ¢ÃÂÃÂ prepend server-side history
      fullMessages = [...serverHistory, ...messages];
    } else {
      // Client sent full history ÃÂ¢ÃÂÃÂ use it and sync to server
      fullMessages = messages;
      sessionStore.setHistory(sessionId, messages.filter(m => m.role !== 'system'));
    }

    // Save the latest user message to server history
    if (lastUser) {
      sessionStore.addMessage(sessionId, 'user', lastUser);
    }

    // Humanized session hint for the LLM Ã¢ÂÂ includes slot context + brief conversation summary
    const turns = sessionStore.get(sessionId).turns || 0;
    let sessionHint = '';
    if (turns > 1) {
      const parts = [];
      // Slot context
      if (prior && Object.keys(prior).some(k => prior[k] != null && k !== '_rendered')) {
        parts.push(`Previous slots: ${slotParser.renderSlotsHint(prior) || '(none)'}. Current merged: ${merged._rendered || '(none)'}`);
      }
      // Brief conversation summary from last 2 assistant responses (so LLM knows what it just recommended)
      const recentAssistant = serverHistory.filter(m => m.role === 'assistant').slice(-2);
      if (recentAssistant.length > 0) {
        const summaries = recentAssistant.map(m => {
          // Truncate to first 300 chars to keep token usage reasonable
          const text = (m.content || '').slice(0, 300);
          return text.length >= 300 ? text + '...' : text;
        });
        parts.push(`Your recent responses to this customer: ${summaries.join(' | ')}`);
      }
      sessionHint = parts.join('. ');
    }

    console.log(`[session:${sessionId}] turn=${turns} history=${serverHistory.length}msgs slots={${merged._rendered}}`);

    // v6.2.1: SPORT CLARIFICATION GATE (multi-agent endpoint).
    // If the user asks a generic shoe/ball/racquet query without naming a sport, scan the
    // recent conversation for a sport word. If none is found anywhere, short-circuit with
    // a clarifying question instead of guessing (or defaulting to tennis). This must run
    // AFTER follow-up detection — follow-ups like "more please" inherit the session's
    // prior intent and sport, so they should not trigger the gate.
    const needsSportClarification =
      !isFollowUpDetected &&
      !merged.sport &&
      (
        merged.intent_hint === 'shoe' ||
        merged.intent_hint === 'racquet' ||
        merged.category === 'balls'
      );
    if (needsSportClarification) {
      // v6.3.0: Use centralized detectSport() with brand-aware keywords. Feed it
      // both the current turn and recent user history so sticky sport context
      // (e.g. "show me pickleball paddles" → two turns later "any new shoes?")
      // resolves via conversation continuity + brand signals, not raw regex.
      const agentsHistoryForDetect = [
        ...serverHistory.filter(m => m && m.role === 'user'),
        { role: 'user', content: lastUser }
      ];
      const sportInAgentsHistory = detectSport(lastUser, agentsHistoryForDetect);
      if (sportInAgentsHistory) {
        // Backfill sport from recent history so downstream tools get the right store.
        merged.sport = sportInAgentsHistory;
        merged._rendered = slotParser.renderSlotsHint(merged);
        sessionStore.update(sessionId, { slots: merged });
        console.log(`[session:${sessionId}] sport backfilled from recent history: ${sportInAgentsHistory}`);
      } else {
        const nounForCategory =
          merged.intent_hint === 'shoe' ? 'shoes' :
          merged.intent_hint === 'racquet' ? 'racquet or paddle' :
          'balls';
        const clarifyingReply =
          `Happy to help you find the right ${nounForCategory}! Which sport are you shopping ` +
          `for — tennis, pickleball, or padel? Once you tell me, I'll pull the in-stock options ` +
          `for that sport.`;
        sessionStore.addMessage(sessionId, 'assistant', clarifyingReply);
        console.log(`[session:${sessionId}] sport clarification short-circuit (intent_hint=${merged.intent_hint}, category=${merged.category})`);
        return res.json({
          message: clarifyingReply,
          session_id: sessionId,
          slots: merged,
          action: 'sport_clarification',
          _normalizer: {
            ok: normResult.ok,
            latency_ms: normResult.latency_ms,
            error: normResult.error || null,
            spec: normResult.spec || null
          }
        });
      }
    }

    // Bind sport to executeFunction so all tool calls get the right store URL
    const detectedSport = merged.sport || 'tennis';
    const sportBoundExecute = (name, args) => executeFunction(name, args, detectedSport);

    // v5.6.0: Build enriched session hint from normalized spec bits
    const specBits = [];
    if (merged.normalized_query) specBits.push(`query="${merged.normalized_query}"`);
    if (merged.brand) specBits.push(`brand=${merged.brand}`);
    if (merged.model) specBits.push(`model=${merged.model}`);
    if (merged.sport) specBits.push(`sport=${merged.sport}`);
    if (merged.skill_level) specBits.push(`skill_level=${merged.skill_level}`);
    if (merged.playing_style) specBits.push(`playing_style=${merged.playing_style}`);
    if (merged.size) specBits.push(`size=${merged.size}`);
    if (merged.min_price != null) specBits.push(`min_price=${merged.min_price}`);
    if (merged.max_price != null) specBits.push(`max_price=${merged.max_price}`);
    if (merged._page_size) specBits.push(`page_size=${merged._page_size}`);
    let enrichedSessionHint = specBits.length
      ? `${sessionHint || ''} [NORMALIZED SPEC ÃÂ¢ÃÂÃÂ USE THESE VALUES VERBATIM] ${specBits.join(', ')}`
      : sessionHint;

    // v6.3.0: LAYER 3 COACHING DIRECTIVE for /api/chat-agents pipeline.
    // Append per-sport coaching rules + hard cross-sport guardrails so the
    // master handler / LLM stays locked to the detected sport. These rules are
    // additive to the normalized-spec hint and are consumed by masterHandle's
    // sessionHint parameter (which it forwards into the LLM system prompt).
    const agentsCoachSport = merged.sport || null;
    if (agentsCoachSport && SPORT_COACHING_NOTES[agentsCoachSport]) {
      const coachBlock =
        ` [SPORT SCOPE: ${agentsCoachSport.toUpperCase()}] ` +
        `You are answering as a ${agentsCoachSport} coach. HARD RULES: ` +
        `(1) Only recommend products returned by the tool calls in this turn - do not invent SKUs, prices, or URLs. ` +
        `(2) Do NOT reference tennis/pickleball/padel gear other than ${agentsCoachSport}. If a product is stamped with a different sport, ignore it. ` +
        `(3) Every product you mention MUST use the exact name, price, and product_url from the tool result. ` +
        `(4) If the retrieved list is empty or off-target, say so honestly and offer the closest in-stock option. ` +
        `COACHING CONTEXT: ${SPORT_COACHING_NOTES[agentsCoachSport]}`;
      enrichedSessionHint = (enrichedSessionHint || '') + coachBlock;
    }

    // v5.7.0: NO deadline ÃÂ¢ÃÂÃÂ let the pipeline complete naturally.
    // Correctness > speed. The LLM + Magento will take as long as they need.
    const result = await masterHandle({
      userMessages: fullMessages,
      allTools: FUNCTION_DEFINITIONS,
      executeFunction: sportBoundExecute,
      slots: merged,
      sessionHint: enrichedSessionHint,
      followUpHint,
      lastProducts,
      normalizedSpec: normResult.spec || null
    });

    // Save assistant response to server history
    if (result.message) {
      sessionStore.addMessage(sessionId, 'assistant', result.message);
    }

    // v5.5.0: Capture products + intent so next-turn follow-ups have context.
    try {
      if (result.agent_trace?.router?.intent && result.agent_trace.router.intent !== 'other') {
        sessionStore.setLastIntent(sessionId, result.agent_trace.router.intent);
      }
      const productLinks = [...(result.message || '').matchAll(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g)];
      if (productLinks.length > 0) {
        const products = productLinks.map(m => ({ name: m[1], product_url: m[2] }));
        sessionStore.setLastProducts(sessionId, products);
        console.log(`[session:${sessionId}] captured ${products.length} products + intent=${result.agent_trace?.router?.intent}`);
      }
    } catch (e) {
      console.warn(`[session:${sessionId}] product capture failed:`, e.message);
    }

    // Attach session id so clients can pin it across turns if they want.
    res.json({ ...result, session_id: sessionId, slots: merged, _normalizer: { ok: normResult.ok, latency_ms: normResult.latency_ms, error: normResult.error || null, spec: normResult.spec || null } });
  } catch (error) {
    console.error('Multi-agent error:', error.response?.data || error.message);
    // v5.5.0: Return 200 with a friendly message instead of 500 so the chat UI
    // stays alive. Session history is untouched ÃÂ¢ÃÂÃÂ next turn resumes cleanly.
    const errSessionId = sessionStore.fallbackId(req);
    const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout/i.test(error.message || '');
    const friendlyMessage = isTimeout
      ? "Sorry, that took longer than usual. Could you send your last message once more? Your conversation context is saved so I'll pick up right where we left off."
      : "I hit a snag on that one ÃÂ¢ÃÂÃÂ please try sending your message again. Everything we discussed is still in memory.";
    res.status(200).json({
      message: friendlyMessage,
      agent_trace: { error: true, reason: error.code || error.message, recoverable: true },
      session_id: errSessionId
    });
  }
});

// ==================== AUTO-REFRESH (v4.6.0) ====================
// Reloads category tree + attribute options every 30 min so newly-added
// products / categories are picked up automatically without a redeploy.
let lastCatalogRefresh = null;
async function refreshCatalog(reason = 'interval') {
  const started = Date.now();
  try {
    await Promise.allSettled([loadAttributeOptions(), initCategoryMap()]);
    lastCatalogRefresh = { at: new Date().toISOString(), reason, took_ms: Date.now() - started, categories: CATEGORY_MAP.length, ball_machine_ids: [...BALL_MACHINE_CATEGORY_IDS] };
    console.log(`[refresh] ${reason} ok - ${CATEGORY_MAP.length} cats in ${Date.now() - started}ms`);
  } catch (e) {
    lastCatalogRefresh = { at: new Date().toISOString(), reason, error: e.message };
    console.log(`[refresh] ${reason} FAILED:`, e.message);
  }
}
setInterval(() => refreshCatalog('interval'), 30 * 60 * 1000).unref?.();

// Webhook so Magento (or a cron) can force a reload on product/category change.
// Protect with a shared secret in REFRESH_SECRET env var (optional).
app.post('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET;
  if (secret && req.headers['x-refresh-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  await refreshCatalog('webhook');
  res.json({ ok: true, ...lastCatalogRefresh });
});

// ==================== DEBUG TRACE (v4.7.0) ====================
app.get('/api/debug/trace', (req, res) => {
  res.json({ count: TRACE.length, trace: TRACE.slice().reverse() });
});

app.get('/api/debug/classify', (req, res) => {
  const q = String(req.query.q || '');
  const result = classifyIntent(q);
  // v6.1.5: Show sport injection as it would happen in /api/chat
  const qLow = q.toLowerCase();
  if (result.top && result.top.force) {
    if (!result.top.hintArgs) result.top.hintArgs = {};
    if (!result.top.hintArgs.sport) {
      if (/padel/i.test(q)) result.top.hintArgs.sport = 'padel';
      else if (/pickleball|pickle/i.test(q)) result.top.hintArgs.sport = 'pickleball';
    }
  }
  res.json({ query: q, ...result });
});

// ==================== PRODUCT PROBE (v4.7.1) ====================
// Direct Magento lookup that skips status/visibility filters ÃÂ¢ÃÂÃÂ for diagnosing
// missing products. Returns raw API response.
app.get('/api/debug/probe', async (req, res) => {
  const q = String(req.query.q || 'tenniix');
  try {
    // Strategy 1: name LIKE without status filter
    const r1 = await magentoGet('/products', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'name',
      'searchCriteria[filter_groups][0][filters][0][value]': '%' + q + '%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[pageSize]': 10
    });
    // Strategy 2: url_key LIKE without status filter
    const r2 = await magentoGet('/products', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'url_key',
      'searchCriteria[filter_groups][0][filters][0][value]': '%' + q + '%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[pageSize]': 10
    });
    // Strategy 3: sku LIKE without status filter
    const r3 = await magentoGet('/products', {
      'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
      'searchCriteria[filter_groups][0][filters][0][value]': '%' + q + '%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      'searchCriteria[pageSize]': 10
    });
    const fmt = items => (items || []).map(i => ({
      sku: i.sku, name: i.name, url_key: (i.custom_attributes||[]).find(a=>a.attribute_code==='url_key')?.value,
      status: i.status, visibility: i.visibility, type_id: i.type_id, price: i.price
    }));
    res.json({
      query: q,
      by_name: { total: r1.total_count, items: fmt(r1.items) },
      by_url_key: { total: r2.total_count, items: fmt(r2.items) },
      by_sku: { total: r3.total_count, items: fmt(r3.items) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== HEALTH ====================
app.get('/api/health', async (req, res) => {
  const pkg = require('./package.json');
  let magentoStatus = 'unknown';
  let oauthStatus = 'unknown';
  const errors = {};
  try { await magentoGet('/store/storeConfigs'); magentoStatus = 'connected'; }
  catch (e) { magentoStatus = 'disconnected'; errors.magento_bearer = e.response?.status ? `HTTP ${e.response.status}` : (e.code || e.message || 'unknown'); }
  try {
    if (OAUTH_CONSUMER_KEY) {
      await oauthGet('/orders', { 'searchCriteria[pageSize]': 1 });
      oauthStatus = 'connected';
    } else { oauthStatus = 'not-configured'; }
  } catch (e) { oauthStatus = 'disconnected'; errors.magento_oauth = e.response?.status ? `HTTP ${e.response.status}` : (e.code || e.message || 'unknown'); }

  res.json({
    status: 'running',
    version: pkg.version,
    code_build: '6.1.5c',
    last_refresh: lastCatalogRefresh,
    categories_loaded: CATEGORY_MAP.length,
    category_index_keys: Object.keys(CATEGORY_INDEX).length,
    magento_bearer: magentoStatus,
    magento_oauth: oauthStatus,
    errors: Object.keys(errors).length ? errors : undefined,
    model: OPENROUTER_MODEL,
    timestamp: new Date().toISOString()
  });
});

// ==================== STOCK DIAGNOSTIC (temporary) ====================
app.get('/api/debug/shoes-ultra', async (req, res) => {
  try {
    const sport = String(req.query.sport || 'all');
    const size = req.query.size ? String(req.query.size) : null;
    const brand = req.query.brand ? String(req.query.brand) : null;
    const result = await getShoesUltra({ sport, size, brand, page_size: 10 });
    // Keep response compact for inspection
    const slim = {
      customer_query: result.customer_query,
      size_requested: result.size_requested,
      size_available: result.size_available,
      total: result.total,
      showing: result.showing,
      message: result.message,
      products: (result.products || []).map(p => ({
        name: p.name, sku: p.sku, price: p.price, qty: p.qty,
        sport: p.sport, in_stock: p.in_stock,
        sizes_in_stock: p.sizes_in_stock,
        has_requested_size: p.has_requested_size
      }))
    };
    res.json(slim);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,5) });
  }
});

app.get('/api/stock-debug', async (req, res) => {
  const keyword = req.query.q || 'tennis racquet';
  const sport = req.query.sport || 'tennis';
  const sku = req.query.sku; // deep-dive a single configurable SKU
  try {
    // mode=scan: find ANY products with real stock in MSI
    if (req.query.mode === 'scan') {
      // Query MSI source-items with qty > 0
      const scanResult = {};
      try {
        const msiParams = {
          'searchCriteria[filter_groups][0][filters][0][field]': 'quantity',
          'searchCriteria[filter_groups][0][filters][0][value]': 0,
          'searchCriteria[filter_groups][0][filters][0][condition_type]': 'gt',
          'searchCriteria[filter_groups][1][filters][0][field]': 'status',
          'searchCriteria[filter_groups][1][filters][0][value]': 1,
          'searchCriteria[pageSize]': 20,
          'searchCriteria[sortOrders][0][field]': 'quantity',
          'searchCriteria[sortOrders][0][direction]': 'DESC'
        };
        let msiRes;
        try { msiRes = await oauthGet('/inventory/source-items', msiParams); }
        catch { msiRes = await magentoGet('/inventory/source-items', msiParams); }
        scanResult.total_in_stock = msiRes.total_count || 0;
        scanResult.top_stock = (msiRes.items || []).map(i => ({
          sku: i.sku, source: i.source_code, qty: i.quantity, status: i.status
        }));
      } catch (e) { scanResult.msi_error = e.message; }
      // Also try stockItems via OAuth for a known shoe child
      try {
        const si = await oauthGet(`/stockItems/TSH0011-10`);
        scanResult.oauth_stockItem_test = { sku: 'TSH0011-10', qty: si.qty, is_in_stock: si.is_in_stock };
      } catch (e) { scanResult.oauth_stockItem_error = e.message; }
      return res.json(scanResult);
    }
    // v6.4.1: category=<id> mode — return real products in the given category
    // with live MSI stock. This is the "ultrareview" path that proves via the
    // actual Magento call what's reachable through a category, independent of
    // noisy keyword LIKE search.
    if (req.query.category) {
      const catId = String(req.query.category).trim();
      const pageSize = Math.min(parseInt(req.query.pageSize, 10) || 50, 200);
      const params = {
        'searchCriteria[filter_groups][0][filters][0][field]': 'category_id',
        'searchCriteria[filter_groups][0][filters][0][value]': catId,
        'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
        'searchCriteria[filter_groups][1][filters][0][field]': 'status',
        'searchCriteria[filter_groups][1][filters][0][value]': 1,
        'searchCriteria[filter_groups][1][filters][0][condition_type]': 'eq',
        'searchCriteria[pageSize]': pageSize
      };
      // Optional: attribute_set filter (e.g. 24 = Pickleball-Bags) for a tighter view.
      if (req.query.attribute_set_id) {
        params['searchCriteria[filter_groups][2][filters][0][field]'] = 'attribute_set_id';
        params['searchCriteria[filter_groups][2][filters][0][value]'] = req.query.attribute_set_id;
        params['searchCriteria[filter_groups][2][filters][0][condition_type]'] = 'eq';
      }
      try {
        const result = await magentoGet('/products', params);
        const items = result.items || [];
        const skus = items.map(i => i.sku);
        const stockMap = await fetchStockMap(skus);
        const rows = items.map(i => {
          const attrs = {};
          (i.custom_attributes || []).forEach(a => { attrs[a.attribute_code] = a.value; });
          const siQty = i.extension_attributes?.stock_item?.qty;
          const siInStock = i.extension_attributes?.stock_item?.is_in_stock;
          return {
            sku: i.sku,
            name: i.name,
            type_id: i.type_id,
            attribute_set_id: i.attribute_set_id,
            status: i.status,
            visibility: i.visibility,
            price: i.price,
            msi_qty: stockMap[i.sku] || 0,
            stock_item_qty: siQty != null ? siQty : null,
            stock_item_in_stock: siInStock != null ? siInStock : null,
            url_key: attrs.url_key
          };
        });
        const in_stock_count = rows.filter(r => r.msi_qty > 0 || r.stock_item_in_stock === true).length;
        return res.json({
          category_id: catId,
          attribute_set_id: req.query.attribute_set_id || null,
          total_count: result.total_count || items.length,
          returned: items.length,
          in_stock_count,
          out_of_stock_count: items.length - in_stock_count,
          items: rows
        });
      } catch (e) {
        return res.status(500).json({ category_id: catId, error: e.message });
      }
    }
    // If a specific SKU is requested, do a deep stock analysis
    if (sku) {
      const deepResult = {};
      // 1. MSI source-items for this SKU
      try {
        const msiParams = {
          'searchCriteria[filter_groups][0][filters][0][field]': 'sku',
          'searchCriteria[filter_groups][0][filters][0][value]': sku,
          'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
          'searchCriteria[pageSize]': 10
        };
        let msiRes;
        try { msiRes = await oauthGet('/inventory/source-items', msiParams); }
        catch { msiRes = await magentoGet('/inventory/source-items', msiParams); }
        deepResult.msi_parent = msiRes.items || [];
      } catch (e) { deepResult.msi_parent_error = e.message; }
      // 2. stockItems for this SKU
      try {
        const si = await magentoGet(`/stockItems/${encodeURIComponent(sku)}`);
        deepResult.stockItem_parent = { qty: si.qty, is_in_stock: si.is_in_stock, manage_stock: si.manage_stock };
      } catch (e) { deepResult.stockItem_parent_error = e.message; }
      // 3. Children
      try {
        const children = await magentoGet(`/configurable-products/${encodeURIComponent(sku)}/children`);
        const childSkus = children.map(c => c.sku);
        // MSI for children
        const childMsi = await fetchStockMap(childSkus);
        // Children stock_item from their own extension_attributes
        deepResult.children = children.map(c => {
          const si = c.extension_attributes?.stock_item;
          return {
            sku: c.sku,
            name: c.name,
            msi_qty: childMsi[c.sku] || 0,
            stock_item_qty: si ? si.qty : null,
            stock_item_in_stock: si ? si.is_in_stock : null
          };
        });
      } catch (e) { deepResult.children_error = e.message; }
      return res.json({ sku, deep: deepResult });
    }
    // Standard search debug
    const params = buildSearchParams(keyword, 8);
    const result = await magentoGet('/products', params);
    if (!result.items || result.items.length === 0) {
      return res.json({ keyword, total: 0, message: 'No Magento results' });
    }
    const items = result.items.slice(0, 8);
    // Check if search results include extension_attributes.stock_item
    const rawStockSample = items.slice(0, 2).map(i => ({
      sku: i.sku,
      type_id: i.type_id,
      has_ext_attrs: !!i.extension_attributes,
      has_stock_item: !!i.extension_attributes?.stock_item,
      stock_item: i.extension_attributes?.stock_item ? {
        qty: i.extension_attributes.stock_item.qty,
        is_in_stock: i.extension_attributes.stock_item.is_in_stock
      } : null
    }));
    const skus = items.map(i => i.sku);
    const stockMap = await fetchStockMap(skus);
    const shaped = items.map(item => shapeProduct(item, stockMap[item.sku] || 0, sport));
    const enrichStart = Date.now();
    await enrichConfigurables(shaped);
    const enrichMs = Date.now() - enrichStart;
    // applyFallbackStock removed in v5.2.0
    const debugProducts = shaped.map(p => ({
      name: p.name,
      sku: p.sku,
      type_id: p.type_id,
      qty: p.qty,
      magento_in_stock: p.magento_in_stock,
      _children_loaded: p._children_loaded || false,
      _children_count: p._children ? p._children.length : 0,
      _children_stock: p._children ? p._children.map(c => ({ sku: c.sku, qty: c.qty, in_stock: c.in_stock })) : [],
      _stock_source: p._stock_source || (p._children_loaded ? 'children' : 'msi'),
      available: isProductAvailable(p)
    }));
    res.json({
      keyword,
      magento_total: result.total_count,
      checked: debugProducts.length,
      enrich_ms: enrichMs,
      raw_stock_sample: rawStockSample,
      msi_map_sample: Object.fromEntries(Object.entries(stockMap).slice(0, 5)),
      products: debugProducts
    });
  } catch (e) {
    res.json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  }
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
  console.log(`[startup] Attribute cache ready.`);
  console.log(`[startup] Loading Magento category map...`);
  await initCategoryMap();
  // v6.4.0: If Magento was cold or returned nothing, retry with backoff so we
  // don't leave the service with CATEGORY_INDEX empty (breaks smart_product_search).
  if (CATEGORY_MAP.length === 0) {
    for (const delay of [2000, 5000, 15000]) {
      console.log(`[startup] category map empty — retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      await initCategoryMap();
      if (CATEGORY_MAP.length > 0) break;
    }
  }
  console.log(`[startup] Category map ready: ${CATEGORY_MAP.length} categories, ${Object.keys(CATEGORY_INDEX).length} index keys.\n`);
});


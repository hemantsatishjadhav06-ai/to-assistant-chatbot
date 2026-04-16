// normalizer.js — LLM-powered query normalization (v6.0.0)
// Converts messy natural-language messages into a clean, structured QuerySpec
// before any specialist runs. Handles typos, slang ("bat" = racquet), Hinglish,
// budget phrases ("20K to 30K"), playing-style descriptions ("best balance"),
// and implicit intent ("i like to play" = browsing intent).
//
// v6.0.0: Added 6 new intents — availability, comparison, starter_kit, coupon, stringing, tech
//
// Uses gpt-4o-mini in JSON mode for speed + cost. Single call, ~300ms.
// Falls back to the raw message if the call fails — never blocks the flow.

const axios = require('axios');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const NORMALIZER_MODEL = process.env.OPENROUTER_NORMALIZER_MODEL || 'openai/gpt-4o-mini';

const NORMALIZER_PROMPT = `You are a query normalizer for a tennis/pickleball/padel e-commerce chatbot. Transform the customer's raw message into a clean, structured JSON spec. Respond with ONLY the JSON object — no prose, no markdown.

SCHEMA:
{
  "intent": "racquet" | "shoe" | "ball" | "string" | "bag" | "overgrip" | "accessory" | "ball_machine" | "order" | "policy" | "brand" | "review" | "availability" | "comparison" | "starter_kit" | "coupon" | "stringing" | "tech" | "greeting" | "other",
  "sport": "tennis" | "pickleball" | "padel" | null,
  "brand": "Babolat" | "Wilson" | "Head" | "Yonex" | "ASICS" | "Nike" | "Adidas" | "Prince" | "Solinco" | "Dunlop" | "Tecnifibre" | "Joma" | "Selkirk" | "Joola" | "Franklin" | "Bullpadel" | "Nox" | "Siux" | null,
  "model": string or null,
  "skill_level": "beginner" | "intermediate" | "advanced" | null,
  "playing_style": "control" | "power" | "spin" | "all-court" | "balance" | "comfort" | null,
  "gender": "mens" | "womens" | "kids" | "unisex" | null,
  "size": string or null,
  "min_price": number or null,
  "max_price": number or null,
  "quantity": number or null,
  "order_id": string or null,
  "is_follow_up": boolean,
  "refinement_type": "more" | "cheaper" | "different_brand" | "different_size" | "select" | null,
  "normalized_query": string,
  "confidence": number
}

INTERPRETATION RULES (CRITICAL):
1. "bat" = racquet. Tennis players commonly call racquets "bats" (especially Indian customers).
2. "racket" = racquet (same thing, spelling variant).
3. "paddle" = pickleball paddle if pickleball context, padel racket if padel context, else ambiguous -> racquet.
4. "shoe", "footwear", "sneaker", "trainer", "sports shoe" = shoe intent.
5. Currency: "5K" = 5000, "20K" = 20000, "1L" / "1 lakh" = 100000. "20K to 30K" means min_price:20000, max_price:30000.
6. Playing style words map like this:
   - "balance", "balanced", "best balance", "control + power" -> playing_style: "balance"
   - "power", "hit hard", "aggressive" -> "power"
   - "control", "precise", "accurate" -> "control"
   - "spin", "topspin", "slice" -> "spin"
   - "comfort", "arm-friendly", "easy on shoulder" -> "comfort"
   - "all court", "versatile", "everything" -> "all-court"
7. Skill inference: "i like to play very much" / "casual" / "weekend" -> beginner. "club level" / "tournament" -> intermediate. "pro" / "competitive" -> advanced.
8. Typos: "verry" = very, "hlp" = help, "brnd" = brand. Fix silently.
9. Hinglish: "dikhao" = show, "chahiye" = want/need, "bata" = tell, "kya hai" = what is.
10. Implicit intent: "i like to play + bat" -> they want to buy a racquet -> intent: "racquet".
11. If message is just "more"/"another"/"cheaper"/"5 shoes" -> is_follow_up: true, refinement_type set, intent usually inherited from context.
12. If the message is a pure greeting ("hi", "hello") -> intent: "greeting".
13. If it's clearly off-topic (weather, math, jokes) -> intent: "other".
14. AVAILABILITY: "is X in stock", "do you have X", "available hai kya", "is this available", sharing a product name/URL and asking about stock -> intent: "availability".
15. COMPARISON: "compare X and Y", "X vs Y", "difference between X and Y", "which is better X or Y" -> intent: "comparison".
16. STARTER KIT: "beginner kit", "starter kit", "complete set for beginner", "new to tennis what do I need", "starting out need everything" -> intent: "starter_kit".
17. COUPON: "any offers", "discount code", "coupon", "sale", "koi offer hai", "promo code" -> intent: "coupon".
18. STRINGING: "stringing service", "restring", "string my racquet", "string tension", "gut string" -> intent: "stringing".
19. TECH: "what weight is X", "head size of Y", "string pattern", "swingweight", "beam width", technical specs question -> intent: "tech".

EXAMPLES:

Input: "i like to play verry much can you hlp me choosing a bat with best balance for tennis with a budget of 20K to 30 K"
Output: {"intent":"racquet","sport":"tennis","brand":null,"model":null,"skill_level":"intermediate","playing_style":"balance","gender":null,"size":null,"min_price":20000,"max_price":30000,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"balanced tennis racquet 20000-30000","confidence":0.95}

Input: "sports shoe size us 10 at 9500"
Output: {"intent":"shoe","sport":"tennis","brand":null,"model":null,"skill_level":null,"playing_style":null,"gender":"mens","size":"US 10","min_price":null,"max_price":9500,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"tennis shoes size US 10 under 9500","confidence":0.92}

Input: "more option"
Output: {"intent":"racquet","sport":null,"brand":null,"model":null,"skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":true,"refinement_type":"more","normalized_query":"more options","confidence":0.7}

Input: "6 sports shoes"
Output: {"intent":"shoe","sport":"tennis","brand":null,"model":null,"skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":6,"order_id":null,"is_follow_up":true,"refinement_type":"more","normalized_query":"6 tennis shoes","confidence":0.9}

Input: "babolat pure aero latest one"
Output: {"intent":"racquet","sport":"tennis","brand":"Babolat","model":"Pure Aero","skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"Babolat Pure Aero","confidence":0.98}

Input: "where is order 400020695"
Output: {"intent":"order","sport":null,"brand":null,"model":null,"skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":"400020695","is_follow_up":false,"refinement_type":null,"normalized_query":"order status 400020695","confidence":0.99}

Input: "kya aapke pas selkirk paddles hai"
Output: {"intent":"racquet","sport":"pickleball","brand":"Selkirk","model":null,"skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"Selkirk pickleball paddles","confidence":0.94}

Input: "is babolat pure aero available"
Output: {"intent":"availability","sport":"tennis","brand":"Babolat","model":"Pure Aero","skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"Babolat Pure Aero availability","confidence":0.96}

Input: "compare head speed and babolat pure aero"
Output: {"intent":"comparison","sport":"tennis","brand":null,"model":null,"skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"compare Head Speed vs Babolat Pure Aero","confidence":0.95}

Input: "i am new to tennis need a complete starter kit under 15K"
Output: {"intent":"starter_kit","sport":"tennis","brand":null,"model":null,"skill_level":"beginner","playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":15000,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"tennis beginner starter kit under 15000","confidence":0.93}

Input: "koi offer ya discount code hai kya"
Output: {"intent":"coupon","sport":null,"brand":null,"model":null,"skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"discount offers or coupon codes","confidence":0.92}

Input: "do you do restringing? what strings do you have"
Output: {"intent":"stringing","sport":"tennis","brand":null,"model":null,"skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"stringing service and available strings","confidence":0.91}

Input: "what is the head size and weight of wilson clash 100"
Output: {"intent":"tech","sport":"tennis","brand":"Wilson","model":"Clash 100","skill_level":null,"playing_style":null,"gender":null,"size":null,"min_price":null,"max_price":null,"quantity":null,"order_id":null,"is_follow_up":false,"refinement_type":null,"normalized_query":"Wilson Clash 100 head size and weight specs","confidence":0.97}

Now normalize the customer's message. Respond with ONLY the JSON, no other text.`;

async function normalizeQuery(userText, conversationHistory = []) {
  const start = Date.now();
  try {
    const messages = [{ role: 'system', content: NORMALIZER_PROMPT }];

    // If there's recent history, give the normalizer enough to resolve follow-ups.
    const recent = (conversationHistory || []).slice(-4).filter(m => m.role === 'user' || m.role === 'assistant');
    if (recent.length > 0) {
      messages.push({
        role: 'system',
        content: `Recent conversation (use to resolve short follow-up messages):\n${recent.map(m => `${m.role}: ${(m.content || '').slice(0, 300)}`).join('\n')}`
      });
    }
    messages.push({ role: 'user', content: String(userText || '') });

    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: NORMALIZER_MODEL,
      messages,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' }
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tennisoutlet.in',
        'X-Title': 'TO Assistant (normalizer)'
      },
      timeout: 8000   // v5.7.2: balanced
    });

    const raw = res.data.choices[0].message.content;
    const spec = JSON.parse(raw);
    const ms = Date.now() - start;
    console.log(`[normalizer] ${ms}ms intent=${spec.intent} sport=${spec.sport} brand=${spec.brand} style=${spec.playing_style} conf=${spec.confidence}`);
    return { ok: true, spec, latency_ms: ms };
  } catch (e) {
    const ms = Date.now() - start;
    console.warn(`[normalizer] failed in ${ms}ms:`, e.message);
    // Non-fatal — caller falls back to the raw parser output
    return { ok: false, spec: null, latency_ms: ms, error: e.message };
  }
}

module.exports = { normalizeQuery };

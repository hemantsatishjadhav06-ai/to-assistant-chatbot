// session.js — in-memory conversation session store with TTL + conversation history.
//
// v2: Added `history` array to store recent conversation turns server-side.
// This means even if the client sends only the latest message, the server
// can reconstruct the full conversation context for the LLM.
//
// If/when Render scales to >1 instance, swap this module for a Redis/Supabase
// adapter exposing the same interface: get(id), set(id, patch), reset(id).

const DEFAULT_TTL_MS = 30 * 60 * 1000;   // 30 minutes since last touch
const MAX_SESSIONS = 5000;                // hard cap before oldest-first eviction
const MAX_HISTORY_TURNS = 20;             // keep last 20 message pairs (40 messages max)

const store = new Map(); // id -> { slots, lastShown, turns, history, createdAt, updatedAt }

function now() { return Date.now(); }

function evictIfNeeded() {
  if (store.size < MAX_SESSIONS) return;
  // Evict by oldest updatedAt
  const entries = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const toEvict = Math.max(1, Math.floor(MAX_SESSIONS * 0.1));
  for (let i = 0; i < toEvict; i++) store.delete(entries[i][0]);
}

function sweep() {
  const cutoff = now() - DEFAULT_TTL_MS;
  for (const [id, s] of store) if (s.updatedAt < cutoff) store.delete(id);
}

// Lazy sweep every ~5 minutes
let lastSweep = 0;
function maybeSweep() {
  if (now() - lastSweep > 5 * 60 * 1000) { sweep(); lastSweep = now(); }
}

function getOrCreate(id) {
  maybeSweep();
  if (!id) return null;
  let s = store.get(id);
  if (!s) {
    evictIfNeeded();
    s = { slots: {}, lastShown: [], turns: 0, history: [], createdAt: now(), updatedAt: now() };
    store.set(id, s);
  }
  return s;
}

function get(id) {
  const s = store.get(id);
  if (!s) return { slots: {}, lastShown: [], turns: 0, history: [] };
  s.updatedAt = now();
  return s;
}

function update(id, patch) {
  const s = getOrCreate(id);
  if (!s) return null;
  if (patch.slots)     s.slots = { ...s.slots, ...patch.slots };
  if (patch.lastShown) s.lastShown = patch.lastShown.slice(0, 10);
  s.turns = (s.turns || 0) + 1;
  s.updatedAt = now();
  return s;
}

// ===== NEW: Conversation history management =====

/**
 * Add a message to the session's conversation history.
 * @param {string} id - Session ID
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - Message text
 */
function addMessage(id, role, content) {
  const s = getOrCreate(id);
  if (!s || !content) return;
  s.history.push({ role, content, ts: now() });
  // Trim to last MAX_HISTORY_TURNS * 2 messages (user+assistant pairs)
  const maxMessages = MAX_HISTORY_TURNS * 2;
  if (s.history.length > maxMessages) {
    s.history = s.history.slice(-maxMessages);
  }
  s.updatedAt = now();
}

/**
 * Get the conversation history for a session.
 * Returns messages in OpenAI chat format: [{ role, content }, ...]
 * @param {string} id - Session ID
 * @returns {Array} - Message history
 */
function getHistory(id) {
  const s = store.get(id);
  if (!s) return [];
  return s.history.map(({ role, content }) => ({ role, content }));
}

/**
 * Replace the full history (e.g., when client sends complete history).
 * @param {string} id - Session ID
 * @param {Array} messages - [{ role, content }, ...]
 */
function setHistory(id, messages) {
  const s = getOrCreate(id);
  if (!s) return;
  const maxMessages = MAX_HISTORY_TURNS * 2;
  s.history = messages.slice(-maxMessages).map(m => ({
    role: m.role,
    content: m.content,
    ts: now()
  }));
  s.updatedAt = now();
}

function reset(id) {
  if (!id) return;
  store.delete(id);
}

function stats() {
  return { active: store.size, maxSessions: MAX_SESSIONS, ttlMs: DEFAULT_TTL_MS };
}

// Convenience: derive a session id if the client didn't send one.
// Stable-per-IP fallback is NOT great but beats nothing; prefer client-sent ids.
function fallbackId(req) {
  const hint = req.headers['x-session-id'] || req.body?.session_id;
  if (hint && typeof hint === 'string' && hint.length <= 64) return hint;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'anon';
  return `ip:${ip}`;
}

/**
 * Store compact product summaries from the most recent tool response.
 * Lets follow-ups like "the second one" reference actual products.
 */
function setLastProducts(id, products) {
  const s = getOrCreate(id);
  if (!s) return;
  s.lastProducts = (products || []).slice(0, 10).map((p, i) => ({
    index: i + 1,
    name: p.name || null,
    sku: p.sku || null,
    price: p.price || null,
    product_url: p.product_url || p.url || null
  }));
  s.updatedAt = now();
}

function getLastProducts(id) {
  const s = store.get(id);
  return s?.lastProducts || [];
}

/**
 * Track which specialist/intent was last invoked successfully, so follow-ups
 * can inherit it even when the LLM router gets confused.
 */
function setLastIntent(id, intent) {
  const s = getOrCreate(id);
  if (!s) return;
  s.lastIntent = intent;
  s.updatedAt = now();
}

function getLastIntent(id) {
  const s = store.get(id);
  return s?.lastIntent || null;
}

module.exports = { get, update, reset, stats, fallbackId, getOrCreate, addMessage, getHistory, setHistory, setLastProducts, getLastProducts, setLastIntent, getLastIntent };

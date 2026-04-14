// session.js — in-memory conversation session store with TTL.
// Rationale: premature persistence is a trap. Most chatbot "memory" needs
// (carry slots across 2-3 turns, remember what we just showed the user) are
// solved by a keyed Map on the server instance. Supabase/Redis become useful
// only when we need (a) multi-instance horizontal scaling, (b) cross-session
// history, or (c) analytics on conversations.
//
// If/when Render scales to >1 instance, swap this module for a Redis/Supabase
// adapter exposing the same interface: get(id), set(id, patch), reset(id).

const DEFAULT_TTL_MS = 30 * 60 * 1000;   // 30 minutes since last touch
const MAX_SESSIONS = 5000;                // hard cap before oldest-first eviction

const store = new Map(); // id -> { slots, lastShown, turns, createdAt, updatedAt }

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
    s = { slots: {}, lastShown: [], turns: 0, createdAt: now(), updatedAt: now() };
    store.set(id, s);
  }
  return s;
}

function get(id) {
  const s = store.get(id);
  if (!s) return { slots: {}, lastShown: [], turns: 0 };
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

module.exports = { get, update, reset, stats, fallbackId, getOrCreate };

// memory.js — Postgres-backed replacement for session.js.
// Same conceptual interface, but async, and with graceful degradation:
// if Supabase isn't configured, falls back to an in-process Map so the bot
// still runs (v3.3 behaviour). Once env is set, state survives restarts and
// is shared across Render instances.
//
// Key differences vs session.js:
//   - get/update/reset are ASYNC
//   - sessions are keyed by a string id from the client (same as before)
//   - a row in `sessions` carries slots + last_shown + turn count
//   - when we learn a customer_id (via identity.js), we stamp it onto the
//     session row so subsequent turns can hydrate preferences.
//
// This file is intentionally small. Agent logic stays in agents.js.

const { supabase, enabled } = require('./db');

// In-process fallback cache (also used as a write-through cache on top of Supabase
// to keep hot-path latency low).
const cache = new Map(); // id -> { slots, lastShown, turns, customer_id, updatedAt }
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE = 5000;

function now() { return Date.now(); }

function evictIfNeeded() {
  if (cache.size < MAX_CACHE) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const toEvict = Math.max(1, Math.floor(MAX_CACHE * 0.1));
  for (let i = 0; i < toEvict; i++) cache.delete(entries[i][0]);
}

function fallbackId(req) {
  const hint = req.headers['x-session-id'] || req.body?.session_id;
  if (hint && typeof hint === 'string' && hint.length <= 64) return hint;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'anon';
  return `ip:${ip}`;
}

function empty() {
  return { slots: {}, lastShown: [], turns: 0, customer_id: null, updatedAt: now() };
}

// Fetch session row from DB. Returns normalized shape or null if not found / not enabled.
async function loadFromDb(id) {
  if (!enabled) return null;
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, customer_id, slots, last_shown, turns, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) { console.warn('[memory] load error:', error.message); return null; }
    if (!data) return null;
    return {
      slots:       data.slots || {},
      lastShown:   data.last_shown || [],
      turns:       data.turns || 0,
      customer_id: data.customer_id || null,
      updatedAt:   Date.parse(data.updated_at) || now()
    };
  } catch (e) {
    console.warn('[memory] load exception:', e.message);
    return null;
  }
}

async function get(id) {
  if (!id) return empty();
  const cached = cache.get(id);
  if (cached && (now() - cached.updatedAt) < DEFAULT_TTL_MS) return cached;
  const fromDb = await loadFromDb(id);
  if (fromDb) { cache.set(id, fromDb); return fromDb; }
  return empty();
}

async function update(id, patch) {
  if (!id) return null;
  const existing = cache.get(id) || (await loadFromDb(id)) || empty();
  const next = {
    slots:       patch.slots     ? { ...existing.slots, ...patch.slots } : existing.slots,
    lastShown:   patch.lastShown ? patch.lastShown.slice(0, 10)          : existing.lastShown,
    turns:       (existing.turns || 0) + 1,
    customer_id: patch.customer_id !== undefined ? patch.customer_id : existing.customer_id,
    updatedAt:   now()
  };
  evictIfNeeded();
  cache.set(id, next);

  if (enabled) {
    try {
      // upsert so id is stable
      const { error } = await supabase.from('sessions').upsert({
        id,
        customer_id: next.customer_id,
        slots:       next.slots,
        last_shown:  next.lastShown,
        turns:       next.turns,
        updated_at:  new Date().toISOString()
      }, { onConflict: 'id' });
      if (error) console.warn('[memory] upsert error:', error.message);
    } catch (e) {
      console.warn('[memory] upsert exception:', e.message);
    }
  }
  return next;
}

async function reset(id) {
  if (!id) return;
  cache.delete(id);
  if (enabled) {
    try {
      await supabase.from('sessions').delete().eq('id', id);
    } catch (e) { console.warn('[memory] reset error:', e.message); }
  }
}

// Append a single message to the audit log. Best-effort — failure does not break chat.
async function logMessage({ session_id, customer_id, role, content, intent, slots, tool_name, tool_args, tool_result }) {
  if (!enabled) return;
  try {
    const { error } = await supabase.from('messages').insert({
      session_id, customer_id, role,
      content: content ? String(content).slice(0, 8000) : null,
      intent, slots, tool_name, tool_args, tool_result
    });
    if (error) console.warn('[memory] logMessage error:', error.message);
  } catch (e) {
    console.warn('[memory] logMessage exception:', e.message);
  }
}

function stats() {
  return { cached: cache.size, maxCache: MAX_CACHE, persistence: enabled ? 'supabase' : 'memory-only' };
}

module.exports = { get, update, reset, logMessage, stats, fallbackId };

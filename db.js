// db.js — Supabase client for TO Assistant v4.
// Reads credentials strictly from env. No secrets in code, ever.
//
// Required env vars (set in Render, never committed):
//   SUPABASE_URL                 e.g. https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    server-only key, bypasses RLS. NEVER ship to client.
//
// If env is missing, `supabase` will be null — callers must handle that so the
// bot still runs in degraded mode (no memory, no action log) without crashing.

const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let supabase = null;
let enabled = false;

if (URL && SERVICE_KEY) {
  supabase = createClient(URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application': 'to-assistant-v4' } }
  });
  enabled = true;
  console.log('[db] Supabase client initialised');
} else {
  console.warn('[db] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — persistence disabled');
}

// ping() — used by /api/health. Cheap query that exercises the connection.
async function ping() {
  if (!enabled) return { ok: false, reason: 'not_configured' };
  try {
    const { error } = await supabase.from('customers').select('id', { count: 'exact', head: true }).limit(1);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { supabase, enabled, ping };

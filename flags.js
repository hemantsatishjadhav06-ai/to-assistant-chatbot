// flags.js — single place to read feature flags from env.
// Keep parsing cheap so callers can just `flags.WRITES_ENABLED` at action time.

function bool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function num(name, def) {
  const v = process.env[name];
  if (v == null) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const flags = {
  // Master kill switch. When false, no write action executes — proposals still
  // record to the audit table so we can measure demand.
  get WRITES_ENABLED()    { return bool('WRITES_ENABLED', false); },

  // When true, actions log as proposed/confirmed but do not hit Magento/OMS.
  get ACTION_DRYRUN()     { return bool('ACTION_DRYRUN', true); },

  // v4.0 memory layer. Switch off to run v3.3-style with no persistence.
  get MEMORY_ENABLED()    { return bool('MEMORY_ENABLED', true); },

  // Per-customer rate limit for write actions (count / window_minutes).
  get WRITE_RATE_LIMIT()  { return num('WRITE_RATE_LIMIT', 5); },
  get WRITE_RATE_WINDOW() { return num('WRITE_RATE_WINDOW_MIN', 60); },

  // TTL for a proposed action's confirmation token.
  get CONFIRM_TTL_MIN()   { return num('CONFIRM_TTL_MIN', 10); },

  // Per-action opt-in. Even with WRITES_ENABLED, an action must also be enabled here.
  // Default ON for reads, OFF for writes.
  isActionEnabled(name) {
    const envKey = `ACTION_${name.toUpperCase()}_ENABLED`;
    // Reads are always allowed (no real side-effect).
    const READS = new Set(['track_order', 'list_my_orders', 'get_my_preferences']);
    if (READS.has(name)) return bool(envKey, true);
    // Writes require both master + per-action.
    if (!this.WRITES_ENABLED) return false;
    return bool(envKey, false);
  }
};

module.exports = flags;

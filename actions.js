// actions.js — v4.1 transactional action layer (Thesis B).
//
// Protocol: two-turn confirmation for anything that writes.
//   1. propose(name, params, { session_id, customer_id })
//        → inserts row in `actions` with status='proposed' + confirmation_token
//        → returns { ok:true, confirmation_token, summary, expires_at }
//   2. confirm(token)
//        → marks status='confirmed', runs handler, writes result, status='executed' or 'failed'
//        → returns { ok, action, result }
//
// Reads (track_order, list_my_orders, get_my_preferences) skip the protocol —
// they return inline from propose() because there's no side effect.
//
// All actions are guarded by flags.isActionEnabled(name) AND per-customer rate
// limiting. In ACTION_DRYRUN mode writes are logged but not actually sent to
// Magento/OMS — useful for soak-testing the flow in production before cutover.

const crypto = require('crypto');
const { supabase, enabled: dbEnabled } = require('./db');
const flags = require('./flags');

// Injected at boot so we don't circular-require server.js.
let _magentoGet = null, _magentoPost = null, _oauthGet = null;
function init({ magentoGet, magentoPost, oauthGet }) {
  _magentoGet  = magentoGet  || null;
  _magentoPost = magentoPost || null;
  _oauthGet    = oauthGet    || null;
}

// ==================== catalogue ====================

const ACTIONS = {
  // ---------- READS ----------
  track_order: {
    kind: 'read',
    schema: ['order_id'],
    summary: (p) => `Check status of order ${p.order_id}`,
    async run({ params }) {
      if (!_oauthGet) throw new Error('OAuth not configured');
      const r = await _oauthGet('/orders', {
        'searchCriteria[filterGroups][0][filters][0][field]': 'increment_id',
        'searchCriteria[filterGroups][0][filters][0][value]': params.order_id,
        'searchCriteria[pageSize]': 1
      });
      const o = (r?.items || [])[0];
      if (!o) return { found: false };
      return {
        found: true,
        order_id: o.increment_id,
        status: o.status,
        state: o.state,
        created_at: o.created_at,
        grand_total: o.grand_total
      };
    }
  },

  list_my_orders: {
    kind: 'read',
    schema: [],
    requiresCustomer: true,
    summary: () => 'List your recent orders',
    async run({ customer, params }) {
      if (!_oauthGet) throw new Error('OAuth not configured');
      if (!customer?.email) return { orders: [] };
      const r = await _oauthGet('/orders', {
        'searchCriteria[filterGroups][0][filters][0][field]': 'customer_email',
        'searchCriteria[filterGroups][0][filters][0][value]': customer.email,
        'searchCriteria[sortOrders][0][field]': 'created_at',
        'searchCriteria[sortOrders][0][direction]': 'DESC',
        'searchCriteria[pageSize]': params.limit || 5
      });
      return {
        orders: (r?.items || []).map(o => ({
          order_id: o.increment_id, status: o.status, created_at: o.created_at, total: o.grand_total
        }))
      };
    }
  },

  get_my_preferences: {
    kind: 'read',
    schema: [],
    requiresCustomer: true,
    summary: () => 'Show your saved preferences',
    async run({ customer }) {
      if (!dbEnabled) return { consent: false, preferences: {} };
      const { data } = await supabase.from('customers')
        .select('consent_personalise,shoe_size,grip,preferred_brand,skill_level,preferred_sport,last_max_price')
        .eq('id', customer.id).maybeSingle();
      if (!data) return { consent: false, preferences: {} };
      return {
        consent: !!data.consent_personalise,
        preferences: data.consent_personalise ? {
          shoe_size: data.shoe_size, grip: data.grip, brand: data.preferred_brand,
          skill_level: data.skill_level, sport: data.preferred_sport, max_price: data.last_max_price
        } : {}
      };
    }
  },

  // ---------- WRITES ----------
  update_my_preferences: {
    kind: 'write',
    schema: ['fields'],   // fields: { shoe_size?, grip?, brand?, ... }
    requiresCustomer: true,
    requiresConsent: true,
    summary: (p) => `Save your preferences: ${Object.entries(p.fields || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`,
    async run({ customer, params }) {
      if (!dbEnabled) throw new Error('persistence not configured');
      const map = {
        shoe_size: 'shoe_size', grip: 'grip', brand: 'preferred_brand',
        skill_level: 'skill_level', sport: 'preferred_sport', max_price: 'last_max_price'
      };
      const patch = {};
      for (const [k, v] of Object.entries(params.fields || {})) {
        if (map[k] && v != null) patch[map[k]] = v;
      }
      if (!Object.keys(patch).length) return { updated: 0 };
      if (flags.ACTION_DRYRUN) return { dryrun: true, would_update: patch };
      const { error } = await supabase.from('customers').update(patch).eq('id', customer.id);
      if (error) throw new Error(error.message);
      return { updated: Object.keys(patch).length, fields: patch };
    }
  },

  book_stringing: {
    kind: 'write',
    schema: ['racquet', 'string_sku', 'tension_main', 'tension_cross', 'slot_start'],
    requiresCustomer: true,
    summary: (p) => `Book stringing: ${p.racquet} with ${p.string_sku} at ${p.tension_main}/${p.tension_cross} lbs, slot ${p.slot_start}`,
    async run({ customer, params }) {
      if (!dbEnabled) throw new Error('persistence not configured');
      const row = {
        customer_id:  customer.id,
        racquet:      params.racquet,
        string_sku:   params.string_sku,
        tension_main: params.tension_main,
        tension_cross: params.tension_cross || params.tension_main,
        slot_start:   params.slot_start,
        slot_end:     params.slot_end || null,
        notes:        params.notes || null,
        status:       'pending'
      };
      if (flags.ACTION_DRYRUN) return { dryrun: true, would_insert: row };
      const { data, error } = await supabase.from('stringing_bookings').insert(row).select('id').maybeSingle();
      if (error) throw new Error(error.message);
      return { booking_id: data?.id, ...row };
    }
  },

  apply_coupon_to_cart: {
    kind: 'write',
    schema: ['cart_id', 'coupon'],
    summary: (p) => `Apply coupon "${p.coupon}" to cart ${p.cart_id}`,
    async run({ params }) {
      if (flags.ACTION_DRYRUN) return { dryrun: true, cart_id: params.cart_id, coupon: params.coupon };
      if (!_magentoPost) throw new Error('Magento not configured');
      const res = await _magentoPost(`/carts/${encodeURIComponent(params.cart_id)}/coupons/${encodeURIComponent(params.coupon)}`, {});
      return { applied: res === true || res?.success === true, raw: res };
    }
  }
};

// ==================== rate limiting ====================

async function underRateLimit(customer_id) {
  if (!dbEnabled || !customer_id) return true;
  try {
    const since = new Date(Date.now() - flags.WRITE_RATE_WINDOW * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('actions')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customer_id)
      .in('status', ['confirmed', 'executed'])
      .gte('created_at', since);
    return (count || 0) < flags.WRITE_RATE_LIMIT;
  } catch { return true; }
}

// ==================== core flow ====================

function validateParams(actionDef, params) {
  for (const key of actionDef.schema || []) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      return `missing required param: ${key}`;
    }
  }
  return null;
}

async function logAction({ session_id, customer_id, name, params, status, confirmation_token, result, failed_reason }) {
  if (!dbEnabled) return null;
  try {
    const row = {
      session_id, customer_id, action: name, params,
      status, confirmation_token, result, failed_reason,
      confirmed_at: status === 'confirmed' ? new Date().toISOString() : null,
      executed_at:  status === 'executed'  ? new Date().toISOString() : null
    };
    const { data } = await supabase.from('actions').insert(row).select('id').maybeSingle();
    return data?.id;
  } catch (e) {
    console.warn('[actions] logAction failed:', e.message);
    return null;
  }
}

async function propose({ name, params = {}, session_id, customer_id, customer }) {
  const def = ACTIONS[name];
  if (!def) return { ok: false, error: `unknown action: ${name}` };
  if (!flags.isActionEnabled(name)) return { ok: false, error: `action disabled by feature flag: ${name}` };

  const err = validateParams(def, params);
  if (err) return { ok: false, error: err };

  if (def.requiresCustomer && !customer_id) {
    return { ok: false, error: 'this action needs an identified customer (share your email first)' };
  }
  if (def.requiresConsent) {
    if (!dbEnabled) return { ok: false, error: 'persistence not configured' };
    const { data } = await supabase.from('customers').select('consent_personalise').eq('id', customer_id).maybeSingle();
    if (!data?.consent_personalise) return { ok: false, error: 'this action requires opt-in; please say "remember me" first' };
  }

  // READS execute immediately.
  if (def.kind === 'read') {
    try {
      const result = await def.run({ customer: customer || { id: customer_id }, params });
      await logAction({ session_id, customer_id, name, params, status: 'executed', confirmation_token: null, result });
      return { ok: true, kind: 'read', result };
    } catch (e) {
      await logAction({ session_id, customer_id, name, params, status: 'failed', confirmation_token: null, failed_reason: e.message });
      return { ok: false, error: e.message };
    }
  }

  // WRITES: rate limit, then stage.
  if (!(await underRateLimit(customer_id))) {
    return { ok: false, error: `rate limit: too many write actions in last ${flags.WRITE_RATE_WINDOW} min` };
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + flags.CONFIRM_TTL_MIN * 60 * 1000).toISOString();
  await logAction({ session_id, customer_id, name, params, status: 'proposed', confirmation_token: token });

  return {
    ok: true,
    kind: 'write',
    confirmation_token: token,
    summary: def.summary(params),
    expires_at: expires,
    dryrun: flags.ACTION_DRYRUN
  };
}

async function confirm(token, { customer } = {}) {
  if (!dbEnabled) return { ok: false, error: 'persistence not configured' };
  if (!token) return { ok: false, error: 'missing confirmation_token' };

  const { data: row, error } = await supabase.from('actions')
    .select('*').eq('confirmation_token', token).maybeSingle();
  if (error || !row) return { ok: false, error: 'unknown or expired token' };
  if (row.status !== 'proposed') return { ok: false, error: `action already ${row.status}` };

  const ttlMs = flags.CONFIRM_TTL_MIN * 60 * 1000;
  if (Date.now() - Date.parse(row.created_at) > ttlMs) {
    await supabase.from('actions').update({ status: 'cancelled', failed_reason: 'expired' }).eq('id', row.id);
    return { ok: false, error: 'token expired' };
  }

  const def = ACTIONS[row.action];
  if (!def) return { ok: false, error: `unknown action: ${row.action}` };

  await supabase.from('actions').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', row.id);

  try {
    const result = await def.run({ customer: customer || { id: row.customer_id }, params: row.params || {} });
    await supabase.from('actions').update({ status: 'executed', executed_at: new Date().toISOString(), result }).eq('id', row.id);
    return { ok: true, action: row.action, result };
  } catch (e) {
    await supabase.from('actions').update({ status: 'failed', failed_reason: e.message }).eq('id', row.id);
    return { ok: false, error: e.message };
  }
}

async function cancel(token) {
  if (!dbEnabled || !token) return { ok: false };
  const { error } = await supabase.from('actions')
    .update({ status: 'cancelled' }).eq('confirmation_token', token).eq('status', 'proposed');
  return { ok: !error };
}

function catalogue() {
  return Object.entries(ACTIONS).map(([name, def]) => ({
    name, kind: def.kind, schema: def.schema,
    requiresCustomer: !!def.requiresCustomer, requiresConsent: !!def.requiresConsent,
    enabled: flags.isActionEnabled(name)
  }));
}

module.exports = { init, propose, confirm, cancel, catalogue, ACTIONS };

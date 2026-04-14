// identity.js — customer identity resolution for v4.
//
// Policy (user-locked 2026-04-15):
//   - Email is the PRIMARY identity key. Phone is secondary.
//   - Personalization is OPT-IN. `consent_personalise` defaults to false.
//     We will NOT hydrate prior preferences into the slot state until the user
//     explicitly says "remember me / save my preferences" (or toggles in UI).
//   - We still UPSERT the customer row on first sighting so that when consent
//     is granted later, history is already linked. We store only what the
//     user volunteered (email, name). No covert profiling.
//
// Resolution precedence per turn:
//   1. Explicit email/phone parsed from THIS message
//   2. customer_id stamped on the current session row (from a prior turn)
//   3. None → anonymous session
//
// Magento linkage: if we find an email, we try to look it up in Magento to
// stamp `magento_customer_id` + hydrate shoe_size/brand from order history
// (only when consent is true).

const { supabase, enabled } = require('./db');

// Cheap in-process cache for Magento lookups so we don't hammer the REST API.
const magentoCache = new Map(); // email -> { id, firstName, lastName, ts }
const MAGENTO_TTL_MS = 10 * 60 * 1000;

// Lazy import to avoid circular dep with server.js. `magentoGet` is expected
// to be attached at boot via init(). This keeps identity.js decoupled.
let _magentoGet = null;
function init({ magentoGet }) { _magentoGet = magentoGet || null; }

async function findMagentoCustomerByEmail(email) {
  if (!_magentoGet || !email) return null;
  const cached = magentoCache.get(email);
  if (cached && (Date.now() - cached.ts) < MAGENTO_TTL_MS) return cached;
  try {
    const res = await _magentoGet('/customers/search', {
      'searchCriteria[filterGroups][0][filters][0][field]': 'email',
      'searchCriteria[filterGroups][0][filters][0][value]': email,
      'searchCriteria[filterGroups][0][filters][0][conditionType]': 'eq',
      'searchCriteria[pageSize]': 1
    });
    const hit = (res?.items || [])[0];
    if (!hit) return null;
    const rec = {
      id:         hit.id,
      firstName:  hit.firstname || null,
      lastName:   hit.lastname  || null,
      ts:         Date.now()
    };
    magentoCache.set(email, rec);
    return rec;
  } catch (e) {
    console.warn('[identity] magento lookup failed:', e.message);
    return null;
  }
}

// Upsert a customer row in Supabase. Returns the row id (uuid) or null.
async function upsertCustomer({ email, phone, magento_customer_id, firstName, lastName }) {
  if (!enabled || (!email && !phone)) return null;
  try {
    const patch = {
      email: email ? email.toLowerCase() : null,
      phone: phone || null,
      magento_customer_id: magento_customer_id || null,
      first_name: firstName || null,
      last_name:  lastName  || null,
      last_seen_at: new Date().toISOString()
    };
    // Strip nulls so upsert doesn't clobber existing values
    Object.keys(patch).forEach(k => patch[k] === null && delete patch[k]);
    if (!patch.email && !patch.phone) return null;

    // Upsert on email (the unique key). If no email, try phone (non-unique but
    // handled by select-first strategy).
    if (patch.email) {
      const { data, error } = await supabase
        .from('customers')
        .upsert(patch, { onConflict: 'email' })
        .select('id, consent_personalise, shoe_size, grip, preferred_brand, skill_level, preferred_sport, last_max_price')
        .maybeSingle();
      if (error) { console.warn('[identity] upsert error:', error.message); return null; }
      return data;
    }
    // Phone-only path: select first, insert if missing.
    const { data: existing } = await supabase
      .from('customers').select('id, consent_personalise').eq('phone', patch.phone).maybeSingle();
    if (existing) return existing;
    const { data: ins, error: insErr } = await supabase.from('customers').insert(patch).select('id, consent_personalise').maybeSingle();
    if (insErr) { console.warn('[identity] insert error:', insErr.message); return null; }
    return ins;
  } catch (e) {
    console.warn('[identity] upsertCustomer exception:', e.message);
    return null;
  }
}

// Resolve identity for this turn. Returns:
//   { customer_id, consent, preferences }
// where preferences is ONLY populated if consent is true.
async function resolveForTurn({ sessionState, parsedSlots }) {
  const email = parsedSlots?.email || null;
  const phone = parsedSlots?.phone || null;

  // No new identity info in this message — reuse stamped customer_id if any.
  if (!email && !phone) {
    if (!sessionState?.customer_id || !enabled) {
      return { customer_id: null, consent: false, preferences: {} };
    }
    // Pull existing consent + prefs.
    try {
      const { data } = await supabase
        .from('customers')
        .select('id, consent_personalise, shoe_size, grip, preferred_brand, skill_level, preferred_sport, last_max_price')
        .eq('id', sessionState.customer_id).maybeSingle();
      if (!data) return { customer_id: sessionState.customer_id, consent: false, preferences: {} };
      return {
        customer_id: data.id,
        consent: !!data.consent_personalise,
        preferences: data.consent_personalise ? extractPrefs(data) : {}
      };
    } catch (e) {
      return { customer_id: sessionState.customer_id, consent: false, preferences: {} };
    }
  }

  // Fresh email/phone in this message. Enrich from Magento + upsert.
  let magento = null;
  if (email) magento = await findMagentoCustomerByEmail(email);
  const row = await upsertCustomer({
    email,
    phone,
    magento_customer_id: magento?.id || null,
    firstName: magento?.firstName || null,
    lastName:  magento?.lastName  || null
  });
  if (!row) return { customer_id: null, consent: false, preferences: {} };
  return {
    customer_id: row.id,
    consent: !!row.consent_personalise,
    preferences: row.consent_personalise ? extractPrefs(row) : {}
  };
}

function extractPrefs(row) {
  const p = {};
  if (row.shoe_size       != null) p.size           = row.shoe_size;
  if (row.grip)                    p.grip           = row.grip;
  if (row.preferred_brand)         p.brand          = row.preferred_brand;
  if (row.skill_level)             p.skill_level    = row.skill_level;
  if (row.preferred_sport)         p.sport          = row.preferred_sport;
  if (row.last_max_price  != null) p.max_price_hint = row.last_max_price;
  return p;
}

// Called when user explicitly consents ("yes, remember me" etc.)
async function grantConsent(customer_id) {
  if (!enabled || !customer_id) return false;
  try {
    const { error } = await supabase.from('customers').update({
      consent_personalise: true,
      consent_at: new Date().toISOString()
    }).eq('id', customer_id);
    return !error;
  } catch { return false; }
}

// Called when user says "forget me".
async function revokeConsent(customer_id) {
  if (!enabled || !customer_id) return false;
  try {
    const { error } = await supabase.from('customers').update({
      consent_personalise: false,
      shoe_size: null, grip: null, preferred_brand: null,
      skill_level: null, preferred_sport: null, last_max_price: null
    }).eq('id', customer_id);
    return !error;
  } catch { return false; }
}

// Persist a learned preference — only when consent is true.
async function rememberPreference(customer_id, field, value) {
  if (!enabled || !customer_id) return false;
  const allowed = new Set(['shoe_size','grip','preferred_brand','skill_level','preferred_sport','last_max_price']);
  if (!allowed.has(field)) return false;
  try {
    const { data: row } = await supabase
      .from('customers').select('consent_personalise').eq('id', customer_id).maybeSingle();
    if (!row?.consent_personalise) return false;
    const { error } = await supabase.from('customers').update({ [field]: value }).eq('id', customer_id);
    return !error;
  } catch { return false; }
}

module.exports = { init, resolveForTurn, grantConsent, revokeConsent, rememberPreference };

/**
 * ADDY ↔ MONARCH integration — the "Sales Suite" upsell.
 *
 * DSD partners subscribe inside Addy (Stripe they already trust) and get
 * their own private Monarch workspace, provisioned over Monarch's partner
 * API. Tier changes / cancellations flow through automatically via the
 * Stripe webhook. Admin gets a usage endpoint for monthly overage billing.
 *
 * Loaded by boot.js; everything lives at new paths so server.js is untouched.
 *
 * Env (Railway):
 *   MONARCH_API_URL            e.g. https://monarch.yourdomain.com (server-to-server)
 *   MONARCH_APP_URL            public login URL shown to partners (defaults to API URL)
 *   MONARCH_PARTNER_KEY        the same secret set as PARTNER_API_KEY on Monarch
 *   MONARCH_STARTER_PRICE_ID   Stripe Price id for the Starter subscription
 *   MONARCH_PRO_PRICE_ID       Stripe Price id for the Pro subscription
 *   STRIPE_MONARCH_WEBHOOK_SECRET  signing secret of the Stripe webhook endpoint
 *                                  (points at /api/monarch/stripe-webhook)
 * Without MONARCH_API_URL + MONARCH_PARTNER_KEY the whole feature hides itself.
 */
const { Pool } = require('pg');
const { authenticate, authorize } = require('./middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  options: '-c search_path=addy,public',
  max: 3,
});

const MONARCH_API = (process.env.MONARCH_API_URL || '').replace(/\/$/, '');
const MONARCH_APP = (process.env.MONARCH_APP_URL || MONARCH_API).replace(/\/$/, '');
const PARTNER_KEY = process.env.MONARCH_PARTNER_KEY || '';
const PRICE_TO_TIER = {
  [process.env.MONARCH_STARTER_PRICE_ID || 'price_starter_unset']: 'starter',
  [process.env.MONARCH_PRO_PRICE_ID || 'price_pro_unset']: 'pro',
};

function configured() { return !!(MONARCH_API && PARTNER_KEY); }

async function monarchApi(path, method = 'GET', body = null, timeoutMs = 12000) {
  // Hard timeout: without it, a slow/unreachable Monarch makes Addy hang until
  // the platform edge returns a mysterious 504. Fail fast with a real reason.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${MONARCH_API}/api/partner${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Partner-Key': PARTNER_KEY },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Couldn't reach Monarch at ${MONARCH_API} within ${timeoutMs / 1000}s — is it deployed and is MONARCH_API_URL correct?`);
    }
    throw new Error(`Couldn't connect to Monarch at ${MONARCH_API}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Monarch rejected the partner key — MONARCH_PARTNER_KEY must equal PARTNER_API_KEY on Monarch.');
    if (res.status === 503) throw new Error('Monarch has no PARTNER_API_KEY set — add it on the Monarch deployment.');
    throw new Error(data.error || `Monarch API error ${res.status}`);
  }
  return data;
}

/** Quick connectivity probe used by the status endpoints — never throws. */
async function monarchPing() {
  try { await monarchApi('/plans', 'GET', null, 6000); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function slugify(name, userId) {
  const base = String(name || 'partner').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'partner';
  return `${base}-${userId}`;
}

async function ensureTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS monarch_workspaces (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT UNIQUE NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    stripe_subscription_id TEXT,
    temp_password TEXT,
    monarch_email TEXT,
    monarch_provisioned BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Additive for existing installs.
  await pool.query(`ALTER TABLE monarch_workspaces ADD COLUMN IF NOT EXISTS monarch_provisioned BOOLEAN NOT NULL DEFAULT false`);
  // Build-your-own AI plan (the sliders): the requested bundle + its lifecycle.
  // custom_plan = { units:{ai_calls,texts,ai_drafts,emails}, monthly_usd, tier, requested_at }
  // custom_status = 'pending' (awaiting admin approval) | 'active' | NULL
  // custom_plan_prev = snapshot of the ACTIVE plan while an adjustment request
  // is pending, so a declined adjustment restores it instead of erasing the
  // record of what's live (and billed) on Monarch.
  await pool.query(`ALTER TABLE monarch_workspaces ADD COLUMN IF NOT EXISTS custom_plan JSONB`);
  await pool.query(`ALTER TABLE monarch_workspaces ADD COLUMN IF NOT EXISTS custom_status TEXT`);
  await pool.query(`ALTER TABLE monarch_workspaces ADD COLUMN IF NOT EXISTS custom_plan_prev JSONB`);
  // House/comped plans (e.g. Danny): granted by an admin, no Stripe involved.
  await pool.query(`ALTER TABLE monarch_workspaces ADD COLUMN IF NOT EXISTS comped BOOLEAN NOT NULL DEFAULT false`);
}

/**
 * Push one local workspace up to Monarch (create the tenant) and mark it
 * provisioned. Used by the background call on signup AND the retry/backfill
 * sweep, so a signup made while Monarch was down still lands later. Idempotent:
 * a slug that already exists on Monarch (409) is treated as provisioned.
 */
async function syncWorkspaceToMonarch(row) {
  try {
    const created = await monarchApi('/tenants', 'POST', {
      company_name: row.name ? `${row.name} Distribution` : `Addy Partner ${row.user_id}`,
      slug: row.slug, admin_email: row.monarch_email || row.email, admin_name: row.name || row.email, plan_tier: row.tier || 'free',
    });
    await pool.query(
      `UPDATE monarch_workspaces SET monarch_provisioned=true, temp_password=COALESCE($1,temp_password), monarch_email=COALESCE($2,monarch_email), updated_at=NOW() WHERE user_id=$3`,
      [created.login?.temp_password ?? null, created.login?.email ?? null, row.user_id]
    );
    return { ok: true };
  } catch (e) {
    // Already exists on Monarch -> it IS provisioned; stop retrying it.
    if (/already exists/i.test(e.message)) {
      await pool.query(`UPDATE monarch_workspaces SET monarch_provisioned=true, updated_at=NOW() WHERE user_id=$1`, [row.user_id]);
      return { ok: true, existed: true };
    }
    return { ok: false, error: e.message };
  }
}

/**
 * Provision (or re-tier) the Monarch workspace for an Addy user after payment.
 * `customPlan` = { units, monthly_usd } for a build-your-own Pro plan (from the
 * sliders); when present the tier is Pro and their custom allowances are set on
 * Monarch. When absent it's a standard fixed tier and any prior custom
 * allowances are cleared, so entitlement and billing always match what's paid.
 */
async function provisionWorkspace(user, tier, stripeSubId = null, customPlan = null) {
  const effectiveTier = customPlan ? 'pro' : tier;
  const patch = customPlan
    ? { plan_tier: 'pro', status: 'active', custom_included: customPlan.units }
    : { plan_tier: effectiveTier, status: 'active', custom_included: null };

  const existing = (await pool.query(`SELECT * FROM monarch_workspaces WHERE user_id=$1`, [user.id])).rows[0];
  if (existing) {
    let login = null;
    try {
      await monarchApi(`/tenants/${existing.slug}`, 'PATCH', patch);
    } catch (e) {
      // Local row but the PATCH found no partner-manageable tenant. Two ways
      // that happens, and Monarch's PATCH reports both as "not found" (it
      // filters enterprise tenants out of partner management):
      //   1. The tenant truly doesn't exist — background provisioning after
      //      "Start free" never landed (Monarch down, key missing, old
      //      build). Self-heal: create it now, same slug, requested tier.
      //   2. The tenant EXISTS but is an enterprise workspace set up directly
      //      on Monarch (Danny's case) — the create then 409s "already
      //      exists". Link to it as-is: enterprise already outranks any tier
      //      we could set, and it's the workspace holding the user's API
      //      keys. Never fail the grant over it.
      if (!/not found/i.test(e.message)) throw e;
      try {
        const created = await monarchApi('/tenants', 'POST', {
          company_name: user.name ? `${user.name} Distribution` : `Addy Partner ${user.id}`,
          slug: existing.slug,
          admin_email: existing.monarch_email || user.email,
          admin_name: user.name || user.email,
          plan_tier: effectiveTier,
        });
        login = created.login || null;
        if (customPlan) await monarchApi(`/tenants/${existing.slug}`, 'PATCH', patch);
      } catch (e2) {
        if (!/already exists/i.test(e2.message)) throw e2;
      }
    }
    await pool.query(
      `UPDATE monarch_workspaces SET tier=$1, status='active',
         stripe_subscription_id=COALESCE($2, stripe_subscription_id),
         custom_plan=$3, custom_status=$4, custom_plan_prev=NULL,
         monarch_provisioned=true,
         temp_password=COALESCE($6, temp_password),
         monarch_email=COALESCE($7, monarch_email),
         updated_at=NOW() WHERE user_id=$5`,
      [effectiveTier, stripeSubId, customPlan ? JSON.stringify(customPlan) : null,
       customPlan ? 'active' : null, user.id,
       login?.temp_password ?? null, login?.email ?? null]
    );
    return { slug: existing.slug, tier: effectiveTier, upgraded: true, healed: !!login };
  }
  const slug = slugify(user.name || user.email.split('@')[0], user.id);
  const created = await monarchApi('/tenants', 'POST', {
    company_name: user.name ? `${user.name} Distribution` : `Addy Partner ${user.id}`,
    slug,
    admin_email: user.email,
    admin_name: user.name || user.email,
    plan_tier: effectiveTier,
  });
  // New tenants are created on the tier; a custom plan then sets allowances.
  if (customPlan) await monarchApi(`/tenants/${slug}`, 'PATCH', { plan_tier: 'pro', status: 'active', custom_included: customPlan.units });
  await pool.query(
    `INSERT INTO monarch_workspaces (user_id, slug, tier, status, stripe_subscription_id, temp_password, monarch_email, monarch_provisioned, custom_plan, custom_status)
     VALUES ($1,$2,$3,'active',$4,$5,$6,true,$7,$8)`,
    [user.id, slug, effectiveTier, stripeSubId, created.login.temp_password, created.login.email,
     customPlan ? JSON.stringify(customPlan) : null, customPlan ? 'active' : null]
  );
  return { slug, tier: effectiveTier, created: true };
}

function installMonarchIntegration(app) {
  const express = require('express');
  const jsonParser = express.json({ limit: '1mb' });
  ensureTable().then(() => console.log('🚀 Monarch integration ready (monarch_workspaces table ensured)'))
    .catch(e => console.error('monarch_workspaces ensure failed:', e.message));

  /** Status + tier catalog for the DSD dashboard card. */
  app.get('/api/monarch/status', authenticate, authorize('dsd', 'admin'), async (req, res) => {
    try {
      if (!configured()) return res.json({ configured: false });
      const ws = (await pool.query(
        `SELECT slug, tier, status, temp_password, monarch_email, custom_plan, custom_status, custom_plan_prev, comped
         FROM monarch_workspaces WHERE user_id=$1`,
        [req.user.id]
      )).rows[0] || null;
      let plans = null, reach = { ok: true };
      try { plans = await monarchApi('/plans'); } catch (e) { reach = { ok: false, error: e.message }; }
      res.json({
        configured: true,
        app_url: MONARCH_APP,
        checkout_ready: !!process.env.STRIPE_SECRET_KEY, // dynamic pricing — no pre-made price IDs needed
        workspace: ws,
        plans,
        monarch_reachable: reach.ok,
        monarch_error: reach.ok ? null : reach.error,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /**
   * Embedded-Suite sign-on. Asks Monarch (partner-key auth, server-to-server)
   * for a short-lived session token for THIS user's workspace, and returns the
   * dashboard URL Addy's /suite.html iframe should load — token in the #hash,
   * so it never appears in server logs. The user never sees a Monarch login.
   */
  app.get('/api/monarch/sso', authenticate, authorize('dsd', 'admin'), async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'Sales Suite is not configured yet' });
      const ws = (await pool.query(
        `SELECT slug, tier, status, monarch_email, monarch_provisioned
         FROM monarch_workspaces WHERE user_id=$1`,
        [req.user.id]
      )).rows[0];
      if (!ws) return res.status(404).json({ error: 'No Sales Suite workspace yet' });
      if (!ws.monarch_provisioned) {
        return res.status(409).json({ error: 'Your workspace is still being set up — try again in a minute' });
      }
      if (ws.status !== 'active') return res.status(403).json({ error: 'Your Sales Suite plan is paused' });
      // Prefer their known Monarch login; if that email doesn't exist on the
      // workspace (e.g. a linked enterprise tenant set up with a different
      // address), fall back to the workspace's admin.
      let sso;
      try {
        sso = await monarchApi(`/tenants/${ws.slug}/sso`, 'POST',
          ws.monarch_email ? { email: ws.monarch_email } : {});
      } catch (e) {
        if (!ws.monarch_email || !/no active user/i.test(e.message)) throw e;
        sso = await monarchApi(`/tenants/${ws.slug}/sso`, 'POST', {});
      }
      const frag = new URLSearchParams({ sso: sso.token, role: sso.role || 'admin', embed: 'addy' });
      res.json({ url: `${MONARCH_APP}/dashboard.html#${frag.toString()}` });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  /**
   * Free tier — INSTANT and fully local to Addy. The free features (claim
   * stores, customer list, order history) already live in Addy; free users
   * just get the Monarch-branded experience here. We do NOT call Monarch on
   * this request, so it can never hang or 504 even if Monarch is slow/down.
   *
   * A real Monarch free tenant is then created in the BACKGROUND (best-effort)
   * purely to grow the Monarch user base — it never blocks the response and a
   * failure is silent to the user.
   */
  app.post('/api/monarch/start-free', authenticate, authorize('dsd'), async (req, res) => {
    try {
      const user = (await pool.query(`SELECT id, name, email FROM users WHERE id=$1`, [req.user.id])).rows[0];
      const existing = (await pool.query(`SELECT slug FROM monarch_workspaces WHERE user_id=$1`, [user.id])).rows[0];
      if (existing) return res.status(409).json({ error: 'You already have a Sales Suite workspace' });
      const slug = slugify(user.name || user.email.split('@')[0], user.id);
      // Local record first — this is what makes free work instantly.
      await pool.query(
        `INSERT INTO monarch_workspaces (user_id, slug, tier, status, monarch_email)
         VALUES ($1,$2,'free','active',$3)`,
        [user.id, slug, user.email]
      );
      res.status(201).json({ success: true, tier: 'free', slug });
      // Grow the Monarch user base in the background — fire and forget. If it
      // fails (Monarch down), the nightly/manual sync backfills it later.
      if (configured()) {
        syncWorkspaceToMonarch({ user_id: user.id, slug, tier: 'free', name: user.name, email: user.email, monarch_email: user.email })
          .then(r => console.log(`(bg) Monarch sync for user ${user.id}:`, r.ok ? 'ok' : r.error))
          .catch(() => {});
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Fallback prices if Monarch is unreachable when a partner opens the builder
  // — kept in sync with Monarch's src/config/plans.js METERED_UNITS prices.
  // AI writing is a given on Pro (not billed); its cost is folded into these.
  const FALLBACK_UNIT_PRICES = { ai_calls: 0.50, texts: 0.20, emails: 0.16 };
  const FALLBACK_BASE_FEE = 199; // Pro license fee — kept in sync with Monarch's CUSTOM_BASE_FEE
  const CUSTOM_UNIT_MAX = { ai_calls: 10000, texts: 100000, emails: 500000 };

  /**
   * Build-your-own Pro plan (the sliders). A partner composes a bundle of
   * monthly allowances; we price it server-side (never trust the browser's
   * math) and send them straight to Stripe Checkout for that exact monthly
   * amount (a dynamic recurring price — no pre-made Stripe price IDs needed).
   * On successful payment the webhook provisions Pro + their custom allowances.
   * Self-serve: no admin approval, and they can't use anything until they pay.
   */
  app.post('/api/monarch/custom-plan', authenticate, authorize('dsd'), (req, res) => {
    jsonParser(req, res, async () => {
      try {
        if (!configured()) return res.status(503).json({ error: 'Sales Suite is not configured yet' });
        const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
        if (!stripe) { console.warn('custom-plan: STRIPE_SECRET_KEY not set on Addy'); return res.status(503).json({ error: 'Card payments are switching on shortly — hang tight, this will be ready very soon.' }); }

        const raw = req.body?.units || {};
        const units = {};
        for (const k of Object.keys(FALLBACK_UNIT_PRICES)) {
          const v = Number(raw[k]);
          if (!Number.isFinite(v) || v < 0 || v > CUSTOM_UNIT_MAX[k]) {
            return res.status(400).json({ error: `Invalid amount for ${k}` });
          }
          units[k] = Math.floor(v);
        }
        if (Object.values(units).every(v => v === 0)) {
          return res.status(400).json({ error: 'Slide at least one dial up first' });
        }
        // Price it from Monarch's live catalog (fallback to the mirrored rates).
        let prices = FALLBACK_UNIT_PRICES, baseFee = FALLBACK_BASE_FEE;
        try {
          const plans = await monarchApi('/plans', 'GET', null, 6000);
          if (plans.unit_prices) prices = Object.fromEntries(Object.entries(plans.unit_prices).map(([k, u]) => [k, u.price]));
          if (typeof plans.custom_base_fee === 'number') baseFee = plans.custom_base_fee;
        } catch { /* unreachable Monarch must not block reaching checkout */ }
        const usage_usd = Object.entries(units).reduce((s, [k, q]) => s + q * (prices[k] || 0), 0);
        const monthly_usd = +(usage_usd + baseFee).toFixed(2);

        const user = (await pool.query(`SELECT id, name, email FROM users WHERE id=$1`, [req.user.id])).rows[0];
        const summary = Object.entries(units).filter(([, v]) => v > 0)
          .map(([k, v]) => `${v.toLocaleString()} ${({ ai_calls: 'call minutes', texts: 'texts', emails: 'emails' })[k]}`).join(', ');
        const origin = `${req.protocol}://${req.get('host')}`;
        // custom_units rides in metadata so the webhook can provision exactly
        // what was paid for. All values are strings (Stripe metadata rule).
        const meta = { addy_user_id: String(user.id), tier: 'pro', custom_units: JSON.stringify(units), monthly_usd: String(monthly_usd) };
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: { name: 'Sales Suite — Pro (your plan)', description: summary },
              unit_amount: Math.round(monthly_usd * 100),
              recurring: { interval: 'month' },
            },
            quantity: 1,
          }],
          customer_email: user.email,
          success_url: `${origin}/dashboard-dsd.html?monarch=success`,
          cancel_url: `${origin}/dashboard-dsd.html?monarch=cancelled`,
          metadata: meta,
          subscription_data: { metadata: meta },
        });
        res.json({ url: session.url, monthly_usd });
      } catch (e) { console.error('custom-plan checkout failed:', e.message); res.status(500).json({ error: e.message }); }
    });
  });

  /** One-time credential reveal: returns the temp password then clears it. */
  app.post('/api/monarch/credentials/reveal', authenticate, authorize('dsd'), async (req, res) => {
    try {
      const row = (await pool.query(
        `SELECT slug, monarch_email, temp_password FROM monarch_workspaces WHERE user_id=$1`, [req.user.id]
      )).rows[0];
      if (!row || !row.temp_password) return res.status(404).json({ error: 'No unseen credentials — use "Forgot password" on the Sales Suite login if needed' });
      await pool.query(`UPDATE monarch_workspaces SET temp_password=NULL, updated_at=NOW() WHERE user_id=$1`, [req.user.id]);
      res.json({ company: row.slug, email: row.monarch_email, temp_password: row.temp_password, app_url: MONARCH_APP });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Flat monthly prices for the fixed tiers (dynamic Stripe price — no pre-made
  // price IDs). Only Plus is sold this way; Pro goes through the sliders.
  const FIXED_TIER_PRICE = { plus: Number(process.env.MONARCH_PLUS_PRICE || 50) };
  const FIXED_TIER_LABEL = { plus: 'Plus — inventory tracking' };

  /** Fixed tiers (currently Plus $50/mo) — Stripe Checkout, dynamic price. */
  app.post('/api/monarch/checkout', authenticate, authorize('dsd'), (req, res) => {
    jsonParser(req, res, async () => {
      try {
        if (!configured()) return res.status(503).json({ error: 'Sales Suite is not configured yet' });
        const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
        if (!stripe) { console.warn('checkout: STRIPE_SECRET_KEY not set on Addy'); return res.status(503).json({ error: 'Card payments are switching on shortly — hang tight.' }); }
        const tier = req.body?.tier;
        const price = FIXED_TIER_PRICE[tier];
        if (!price) return res.status(400).json({ error: 'That plan isn\'t a fixed-price plan' });
        const user = (await pool.query(`SELECT id, name, email FROM users WHERE id=$1`, [req.user.id])).rows[0];
        const origin = `${req.protocol}://${req.get('host')}`;
        const meta = { addy_user_id: String(user.id), tier };
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: { name: `Sales Suite — ${FIXED_TIER_LABEL[tier] || tier}` },
              unit_amount: Math.round(price * 100),
              recurring: { interval: 'month' },
            },
            quantity: 1,
          }],
          customer_email: user.email,
          success_url: `${origin}/dashboard-dsd.html?monarch=success`,
          cancel_url: `${origin}/dashboard-dsd.html?monarch=cancelled`,
          metadata: meta,
          subscription_data: { metadata: meta },
        });
        res.json({ url: session.url });
      } catch (e) { console.error('monarch checkout failed:', e.message); res.status(500).json({ error: e.message }); }
    });
  });

  /**
   * Stripe webhook for Sales Suite subscriptions. Raw body (signature check).
   * Registered by boot.js BEFORE server.js's global json parser, so req.body
   * here is the untouched Buffer Stripe signed.
   */
  app.post('/api/monarch/stripe-webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
    const secret = process.env.STRIPE_MONARCH_WEBHOOK_SECRET;
    if (!stripe || !secret) return res.status(503).json({ error: 'not configured' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } catch (e) {
      return res.status(400).json({ error: `signature verification failed` });
    }
    try {
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const userId = parseInt(s.metadata?.addy_user_id, 10);
        const tier = s.metadata?.tier;
        // Build-your-own Pro plan pays through a dynamic price; custom_units
        // rides in the session metadata so we provision exactly what was paid.
        let customPlan = null;
        if (s.metadata?.custom_units) {
          try {
            customPlan = { units: JSON.parse(s.metadata.custom_units), monthly_usd: Number(s.metadata.monthly_usd) || null };
          } catch { /* malformed metadata — treat as a plain tier */ }
        }
        if (userId && (tier === 'plus' || tier === 'starter' || tier === 'pro')) {
          const user = (await pool.query(`SELECT id, name, email FROM users WHERE id=$1`, [userId])).rows[0];
          if (user) {
            // An adjustment means a NEW subscription — cancel the previous one
            // so the partner is never billed on two subscriptions at once.
            const prev = (await pool.query(`SELECT stripe_subscription_id FROM monarch_workspaces WHERE user_id=$1`, [userId])).rows[0];
            if (prev?.stripe_subscription_id && prev.stripe_subscription_id !== s.subscription) {
              try { await stripe.subscriptions.cancel(prev.stripe_subscription_id); }
              catch (e) { console.error('could not cancel prior subscription:', e.message); }
            }
            await provisionWorkspace(user, tier, s.subscription || null, customPlan);
          }
          console.log(`🚀 Sales Suite ${customPlan ? 'custom Pro' : tier} activated for Addy user ${userId}`);
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const row = (await pool.query(`SELECT user_id, slug FROM monarch_workspaces WHERE stripe_subscription_id=$1`, [sub.id])).rows[0];
        if (row) {
          // Cancellation drops them to free AND clears any custom allowances —
          // free must never keep elevated included amounts alive on Monarch.
          await monarchApi(`/tenants/${row.slug}`, 'PATCH', { plan_tier: 'free', status: 'active', custom_included: null });
          await pool.query(`UPDATE monarch_workspaces SET tier='free', stripe_subscription_id=NULL, custom_plan=NULL, custom_status=NULL, custom_plan_prev=NULL, updated_at=NOW() WHERE user_id=$1`, [row.user_id]);
          console.log(`⬇️ Sales Suite dropped to free for Addy user ${row.user_id} (subscription cancelled)`);
        }
      } else if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        const row = (await pool.query(`SELECT user_id, slug FROM monarch_workspaces WHERE stripe_subscription_id=$1`, [sub.id])).rows[0];
        if (row) {
          if (sub.status === 'past_due' || sub.status === 'unpaid') {
            await monarchApi(`/tenants/${row.slug}`, 'PATCH', { status: 'suspended' });
            await pool.query(`UPDATE monarch_workspaces SET status='suspended', updated_at=NOW() WHERE user_id=$1`, [row.user_id]);
          } else if (sub.status === 'active') {
            const priceId = sub.items?.data?.[0]?.price?.id;
            const tier = PRICE_TO_TIER[priceId];
            // A Stripe tier change replaces any custom plan (standard tiers
            // have standard allowances); a plain reactivation leaves it alone.
            const patch = tier ? { plan_tier: tier, status: 'active', custom_included: null } : { status: 'active' };
            await monarchApi(`/tenants/${row.slug}`, 'PATCH', patch);
            await pool.query(
              `UPDATE monarch_workspaces SET status='active', tier=COALESCE($2, tier),
                 custom_plan      = CASE WHEN $2::text IS NOT NULL THEN NULL ELSE custom_plan END,
                 custom_status    = CASE WHEN $2::text IS NOT NULL THEN NULL ELSE custom_status END,
                 custom_plan_prev = CASE WHEN $2::text IS NOT NULL THEN NULL ELSE custom_plan_prev END,
                 updated_at=NOW() WHERE user_id=$1`,
              [row.user_id, tier || null]);
          }
        }
      }
      res.json({ received: true });
    } catch (e) {
      console.error('monarch webhook handling failed:', e.message);
      res.status(500).json({ error: 'webhook handling failed' }); // Stripe retries
    }
  });

  /** Admin: every partner workspace + this month's usage/overage from Monarch. */
  app.get('/api/admin/monarch/usage', authenticate, authorize('admin'), async (req, res) => {
    try {
      if (!configured()) return res.json({ configured: false, workspaces: [] });
      const ping = await monarchPing();
      if (!ping.ok) return res.json({ configured: true, monarch_reachable: false, monarch_error: ping.error, workspaces: [] });
      const rows = (await pool.query(
        `SELECT w.user_id, w.slug, w.tier, w.status, w.monarch_provisioned,
                w.custom_plan, w.custom_status, w.custom_plan_prev, w.stripe_subscription_id,
                u.name, u.email
         FROM monarch_workspaces w JOIN users u ON u.id = w.user_id ORDER BY w.created_at ASC`
      )).rows;
      const out = [];
      for (const r of rows) {
        let usage = null;
        if (r.tier !== 'free') { // only paid tenants meter usage
          try { usage = await monarchApi(`/tenants/${r.slug}/usage${req.query.period ? `?period=${req.query.period}` : ''}`); }
          catch (e) { usage = { error: e.message }; }
        }
        out.push({ ...r, usage });
      }
      const counts = {
        total: rows.length,
        synced: rows.filter(r => r.monarch_provisioned).length,
        pending_sync: rows.filter(r => !r.monarch_provisioned).length,
        paid: rows.filter(r => r.tier !== 'free').length,
      };
      res.json({ configured: true, monarch_reachable: true, counts, workspaces: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /** POST /api/admin/monarch/sync — push not-yet-provisioned signups up to
   *  Monarch (backfills anyone who signed up while Monarch was unreachable).
   *  POST with {all:true} (or ?all=1) re-pushes EVERY workspace regardless of
   *  the provisioned flag — used when pointing Addy at a fresh Monarch instance
   *  (e.g. after moving to your own Railway), so the new box repopulates.
   *  syncWorkspaceToMonarch is idempotent (409 "already exists" counts as ok),
   *  so re-running against a box that already has them is harmless. */
  app.post('/api/admin/monarch/sync', authenticate, authorize('admin'), async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'Monarch integration not configured' });
      const all = req.body?.all === true || req.query.all === '1' || req.query.all === 'true';
      const where = all ? '' : 'WHERE w.monarch_provisioned = false';
      const rows = (await pool.query(
        `SELECT w.user_id, w.slug, w.tier, w.monarch_email, u.name, u.email
         FROM monarch_workspaces w JOIN users u ON u.id = w.user_id
         ${where} ORDER BY w.created_at ASC LIMIT 500`
      )).rows;
      let synced = 0, failed = 0;
      for (const r of rows) { const out = await syncWorkspaceToMonarch(r); out.ok ? synced++ : failed++; }
      res.json({ attempted: rows.length, synced, failed, mode: all ? 'all' : 'pending' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /**
   * POST /api/admin/monarch/grant { user_id, tier } — comp a Sales Suite plan
   * (house partners like Danny get the full Pro suite without a Stripe
   * subscription). Provisions or re-tiers the Monarch tenant through the same
   * path a paid checkout uses, then marks the workspace comped so the DSD's
   * card shows no purchase/upgrade prompts.
   */
  app.post('/api/admin/monarch/grant', authenticate, authorize('admin'), jsonParser, async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'Monarch integration not configured' });
      const userId = parseInt(req.body?.user_id);
      const tier = ['free', 'plus', 'pro'].includes(req.body?.tier) ? req.body.tier : 'pro';
      if (!userId) return res.status(400).json({ error: 'user_id required' });
      const user = (await pool.query(
        `SELECT id, name, email FROM users WHERE id=$1 AND role='dsd'`, [userId]
      )).rows[0];
      if (!user) return res.status(404).json({ error: 'DSD user not found' });
      const out = await provisionWorkspace(user, tier);
      await pool.query(
        `UPDATE monarch_workspaces SET comped=true, updated_at=NOW() WHERE user_id=$1`, [user.id]
      );
      res.json({ success: true, slug: out.slug, tier: out.tier || tier, comped: true });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  /** GET /api/admin/monarch/diagnose — raw connectivity probe for the admin.
   *  Does a live fetch to Monarch's partner /plans and returns the VERBATIM
   *  status/body so we can tell apart the three ways this fails:
   *    • unreachable / timeout  → wrong MONARCH_API_URL, Monarch down, no DNS
   *    • 401                    → partner key mismatch (or trailing whitespace)
   *    • 404                    → old Monarch build without /api/partner routes
   *  key_len is reported (not the key) so a copy that picked up a newline or a
   *  trailing space is obvious without leaking the secret. */
  app.get('/api/admin/monarch/diagnose', authenticate, authorize('admin'), async (req, res) => {
    const out = {
      configured: configured(),
      api_url: MONARCH_API || '(unset)',
      key_set: !!PARTNER_KEY,
      key_len: PARTNER_KEY.length,
      key_trimmed_len: PARTNER_KEY.trim().length,
      probe_url: MONARCH_API ? `${MONARCH_API}/api/partner/plans` : null,
    };
    if (!MONARCH_API) { out.verdict = 'MONARCH_API_URL is not set on Addy.'; return res.json(out); }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(out.probe_url, {
        headers: { 'X-Partner-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
        signal: ctrl.signal,
      });
      out.status = r.status;
      out.ok = r.ok;
      const text = await r.text().catch(() => '');
      out.body = text.slice(0, 600);
      if (r.ok) out.verdict = '✓ Connected — Monarch accepted the partner key.';
      else if (r.status === 401 || r.status === 403) out.verdict = 'Reached Monarch, but it REJECTED the key. MONARCH_PARTNER_KEY (Addy) must exactly equal PARTNER_API_KEY (Monarch) — check for a trailing space/newline (compare key_len vs key_trimmed_len).';
      else if (r.status === 404) out.verdict = 'Reached the host, but /api/partner/plans is 404 — Monarch is deployed WITHOUT the partner routes (old build) or MONARCH_API_URL points at the wrong service.';
      else if (r.status === 503) out.verdict = 'Reached Monarch, but it has no PARTNER_API_KEY set — add it on the Monarch deployment.';
      else out.verdict = `Reached Monarch but got HTTP ${r.status}.`;
    } catch (e) {
      out.fetch_error = e.name === 'AbortError' ? 'timeout after 8s' : e.message;
      out.verdict = `Could NOT reach ${out.probe_url} (${out.fetch_error}). MONARCH_API_URL is wrong, Monarch is down, or the network blocks it.`;
    } finally {
      clearTimeout(timer);
    }
    res.json(out);
  });

  // Inject the Sales Suite card script into the DSD dashboard.
  const fs = require('fs');
  const path = require('path');
  app.get(['/dashboard-dsd.html', '/dashboard-dsd'], (req, res, next) => {
    const file = path.join(__dirname, 'public', 'dashboard-dsd.html');
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      res.type('html').send(html.replace('</body>', '<script src="/js/monarch_suite.js"></script></body>'));
    });
  });

  console.log('🚀 Monarch integration routes installed');
}

module.exports = { installMonarchIntegration };

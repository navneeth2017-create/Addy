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

/** Provision (or re-tier) the Monarch workspace for an Addy user. */
async function provisionWorkspace(user, tier, stripeSubId = null) {
  const existing = (await pool.query(`SELECT * FROM monarch_workspaces WHERE user_id=$1`, [user.id])).rows[0];
  if (existing) {
    await monarchApi(`/tenants/${existing.slug}`, 'PATCH', { plan_tier: tier, status: 'active' });
    await pool.query(
      `UPDATE monarch_workspaces SET tier=$1, status='active',
         stripe_subscription_id=COALESCE($2, stripe_subscription_id), updated_at=NOW() WHERE user_id=$3`,
      [tier, stripeSubId, user.id]
    );
    return { slug: existing.slug, tier, upgraded: true };
  }
  const slug = slugify(user.name || user.email.split('@')[0], user.id);
  const created = await monarchApi('/tenants', 'POST', {
    company_name: user.name ? `${user.name} Distribution` : `Addy Partner ${user.id}`,
    slug,
    admin_email: user.email,
    admin_name: user.name || user.email,
    plan_tier: tier,
  });
  await pool.query(
    `INSERT INTO monarch_workspaces (user_id, slug, tier, status, stripe_subscription_id, temp_password, monarch_email, monarch_provisioned)
     VALUES ($1,$2,$3,'active',$4,$5,$6,true)`,
    [user.id, slug, tier, stripeSubId, created.login.temp_password, created.login.email]
  );
  return { slug, tier, created: true };
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
        `SELECT slug, tier, status, temp_password, monarch_email FROM monarch_workspaces WHERE user_id=$1`,
        [req.user.id]
      )).rows[0] || null;
      let plans = null, reach = { ok: true };
      try { plans = await monarchApi('/plans'); } catch (e) { reach = { ok: false, error: e.message }; }
      res.json({
        configured: true,
        app_url: MONARCH_APP,
        checkout_ready: !!(process.env.STRIPE_SECRET_KEY && process.env.MONARCH_STARTER_PRICE_ID && process.env.MONARCH_PRO_PRICE_ID),
        workspace: ws,
        plans,
        monarch_reachable: reach.ok,
        monarch_error: reach.ok ? null : reach.error,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

  /** Paid tiers — Stripe Checkout (subscription mode). */
  app.post('/api/monarch/checkout', authenticate, authorize('dsd'), (req, res) => {
    jsonParser(req, res, async () => {
      try {
        if (!configured()) return res.status(503).json({ error: 'Sales Suite is not configured yet' });
        const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
        if (!stripe) return res.status(503).json({ error: 'Card payments are not configured yet' });
        const tier = req.body?.tier;
        const price = tier === 'starter' ? process.env.MONARCH_STARTER_PRICE_ID
                    : tier === 'pro' ? process.env.MONARCH_PRO_PRICE_ID : null;
        if (!price) return res.status(400).json({ error: 'Pick a plan (starter or pro)' });
        const user = (await pool.query(`SELECT id, name, email FROM users WHERE id=$1`, [req.user.id])).rows[0];
        const origin = `${req.protocol}://${req.get('host')}`;
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price, quantity: 1 }],
          customer_email: user.email,
          success_url: `${origin}/dashboard-dsd.html?monarch=success`,
          cancel_url: `${origin}/dashboard-dsd.html?monarch=cancelled`,
          metadata: { addy_user_id: String(user.id), tier },
          subscription_data: { metadata: { addy_user_id: String(user.id), tier } },
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
        if (userId && (tier === 'starter' || tier === 'pro')) {
          const user = (await pool.query(`SELECT id, name, email FROM users WHERE id=$1`, [userId])).rows[0];
          if (user) await provisionWorkspace(user, tier, s.subscription || null);
          console.log(`🚀 Sales Suite ${tier} activated for Addy user ${userId}`);
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const row = (await pool.query(`SELECT user_id, slug FROM monarch_workspaces WHERE stripe_subscription_id=$1`, [sub.id])).rows[0];
        if (row) {
          await monarchApi(`/tenants/${row.slug}`, 'PATCH', { plan_tier: 'free', status: 'active' });
          await pool.query(`UPDATE monarch_workspaces SET tier='free', stripe_subscription_id=NULL, updated_at=NOW() WHERE user_id=$1`, [row.user_id]);
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
            const patch = tier ? { plan_tier: tier, status: 'active' } : { status: 'active' };
            await monarchApi(`/tenants/${row.slug}`, 'PATCH', patch);
            await pool.query(`UPDATE monarch_workspaces SET status='active', tier=COALESCE($2, tier), updated_at=NOW() WHERE user_id=$1`, [row.user_id, tier || null]);
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
        `SELECT w.user_id, w.slug, w.tier, w.status, w.monarch_provisioned, u.name, u.email
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

  /** POST /api/admin/monarch/sync — push any not-yet-provisioned signups up to
   *  Monarch (backfills anyone who signed up while Monarch was unreachable). */
  app.post('/api/admin/monarch/sync', authenticate, authorize('admin'), async (req, res) => {
    try {
      if (!configured()) return res.status(503).json({ error: 'Monarch integration not configured' });
      const rows = (await pool.query(
        `SELECT w.user_id, w.slug, w.tier, w.monarch_email, u.name, u.email
         FROM monarch_workspaces w JOIN users u ON u.id = w.user_id
         WHERE w.monarch_provisioned = false LIMIT 200`
      )).rows;
      let synced = 0, failed = 0;
      for (const r of rows) { const out = await syncWorkspaceToMonarch(r); out.ok ? synced++ : failed++; }
      res.json({ attempted: rows.length, synced, failed });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

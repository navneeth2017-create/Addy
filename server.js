const express = require('express');
const { startBackupScheduler } = require('./backup_module');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { authenticate, authorize, JWT_SECRET } = require('./middleware/auth');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── WWW REDIRECT ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.headers.host && !req.headers.host.startsWith('www.') && !req.headers.host.includes('localhost') && !req.headers.host.includes('railway')) {
    return res.redirect(301, `https://www.${req.headers.host}${req.url}`);
  }
  next();
});

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Simple in-memory rate limiter — no extra dependencies needed
const _rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const entry = _rateLimitMap.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    _rateLimitMap.set(key, entry);
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    }
    next();
  };
}
// Clean up stale entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of _rateLimitMap) if (v.start < cutoff) _rateLimitMap.delete(k);
}, 10 * 60 * 1000);

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  options: '-c search_path=addy,public'  // ADDY uses its own schema, isolated from WowCow
});

async function q(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}
async function one(text, params) { const r = await q(text, params); return r.rows[0] || null; }
async function all(text, params) { const r = await q(text, params); return r.rows; }

const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── STRIPE (activates automatically when STRIPE_SECRET_KEY env var is set) ──
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (stripe) console.log('💳 Stripe payment processing enabled');
else console.log('📄 Invoice-only mode (add STRIPE_SECRET_KEY to enable card payments)');

// ── WEB PUSH NOTIFICATIONS ────────────────────────────────────────────────────
const webpush = require('web-push');
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BDgZsDCilhapnLmxI8TIFc5KiZLPmdnLwaW7kluTozXvDqo237jLLiKaWac86rtM0ZDymkCr-KpatLntmYvXM5c';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'ywl9LZOtPOzH3-QGIotbvz4SHljJ8QUf0EGPVvudvak';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@addydsds.com';
webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

async function sendPushToAdmins(title, body, url) {
  try {
    const admins = await all("SELECT ps.subscription FROM push_subscriptions ps JOIN users u ON u.id=ps.user_id WHERE u.role='admin'");
    for (const row of admins) {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({ title, body, url }));
      } catch(e) {
        if (e.statusCode === 410) {
          // Subscription expired — remove it
          await q('DELETE FROM push_subscriptions WHERE subscription=$1', [row.subscription]);
        }
      }
    }
  } catch(e) { console.error('Push notification error:', e.message); }
}

// ── EMAIL HELPER ──────────────────────────────────────────────────────────────
async function sendNotification(subject, htmlBody) {
  if (!resend) return; // silently skip if no API key configured
  try {
    const recipients = await all('SELECT email FROM notification_emails');
    if (!recipients.length) return;
    const to = recipients.map(r => r.email);
    await resend.emails.send({
      from: (process.env.EMAIL_FROM || 'ADDY DSD Portal <notifications@addydsds.com>').replace(/\n/g,' ').trim(),
      to,
      subject,
      html: htmlBody
    });
  } catch(e) {
    console.error('Email notification failed:', e.message);
  }
}
async function migrate() {
  // Create isolated addy schema — keeps ADDY tables separate from WowCow (public schema)
  await q('CREATE SCHEMA IF NOT EXISTS addy');
  await q('SET search_path TO addy,public');
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await q(schema);
  console.log('✅ Schema ready');

  // ── Fix orders.user_id FK to allow NULL (enables user deletion) ──────────────
  try {
    await q('ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL');
    await q('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey');
    await q('ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL');
    console.log('✅ orders.user_id FK migration applied');
  } catch(e) { console.log('ℹ️  orders.user_id FK already up to date'); }

  // ── ADDY DSD Tier System migrations ──────────────────────────────────────────
  try {
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS tier INTEGER NOT NULL DEFAULT 1 CHECK(tier IN (1,2,3))');
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id)');
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_balance NUMERIC(10,2) NOT NULL DEFAULT 0');
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_connect_id TEXT');
    await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(10,2) NOT NULL DEFAULT 0');
    await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS retail_price NUMERIC(10,2) NOT NULL DEFAULT 0');
    // New pricing model: tag products as a master-box type + per-user locked discount override
    await q('ALTER TABLE products ADD COLUMN IF NOT EXISTS box_type TEXT');
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_discount_pct NUMERIC(5,2)');
    await q('CREATE TABLE IF NOT EXISTS app_migrations (key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await q('ALTER TABLE stores ADD COLUMN IF NOT EXISTS exclusive_rep_id INTEGER REFERENCES users(id)');
    await q("ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_approval_status TEXT NOT NULL DEFAULT 'approved'");
    console.log('✅ ADDY DSD tier/commission migrations applied');
  } catch(e) { console.log('ℹ️  ADDY migrations already up to date:', e.message); }

  // One-time: pin every existing rep/member to a flat 30% (Danny → 35%).
  // New reps created after this run stay unlocked and use the earn-up system (20→25→30%).
  try {
    await q('CREATE TABLE IF NOT EXISTS app_migrations (key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const alreadyPinned = await one("SELECT 1 FROM app_migrations WHERE key='pin_existing_discounts_v1'");
    if (!alreadyPinned) {
      const r1 = await q("UPDATE users SET locked_discount_pct=30 WHERE role IN ('dsd','member') AND locked_discount_pct IS NULL");
      const r2 = await q("UPDATE users SET locked_discount_pct=35 WHERE role IN ('dsd','member') AND (lower(trim(name))='danny' OR lower(name) LIKE 'danny %')");
      await q("INSERT INTO app_migrations (key) VALUES ('pin_existing_discounts_v1')");
      console.log(`✅ Pinned ${r1.rowCount||0} existing DSD/member account(s) to 30%; set ${r2.rowCount||0} "Danny" account(s) to 35%`);
      if ((r2.rowCount||0) !== 1) console.log(`⚠️  Expected exactly one "Danny" for the 35% lock but matched ${r2.rowCount||0} — set it manually in the admin if needed.`);
    }
  } catch(e) { console.log('ℹ️  discount pin migration skipped:', e.message); }

  // ── Add processing_fee column to orders ──────────────────────────────────────
  try {
    await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_fee NUMERIC(10,2) NOT NULL DEFAULT 0');
    console.log('✅ processing_fee column ready');
  } catch(e) { console.log('ℹ️  processing_fee already exists'); }

  // ── Fix order_items.product_id FK to allow NULL (enables product deletion) ──
  try {
    await q('ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL');
    await q('ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_product_id_fkey');
    await q(`ALTER TABLE order_items ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL`);
    console.log('✅ order_items FK migration applied');
  } catch(e) { console.log('ℹ️  order_items FK already up to date'); }

  // Seed default notification email
  await q("INSERT INTO notification_emails (email, label) VALUES ('d.n.holding7@gmail.com', 'Admin') ON CONFLICT DO NOTHING");


  // Backfill invoices for any orders that don't have one yet
  const ordersWithoutInvoice = await all(`
    SELECT o.id, o.created_at FROM orders o
    LEFT JOIN invoices i ON i.order_id = o.id
    WHERE i.id IS NULL
    ORDER BY o.id ASC
  `);
  if (ordersWithoutInvoice.length > 0) {
    console.log(`🧾 Backfilling invoices for ${ordersWithoutInvoice.length} existing orders...`);
    for (const order of ordersWithoutInvoice) {
      const year = new Date(order.created_at).getFullYear();
      const count = await one('SELECT COUNT(*) as c FROM invoices');
      const num = String(parseInt(count?.c || 0) + 1).padStart(4, '0');
      const invoiceNumber = `WC-${year}-${num}`;
      const dueDate = new Date(order.created_at);
      dueDate.setDate(dueDate.getDate() + 30);
      await q(
        'INSERT INTO invoices (order_id, invoice_number, due_date) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [order.id, invoiceNumber, dueDate.toISOString().split('T')[0]]
      );
    }
    console.log('  ✓ Invoice backfill complete');
  }

  // NOTE: removed a destructive "demo store cleanup" that used to run here on
  // every server boot — it deleted ALL stores whenever order count was 0,
  // which wiped real onboarding data (you can have real stores before any
  // orders exist). Never auto-delete data based on heuristics like this again.

  // ── Feedback / feature request box ───────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','planned','done','declined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // ── Ownership transfer requests table ────────────────────────────────────────
  await q(`CREATE TABLE IF NOT EXISTS ownership_requests (
    id SERIAL PRIMARY KEY,
    store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_owner_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // ── Per-user invoice payment permission ──────────────────────────────────────
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS can_pay_invoice BOOLEAN NOT NULL DEFAULT false');

  // ── Child/member accounts: parent_id links a member to their parent DSD ─────
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  try {
    await q("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check");
    await q("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin','dsd','member'))");
  } catch(e) { console.log('Role constraint:', e.message); }

  // ── pricing_tier on users (stores the tier label e.g. 'tier_1', 'custom_15pct') ──
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS pricing_tier TEXT DEFAULT NULL');

  // ── Store table optional fields (phone, store number) ───────────────────────
  await q(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''`);
  await q(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_number TEXT DEFAULT ''`);
  // Relax NOT NULL on owner_name and email so partial store data is accepted
  try { await q('ALTER TABLE stores ALTER COLUMN owner_name DROP NOT NULL'); } catch(e) {}
  try { await q('ALTER TABLE stores ALTER COLUMN email DROP NOT NULL'); } catch(e) {}
  try { await q('ALTER TABLE stores ALTER COLUMN address DROP NOT NULL'); } catch(e) {}
  try { await q('ALTER TABLE stores ALTER COLUMN city DROP NOT NULL'); } catch(e) {}
  try { await q('ALTER TABLE stores ALTER COLUMN state DROP NOT NULL'); } catch(e) {}
  try { await q('ALTER TABLE stores ALTER COLUMN zip DROP NOT NULL'); } catch(e) {}

  // ── Store photo requirements ─────────────────────────────────────────────────
  await q(`
    CREATE TABLE IF NOT EXISTS store_photos (
      id          SERIAL PRIMARY KEY,
      store_id    INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      rep_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      photo_type  TEXT NOT NULL CHECK(photo_type IN ('front','display')),
      photo_data  TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(store_id, photo_type)
    )
  `);
  await q("ALTER TABLE stores ADD COLUMN IF NOT EXISTS photos_due_at TIMESTAMPTZ");
  await q("ALTER TABLE stores ADD COLUMN IF NOT EXISTS photos_complete BOOLEAN NOT NULL DEFAULT false");
  await q("ALTER TABLE stores ADD COLUMN IF NOT EXISTS claimed_via TEXT DEFAULT 'manual'");

  // ── Free shipping flag on products ──────────────────────────────────────────
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN NOT NULL DEFAULT false`);

  // ── Demo product (10 cents, no shipping) — admin deactivates when not needed ──
  await q(`INSERT INTO products (name, description, sku, stock, active, free_shipping)
    VALUES ('Test Order — $0.10', 'Demo product for testing checkout. Deactivate from Products tab when not needed.', 'DEMO-001', 9999, 1, true)
    ON CONFLICT (sku) DO NOTHING`);
  const demoProduct = await one("SELECT id FROM products WHERE sku='DEMO-001'");
  if (demoProduct) {
    // ADDY prices products via retail_price on the products table (not product_prices like WowCow)
    // Tier pricing multiplies off retail_price, so $0.10 retail = $0.065 for Tier 1, etc.
    // Set directly to $0.10 so it's cheap at any tier
    await q("UPDATE products SET retail_price=0.10, cost_price=0.10 WHERE id=$1", [demoProduct.id]);
  }

  // Create production admin account if it doesn't exist
  // ── Demo + Admin accounts ─────────────────────────────────────────────────
  const demoAccounts = [
    { email: 'admin@addy.com',   password: 'addy-admin-2026', role: 'admin', name: 'Admin',    tier: 1 },
    { email: 'demo@addy.com',    password: 'addy-dsd-2026',   role: 'dsd',   name: 'Demo DSD', tier: 1 },
  ];
  for (const acc of demoAccounts) {
    const hash = bcrypt.hashSync(acc.password, 10);
    const exists = await one('SELECT id FROM users WHERE email=$1', [acc.email]);
    if (!exists) {
      await q(
        "INSERT INTO users (email,name,phone,role,password_hash,status,tier) VALUES ($1,$2,$3,$4,$5,'active',$6)",
        [acc.email, acc.name, '', acc.role, hash, acc.tier]
      );
      console.log('✅ Demo account created: ' + acc.email);
    } else {
      // Always sync password + status so demo accounts always work
      await q(
        "UPDATE users SET password_hash=$1,status='active',role=$2,tier=$3 WHERE email=$4",
        [hash, acc.role, acc.tier, acc.email]
      );
      console.log('✅ Demo account synced: ' + acc.email);
    }
  }

  // ── Production admin via env vars ──────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const existing = await one('SELECT id FROM users WHERE email=$1', [adminEmail]);
    const hash = bcrypt.hashSync(adminPassword, 10);
    if (!existing) {
      await q(
        "INSERT INTO users (email,name,phone,role,password_hash,status,tier) VALUES ($1,'Admin','','admin',$2,'active',1)",
        [adminEmail, hash]
      );
      console.log('✅ Production admin created: ' + adminEmail);
    } else {
      await q("UPDATE users SET password_hash=$1,role='admin',status='active' WHERE email=$2", [hash, adminEmail]);
      console.log('✅ Production admin password synced: ' + adminEmail);
    }
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function logActivity(action, targetName, userEmail) {
  await q('INSERT INTO activity_log (action, target_name, user_email) VALUES ($1,$2,$3)', [action, targetName, userEmail]);
}

// ── ADDY discount model ───────────────────────────────────────────────────────
// New reps earn their discount up by cumulative master boxes bought:
//   < 15 boxes → 20% off · 15+ → 25% · 27+ → 30%   (buy-in-threes: 15 = 5 of each, 27 = 9 of each)
// Existing reps/members are pinned via users.locked_discount_pct (30%, Danny 35%),
// which always wins over the earned rate. Members ride their parent DSD's discount.
const BOX_TYPES = ['shots', 'blister_card', 'gummies'];
const TIER_25_BOXES = 15;
const TIER_30_BOXES = 27;
function discountFromBoxes(boxes) {
  if (boxes >= TIER_30_BOXES) return 30;
  if (boxes >= TIER_25_BOXES) return 25;
  return 20;
}
async function getCumulativeBoxes(userId) {
  const r = await one(
    `SELECT COALESCE(SUM(oi.quantity),0) AS boxes
       FROM order_items oi
       JOIN orders o   ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
      WHERE o.user_id=$1 AND o.status<>'cancelled' AND p.box_type IS NOT NULL`,
    [userId]
  );
  return parseInt(r?.boxes || 0, 10);
}
// Effective discount % for a user (locked override wins; members ride their parent DSD).
async function getEffectiveDiscountPct(userId) {
  const user = await one('SELECT id, role, parent_id, locked_discount_pct FROM users WHERE id=$1', [userId]);
  if (!user) return 20;
  if (user.role === 'member' && user.parent_id) {
    const parent = await one('SELECT id, locked_discount_pct FROM users WHERE id=$1', [user.parent_id]);
    if (parent) {
      if (parent.locked_discount_pct != null) return parseFloat(parent.locked_discount_pct);
      return discountFromBoxes(await getCumulativeBoxes(parent.id));
    }
  }
  if (user.locked_discount_pct != null) return parseFloat(user.locked_discount_pct);
  return discountFromBoxes(await getCumulativeBoxes(userId));
}

// A locked discount (the user's own, or a member's parent DSD) — or null when they earn their rate.
async function getLockedDiscountPct(userId) {
  const user = await one('SELECT role, parent_id, locked_discount_pct FROM users WHERE id=$1', [userId]);
  if (!user) return null;
  if (user.role === 'member' && user.parent_id) {
    const parent = await one('SELECT locked_discount_pct FROM users WHERE id=$1', [user.parent_id]);
    return parent && parent.locked_discount_pct != null ? parseFloat(parent.locked_discount_pct) : null;
  }
  return user.locked_discount_pct != null ? parseFloat(user.locked_discount_pct) : null;
}

async function getPriceForUser(productId, userId, role) {
  const product = await one('SELECT retail_price FROM products WHERE id=$1', [productId]);
  const retail = parseFloat(product?.retail_price || 0);
  // 1. A locked discount always wins — pinned reps get exactly their rate, no matter what.
  const locked = await getLockedDiscountPct(userId);
  if (locked != null && retail > 0) return Math.round(retail * (1 - locked / 100) * 100) / 100;
  // 2. Per-user manual price override (for unlocked reps the admin hand-prices)
  const userPrice = await one('SELECT price FROM product_prices WHERE product_id=$1 AND user_id=$2', [productId, userId]);
  if (userPrice) return parseFloat(userPrice.price);
  // 3. Earned discount off retail_price
  if (retail > 0) {
    const discount = await getEffectiveDiscountPct(userId);
    return Math.round(retail * (1 - discount / 100) * 100) / 100;
  }
  // 4. Fallback to role-based price
  const rolePrice = await one('SELECT price FROM product_prices WHERE product_id=$1 AND role=$2 AND user_id IS NULL ORDER BY id DESC', [productId, role]);
  return rolePrice ? parseFloat(rolePrice.price) : null;
}

// ── Store claiming ────────────────────────────────────────────────────────────
// A DSD's claim is auto-approved and linked everywhere the store list reads from
// (exclusive_rep_id, owner_stores, dsd_stores) so it shows up consistently.
async function claimStoreForDsd(storeId, userId, via = 'manual') {
  const photoDue = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await q("UPDATE stores SET exclusive_rep_id=$1, store_approval_status='approved', photos_due_at=$2, photos_complete=false, claimed_via=$3 WHERE id=$4",
    [userId, photoDue, via, storeId]);
  await q('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, storeId]);
  await q('INSERT INTO dsd_stores (dsd_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, storeId]);
}
// When a store is already claimed by someone else, raise a flag for admins to resolve
// instead of blocking or silently stealing it.
async function flagStoreClaimConflict(storeId, requesterId, currentOwnerId, note) {
  const existing = await one("SELECT id FROM ownership_requests WHERE store_id=$1 AND requester_id=$2 AND status='pending'", [storeId, requesterId]);
  if (existing) return false;
  await q('INSERT INTO ownership_requests (store_id, requester_id, current_owner_id, message) VALUES ($1,$2,$3,$4)',
    [storeId, requesterId, currentOwnerId, note || 'Auto-flagged: tried to claim a store already claimed by another rep']);
  return true;
}

async function calculateAndSaveCommissions(orderId, buyerId, orderTotal) {
  try {
    // Guard 1: skip if order total is invalid
    if (!orderTotal || orderTotal <= 0) return;

    // Guard 2: skip if commissions already calculated for this order (prevent duplicates)
    const existing = await one('SELECT id FROM commissions WHERE order_id=$1 LIMIT 1', [orderId]);
    if (existing) {
      console.log('Commissions already calculated for order #' + orderId + ' — skipping');
      return;
    }

    const buyer = await one('SELECT id, referred_by FROM users WHERE id=$1', [buyerId]);
    if (!buyer || !buyer.referred_by) return;

    // Guard 3: prevent self-referral
    if (buyer.referred_by === buyer.id) return;

    const recruiter = await one("SELECT id, referred_by, status FROM users WHERE id=$1 AND role='dsd'", [buyer.referred_by]);
    if (!recruiter) return;

    // Guard 4: only pay commission to active recruiters
    if (recruiter.status !== 'active') {
      console.log('Recruiter #' + recruiter.id + ' is not active — skipping L1 commission');
    } else {
      const level1Amount = Math.round(orderTotal * 0.05 * 100) / 100;
      if (level1Amount > 0) {
        await q('INSERT INTO commissions (earner_id,order_id,buyer_id,amount,rate,level) VALUES ($1,$2,$3,$4,$5,1)',
          [recruiter.id, orderId, buyerId, level1Amount, 0.05]);
        await q('UPDATE users SET commission_balance=commission_balance+$1 WHERE id=$2', [level1Amount, recruiter.id]);
        console.log('✅ Commission L1: $' + level1Amount + ' → user #' + recruiter.id);
      }
    }

    // Single level only — the direct recruiter earns 5%. There is deliberately no
    // second level: if a rep you brought recruits someone else, you earn nothing on that.
  } catch(e) { console.error('❌ Commission calculation error for order #' + orderId + ':', e.message); }
}

// ── FAVICON ───────────────────────────────────────────────────────────────────
// favicon served as static file from public/favicon.svg

// ── PROTECTED DASHBOARD SERVING ───────────────────────────────────────────────
function serveDashboard(allowedRoles) {
  return (req, res) => {
    const token = req.query.t;
    if (!token) return res.redirect('/login.html');
    try {
      const user = jwt.verify(token, JWT_SECRET);
      if (!allowedRoles.includes(user.role)) return res.redirect('/login.html');
      // Every non-admin role (dsd, member, and the legacy investor/rep) uses the DSD dashboard.
      const roleFileMap = { admin:'admin', dsd:'dsd', member:'dsd', investor:'dsd', rep:'dsd' };
      const file = roleFileMap[user.role] || 'dsd';
      res.sendFile(path.join(__dirname, 'public', `dashboard-${file}.html`));
    } catch { res.redirect('/login.html'); }
  };
}
app.get('/dashboard-admin.html', serveDashboard(['admin']));
app.get('/dashboard-dsd.html', serveDashboard(['dsd', 'investor', 'rep', 'member']));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, filePath) => { if (filePath.includes('dashboard-')) res.status(403).end('Forbidden'); }
}));

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/login', rateLimit(10, 60 * 1000), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await one('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.status === 'pending') return res.status(403).json({ error: 'Your account is pending admin approval.' });
    if (user.status === 'inactive') return res.status(403).json({ error: 'Your account has been deactivated.' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, store_id: user.store_id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, role: user.role });
  } catch(e) { console.error('Login error:', e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/signup', rateLimit(5, 60 * 1000), async (req, res) => {
  try {
    const { email, password, name, phone, referral_code } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    // Resolve referral code (email of recruiter)
    let referredById = null;
    if (referral_code && referral_code.trim()) {
      const rcEmail = referral_code.trim().toLowerCase();
      // Prevent self-referral
      if (rcEmail !== email.toLowerCase()) {
        const recruiter = await one("SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND role='dsd' AND status='active'", [rcEmail]);
        if (recruiter) referredById = recruiter.id;
        else console.log('Referral code not found or recruiter not active:', rcEmail);
      }
    }

    const hash = bcrypt.hashSync(password, 10);
    // New DSDs default to Tier 3 — admin promotes them
    await q(
      "INSERT INTO users (email,password_hash,role,name,phone,status,tier,referred_by) VALUES ($1,$2,'dsd',$3,$4,'pending',3,$5)",
      [email.toLowerCase(), hash, name, phone||'', referredById]
    );

    await logActivity('signup_request', `${name} (DSD)`, email.toLowerCase());

    // Email notification (ADDY only has DSD signups — no role selector)
    const roleLabel = 'DSD';
    await sendNotification(
      `👤 New Account Request — ${name} (${roleLabel})`,
      `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <div style="background:#2563eb;padding:24px 28px;">
          <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#93c5fd;">ADDY Distribution</p>
          <h1 style="margin:8px 0 0;font-size:22px;color:#ffffff;">New Account Request</h1>
        </div>
        <div style="padding:24px 28px;">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Name</td><td style="padding:6px 0;font-weight:700;font-size:13px;">${name}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Email</td><td style="padding:6px 0;font-size:13px;">${email.toLowerCase()}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Phone</td><td style="padding:6px 0;font-size:13px;">${phone || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Role</td><td style="padding:6px 0;font-size:13px;"><strong>${roleLabel}</strong></td></tr>
            ${referredById ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Referred By</td><td style="padding:6px 0;font-size:13px;">${referral_code||''}</td></tr>` : ''}
          </table>
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;font-size:13px;color:#1d4ed8;">
            Log in to your admin dashboard → Pending Approvals to approve or deny this request.
          </div>
        </div>
        <div style="background:#f8fafc;padding:16px 28px;text-align:center;font-size:12px;color:#94a3b8;">ADDY Distribution — Admin Notifications</div>
      </div>`
    );

    // Send confirmation email to the new user
    if (resend) {
      try {
        await resend.emails.send({
          from: (process.env.EMAIL_FROM || 'ADDY DSD Portal <notifications@addydsds.com>').replace(/\n/g,' ').trim(),
          to: [email.toLowerCase()],
          subject: 'We received your application — ADDY DSD Portal',
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <div style="background:linear-gradient(135deg,#1e40af,#2563eb);padding:32px 28px;text-align:center;">
              <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.7);">ADDY DSD Portal</p>
              <h1 style="margin:0;font-size:26px;font-weight:800;color:#ffffff;">Application Received</h1>
            </div>
            <div style="padding:32px 28px;">
              <p style="font-size:15px;color:#1e293b;margin:0 0 16px;">Hi ${name},</p>
              <p style="font-size:14px;color:#475569;margin:0 0 16px;">Thanks for applying to become a <strong>${roleLabel}</strong> partner with ADDY DSD Portal. We've received your application and our team will review it shortly.</p>
              <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px;margin:24px 0;text-align:center;">
                <p style="font-size:13px;font-weight:700;color:#16a34a;margin:0 0 4px;">✓ Application Submitted</p>
                <p style="font-size:12px;color:#64748b;margin:0;">You'll receive another email once your account is approved.</p>
              </div>
              <p style="font-size:14px;color:#475569;margin:0 0 8px;">What happens next:</p>
              <ul style="font-size:13px;color:#64748b;margin:0 0 24px;padding-left:20px;line-height:2;">
                <li>Our team reviews your application</li>
                <li>You'll get an email when you're approved</li>
                <li>Log in and start placing orders</li>
              </ul>
              <p style="font-size:13px;color:#94a3b8;margin:0;">Questions? DSDly to this email or contact us at <a href="mailto:admin@addydsds.com" style="color:#2563eb;">admin@addydsds.com</a></p>
            </div>
            <div style="background:#f8fafc;padding:16px 28px;text-align:center;font-size:12px;color:#94a3b8;">
              © 2026 ADDY DSD Portal · <a href="https://addydsds.com/terms.html" style="color:#94a3b8;">Terms</a> · <a href="https://addydsds.com/privacy.html" style="color:#94a3b8;">Privacy</a>
            </div>
          </div>`
        });
      } catch(emailErr) { console.error('Signup confirmation email failed:', emailErr.message); }
    }

    res.status(201).json({ success: true, message: 'Account request submitted. An admin will review and approve your account.' });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/me', authenticate, async (req, res) => {
  try {
    const user = await one('SELECT id,email,role,store_id,name,can_pay_invoice,tier,parent_id,locked_discount_pct FROM users WHERE id=$1', [req.user.id]);
    if (user) {
      user.discount_pct = await getEffectiveDiscountPct(user.id);
      user.boxes_bought = await getCumulativeBoxes(user.role === 'member' && user.parent_id ? user.parent_id : user.id);
      // How many boxes until the next discount tier (null when locked or already at the top).
      user.next_tier_at = user.locked_discount_pct != null || user.discount_pct >= 30
        ? null
        : (user.discount_pct >= 25 ? TIER_30_BOXES : TIER_25_BOXES);
    }
    res.json(user || req.user);
  } catch(e) { res.json(req.user); }
});

app.get('/api/profile', authenticate, async (req, res) => {
  try {
    const user = await one(
      'SELECT id,name,email,role,phone,status,tier,locked_discount_pct,commission_balance,referred_by,stripe_connect_id,can_pay_invoice,parent_id FROM users WHERE id=$1',
      [req.user.id]
    );
    if (user) {
      user.discount_pct = await getEffectiveDiscountPct(user.id);
      user.boxes_bought = await getCumulativeBoxes(user.role === 'member' && user.parent_id ? user.parent_id : user.id);
      user.next_tier_at = user.locked_discount_pct != null || user.discount_pct >= 30
        ? null
        : (user.discount_pct >= 25 ? TIER_30_BOXES : TIER_25_BOXES);
    }
    res.json(user);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/profile', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await one('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), req.user.id]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/forgot-password', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await one("SELECT id,email,name FROM users WHERE email=$1 AND status='active'", [email.toLowerCase()]);
    if (!user) return res.json({ success: true }); // don't reveal if email exists
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await q('UPDATE password_resets SET used=1 WHERE user_id=$1', [user.id]);
    await q('INSERT INTO password_resets (user_id,code,expires_at) VALUES ($1,$2,$3)', [user.id, code, expires]);

    if (resend) {
      // Production: send code by email, never expose it in the response
      try {
        await resend.emails.send({
          from: (process.env.EMAIL_FROM || 'ADDY DSD Portal <notifications@addydsds.com>').replace(/\n/g,' ').trim(),
          to: [user.email],
          subject: 'Your ADDY password reset code',
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
            <h2 style="color:#1e293b;">Password Reset</h2>
            <p>Hi ${user.name || 'there'},</p>
            <p>Your reset code is:</p>
            <div style="font-size:40px;font-weight:800;letter-spacing:10px;color:#2563eb;text-align:center;padding:24px;background:#eff6ff;border-radius:10px;margin:20px 0;">${code}</div>
            <p style="color:#64748b;font-size:13px;">This code expires in 15 minutes. If you didn't request this, ignore this email.</p>
          </div>`
        });
      } catch(emailErr) {
        console.error('Password reset email failed:', emailErr.message);
      }
      res.json({ success: true, name: user.name || user.email });
    } else {
      // Dev/no-email fallback: return code in response so the UI can display it
      res.json({ success: true, code, name: user.name || user.email });
    }
  } catch(e) { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { email, code, new_password } = req.body;
    if (!email || !code || !new_password) return res.status(400).json({ error: 'Email, code, and new password are required' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await one("SELECT id FROM users WHERE email=$1 AND status='active'", [email.toLowerCase()]);
    if (!user) return res.status(400).json({ error: 'Invalid email or code' });
    const reset = await one('SELECT * FROM password_resets WHERE user_id=$1 AND code=$2 AND used=0', [user.id, code]);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired code' });
    if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [bcrypt.hashSync(new_password, 10), user.id]);
    await q('UPDATE password_resets SET used=1 WHERE id=$1', [reset.id]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── NOTIFICATION EMAILS ───────────────────────────────────────────────────────
app.get('/api/notification-emails', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await all('SELECT * FROM notification_emails ORDER BY created_at ASC')); }
  catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/notification-emails', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { email, label } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const existing = await one('SELECT id FROM notification_emails WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already added' });
    const result = await one(
      'INSERT INTO notification_emails (email, label) VALUES ($1,$2) RETURNING *',
      [email.toLowerCase(), label || '']
    );
    res.status(201).json(result);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.delete('/api/notification-emails/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await q('DELETE FROM notification_emails WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── STORES ────────────────────────────────────────────────────────────────────
app.get('/api/stores', authenticate, async (req, res) => {
  try {
    const { role, store_id, id: userId } = req.user;
    const { search, sort, order, page, limit, category, state, status } = req.query;

    if (role === 'dsd') {
      const owned = await all(
        'SELECT s.* FROM stores s INNER JOIN owner_stores os ON os.store_id=s.id WHERE os.owner_id=$1',
        [userId]
      );
      if (owned.length > 0) {
        const avg = await one('SELECT AVG(monthly_revenue) as avg_revenue FROM stores');
        return res.json({ stores: owned, total: owned.length, network_avg: avg.avg_revenue });
      }
      const store = store_id ? await one('SELECT * FROM stores WHERE id=$1', [store_id]) : null;
      const avg = await one('SELECT AVG(monthly_revenue) as avg_revenue FROM stores');
      return res.json({ stores: store ? [store] : [], total: store ? 1 : 0, network_avg: avg.avg_revenue });
    }

    if (role === 'member') {
      // Members see only their parent DSD's claimed stores — never the global directory.
      const me = await one('SELECT parent_id FROM users WHERE id=$1', [userId]);
      const stores = me?.parent_id ? await all(
        'SELECT s.* FROM stores s INNER JOIN owner_stores os ON os.store_id=s.id WHERE os.owner_id=$1 ORDER BY s.name',
        [me.parent_id]
      ) : [];
      return res.json({ stores, total: stores.length });
    }

    if (role === 'rep') {
      const rep = await one('SELECT id FROM reps WHERE user_id=$1', [userId]);
      if (!rep) return res.json({ stores: [], total: 0 });
      const stores = await all(
        'SELECT s.* FROM stores s INNER JOIN rep_store_assignments rsa ON rsa.store_id=s.id WHERE rsa.rep_id=$1',
        [rep.id]
      );
      return res.json({ stores, total: stores.length });
    }

    const baseSelect = role === 'investor' ? 'SELECT id,name,monthly_revenue,status FROM stores' : 'SELECT * FROM stores';
    const conditions = [], params = [];
    let pi = 1;
    if (search) {
      if (role === 'admin') {
        conditions.push(`(name ILIKE $${pi} OR owner_name ILIKE $${pi+1} OR email ILIKE $${pi+2} OR city ILIKE $${pi+3})`);
        params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); pi+=4;
      } else { conditions.push(`name ILIKE $${pi}`); params.push(`%${search}%`); pi++; }
    }
    if (category) { conditions.push(`category=$${pi}`); params.push(category); pi++; }
    if (state) { conditions.push(`state=$${pi}`); params.push(state); pi++; }
    if (status) { conditions.push(`status=$${pi}`); params.push(status); pi++; }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const allowedSorts = ['name','monthly_revenue','city','state','category','owner_name','status'];
    const orderClause = (sort && allowedSorts.includes(sort)) ? ` ORDER BY ${sort} ${order==='desc'?'DESC':'ASC'}` : ' ORDER BY name ASC';
    const totalFiltered = (await one(`SELECT COUNT(*) as count FROM stores${where}`, params)).count;
    const pageNum = Math.max(1, parseInt(page)||1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit)||25));
    const offset = (pageNum-1)*pageSize;

    const stores = await all(`${baseSelect}${where}${orderClause} LIMIT $${pi} OFFSET $${pi+1}`, [...params, pageSize, offset]);
    const stats = await one('SELECT COUNT(*) as total, SUM(monthly_revenue) as total_revenue, AVG(monthly_revenue) as avg_revenue FROM stores');
    const byCategory = await all('SELECT category, SUM(monthly_revenue) as revenue, COUNT(*) as count FROM stores GROUP BY category ORDER BY revenue DESC');
    const top10 = await all('SELECT id,name,monthly_revenue FROM stores ORDER BY monthly_revenue DESC LIMIT 10');
    const bottom10 = await all('SELECT id,name,monthly_revenue FROM stores ORDER BY monthly_revenue ASC LIMIT 10');
    const byStatus = await all('SELECT status, COUNT(*) as count FROM stores GROUP BY status');
    // Revenue by product (from actual orders)
    const byProduct = await all(`
      SELECT COALESCE(p.name, '[Deleted Product]') as name,
             SUM(oi.total_price) as revenue,
             SUM(oi.quantity) as units
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      LEFT JOIN orders o ON o.id = oi.order_id
      WHERE o.status != 'cancelled' AND o.payment_status != 'cancelled'
      GROUP BY p.name ORDER BY revenue DESC LIMIT 10
    `);
    // Orders over time (last 30 days)
    const ordersOverTime = await all(`
      SELECT DATE(created_at) as date, COUNT(*) as orders, SUM(total) as revenue
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND status != 'cancelled' AND payment_status != 'cancelled'
      GROUP BY DATE(created_at) ORDER BY date ASC
    `);

    const buckets = [0,50000,100000,150000,200000,250000,300000,400000,500000];
    const distribution = await Promise.all(buckets.map(async (min,i) => {
      const max = buckets[i+1] || 999999999;
      const label = i===buckets.length-1 ? `$${min/1000}k+` : `$${min/1000}k-${max/1000}k`;
      const count = (await one('SELECT COUNT(*) as count FROM stores WHERE monthly_revenue>=$1 AND monthly_revenue<$2', [min,max])).count;
      return { label, count, min, max };
    }));

    res.json({
      stores, total: stats.total, total_filtered: totalFiltered,
      total_revenue: stats.total_revenue, avg_revenue: stats.avg_revenue,
      page: pageNum, page_size: pageSize, total_pages: Math.ceil(totalFiltered/pageSize),
      by_category: byCategory, top10, bottom10, by_status: byStatus, distribution,
      by_product: byProduct, orders_over_time: ordersOverTime
    });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Must be before /:id route to avoid param matching
app.get('/api/stores/pending-claims', authenticate, authorize('admin'), async (req, res) => {
  try {
    const stores = await all(
      "SELECT s.*, u.name as rep_name, u.email as rep_email FROM stores s JOIN users u ON u.id=s.exclusive_rep_id WHERE s.store_approval_status='pending' ORDER BY s.id DESC"
    );
    res.json(stores);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stores/map-data', authenticate, authorize('admin'), async (req, res) => {
  try {
    const stores = await all(
      "SELECT id, name, address, city, state, zip, category, store_approval_status, exclusive_rep_id FROM stores WHERE store_approval_status='approved' ORDER BY name"
    );
    res.json(stores);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stores/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json(store);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/stores', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, owner_name, email, address, city, state, zip, category, monthly_revenue, wholesale_price, retail_price, distribution_cost, status, phone, store_number } = req.body;
    if (!name) return res.status(400).json({ error: 'Store name is required' });
    const result = await one(
      `INSERT INTO stores (name,owner_name,email,address,city,state,zip,category,monthly_revenue,wholesale_price,retail_price,distribution_cost,status,phone,store_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [name, owner_name||'', email||'', address||'', city||'', state||'', zip||'',
       category||'General', monthly_revenue||0, wholesale_price||0, retail_price||0,
       distribution_cost||0, status||'active', phone||'', store_number||'']
    );
    await logActivity('created', name, req.user.email);
    res.status(201).json(result);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/stores/:id', authenticate, async (req, res) => {
  try {
    const { role, store_id } = req.user;
    const id = parseInt(req.params.id);
    if (role === 'dsd' && store_id !== id) return res.status(403).json({ error: 'Access denied' });
    if (role === 'investor') return res.status(403).json({ error: 'Access denied' });
    const store = await one('SELECT * FROM stores WHERE id=$1', [id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const allowed = ['name','owner_name','email','address','city','state','zip','category','monthly_revenue','wholesale_price','retail_price','distribution_cost','status'];
    const updates = [], params = [];
    let pi = 1;
    for (const field of allowed) {
      if (req.body[field] !== undefined) { updates.push(`${field}=$${pi}`); params.push(req.body[field]); pi++; }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);
    const updated = await one(`UPDATE stores SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params);
    await logActivity(req.body.status && req.body.status !== store.status ? 'status_changed' : 'updated', store.name, req.user.email);
    res.json(updated);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.delete('/api/stores/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const id = req.params.id;
    await q('DELETE FROM store_notes          WHERE store_id=$1', [id]);
    await q('DELETE FROM store_inventory      WHERE store_id=$1', [id]);
    await q('DELETE FROM rep_store_assignments WHERE store_id=$1', [id]);
    await q('DELETE FROM dsd_stores   WHERE store_id=$1', [id]);
    await q('DELETE FROM owner_stores         WHERE store_id=$1', [id]);
    await q('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE store_id=$1)', [id]);
    await q('DELETE FROM carts                WHERE store_id=$1', [id]);
    await q('UPDATE orders SET store_id=NULL  WHERE store_id=$1', [id]);
    await q('UPDATE users  SET store_id=NULL  WHERE store_id=$1', [id]);
    await q('DELETE FROM stores               WHERE id=$1', [id]);
    await logActivity('deleted', store.name, req.user.email);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/stores/bulk-delete', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No store IDs provided' });
    const placeholders = ids.map((_,i) => `$${i+1}`).join(',');
    const stores = await all(`SELECT name FROM stores WHERE id IN (${placeholders})`, ids);
    // Delete in FK-safe order
    await q(`DELETE FROM store_notes         WHERE store_id IN (${placeholders})`, ids);
    await q(`DELETE FROM store_inventory     WHERE store_id IN (${placeholders})`, ids);
    await q(`DELETE FROM rep_store_assignments WHERE store_id IN (${placeholders})`, ids);
    await q(`DELETE FROM dsd_stores  WHERE store_id IN (${placeholders})`, ids);
    await q(`DELETE FROM owner_stores        WHERE store_id IN (${placeholders})`, ids);
    await q(`DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE store_id IN (${placeholders}))`, ids);
    await q(`DELETE FROM carts               WHERE store_id IN (${placeholders})`, ids);
    await q(`UPDATE orders SET store_id=NULL WHERE store_id IN (${placeholders})`, ids);
    await q(`UPDATE users  SET store_id=NULL WHERE store_id IN (${placeholders})`, ids);
    await q(`DELETE FROM stores              WHERE id       IN (${placeholders})`, ids);
    for (const s of stores) await logActivity('deleted', s.name, req.user.email);
    res.json({ success: true, deleted: ids.length });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Delete ALL stores (admin only - for clearing demo data)
app.post('/api/stores/delete-all', authenticate, authorize('admin'), async (req, res) => {
  try {
    const count = await one('SELECT COUNT(*) as c FROM stores');
    await q('DELETE FROM store_notes');
    await q('DELETE FROM store_inventory');
    await q('DELETE FROM rep_store_assignments');
    await q('DELETE FROM dsd_stores');
    await q('DELETE FROM owner_stores');
    await q('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE store_id IS NOT NULL)');
    await q('DELETE FROM carts WHERE store_id IS NOT NULL');
    await q('UPDATE orders SET store_id=NULL WHERE store_id IS NOT NULL');
    await q('UPDATE users  SET store_id=NULL WHERE store_id IS NOT NULL');
    await q('DELETE FROM stores');
    await logActivity('deleted_all_stores', `${count.c} stores removed`, req.user.email);
    res.json({ success: true, deleted: parseInt(count.c) });
  } catch(e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// ── FILTERS / ACTIVITY / NOTES / CSV ─────────────────────────────────────────
app.get('/api/filters', authenticate, async (req, res) => {
  try {
    const categories = (await all('SELECT DISTINCT category FROM stores ORDER BY category')).map(r=>r.category);
    const states = (await all('SELECT DISTINCT state FROM stores ORDER BY state')).map(r=>r.state);
    res.json({ categories, states });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/activity', authenticate, authorize('admin'), async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit)||10);
    res.json(await all('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1', [limit]));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/stores/:id/notes', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await all('SELECT * FROM store_notes WHERE store_id=$1 ORDER BY created_at DESC', [req.params.id])); }
  catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/stores/:id/notes', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const result = await one('INSERT INTO store_notes (store_id,note) VALUES ($1,$2) RETURNING *', [req.params.id, note.trim()]);
    res.status(201).json(result);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/export/csv', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { search, category, state, status, ids } = req.query;
    const conditions = [], params = []; let pi = 1;
    if (ids) {
      const idList = ids.split(',').map(Number).filter(n=>!isNaN(n));
      if (idList.length) { conditions.push(`id IN (${idList.map((_,i)=>`$${pi+i}`).join(',')})`); params.push(...idList); pi+=idList.length; }
    }
    if (search) { conditions.push(`(name ILIKE $${pi} OR owner_name ILIKE $${pi+1} OR email ILIKE $${pi+2} OR city ILIKE $${pi+3})`); params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); pi+=4; }
    if (category) { conditions.push(`category=$${pi}`); params.push(category); pi++; }
    if (state) { conditions.push(`state=$${pi}`); params.push(state); pi++; }
    if (status) { conditions.push(`status=$${pi}`); params.push(status); pi++; }
    const stores = await all(`SELECT * FROM stores${conditions.length?' WHERE '+conditions.join(' AND '):''} ORDER BY name`, params);
    const headers = ['Name','Owner','Email','Address','City','State','Zip','Category','Monthly Revenue','Wholesale Price','Retail Price','Distribution Cost','Status'];
    const rows = stores.map(s => [s.name,s.owner_name,s.email,s.address,s.city,s.state,s.zip,s.category,s.monthly_revenue,s.wholesale_price,s.retail_price,s.distribution_cost,s.status].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename=addy-stores.csv');
    res.send([headers.join(','),...rows].join('\n'));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.post('/api/users', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { email, password, name, phone, role } = req.body;
    if (!email || !password || !name || !role) return res.status(400).json({ error: 'Email, password, name, and role are required' });
    if (!['admin','investor'].includes(role)) return res.status(400).json({ error: 'This endpoint only creates admin or investor accounts' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
    const result = await one(
      `INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
      [email.toLowerCase(), bcrypt.hashSync(password,10), role, name, phone||'']
    );
    await logActivity('created_user', `${name} (${role})`, req.user.email);
    res.status(201).json({ success: true, id: result.id });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/users', authenticate, authorize('admin'), async (req, res) => {
  try { res.json(await all('SELECT id,email,name,phone,role,status,pricing_tier,tier,locked_discount_pct,can_pay_invoice FROM users ORDER BY role,name')); }
  catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/users/:id/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await q('UPDATE users SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/users/:id/stores', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { store_ids } = req.body;
    if (!store_ids || !Array.isArray(store_ids)) return res.status(400).json({ error: 'store_ids array required' });
    for (const sid of store_ids) {
      await q('INSERT INTO owner_stores (owner_id,store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, sid]);
    }
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Delete a user account
app.delete('/api/users/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    const uid = user.id;
    // Clean up in FK-safe order — cover every table that references users(id)
    await q('DELETE FROM push_subscriptions  WHERE user_id=$1', [uid]);
    await q('DELETE FROM preorders           WHERE user_id=$1', [uid]);
    await q('DELETE FROM password_resets     WHERE user_id=$1', [uid]);
    await q('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id=$1)', [uid]);
    await q('DELETE FROM carts               WHERE user_id=$1', [uid]);
    await q('DELETE FROM rep_store_assignments WHERE rep_id IN (SELECT id FROM reps WHERE user_id=$1)', [uid]);
    await q('DELETE FROM reps                WHERE user_id=$1', [uid]);
    await q('DELETE FROM dsd_stores  WHERE dsd_id=$1', [uid]);
    await q('DELETE FROM owner_stores        WHERE owner_id=$1', [uid]);
    // Nullify orders so order history is preserved but user reference removed
    await q('UPDATE orders SET user_id=NULL  WHERE user_id=$1', [uid]);
    await q('UPDATE users  SET store_id=NULL WHERE id=$1', [uid]);
    await q('DELETE FROM users               WHERE id=$1', [uid]);
    await logActivity('deleted_user', user.name || user.email, req.user.email);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// Get per-user product pricing
app.get('/api/users/:id/pricing', authenticate, authorize('admin'), async (req, res) => {
  try {
    const prices = await all(
      'SELECT pp.product_id, pp.price, p.name FROM product_prices pp JOIN products p ON p.id=pp.product_id WHERE pp.user_id=$1',
      [req.params.id]
    );
    res.json(prices);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set per-user pricing — handles TWO use cases on the same route:
// 1. { product_id, price } — set/clear ONE product's custom price (per-product editor)
// 2. { tier, custom_prices, custom_margin_pct } — change a DSD's whole tier (Change Tier modal)
app.patch('/api/users/:id/pricing', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { product_id, price, tier, custom_prices, custom_margin_pct, can_pay_invoice } = req.body || {};

    if (product_id) {
      // Use case 1: single product custom price
      if (price === null || price === undefined || price === '') {
        await q('DELETE FROM product_prices WHERE user_id=$1 AND product_id=$2', [req.params.id, product_id]);
      } else {
        await q(
          "INSERT INTO product_prices (product_id, user_id, role, price) VALUES ($1,$2,'dsd',$3) ON CONFLICT (product_id, user_id, role) DO UPDATE SET price=EXCLUDED.price",
          [product_id, req.params.id, parseFloat(price)]
        );
      }
      return res.json({ success: true });
    }

    if (tier !== undefined && tier !== null && tier !== '') {
      // Use case 2 (new model): lock a discount % for this DSD, or 'auto' to clear it (earn-up rate).
      const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
      if (!user) return res.status(404).json({ error: 'User not found' });
      let pct;
      if (tier === 'auto') pct = null;
      else if (custom_margin_pct !== undefined && custom_margin_pct !== null && custom_margin_pct !== '') pct = parseFloat(custom_margin_pct);
      else { const legacy = { 1: 35, 2: 30, 3: 25 }; pct = legacy[parseInt(tier)] ?? parseFloat(tier); }
      if (pct != null && !(pct >= 0 && pct <= 90)) return res.status(400).json({ error: 'Margin must be between 0 and 90%.' });
      await q('UPDATE users SET locked_discount_pct=$1 WHERE id=$2', [pct, req.params.id]);
      if (can_pay_invoice !== undefined) await q('UPDATE users SET can_pay_invoice=$1 WHERE id=$2', [!!can_pay_invoice, req.params.id]);
      await logActivity('pricing_updated', user.name||user.email, req.user.email);
      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Provide either product_id+price or tier' });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Admin reset a user's password
app.patch('/api/users/:id/reset-password', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await one('SELECT id, email, name FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const hash = bcrypt.hashSync(new_password, 10);
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
    await logActivity('reset_password', user.name || user.email, req.user.email);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/pending-users', authenticate, authorize('admin'), async (req, res) => {
  try {
    res.json(await all(
      `SELECT u.id,u.email,u.name,u.phone,u.status,u.role,
              s.id as store_id,s.name as store_name,s.city,s.state,s.category
       FROM users u LEFT JOIN stores s ON s.id=u.store_id
       WHERE u.role IN ('dsd','dsd','rep')
       ORDER BY u.status ASC, u.id DESC`
    ));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Pricing is now discount-based (see getPriceForUser). Approval optionally locks a
// custom discount %; otherwise the rep earns their rate automatically.

app.patch('/api/users/:id/approve', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await q("UPDATE users SET status='active' WHERE id=$1", [req.params.id]);
    // If member, link to parent DSD from request body
    if (req.body?.parent_id) {
      await q('UPDATE users SET parent_id=$1 WHERE id=$2', [req.body.parent_id, req.params.id]);
    }
    if (user.store_id) await q("UPDATE stores SET status='active' WHERE id=$1", [user.store_id]);
    const { custom_margin_pct, can_pay_invoice } = req.body || {};
    // New reps start on the automatic earn-up rate (20%). Admin can optionally lock a custom % now.
    if (custom_margin_pct !== undefined && custom_margin_pct !== null && custom_margin_pct !== '') {
      const pct = parseFloat(custom_margin_pct);
      if (pct >= 0 && pct <= 90) await q('UPDATE users SET locked_discount_pct=$1 WHERE id=$2', [pct, req.params.id]);
    }
    await q('UPDATE users SET can_pay_invoice=$1 WHERE id=$2', [!!can_pay_invoice, req.params.id]);
    await logActivity('approved', user.name||user.email, req.user.email);

    // Send approval email to user
    if (resend) {
      try {
        const roleLabel = user.role === 'dsd' ? 'DSD' : user.role === 'dsd' ? 'DSD' : 'DSD';
        await resend.emails.send({
          from: (process.env.EMAIL_FROM || 'ADDY DSD Portal <notifications@addydsds.com>').replace(/\n/g,' ').trim(),
          to: [user.email],
          subject: '✅ Your ADDY account is approved!',
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <div style="background:linear-gradient(135deg,#15803d,#16a34a);padding:32px 28px;text-align:center;">
              <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.8);">ADDY DSD Portal</p>
              <h1 style="margin:0;font-size:26px;font-weight:800;color:#ffffff;">You're Approved! 🎉</h1>
            </div>
            <div style="padding:32px 28px;">
              <p style="font-size:15px;color:#1e293b;margin:0 0 16px;">Hi ${user.name || 'there'},</p>
              <p style="font-size:14px;color:#475569;margin:0 0 24px;">Your <strong>${roleLabel}</strong> account has been approved. You can now log in and start placing orders.</p>
              <div style="text-align:center;margin:28px 0;">
                <a href="https://addydsds.com/login.html" style="background:#2563eb;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">Log In to Your Account →</a>
              </div>
              <p style="font-size:13px;color:#94a3b8;margin:0;text-align:center;">Questions? Contact us at <a href="mailto:admin@addydsds.com" style="color:#2563eb;">admin@addydsds.com</a></p>
            </div>
            <div style="background:#f8fafc;padding:16px 28px;text-align:center;font-size:12px;color:#94a3b8;">© 2026 ADDY DSD Portal</div>
          </div>`
        });
      } catch(emailErr) { console.error('Approval email failed:', emailErr.message); }
    }

    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/users/:id/reject', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await q("UPDATE users SET status='inactive' WHERE id=$1", [req.params.id]);
    if (user.store_id) await q("UPDATE stores SET status='inactive' WHERE id=$1", [user.store_id]);
    await logActivity('rejected', user.name||user.email, req.user.email);

    // Send rejection email
    if (resend) {
      try {
        await resend.emails.send({
          from: (process.env.EMAIL_FROM || 'ADDY DSD Portal <notifications@addydsds.com>').replace(/\n/g,' ').trim(),
          to: [user.email],
          subject: 'Update on your ADDY application',
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <div style="background:#1e293b;padding:32px 28px;text-align:center;">
              <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.5);">ADDY DSD Portal</p>
              <h1 style="margin:0;font-size:24px;font-weight:800;color:#ffffff;">Application Update</h1>
            </div>
            <div style="padding:32px 28px;">
              <p style="font-size:15px;color:#1e293b;margin:0 0 16px;">Hi ${user.name || 'there'},</p>
              <p style="font-size:14px;color:#475569;margin:0 0 16px;">Thank you for your interest in partnering with ADDY DSD Portal. Unfortunately, we're unable to approve your application at this time.</p>
              <p style="font-size:14px;color:#475569;margin:0 0 24px;">If you believe this is an error or would like more information, please reach out to us directly.</p>
              <p style="font-size:13px;color:#94a3b8;margin:0;text-align:center;">Contact us at <a href="mailto:admin@addydsds.com" style="color:#2563eb;">admin@addydsds.com</a></p>
            </div>
            <div style="background:#f8fafc;padding:16px 28px;text-align:center;font-size:12px;color:#94a3b8;">© 2026 ADDY DSD Portal</div>
          </div>`
        });
      } catch(emailErr) { console.error('Rejection email failed:', emailErr.message); }
    }

    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── REPS ──────────────────────────────────────────────────────────────────────
app.get('/api/reps', authenticate, authorize('admin'), async (req, res) => {
  // Returns all DSDs using the REAL data model: users.tier, users.referred_by, users.commission_balance
  try {
    const dsds = await all(
      `SELECT u.id as user_id, u.name, u.email, u.phone, u.status, u.tier, u.pricing_tier,
              u.commission_balance,
              su.name as sponsor_name, su.id as sponsor_id,
              (SELECT COUNT(*) FROM owner_stores os WHERE os.owner_id=u.id) as store_count
       FROM users u
       LEFT JOIN users su ON su.id = u.referred_by
       WHERE u.role='dsd'
       ORDER BY u.name`
    );
    res.json(dsds);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});


app.post('/api/reps', authenticate, authorize('admin'), async (req, res) => {
  // Admin-added DSD: created directly as active (no approval step needed), default Tier 3.
  // sponsor_rep_id is treated as the sponsor's USER id (links via referred_by, same chain used by commissions).
  try {
    const { name, email, password, phone, sponsor_rep_id } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    let sponsorId = null;
    if (sponsor_rep_id) {
      const sponsor = await one("SELECT id FROM users WHERE id=$1 AND role='dsd'", [sponsor_rep_id]);
      if (!sponsor) return res.status(400).json({ error: 'Sponsor DSD not found' });
      sponsorId = sponsor.id;
    }

    const hash = bcrypt.hashSync(password, 10);
    const ur = await one(
      `INSERT INTO users (email,password_hash,role,name,phone,status,tier,referred_by)
       VALUES ($1,$2,'dsd',$3,$4,'active',3,$5) RETURNING id`,
      [email.toLowerCase(), hash, name, phone||'', sponsorId]
    );

    await logActivity('created_dsd', name, req.user.email);
    res.status(201).json({ success: true, userId: ur.id });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});


// ── DISTRIBUTOR ───────────────────────────────────────────────────────────────
app.get('/api/dsd/stores', authenticate, authorize('dsd'), async (req, res) => {
  try {
    res.json(await all(
      'SELECT s.* FROM stores s INNER JOIN dsd_stores ds ON ds.store_id=s.id WHERE ds.dsd_id=$1 ORDER BY s.name',
      [req.user.id]
    ));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────
app.get('/api/products', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const products = await all('SELECT * FROM products WHERE active IN (1,2) ORDER BY active DESC, name');
    const result = await Promise.all(products.map(async p => {
      const price = p.active === 1 ? await getPriceForUser(p.id, userId, role) : null;
      const allPrices = role === 'admin' ? await all('SELECT role,user_id,price FROM product_prices WHERE product_id=$1', [p.id]) : null;
      const preorder_count = p.active === 2 ? (await one('SELECT COUNT(*) as c FROM preorders WHERE product_id=$1', [p.id]))?.c || 0 : 0;
      const user_preordered = p.active === 2 ? !!(await one('SELECT id FROM preorders WHERE product_id=$1 AND user_id=$2', [p.id, userId])) : false;
      return { ...p, my_price: price, all_prices: allPrices, preorder_count, user_preordered };
    }));
    res.json(result);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/products/all', authenticate, authorize('admin'), async (req, res) => {
  try {
    const products = await all('SELECT * FROM products ORDER BY active DESC, name');
    const result = await Promise.all(products.map(async p => {
      const prices = await all('SELECT role,user_id,price FROM product_prices WHERE product_id=$1 AND user_id IS NULL', [p.id]);
      const preorder_count = parseInt((await one('SELECT COUNT(*) as c FROM preorders WHERE product_id=$1', [p.id]))?.c || 0);
      return { ...p, role_prices: prices, preorder_count };
    }));
    res.json(result);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/products', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, description, image_url, sku, stock, cost_price, prices } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name is required' });
    const box_type = BOX_TYPES.includes(req.body.box_type) ? req.body.box_type : null;
    const p = await one(
      'INSERT INTO products (name,description,image_url,sku,stock,retail_price,cost_price,box_type,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING *',
      [name, description||'', image_url||'', sku||'', stock||0, parseFloat(req.body.retail_price||0), parseFloat(req.body.cost_price||0), box_type]
    );
    if (prices) {
      for (const [role, price] of Object.entries(prices)) {
        if (price !== '' && price != null) {
          await q(
            'INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,NULL,$2,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price',
            [p.id, role, parseFloat(price)]
          );
        }
      }
    }
    await logActivity('created_product', name, req.user.email);
    res.status(201).json(p);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/products/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, description, image_url, sku, stock, cost_price, retail_price, active, prices } = req.body;
    const p = await one('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const box_type = req.body.box_type === undefined
      ? p.box_type
      : (BOX_TYPES.includes(req.body.box_type) ? req.body.box_type : null);
    const updated = await one(
      'UPDATE products SET name=$1,description=$2,image_url=$3,sku=$4,stock=$5,active=$6,retail_price=$7,cost_price=$8,box_type=$9 WHERE id=$10 RETURNING *',
      [name??p.name, description??p.description, image_url??p.image_url, sku??p.sku, stock??p.stock, active??p.active,
       parseFloat(retail_price??p.retail_price??0), parseFloat(cost_price??p.cost_price??0), box_type, req.params.id]
    );
    if (prices) {
      for (const [role, price] of Object.entries(prices)) {
        if (price !== '' && price != null) {
          await q(
            'INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,NULL,$2,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price',
            [req.params.id, role, parseFloat(price)]
          );
        }
      }
    }
    // If flipping from Coming Soon (2) → Active (1), email everyone who pre-ordered
    if (p.active === 2 && active === 1 && resend) {
      const preorders = await all(
        'SELECT u.email, u.name FROM preorders po JOIN users u ON u.id=po.user_id WHERE po.product_id=$1 AND po.notified=0',
        [req.params.id]
      );
      const productName = name ?? p.name;
      for (const user of preorders) {
        try {
          await resend.emails.send({
            from: (process.env.EMAIL_FROM || 'ADDY DSD Portal <notifications@addydsds.com>').replace(/\n/g,' ').trim(),
            to: [user.email],
            subject: `${productName} is now available — ADDY`,
            html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;">
              <div style="background:#2563eb;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
                <p style="color:rgba(255,255,255,0.7);font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin:0 0 8px;">ADDY Distribution</p>
                <h1 style="color:#fff;font-size:26px;font-weight:800;margin:0;">It's live! 🎉</h1>
              </div>
              <p>Hi ${user.name || 'there'},</p>
              <p>You asked us to let you know — <strong>${productName}</strong> is now available to order on ADDY.</p>
              <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:20px;margin:20px 0;text-align:center;">
                <p style="font-size:18px;font-weight:700;color:#16a34a;margin:0;">✓ Now Available</p>
                <p style="color:#374151;margin:8px 0 0;">${productName}</p>
              </div>
              <p>Log in to your ADDY account to place an order.</p>
              <p style="color:#64748b;font-size:12px;margin-top:32px;">You received this because you clicked "Notify Me" on this product.</p>
            </div>`
          });
        } catch(emailErr) { console.error('Preorder notify email failed:', emailErr.message); }
      }
      if (preorders.length > 0) {
        await q('UPDATE preorders SET notified=1 WHERE product_id=$1', [req.params.id]);
        console.log(`✓ Notified ${preorders.length} preorder users for: ${productName}`);
      }
    }
    await logActivity('updated_product', name||p.name, req.user.email);
    res.json(updated);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/products/:id/price', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { user_id, role, price } = req.body;
    if (!price) return res.status(400).json({ error: 'Price required' });
    if (user_id) {
      await q('INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,$2,NULL,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price', [req.params.id, user_id, parseFloat(price)]);
    } else if (role) {
      await q('INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,NULL,$2,$3) ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price', [req.params.id, role, parseFloat(price)]);
    }
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.delete('/api/products/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const p = await one('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    // Nullify product reference in order_items (preserve order history)
    await q('UPDATE order_items SET product_id=NULL WHERE product_id=$1', [req.params.id]);
    await q('DELETE FROM products WHERE id=$1', [req.params.id]);
    await logActivity('deleted_product', p.name, req.user.email);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── PUBLIC ENDPOINTS (no auth) ────────────────────────────────────────────────
app.get('/api/products/public', async (req, res) => {
  try {
    const products = await all('SELECT id, name, description, image_url, sku FROM products WHERE active=1 ORDER BY id ASC');
    res.json(products);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong.' }); }
});

// ── CONFIG (frontend reads this to know if Stripe and Push are active) ────────
app.get('/api/config', (req, res) => {
  res.json({
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    vapidPublicKey: VAPID_PUBLIC
  });
});

// ── PUSH NOTIFICATION ENDPOINTS ───────────────────────────────────────────────
app.post('/api/push/subscribe', authenticate, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Subscription required' });
    await q(
      'INSERT INTO push_subscriptions (user_id, subscription) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET subscription=EXCLUDED.subscription',
      [req.user.id, JSON.stringify(subscription)]
    );
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong.' }); }
});

app.delete('/api/push/unsubscribe', authenticate, async (req, res) => {
  try {
    await q('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong.' }); }
});

// ── INVOICE HELPERS ───────────────────────────────────────────────────────────
async function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const count = await one('SELECT COUNT(*) as c FROM invoices');
  const num = String(parseInt(count?.c || 0) + 1).padStart(4, '0');
  return `WC-${year}-${num}`;
}

async function createInvoiceForOrder(orderId) {
  const invoiceNumber = await generateInvoiceNumber();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  return await one(
    'INSERT INTO invoices (order_id, invoice_number, due_date) VALUES ($1,$2,$3) RETURNING *',
    [orderId, invoiceNumber, dueDate.toISOString().split('T')[0]]
  );
}

// ── STRIPE PAYMENT ENDPOINTS ──────────────────────────────────────────────────
app.post('/api/payment/intent', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Card payments not configured. Please use invoice payment.' });
  try {
    const { amount_cents } = req.body;
    if (!amount_cents || amount_cents < 50) return res.status(400).json({ error: 'Invalid amount' });
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount_cents),
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: intent.client_secret });
  } catch(e) { console.error('Stripe error:', e.message); res.status(500).json({ error: 'Payment processing error. Please try again.' }); }
});

app.post('/api/payment/confirm', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Card payments not configured' });
  try {
    const { payment_intent_id, order_id } = req.body;
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.status !== 'succeeded') return res.status(400).json({ error: 'Payment not completed' });
    await q('UPDATE orders SET payment_status=$1 WHERE id=$2', ['paid', order_id]);
    await q('UPDATE invoices SET payment_status=$1, paid_at=NOW(), stripe_payment_intent_id=$2 WHERE order_id=$3',
      ['paid', payment_intent_id, order_id]);
    res.json({ success: true });
  } catch(e) { console.error('Stripe confirm error:', e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── INVOICE ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/api/invoices/:orderId/print', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const order = role === 'admin'
      ? await one('SELECT o.*,u.name as user_name,u.email as user_email,u.phone as user_phone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1', [req.params.orderId])
      : await one('SELECT o.*,u.name as user_name,u.email as user_email,u.phone as user_phone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1 AND o.user_id=$2', [req.params.orderId, userId]);
    if (!order) return res.status(404).send('Invoice not found');
    const invoice = await one('SELECT * FROM invoices WHERE order_id=$1', [req.params.orderId]);
    if (!invoice) return res.status(404).send('Invoice not found');
    const items = await all('SELECT oi.*,COALESCE(p.name,\'[Deleted Product]\') as name,COALESCE(p.sku,\'—\') as sku FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1', [req.params.orderId]);
    const isCancelled = invoice.payment_status === 'cancelled';
    const statusColor = invoice.payment_status === 'paid' ? '#16a34a' : isCancelled ? '#6b7280' : invoice.payment_status === 'overdue' ? '#dc2626' : '#d97706';
    const statusBg = invoice.payment_status === 'paid' ? '#f0fdf4' : isCancelled ? '#f1f5f9' : invoice.payment_status === 'overdue' ? '#fef2f2' : '#fffbeb';
    const statusLabel = isCancelled ? 'CANCELLED' : invoice.payment_status.charAt(0).toUpperCase() + invoice.payment_status.slice(1);
    const itemRows = items.map(i => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">${i.name}${i.sku ? `<span style="color:#94a3b8;font-size:11px;display:block;">${i.sku}</span>` : ''}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">${i.quantity}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;">$${parseFloat(i.unit_price).toFixed(2)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;">$${parseFloat(i.total_price).toFixed(2)}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1.0">
      <title>Invoice ${invoice.invoice_number}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1e293b; background: #f8fafc; }
        .page { max-width: 780px; margin: 32px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #1e40af, #2563eb); padding: 36px 40px; display: flex; justify-content: space-between; align-items: flex-start; }
        .header-left h1 { font-size: 28px; font-weight: 800; color: #fff; letter-spacing: -0.5px; }
        .header-left p { color: rgba(255,255,255,0.7); font-size: 13px; margin-top: 4px; }
        .header-right { text-align: right; }
        .invoice-num { font-size: 22px; font-weight: 700; color: #fff; }
        .invoice-meta { color: rgba(255,255,255,0.75); font-size: 12px; margin-top: 4px; line-height: 1.8; }
        .status-pill { display: inline-block; padding: 6px 16px; border-radius: 100px; font-size: 13px; font-weight: 700; background: ${statusBg}; color: ${statusColor}; margin-top: 8px; }
        .body { padding: 36px 40px; }
        .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-bottom: 32px; }
        .party-label { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #94a3b8; margin-bottom: 8px; }
        .party-name { font-size: 16px; font-weight: 700; color: #1e293b; margin-bottom: 4px; }
        .party-detail { font-size: 13px; color: #64748b; line-height: 1.6; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
        thead th { background: #f8fafc; padding: 10px 12px; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #64748b; text-align: left; }
        thead th:last-child, thead th:nth-child(3), thead th:nth-child(2) { text-align: right; }
        thead th:nth-child(2) { text-align: center; }
        .totals { display: flex; justify-content: flex-end; }
        .totals-box { width: 280px; }
        .totals-row { display: flex; justify-content: space-between; font-size: 13px; color: #64748b; padding: 5px 0; }
        .totals-total { display: flex; justify-content: space-between; font-size: 18px; font-weight: 800; color: #1e293b; padding: 14px 0 0; border-top: 2px solid #e2e8f0; margin-top: 8px; }
        .totals-total span:last-child { color: #2563eb; }
        .footer { background: #f8fafc; padding: 24px 40px; display: flex; justify-content: space-between; align-items: center; }
        .footer-note { font-size: 12px; color: #94a3b8; }
        .print-btn { background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 10px 24px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
        @media print {
          body { background: #fff; }
          .page { box-shadow: none; border-radius: 0; margin: 0; }
          .print-btn { display: none; }
        }
      </style>
    </head>
    <body>
      <div class="page">
        <div style="background:#0F1E3C;color:#fff;text-align:center;padding:8px;font-size:13px;font-weight:800;letter-spacing:3px;border-radius:8px 8px 0 0;margin:-24px -24px 20px -24px;">
          ★ FOR RESALE ONLY — NOT FOR PERSONAL USE ★
        </div>
        <div class="header">
          <div class="header-left">
            <img src="https://addyproducts.com/wp-content/uploads/2025/03/WGCPADDY-Logo-300x165.png" style="height:50px;width:auto;object-fit:contain;" alt="ADDY">
            <p style="margin-top:4px;font-size:11px;color:#64748b;">DSD Partner Invoice</p>
          </div>
          <div class="header-right">
            <div class="invoice-num">${invoice.invoice_number}</div>
            <div class="invoice-meta">
              Issued: ${new Date(invoice.created_at).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}<br>
              Due: ${new Date(invoice.due_date).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}
            </div>
            <div class="status-pill">${statusLabel}</div>
          </div>
        </div>
        <div class="body">
          <div class="parties">
            <div>
              <div class="party-label">From</div>
              <div class="party-name">ADDY Distribution</div>
              <div class="party-detail">notifications@addydsds.com<br>addydsds.com</div>
            </div>
            <div>
              <div class="party-label">Bill To</div>
              <div class="party-name">${order.user_name || order.user_email}</div>
              <div class="party-detail">
                ${order.user_email}<br>
                ${order.user_phone ? order.user_phone + '<br>' : ''}
                ${order.shipping_address}<br>
                ${order.shipping_city}, ${order.shipping_state} ${order.shipping_zip}
              </div>
            </div>
          </div>
          <table>
            <thead><tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
          <div class="totals">
            <div class="totals-box">
              <div class="totals-row"><span>Subtotal</span><span>$${parseFloat(order.subtotal).toFixed(2)}</span></div>
              <div class="totals-row"><span>Shipping</span><span>${parseFloat(order.shipping_cost) === 0 ? 'FREE' : '$' + parseFloat(order.shipping_cost).toFixed(2)}</span></div>
              <div class="totals-total"><span>Total Due</span><span>$${parseFloat(order.total).toFixed(2)}</span></div>
            </div>
          </div>
        </div>
        <div class="footer">
          <div class="footer-note">Payment due within 30 days of invoice date · Order #${order.id}</div>
          <button class="print-btn" onclick="window.print()">⬇ Save as PDF</button>
        </div>
      </div>
    </body></html>`;
    res.send(html);
  } catch(e) { console.error(e.message); res.status(500).send('Something went wrong'); }
});

app.patch('/api/invoices/:orderId/pay', authenticate, authorize('admin'), async (req, res) => {
  try {
    const inv = await one('SELECT * FROM invoices WHERE order_id=$1', [req.params.orderId]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    await q('UPDATE invoices SET payment_status=$1, paid_at=NOW() WHERE order_id=$2', ['paid', req.params.orderId]);
    await q('UPDATE orders SET payment_status=$1 WHERE id=$2', ['paid', req.params.orderId]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/invoices', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const invoices = role === 'admin'
      ? await all('SELECT i.*, o.total, o.user_id, u.name as user_name, u.email as user_email FROM invoices i JOIN orders o ON o.id=i.order_id JOIN users u ON u.id=o.user_id ORDER BY i.created_at DESC')
      : await all('SELECT i.*, o.total FROM invoices i JOIN orders o ON o.id=i.order_id WHERE o.user_id=$1 ORDER BY i.created_at DESC', [userId]);
    res.json(invoices);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── PREORDERS ─────────────────────────────────────────────────────────────────
app.post('/api/preorders', authenticate, async (req, res) => {
  try {
    const { product_id } = req.body;
    const product = await one('SELECT * FROM products WHERE id=$1 AND active=2', [product_id]);
    if (!product) return res.status(404).json({ error: 'Product not found or not coming soon' });
    await q(
      'INSERT INTO preorders (user_id,product_id) VALUES ($1,$2) ON CONFLICT (user_id,product_id) DO NOTHING',
      [req.user.id, product_id]
    );
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.delete('/api/preorders/:productId', authenticate, async (req, res) => {
  try {
    await q('DELETE FROM preorders WHERE user_id=$1 AND product_id=$2', [req.user.id, req.params.productId]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── CART ──────────────────────────────────────────────────────────────────────
async function getOrCreateCart(userId, storeId = null) {
  let cart = storeId
    ? await one('SELECT * FROM carts WHERE user_id=$1 AND store_id=$2', [userId, storeId])
    : await one('SELECT * FROM carts WHERE user_id=$1 AND store_id IS NULL', [userId]);
  if (!cart) {
    cart = await one('INSERT INTO carts (user_id,store_id) VALUES ($1,$2) RETURNING *', [userId, storeId]);
  }
  return cart;
}

async function getCartWithItems(cartId) {
  const cart = await one('SELECT * FROM carts WHERE id=$1', [cartId]);
  if (!cart) return null;
  const items = await all(
    'SELECT ci.*,p.name,p.image_url,p.sku,p.stock FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1',
    [cartId]
  );
  const total = items.reduce((a,i)=>a+parseFloat(i.price_at_add)*i.quantity,0);
  return { ...cart, items, total };
}

app.get('/api/cart', authenticate, async (req, res) => {
  try {
    const storeId = req.query.store_id ? parseInt(req.query.store_id) : null;
    const cart = await getOrCreateCart(req.user.id, storeId);
    res.json(await getCartWithItems(cart.id));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/cart/add', authenticate, async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { product_id, quantity=1, store_id=null } = req.body;
    const product = await one('SELECT * FROM products WHERE id=$1 AND active=1', [product_id]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const price = await getPriceForUser(product_id, userId, role);
    if (!price) return res.status(400).json({ error: 'No price set for your account' });
    const qty = Math.max(1, Math.min(product.stock, Math.floor(parseInt(quantity)||1)));
    if (product.stock < 1) return res.status(400).json({ error: 'Product is out of stock' });
    const cart = await getOrCreateCart(userId, store_id);
    const existing = await one('SELECT * FROM cart_items WHERE cart_id=$1 AND product_id=$2', [cart.id, product_id]);
    if (existing) {
      const newQty = Math.min(product.stock, existing.quantity+qty);
      await q('UPDATE cart_items SET quantity=$1 WHERE id=$2', [newQty, existing.id]);
    } else {
      await q('INSERT INTO cart_items (cart_id,product_id,quantity,price_at_add) VALUES ($1,$2,$3,$4)', [cart.id, product_id, qty, price]);
    }
    res.json(await getCartWithItems(cart.id));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/cart/item/:id', authenticate, async (req, res) => {
  try {
    const { quantity } = req.body;
    const item = await one('SELECT ci.*,c.user_id FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=$1', [req.params.id]);
    if (!item || item.user_id !== req.user.id) return res.status(404).json({ error: 'Item not found' });
    if (quantity <= 0) { await q('DELETE FROM cart_items WHERE id=$1', [req.params.id]); }
    else { await q('UPDATE cart_items SET quantity=$1 WHERE id=$2', [quantity, req.params.id]); }
    res.json(await getCartWithItems(item.cart_id));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.delete('/api/cart/item/:id', authenticate, async (req, res) => {
  try {
    const item = await one('SELECT ci.*,c.user_id FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE ci.id=$1', [req.params.id]);
    if (!item || item.user_id !== req.user.id) return res.status(404).json({ error: 'Item not found' });
    await q('DELETE FROM cart_items WHERE id=$1', [req.params.id]);
    res.json(await getCartWithItems(item.cart_id));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.delete('/api/cart', authenticate, async (req, res) => {
  try {
    const storeId = req.query.store_id ? parseInt(req.query.store_id) : null;
    const cart = storeId
      ? await one('SELECT * FROM carts WHERE user_id=$1 AND store_id=$2', [req.user.id, storeId])
      : await one('SELECT * FROM carts WHERE user_id=$1 AND store_id IS NULL', [req.user.id]);
    if (cart) await q('DELETE FROM cart_items WHERE cart_id=$1', [cart.id]);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── ORDERS ────────────────────────────────────────────────────────────────────
app.post('/api/orders', authenticate, async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const { store_id, payment_method, shipping_name, shipping_address, shipping_city, shipping_state, shipping_zip, notes } = req.body;
    if (!payment_method) return res.status(400).json({ error: 'Payment method required' });
    if (!shipping_address || !shipping_city || !shipping_state || !shipping_zip) return res.status(400).json({ error: 'Complete shipping address required' });

    // Server-side enforcement: only users explicitly granted invoice access can pay this way
    if (payment_method === 'invoice') {
      const buyerCheck = await one('SELECT can_pay_invoice FROM users WHERE id=$1', [userId]);
      if (!buyerCheck?.can_pay_invoice) {
        return res.status(403).json({ error: 'Invoice payment is not enabled for your account. Please pay by card.' });
      }
    }

    const cart = store_id
      ? await one('SELECT * FROM carts WHERE user_id=$1 AND store_id=$2', [userId, store_id])
      : await one('SELECT * FROM carts WHERE user_id=$1 AND store_id IS NULL', [userId]);
    if (!cart) return res.status(400).json({ error: 'Cart not found' });

    const items = await all('SELECT ci.*,p.name,p.stock,p.free_shipping,p.box_type FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1', [cart.id]);
    if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
    for (const item of items) {
      if (item.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${item.name}` });
    }

    // ── New-model order rules ──────────────────────────────────────────────
    // A "master box" is any product tagged with a box_type; cart quantity = number of boxes.
    const boxItems    = items.filter(i => i.box_type);
    const totalBoxes  = boxItems.reduce((a,i) => a + i.quantity, 0);
    const typesInCart = new Set(boxItems.map(i => i.box_type));
    const isRep       = role === 'dsd';
    const priorOrders = (await one("SELECT COUNT(*)::int AS c FROM orders WHERE user_id=$1 AND status<>'cancelled'", [userId]))?.c || 0;
    const isFirstOrder = priorOrders === 0;

    if (isRep) {
      // Minimum purchase: at least one master box.
      if (totalBoxes < 1) {
        return res.status(400).json({ error: 'Your order must include at least one master box (shots, blister card, or gummies).' });
      }
    }
    if (isRep && isFirstOrder) {
      // Onboarding: the first order must be one master box of each type, 3 boxes minimum.
      const missing = BOX_TYPES.filter(t => !typesInCart.has(t));
      if (missing.length > 0 || totalBoxes < 3) {
        return res.status(400).json({ error: 'Your first order must include one master box of each type — shots, blister card, and gummies (3 boxes minimum). After that you can order freely.' });
      }
    }

    const subtotal = items.reduce((a,i)=>a+parseFloat(i.price_at_add)*i.quantity,0);
    const allFreeShipping = items.every(i => i.free_shipping);
    // Free shipping: a rep's first order, any order of 3+ master boxes, or all items flagged free.
    const shipping_cost = (allFreeShipping || totalBoxes >= 3 || (isRep && isFirstOrder)) ? 0 : 35;
    // Stripe fee passthrough: customer pays fee so we receive full amount
    // Formula: (subtotal + shipping + $0.30) / (1 - 0.029) - subtotal - shipping
    const processing_fee = payment_method === 'card'
      ? Math.round(((subtotal + shipping_cost + 0.30) / 0.971 - subtotal - shipping_cost) * 100) / 100
      : 0;
    const total = Math.round((subtotal + shipping_cost + processing_fee) * 100) / 100;
    const payment_status = payment_method === 'card' ? 'paid' : 'unpaid';

    const client = await pool.connect();
    let order;
    try {
      await client.query('BEGIN');
      const or = await client.query(
        `INSERT INTO orders (user_id,store_id,payment_method,payment_status,subtotal,shipping_cost,processing_fee,total,shipping_name,shipping_address,shipping_city,shipping_state,shipping_zip,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [userId, store_id||null, payment_method, payment_status, subtotal, shipping_cost, processing_fee, total,
         shipping_name||'', shipping_address, shipping_city, shipping_state, shipping_zip, notes||'']
      );
      order = or.rows[0];
      for (const item of items) {
        await client.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5)',
          [order.id, item.product_id, item.quantity, item.price_at_add, parseFloat(item.price_at_add)*item.quantity]);
        await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [item.quantity, item.product_id]);
      }
      await client.query('DELETE FROM cart_items WHERE cart_id=$1', [cart.id]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    await logActivity('placed_order', `Order #${order.id}`, req.user.email);

    // Calculate and save commissions for upline reps
    // Members don't earn or trigger commissions
    if (req.user.role !== 'member') {
      await calculateAndSaveCommissions(order.id, req.user.id, parseFloat(order.total));
    }

    // Auto-generate invoice
    const invoice = await createInvoiceForOrder(order.id);

    // Push notification to admins
    sendPushToAdmins(
      '🛒 New Order Received',
      `Order #${order.id} — $${parseFloat(order.total).toFixed(2)} from ${req.user.email}`,
      '/dashboard-admin.html'
    );

    // Email notification
    const itemList = items.map(i => `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;">${i.name}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">${i.quantity}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;text-align:right;">$${(parseFloat(i.price_at_add)*i.quantity).toFixed(2)}</td></tr>`).join('');
    await sendNotification(
      `🛒 New Order #${order.id} — $${parseFloat(order.total).toFixed(2)}`,
      `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <div style="background:#2563eb;padding:24px 28px;">
          <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#93c5fd;">ADDY Distribution</p>
          <h1 style="margin:8px 0 0;font-size:22px;color:#ffffff;">New Order Received</h1>
        </div>
        <div style="padding:24px 28px;">
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Order #</td><td style="padding:6px 0;font-weight:700;font-size:13px;">#${order.id}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Placed by</td><td style="padding:6px 0;font-size:13px;">${req.user.email}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Payment</td><td style="padding:6px 0;font-size:13px;">${order.payment_method === 'invoice' ? 'Invoice / Net-30' : 'Credit Card'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Ship to</td><td style="padding:6px 0;font-size:13px;">${order.shipping_address}, ${order.shipping_city}, ${order.shipping_state} ${order.shipping_zip}</td></tr>
          </table>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;">Product</th><th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;">Qty</th><th style="padding:8px 12px;text-align:right;font-size:12px;color:#64748b;">Amount</th></tr></thead>
            <tbody>${itemList}</tbody>
          </table>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Subtotal</td><td style="padding:4px 0;text-align:right;font-size:13px;">$${parseFloat(order.subtotal).toFixed(2)}</td></tr>
            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Shipping</td><td style="padding:4px 0;text-align:right;font-size:13px;">${parseFloat(order.shipping_cost) === 0 ? 'FREE' : '$' + parseFloat(order.shipping_cost).toFixed(2)}</td></tr>
            ${parseFloat(order.processing_fee||0) > 0 ? `<tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Processing Fee (2.9% + $0.30)</td><td style="padding:4px 0;text-align:right;font-size:13px;">$${parseFloat(order.processing_fee).toFixed(2)}</td></tr>` : ''}
            <tr style="border-top:2px solid #e2e8f0;"><td style="padding:10px 0 0;font-weight:700;font-size:15px;">Total</td><td style="padding:10px 0 0;text-align:right;font-weight:700;font-size:15px;color:#2563eb;">$${parseFloat(order.total).toFixed(2)}</td></tr>
          </table>
        </div>
        <div style="background:#f8fafc;padding:16px 28px;text-align:center;font-size:12px;color:#94a3b8;">Log in to your admin dashboard to manage this order.</div>
      </div>`
    );

    res.status(201).json({ ...order, invoice_number: invoice?.invoice_number });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/orders', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const orders = role === 'admin'
      ? await all('SELECT o.*,u.name as user_name,u.email as user_email,s.name as store_name FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN stores s ON s.id=o.store_id ORDER BY o.created_at DESC')
      : await all('SELECT o.*,s.name as store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id WHERE o.user_id=$1 ORDER BY o.created_at DESC', [userId]);
    const result = await Promise.all(orders.map(async o => {
      const items = await all('SELECT oi.*,COALESCE(p.name,\'[Deleted Product]\') as name FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1', [o.id]);
      const invoice = await one('SELECT invoice_number, payment_status as invoice_status, due_date, paid_at FROM invoices WHERE order_id=$1', [o.id]);
      return { ...o, items, invoice };
    }));
    res.json(result);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/orders/:id/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['pending','processing','shipped','delivered','cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const order = await one('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const buyer = await one('SELECT email, name FROM users WHERE id=$1', [order.user_id]);
    await q('UPDATE orders SET status=$1 WHERE id=$2', [status, req.params.id]);

    if (status === 'cancelled') {
      await q("UPDATE invoices SET payment_status='cancelled' WHERE order_id=$1", [req.params.id]);
      await q("UPDATE orders SET payment_status='cancelled' WHERE id=$1", [req.params.id]);
      // Reverse commissions earned on this order
      const commissions = await all("SELECT earner_id, amount FROM commissions WHERE order_id=$1 AND status='pending'", [req.params.id]);
      for (const c of commissions) {
        // Floor at 0 — never let balance go negative
        await q('UPDATE users SET commission_balance=GREATEST(0, commission_balance-$1) WHERE id=$2', [c.amount, c.earner_id]);
      }
      await q('DELETE FROM commissions WHERE order_id=$1', [req.params.id]);

      // ── Auto-refund via Stripe if this order was paid by card ──────────────────
      if (order.payment_method === 'card' && order.payment_status === 'paid') {
        try {
          const invoice = await one('SELECT stripe_payment_intent_id FROM invoices WHERE order_id=$1', [req.params.id]);
          if (invoice?.stripe_payment_intent_id) {
            await stripe.refunds.create({ payment_intent: invoice.stripe_payment_intent_id });
            await logActivity('refunded_order', `Order #${req.params.id} — $${order.total}`, req.user.email);
            console.log(`✅ Refunded order #${req.params.id} via Stripe`);
          }
        } catch(refundErr) {
          console.error(`❌ Refund failed for order #${req.params.id}:`, refundErr.message);
        }
      }
    }

    if (status === 'delivered' && order.status !== 'delivered' && order.store_id) {
      const items = await all('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
      for (const item of items) {
        await q(
          `INSERT INTO store_inventory (store_id,product_id,quantity,low_stock_threshold)
           VALUES ($1,$2,$3,10) ON CONFLICT (store_id,product_id) DO UPDATE SET quantity=store_inventory.quantity+EXCLUDED.quantity, updated_at=NOW()`,
          [order.store_id, item.product_id, item.quantity]
        );
      }
    }

    // ── Order status email to the DSD/buyer (shipped / delivered / cancelled) ──
    if (resend && buyer?.email && ['shipped','delivered','cancelled'].includes(status)) {
      const statusCopy = {
        shipped: { subject: 'Your order has shipped! 📦', heading: 'On its way!', body: `Your order #${req.params.id} has shipped and is on its way to you.` },
        delivered: { subject: 'Your order was delivered ✅', heading: 'Delivered!', body: `Your order #${req.params.id} has been marked as delivered. We hope you love it!` },
        cancelled: { subject: 'Your order was cancelled', heading: 'Order Cancelled', body: `Your order #${req.params.id} has been cancelled.${order.payment_method === 'card' && order.payment_status === 'paid' ? ' If you paid by card, your refund has been processed and should appear in 5-10 business days.' : ''}` }
      };
      const copy = statusCopy[status];
      try {
        await resend.emails.send({
          from: (process.env.EMAIL_FROM || 'ADDY DSD Portal <notifications@addydsds.com>').replace(/\n/g,' ').trim(),
          to: [buyer.email],
          subject: copy.subject,
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;">
            <div style="background:#1e3a8a;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
              <p style="color:rgba(255,255,255,0.7);font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin:0 0 8px;">ADDY Distribution</p>
              <h1 style="color:#fff;font-size:24px;font-weight:800;margin:0;">${copy.heading}</h1>
            </div>
            <p style="font-size:15px;color:#334155;line-height:1.6;">Hi ${buyer.name || 'there'},</p>
            <p style="font-size:15px;color:#334155;line-height:1.6;">${copy.body}</p>
            <p style="font-size:13px;color:#94a3b8;margin-top:28px;">Log in to your dashboard to view full order details.</p>
          </div>`
        });
      } catch(emailErr) { console.log('Status email skipped:', emailErr.message); }
    }

    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── INVENTORY ─────────────────────────────────────────────────────────────────
app.get('/api/inventory/:store_id', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const storeId = parseInt(req.params.store_id);
    if (role === 'dsd') {
      // A DSD can view inventory only for stores they've claimed/been assigned.
      const assigned = await one('SELECT 1 FROM dsd_stores WHERE dsd_id=$1 AND store_id=$2', [userId, storeId]);
      if (!assigned) return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'rep') {
      const rep = await one('SELECT id FROM reps WHERE user_id=$1', [userId]);
      if (!rep) return res.status(403).json({ error: 'Access denied' });
      const assigned = await one('SELECT 1 FROM rep_store_assignments WHERE rep_id=$1 AND store_id=$2', [rep.id, storeId]);
      if (!assigned) return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'member') {
      // Members can only view inventory for their parent DSD's stores.
      const me = await one('SELECT parent_id FROM users WHERE id=$1', [userId]);
      const ok = me?.parent_id && await one('SELECT 1 FROM dsd_stores WHERE dsd_id=$1 AND store_id=$2', [me.parent_id, storeId]);
      if (!ok) return res.status(403).json({ error: 'Access denied' });
    }
    const store = await one('SELECT * FROM stores WHERE id=$1', [storeId]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const inventory = await all(
      'SELECT si.*,p.name as product_name,p.sku,p.image_url FROM store_inventory si JOIN products p ON p.id=si.product_id WHERE si.store_id=$1 ORDER BY si.quantity ASC',
      [storeId]
    );
    res.json({ store, inventory });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/inventory', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    let storeIds = [];
    if (role === 'dsd') {
      const user = await one('SELECT store_id FROM users WHERE id=$1', [userId]);
      if (user.store_id) storeIds = [user.store_id];
    } else if (role === 'dsd') {
      storeIds = (await all('SELECT store_id FROM dsd_stores WHERE dsd_id=$1', [userId])).map(r=>r.store_id);
    } else if (role === 'rep') {
      const rep = await one('SELECT id FROM reps WHERE user_id=$1', [userId]);
      if (rep) storeIds = (await all('SELECT store_id FROM rep_store_assignments WHERE rep_id=$1', [rep.id])).map(r=>r.store_id);
    } else if (role === 'admin') {
      storeIds = (await all('SELECT id FROM stores')).map(r=>r.id);
    }
    if (!storeIds.length) return res.json([]);
    const placeholders = storeIds.map((_,i)=>`$${i+1}`).join(',');
    res.json(await all(
      `SELECT s.id as store_id,s.name as store_name,s.city,s.state,
              p.id as product_id,p.name as product_name,p.sku,p.image_url,
              si.quantity,si.low_stock_threshold,
              CASE WHEN si.quantity<=si.low_stock_threshold THEN 1 ELSE 0 END as is_low
       FROM stores s
       INNER JOIN store_inventory si ON si.store_id=s.id
       INNER JOIN products p ON p.id=si.product_id
       WHERE s.id IN (${placeholders})
       ORDER BY is_low DESC, si.quantity ASC, s.name`,
      storeIds
    ));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/inventory/:store_id/:product_id', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const { quantity, low_stock_threshold } = req.body;
    const storeId = parseInt(req.params.store_id);
    if (role === 'dsd') {
      const user = await one('SELECT store_id FROM users WHERE id=$1', [userId]);
      if (user.store_id !== storeId) return res.status(403).json({ error: 'Access denied' });
    } else if (role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    await q(
      `INSERT INTO store_inventory (store_id,product_id,quantity,low_stock_threshold,updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (store_id,product_id) DO UPDATE SET
         quantity=COALESCE($3,store_inventory.quantity),
         low_stock_threshold=COALESCE($4,store_inventory.low_stock_threshold),
         updated_at=NOW()`,
      [storeId, req.params.product_id, quantity??null, low_stock_threshold??null]
    );
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});


// ── ACTIVITY LOG ──────────────────────────────────────────────────────────────
app.get('/api/activity-log', authenticate, authorize('admin'), async (req, res) => {
  try {
    const logs = await all('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200');
    res.json(logs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXPORT ORDERS / COMMISSIONS AS CSV ───────────────────────────────────────
app.get('/api/export/orders-csv', authenticate, authorize('admin'), async (req, res) => {
  try {
    const orders = await all(`
      SELECT o.id, o.created_at, u.name as dsd_name, u.email, o.status, o.payment_method, o.payment_status,
             o.subtotal, o.shipping_cost, o.total
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC
    `);
    const headers = ['Order ID','Date','DSD','Email','Status','Payment Method','Payment Status','Subtotal','Shipping','Total'];
    const rows = orders.map(o => [
      o.id, new Date(o.created_at).toLocaleDateString('en-US'), o.dsd_name||'', o.email||'',
      o.status, o.payment_method, o.payment_status, o.subtotal, o.shipping_cost, o.total
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename=addy-orders.csv');
    res.send([headers.join(','), ...rows].join('\n'));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Export failed' }); }
});

app.get('/api/export/commissions-csv', authenticate, authorize('admin'), async (req, res) => {
  try {
    const commissions = await all(`
      SELECT c.id, c.created_at, c.amount, c.rate, c.level, c.status,
             eu.name as earner_name, eu.email as earner_email,
             bu.name as buyer_name
      FROM commissions c
      LEFT JOIN users eu ON eu.id = c.earner_id
      LEFT JOIN users bu ON bu.id = c.buyer_id
      ORDER BY c.created_at DESC
    `);
    const headers = ['Commission ID','Date','Earner','Earner Email','Buyer','Level','Rate','Amount','Status'];
    const rows = commissions.map(c => [
      c.id, new Date(c.created_at).toLocaleDateString('en-US'), c.earner_name||'', c.earner_email||'',
      c.buyer_name||'', c.level, c.rate, c.amount, c.status
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename=addy-commissions.csv');
    res.send([headers.join(','), ...rows].join('\n'));
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Export failed' }); }
});

// ── ADMIN: VIEW AS (impersonation, read-aware) ───────────────────────────────
app.post('/api/admin/impersonate/:userId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const target = await one('SELECT id,email,role,store_id,name FROM users WHERE id=$1', [req.params.userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(403).json({ error: 'Cannot view as another admin' });
    if (target.status === 'inactive') return res.status(400).json({ error: 'Cannot view as an inactive account' });

    const token = jwt.sign(
      { id: target.id, email: target.email, role: target.role, store_id: target.store_id,
        impersonating: true, admin_id: req.user.id, admin_email: req.user.email },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    await logActivity('admin_view_as', target.name || target.email, req.user.email);
    res.json({ success: true, token, role: target.role, name: target.name || target.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STORE PHOTO UPLOAD ────────────────────────────────────────────────────────
// Upload a store photo (front or display) — base64 compressed image from browser
app.post('/api/stores/:id/photos', authenticate, async (req, res) => {
  try {
    const storeId = parseInt(req.params.id);
    const { photo_type, photo_data } = req.body;

    if (!['front', 'display'].includes(photo_type)) {
      return res.status(400).json({ error: 'photo_type must be "front" or "display"' });
    }
    if (!photo_data || !photo_data.startsWith('data:image/')) {
      return res.status(400).json({ error: 'photo_data must be a valid base64 image' });
    }
    // Size guard: ~2MB base64 limit per photo
    if (photo_data.length > 2_800_000) {
      return res.status(400).json({ error: 'Photo too large. Please use a smaller image.' });
    }

    // Verify this DSD owns the store (or admin)
    const store = await one('SELECT id, exclusive_rep_id, photos_complete FROM stores WHERE id=$1', [storeId]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (req.user.role !== 'admin' && store.exclusive_rep_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this store' });
    }

    // Upsert photo (replace if already uploaded)
    await q(
      `INSERT INTO store_photos (store_id, rep_id, photo_type, photo_data, uploaded_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (store_id, photo_type) DO UPDATE SET photo_data=EXCLUDED.photo_data, uploaded_at=NOW(), rep_id=EXCLUDED.rep_id`,
      [storeId, req.user.id, photo_type, photo_data]
    );

    // Check if both photos are now uploaded — if so, mark photos_complete
    const uploadedCount = await one(
      'SELECT COUNT(*) as cnt FROM store_photos WHERE store_id=$1', [storeId]
    );
    const bothDone = parseInt(uploadedCount.cnt) >= 2;
    if (bothDone) {
      await q('UPDATE stores SET photos_complete=true WHERE id=$1', [storeId]);
    }

    await logActivity('uploaded_store_photo', `${photo_type} photo for store #${storeId}`, req.user.email);
    res.json({ success: true, photo_type, bothComplete: bothDone });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong uploading photo' }); }
});

// Get photo status + actual photos for a store
app.get('/api/stores/:id/photos', authenticate, async (req, res) => {
  try {
    const storeId = parseInt(req.params.id);
    const store = await one('SELECT id, exclusive_rep_id, photos_due_at, photos_complete, claimed_via FROM stores WHERE id=$1', [storeId]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (req.user.role !== 'admin' && store.exclusive_rep_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const photos = await all('SELECT photo_type, uploaded_at FROM store_photos WHERE store_id=$1', [storeId]);
    res.json({
      photos_complete: store.photos_complete,
      photos_due_at: store.photos_due_at,
      claimed_via: store.claimed_via,
      overdue: store.photos_due_at && !store.photos_complete && new Date() > new Date(store.photos_due_at),
      uploaded: photos.map(p => p.photo_type),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DSD: get all stores with pending/overdue photos (for reminder banner)
app.get('/api/my-stores/photos-pending', authenticate, async (req, res) => {
  try {
    const stores = await all(
      `SELECT id, name, photos_due_at, photos_complete, claimed_via,
              (photos_due_at IS NOT NULL AND NOT photos_complete AND photos_due_at < NOW()) as overdue,
              (SELECT array_agg(photo_type) FROM store_photos sp WHERE sp.store_id=stores.id) as uploaded_types
       FROM stores
       WHERE exclusive_rep_id=$1 AND NOT photos_complete AND photos_due_at IS NOT NULL
       ORDER BY photos_due_at ASC`,
      [req.user.id]
    );
    res.json(stores);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin: view all stores with missing/overdue photos
app.get('/api/admin/stores-photos-status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const stores = await all(`
      SELECT s.id, s.name, s.city, s.state, s.photos_due_at, s.photos_complete, s.claimed_via,
             u.name as rep_name, u.email as rep_email,
             (s.photos_due_at IS NOT NULL AND NOT s.photos_complete AND s.photos_due_at < NOW()) as overdue,
             (SELECT array_agg(sp.photo_type) FROM store_photos sp WHERE sp.store_id=s.id) as uploaded_types
      FROM stores s
      LEFT JOIN users u ON u.id=s.exclusive_rep_id
      WHERE s.photos_due_at IS NOT NULL AND NOT s.photos_complete
      ORDER BY s.photos_due_at ASC
    `);
    res.json(stores);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MEMBER (CHILD) ACCOUNT MANAGEMENT ────────────────────────────────────────
// Admin adds a member under a specific DSD parent
app.post('/api/members', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, email, password, phone, parent_id } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!parent_id) return res.status(400).json({ error: 'Parent DSD is required' });

    const parent = await one("SELECT id,name FROM users WHERE id=$1 AND role='dsd'", [parent_id]);
    if (!parent) return res.status(400).json({ error: 'Parent DSD not found' });

    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });

    const hash = require('bcryptjs').hashSync(password, 10);
    const ur = await one(
      "INSERT INTO users (email,password_hash,role,name,phone,status,parent_id) VALUES ($1,$2,'member',$3,$4,'active',$5) RETURNING id",
      [email.toLowerCase(), hash, name, phone||'', parent_id]
    );
    await logActivity('created_member', `${name} under ${parent.name}`, req.user.email);
    res.status(201).json({ success: true, userId: ur.id });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// List members under a specific DSD parent
app.get('/api/members', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { parent_id } = req.query;
    const where = parent_id ? 'WHERE u.parent_id=$1' : "WHERE u.role='member'";
    const params = parent_id ? [parent_id] : [];
    const members = await all(
      `SELECT u.id,u.name,u.email,u.phone,u.status,u.parent_id,
              p.name as parent_name, p.email as parent_email
       FROM users u LEFT JOIN users p ON p.id=u.parent_id
       ${where} ORDER BY p.name,u.name`,
      params
    );
    res.json(members);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BULK CSV STORE IMPORT ─────────────────────────────────────────────────────
app.post('/api/stores/bulk-import', authenticate, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });
    if (rows.length > 500) return res.status(400).json({ error: 'Maximum 500 rows per import. Please split your file.' });

    const { role, id: userId } = req.user;

    // A DSD importing stores claims them: auto-approved and linked if unclaimed (or already
    // theirs); flagged for admin review if another rep already owns the store.
    // admin / member imports create shared-directory stores with no per-user claim.
    async function claimImported(storeId) {
      if (role !== 'dsd') return { linked: false, flagged: false };
      const st = await one('SELECT exclusive_rep_id FROM stores WHERE id=$1', [storeId]);
      if (st && st.exclusive_rep_id && st.exclusive_rep_id !== userId) {
        await flagStoreClaimConflict(storeId, userId, st.exclusive_rep_id, 'Claim conflict via CSV import');
        return { linked: false, flagged: true };
      }
      await q("UPDATE stores SET exclusive_rep_id=$1, store_approval_status='approved' WHERE id=$2", [userId, storeId]);
      await q('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, storeId]);
      await q('INSERT INTO dsd_stores (dsd_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, storeId]);
      return { linked: true, flagged: false };
    }

    // Photo deadline: >25 stores in one batch gets 60 days, otherwise 24 hours
    const isBulkBatch = rows.length > 25;
    const photoDeadline = isBulkBatch
      ? new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)   // 60 days
      : new Date(Date.now() + 24 * 60 * 60 * 1000);         // 24 hours
    const claimedVia = isBulkBatch ? 'csv_bulk' : 'csv_small';

    let created = 0, skipped = 0, errors = 0;
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const name = (row.name || '').trim();
      if (!name) {
        errors++;
        results.push({ row: rowNum, status: 'error', reason: 'Store name is required' });
        continue;
      }

      // Warn about missing address fields (flagged, not hard-blocked)
      const missingFields = ['address','city','state','zip'].filter(f => !(row[f]||'').trim());
      const warning = missingFields.length > 0 ? ` (missing: ${missingFields.join(', ')})` : '';

      try {
        const exists = await one('SELECT id FROM stores WHERE LOWER(name)=LOWER($1)', [name]);
        if (exists) {
          // Store already exists — claim it to this importer, or flag a conflict.
          const r = await claimImported(exists.id);
          skipped++;
          results.push({
            row: rowNum,
            status: r.flagged ? 'flagged' : 'skipped',
            reason: r.flagged
              ? `"${name}" is already claimed by another rep — flagged for admin review`
              : `"${name}" already exists${r.linked ? ' — claimed to you' : ''}`
          });
          continue;
        }

        const inserted = await one(
          `INSERT INTO stores (name,owner_name,email,address,city,state,zip,phone,store_number,category,status,monthly_revenue,wholesale_price,retail_price,distribution_cost,photos_due_at,photos_complete,claimed_via)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,0,0,$12,false,$13) RETURNING id`,
          [name, (row.owner_name||'').trim(), (row.email||'').trim(),
           (row.address||'').trim(), (row.city||'').trim(), (row.state||'').trim(),
           (row.zip||'').trim(), (row.phone||'').trim(), (row.store_number||'').trim(),
           (row.category||'General').trim(), (row.status||'active').trim(),
           photoDeadline, claimedVia]
        );
        await claimImported(inserted.id);
        created++;
        results.push({ row: rowNum, status: 'created', note: warning || undefined });
      } catch(rowErr) {
        errors++;
        results.push({ row: rowNum, status: 'error', reason: rowErr.message });
      }
    }

    await logActivity('bulk_imported_stores', `${created} created, ${skipped} skipped, ${errors} errors (${claimedVia})`, req.user.email);
    res.json({ created, skipped, errors, results, isBulkBatch, photoDeadlineDays: isBulkBatch ? 60 : 1 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXAMPLE CSV DOWNLOAD ───────────────────────────────────────────────────────
app.get('/api/stores/example-csv', authenticate, (req, res) => {
  const csv = [
    'name,owner_name,email,address,city,state,zip,phone,store_number,category',
    '"Corner Market",John Smith,john@example.com,"123 Main St",Miami,FL,33101,(305) 555-0100,ST-001,Convenience',
    '"Green Leaf Deli",Jane Doe,jane@example.com,"456 Oak Ave",Dallas,TX,75001,214.555.0200,,Grocery',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=stores-import-example.csv');
  res.send(csv);
});

// ── DATABASE SIZE ─────────────────────────────────────────────────────────────
app.get('/api/admin/db-size', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await one(`
      SELECT pg_size_pretty(pg_database_size(current_database())) as total_size,
             pg_database_size(current_database()) as total_bytes
    `);
    const tableSizes = await all(`
      SELECT relname as table_name,
             pg_size_pretty(pg_total_relation_size(relid)) as size,
             pg_total_relation_size(relid) as bytes
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 8
    `);
    res.json({ total_size: result.total_size, total_bytes: result.total_bytes, top_tables: tableSizes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FEEDBACK / FEATURE REQUESTS ───────────────────────────────────────────────
app.post('/api/feedback', authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Please enter a message' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters)' });
    await q('INSERT INTO feedback (user_id, message) VALUES ($1,$2)', [req.user.id, message.trim()]);
    await logActivity('submitted_feedback', req.user.name || req.user.email, req.user.email);
    res.json({ success: true, message: 'Thanks! Your feedback has been submitted.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/feedback', authenticate, authorize('admin'), async (req, res) => {
  try {
    const items = await all(`
      SELECT f.id, f.message, f.status, f.created_at, u.name, u.email
      FROM feedback f LEFT JOIN users u ON u.id = f.user_id
      ORDER BY f.created_at DESC
    `);
    res.json(items);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/feedback/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['new','reviewed','planned','done','declined'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await q('UPDATE feedback SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/feedback/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await q('DELETE FROM feedback WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SEARCH WOWCOW STORES (for ADDY claim modal) ─────────────────────────────
app.get('/api/wowcow-stores/search', authenticate, async (req, res) => {
  // Searches BOTH the WowCow network (public.stores) AND ADDY's own stores table,
  // so reps see existing claims and can request ownership instead of creating duplicates.
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    // ADDY's own stores. Non-admins only see unclaimed stores or ones they already own —
    // never a store another rep has claimed (and exclusive_rep_id is not exposed).
    const isAdmin = req.user.role === 'admin';
    const ownStores = await all(
      `SELECT id, name, address, city, state, zip, category,
              (exclusive_rep_id IS NOT NULL) as already_claimed,
              (exclusive_rep_id = $2) as mine
       FROM stores
       WHERE (LOWER(name) LIKE LOWER($1) OR LOWER(city) LIKE LOWER($1))
         ${isAdmin ? '' : 'AND (exclusive_rep_id IS NULL OR exclusive_rep_id = $2)'}
       LIMIT 10`,
      [`%${q}%`, req.user.id]
    );

    // WowCow network stores not yet in ADDY at all
    const wcStores = await all(
      "SELECT id, name, address, city, state, zip, category FROM public.stores WHERE LOWER(name) LIKE LOWER($1) OR LOWER(city) LIKE LOWER($1) LIMIT 10",
      [`%${q}%`]
    );

    const ownNames = new Set(ownStores.map(s => s.name.toLowerCase() + '|' + (s.city||'').toLowerCase()));
    const merged = [
      ...ownStores.map(s => ({ ...s, source: 'addy' })),
      ...wcStores.filter(s => !ownNames.has(s.name.toLowerCase() + '|' + (s.city||'').toLowerCase()))
                 .map(s => ({ ...s, source: 'wowcow', already_claimed: false }))
    ];

    res.json(merged.slice(0, 10));
  } catch(e) { res.json([]); }
});

// When store claim approved, sync back to public.stores so WowCow can see it
app.patch('/api/stores/:id/approve-claim', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { approved } = req.body;
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    await q('UPDATE stores SET store_approval_status=$1 WHERE id=$2', [approved ? 'approved' : 'rejected', req.params.id]);
    if (approved) {
      // Auto-sync approved store to WowCow's public.stores
      try {
        const exists = await one("SELECT id FROM public.stores WHERE LOWER(name)=LOWER($1)", [store.name]);
        if (!exists) {
          await q("INSERT INTO public.stores (name,owner_name,email,address,city,state,zip,category,status,monthly_revenue,wholesale_price,retail_price,distribution_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',0,0,0,0)",
            [store.name, store.name, store.email||'', store.address||'', store.city||'', store.state||'', store.zip||'', store.category||'General']);
          console.log('✅ Store synced to WowCow:', store.name);
        }
      } catch(syncErr) { console.log('Store sync to WowCow skipped:', syncErr.message); }
    }
    await logActivity(approved ? 'approved_store_claim' : 'rejected_store_claim', store.name, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Map data endpoint — returns all approved stores with geocodable addresses

// ── IMPORT PRODUCTS FROM WOWCOW ──────────────────────────────────────────────
app.post('/api/products/import-from-wowcow', authenticate, authorize('admin'), async (req, res) => {
  try {
    // Read from WowCow's public schema directly
    const wowcowProducts = await all(
      "SELECT id, name, description, image_url, sku FROM public.products WHERE active=1 ORDER BY name"
    );

    if (!wowcowProducts.length) {
      return res.json({ success: true, imported: 0, skipped: 0, message: 'No active products found on WowCow' });
    }

    let imported = 0, skipped = 0, priceMatched = 0, backfilled = 0;
    for (const p of wowcowProducts) {
      // Pull WowCow's store_owner base price (role='store_owner', user_id IS NULL) and back-calculate MSRP.
      // WowCow's store_owner price = 50% of MSRP, so MSRP = store_owner_price × 2.
      // ADDY's retail_price IS the MSRP — it drives Tier 1/2/3 pricing (65%/70%/75%).
      let retailPrice = 0;
      try {
        const wcPrice = await one(
          "SELECT price FROM public.product_prices WHERE product_id=$1 AND role='store_owner' AND user_id IS NULL",
          [p.id]
        );
        if (wcPrice) retailPrice = Math.round(parseFloat(wcPrice.price) * 2 * 100) / 100;
      } catch(e) { console.log('Price lookup skipped for', p.name, e.message); }

      // Check if already imported (match by SKU or name)
      const existing = await one(
        'SELECT id, retail_price FROM products WHERE sku=$1 OR LOWER(name)=LOWER($2)',
        [p.sku || '', p.name]
      );

      if (existing) {
        // Already imported — backfill price if it currently has none and WowCow now has one
        if (parseFloat(existing.retail_price || 0) === 0 && retailPrice > 0) {
          await q('UPDATE products SET retail_price=$1 WHERE id=$2', [retailPrice, existing.id]);
          backfilled++;
        }
        skipped++;
        continue;
      }

      // New product — import as INACTIVE so admin can review before DSDs see it
      await q(
        'INSERT INTO products (name,description,image_url,sku,stock,cost_price,retail_price,active) VALUES ($1,$2,$3,$4,0,0,$5,0)',
        [p.name, p.description || '', p.image_url || '', p.sku || '', retailPrice]
      );
      imported++;
      if (retailPrice > 0) priceMatched++;
    }

    await logActivity('imported_products', `${imported} new, ${backfilled} price-backfilled from WowCow`, req.user.email);
    res.json({
      success: true, imported, skipped, priceMatched, backfilled,
      message: `Imported ${imported} new product${imported !== 1 ? 's' : ''}${backfilled > 0 ? `, backfilled pricing on ${backfilled} existing product${backfilled !== 1 ? 's' : ''}` : ''}. Review and activate to make available to DSDs.`
    });
  } catch(e) {
    console.error('Import error:', e.message);
    res.status(500).json({ error: 'Import failed: ' + e.message });
  }
});

// ── ADMIN: RECALCULATE COMMISSIONS FOR AN ORDER ──────────────────────────────
// Safety tool in case something went wrong — deletes and recalculates
app.post('/api/commissions/recalculate/:orderId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const order = await one('SELECT id, user_id, total, status FROM orders WHERE id=$1', [req.params.orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'cancelled') return res.status(400).json({ error: 'Cannot recalculate on cancelled order' });

    // Reverse existing commissions first
    const existing = await all('SELECT earner_id, amount FROM commissions WHERE order_id=$1', [order.id]);
    for (const c of existing) {
      await q('UPDATE users SET commission_balance=GREATEST(0,commission_balance-$1) WHERE id=$2', [c.amount, c.earner_id]);
    }
    await q('DELETE FROM commissions WHERE order_id=$1', [order.id]);

    // Recalculate fresh
    const orderBuyer = await one('SELECT role FROM users WHERE id=$1', [order.user_id]);
    if (orderBuyer?.role !== 'member') {
      await calculateAndSaveCommissions(order.id, order.user_id, parseFloat(order.total));
    }

    const newCommissions = await all('SELECT * FROM commissions WHERE order_id=$1', [order.id]);
    res.json({ success: true, commissions: newCommissions, message: `Recalculated ${newCommissions.length} commission(s)` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MANUAL BACKUP TRIGGER ────────────────────────────────────────────────────
app.post('/api/admin/backup-now', authenticate, authorize('admin'), async (req, res) => {
  res.json({ success: true, message: 'Backup started — check server logs' });
  const { runBackup } = require('./backup_module');
  runBackup(pool, 'addy', 'addy').catch(console.error);
});

// ── ADDY DSD TIER & COMMISSION ENDPOINTS ──────────────────────────────────────

// Update DSD rep tier (admin only)
app.patch('/api/users/:id/tier', authenticate, authorize('admin'), async (req, res) => {
  try {
    // New model: sets a locked discount % override. Empty/null clears it so the
    // user falls back to the automatic earn-up rate (20 → 25 → 30%).
    const { discount } = req.body;
    let val = null;
    if (discount !== null && discount !== undefined && discount !== '') {
      val = parseFloat(discount);
      if (!(val >= 0 && val <= 90)) return res.status(400).json({ error: 'Margin must be between 0 and 90%.' });
    }
    const user = await one('SELECT name, email FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await q('UPDATE users SET locked_discount_pct=$1 WHERE id=$2', [val, req.params.id]);
    await logActivity('changed_discount', `${user.name || user.email} → ${val == null ? 'auto (earn-up)' : val + '%'}`, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get DSD's commission history
app.get('/api/commissions', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const rows = isAdmin
      ? await all('SELECT c.*,u.name as earner_name,u.email as earner_email,b.name as buyer_name FROM commissions c JOIN users u ON u.id=c.earner_id LEFT JOIN users b ON b.id=c.buyer_id ORDER BY c.created_at DESC LIMIT 200')
      : await all('SELECT c.*,b.name as buyer_name FROM commissions c LEFT JOIN users b ON b.id=c.buyer_id WHERE c.earner_id=$1 ORDER BY c.created_at DESC', [req.user.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Request a payout
app.post('/api/payouts/request', authenticate, authorize('dsd'), async (req, res) => {
  try {
    // Use a transaction to prevent race conditions on double-submit
    const client = await pool.connect();
    let pr, balance;
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT commission_balance, name, email FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      const userData = user.rows[0];
      balance = parseFloat(userData?.commission_balance || 0);
      if (balance <= 0) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ error: 'No commission balance available' }); }
      const existing = await client.query("SELECT id FROM payout_requests WHERE user_id=$1 AND status='pending'", [req.user.id]);
      if (existing.rows.length) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ error: 'You already have a pending payout request' }); }
      const prResult = await client.query('INSERT INTO payout_requests (user_id, amount) VALUES ($1,$2) RETURNING id', [req.user.id, balance]);
      pr = prResult.rows[0];
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); client.release(); throw e; }
    finally { client.release(); }
    await logActivity('payout_requested', `$${balance.toFixed(2)} by ${user.name || user.email}`, user.email);
    res.json({ success: true, id: pr.id, amount: balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get payout requests (admin sees all, DSD sees own)
app.get('/api/payouts', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const rows = isAdmin
      ? await all('SELECT pr.*,u.name,u.email,u.stripe_connect_id FROM payout_requests pr JOIN users u ON u.id=pr.user_id ORDER BY pr.created_at DESC')
      : await all('SELECT * FROM payout_requests WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin approve + pay payout request
app.patch('/api/payouts/:id/approve', authenticate, authorize('admin'), async (req, res) => {
  try {
    const pr = await one('SELECT pr.*,u.stripe_connect_id,u.name,u.email FROM payout_requests pr JOIN users u ON u.id=pr.user_id WHERE pr.id=$1', [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Payout request not found' });
    if (pr.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });

    let stripeTransferId = null;
    // Attempt Stripe transfer if rep has connected Stripe account
    if (pr.stripe_connect_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const transfer = await stripe.transfers.create({
          amount: Math.round(parseFloat(pr.amount) * 100),
          currency: 'usd',
          destination: pr.stripe_connect_id,
          description: `ADDY DSD Commission Payout - ${pr.name || pr.email}`,
        });
        stripeTransferId = transfer.id;
      } catch(stripeErr) {
        console.error('Stripe transfer failed:', stripeErr.message);
        return res.status(500).json({ error: 'Stripe transfer failed: ' + stripeErr.message });
      }
    }

    await q('UPDATE payout_requests SET status=$1,stripe_transfer_id=$2,processed_at=NOW() WHERE id=$3',
      [stripeTransferId ? 'paid' : 'approved', stripeTransferId, pr.id]);
    // Deduct from commission balance
    await q('UPDATE users SET commission_balance=commission_balance-$1 WHERE id=$2', [pr.amount, pr.user_id]);
    // Mark related commissions as paid
    await q("UPDATE commissions SET status='paid' WHERE earner_id=$1 AND status='pending'", [pr.user_id]);
    await logActivity('payout_approved', `$${parseFloat(pr.amount).toFixed(2)} to ${pr.name || pr.email}`, req.user.email);
    res.json({ success: true, stripe_transfer_id: stripeTransferId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin reject payout
app.patch('/api/payouts/:id/reject', authenticate, authorize('admin'), async (req, res) => {
  try {
    const pr = await one('SELECT * FROM payout_requests WHERE id=$1', [req.params.id]);
    if (!pr || pr.status !== 'pending') return res.status(400).json({ error: 'Cannot reject this request' });
    await q("UPDATE payout_requests SET status='rejected',admin_note=$1,processed_at=NOW() WHERE id=$2", [req.body.note||'', req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DSD submits a store for exclusivity approval
app.post('/api/stores/claim', authenticate, authorize('dsd'), async (req, res) => {
  try {
    const { name, address, city, state, zip, phone, email, category, store_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Store name required' });

    // If a specific store_id was passed (selected from network search), use that record directly
    let existing = store_id
      ? await one('SELECT id,exclusive_rep_id,store_approval_status FROM stores WHERE id=$1', [store_id])
      : await one('SELECT id,exclusive_rep_id,store_approval_status FROM stores WHERE LOWER(name)=LOWER($1) AND LOWER(city)=LOWER($2)', [name, city||'']);

    if (existing) {
      // Store already exists in the network
      if (existing.exclusive_rep_id && existing.exclusive_rep_id !== req.user.id) {
        // Already claimed by SOMEONE ELSE — auto-flag the conflict for admins, don't steal it.
        await flagStoreClaimConflict(existing.id, req.user.id, existing.exclusive_rep_id, `Claim conflict on "${name}"`);
        await logActivity('store_claim_conflict', `${name} — flagged (already claimed)`, req.user.email);
        return res.json({ success: true, flagged: true, id: existing.id, message: 'This store is already claimed by another rep — flagged for admin review.' });
      }
      if (existing.exclusive_rep_id === req.user.id) {
        return res.status(409).json({ error: 'You have already claimed this store.' });
      }
      // Store exists but unclaimed — claim it (auto-approved), set 24h photo deadline
      await claimStoreForDsd(existing.id, req.user.id, 'manual');
      await logActivity('claimed_store', `${name} by rep #${req.user.id}`, req.user.email);
      return res.json({ success: true, id: existing.id, needsPhotos: true, message: 'Store claimed and approved.' });
    }

    // Brand new store — create it (auto-approved to the claimer), set 24h photo deadline
    const store = await one(
      "INSERT INTO stores (name,owner_name,address,city,state,zip,phone,email,store_number,category,store_approval_status,exclusive_rep_id,monthly_revenue,status,photos_complete,claimed_via) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11,0,'active',false,'manual') RETURNING id",
      [name, req.body.owner_name||'N/A', address||'', city||'', state||'', zip||'N/A', phone||'', email||'', req.body.store_number||'', category||'General', req.user.id]
    );
    await claimStoreForDsd(store.id, req.user.id, 'manual');
    await logActivity('claimed_store', `${name} by rep #${req.user.id}`, req.user.email);
    res.json({ success: true, id: store.id, needsPhotos: true, message: 'Store claimed and approved.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Request ownership transfer of an already-claimed store ───────────────────
app.post('/api/stores/:id/request-ownership', authenticate, authorize('dsd'), async (req, res) => {
  try {
    const store = await one('SELECT id, name, exclusive_rep_id FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (!store.exclusive_rep_id) return res.status(400).json({ error: 'This store is not currently claimed — you can claim it directly instead' });
    if (store.exclusive_rep_id === req.user.id) return res.status(400).json({ error: 'You already own this store' });

    const existingReq = await one(
      "SELECT id FROM ownership_requests WHERE store_id=$1 AND requester_id=$2 AND status='pending'",
      [req.params.id, req.user.id]
    );
    if (existingReq) return res.status(409).json({ error: 'You already have a pending request for this store' });

    await q(
      'INSERT INTO ownership_requests (store_id, requester_id, current_owner_id, message) VALUES ($1,$2,$3,$4)',
      [req.params.id, req.user.id, store.exclusive_rep_id, req.body.message || '']
    );
    await logActivity('requested_ownership', `${store.name} requested by rep #${req.user.id}`, req.user.email);
    res.json({ success: true, message: 'Ownership request submitted for admin review' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: list pending ownership requests ────────────────────────────────────
app.get('/api/ownership-requests', authenticate, authorize('admin'), async (req, res) => {
  try {
    const requests = await all(`
      SELECT orq.id, orq.store_id, orq.status, orq.message, orq.created_at,
             s.name as store_name, s.city, s.state,
             ru.name as requester_name, ru.email as requester_email,
             cu.name as current_owner_name, cu.email as current_owner_email
      FROM ownership_requests orq
      JOIN stores s ON s.id = orq.store_id
      JOIN users ru ON ru.id = orq.requester_id
      LEFT JOIN users cu ON cu.id = orq.current_owner_id
      WHERE orq.status='pending'
      ORDER BY orq.created_at DESC
    `);
    res.json(requests);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: approve/reject an ownership request ────────────────────────────────
app.patch('/api/ownership-requests/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { approved } = req.body;
    const request = await one('SELECT * FROM ownership_requests WHERE id=$1', [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    if (approved) {
      await q("UPDATE stores SET exclusive_rep_id=$1, store_approval_status='approved' WHERE id=$2", [request.requester_id, request.store_id]);
      // Move the claim links to the new owner so store lists stay consistent.
      await q('DELETE FROM owner_stores WHERE store_id=$1', [request.store_id]);
      await q('DELETE FROM dsd_stores  WHERE store_id=$1', [request.store_id]);
      await q('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [request.requester_id, request.store_id]);
      await q('INSERT INTO dsd_stores  (dsd_id,   store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [request.requester_id, request.store_id]);
      await q("UPDATE ownership_requests SET status='approved' WHERE id=$1", [req.params.id]);
    } else {
      await q("UPDATE ownership_requests SET status='rejected' WHERE id=$1", [req.params.id]);
    }
    await logActivity(approved ? 'approved_ownership_transfer' : 'rejected_ownership_transfer', `request #${req.params.id}`, req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DSD gets their claimed stores
app.get('/api/my-stores', authenticate, authorize('dsd'), async (req, res) => {
  try {
    const stores = await all(
      'SELECT * FROM stores WHERE exclusive_rep_id=$1 ORDER BY store_approval_status DESC, name',
      [req.user.id]
    );
    res.json(stores);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get pending store claims (admin)



// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
migrate().then(() => {
  
// Start nightly backup scheduler
startBackupScheduler(pool, 'addy', 'addy');

app.listen(PORT, '0.0.0.0', () => console.log(`⚡ ADDY running on port ${PORT}`));
}).catch(err => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});

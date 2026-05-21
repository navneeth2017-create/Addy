const express = require('express');
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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
    await q('ALTER TABLE stores ADD COLUMN IF NOT EXISTS exclusive_rep_id INTEGER REFERENCES users(id)');
    await q("ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_approval_status TEXT NOT NULL DEFAULT 'approved'");
    console.log('✅ ADDY DSD tier/commission migrations applied');
  } catch(e) { console.log('ℹ️  ADDY migrations already up to date:', e.message); }

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

  // ── One-time cleanup: remove all seeded demo stores ──────────────────────────
  const storeCount = await one('SELECT COUNT(*) as c FROM stores');
  const userCount  = await one('SELECT COUNT(*) as c FROM users');
  // If stores exist but no real orders, they are demo stores — wipe them
  const orderCount = await one('SELECT COUNT(*) as c FROM orders');
  if (parseInt(storeCount?.c) > 0 && parseInt(orderCount?.c) === 0) {
    console.log(`🧹 Removing ${storeCount.c} demo stores...`);
    await q('DELETE FROM store_notes');
    await q('DELETE FROM store_inventory');
    await q('DELETE FROM rep_store_assignments');
    await q('DELETE FROM dsd_stores');
    await q('DELETE FROM owner_stores');
    await q('DELETE FROM carts');
    await q('UPDATE users SET store_id=NULL');
    await q('DELETE FROM stores');
    console.log('✅ Demo stores removed');
  }

  // Create production admin account if it doesn't exist
  // ── Demo + Admin accounts ─────────────────────────────────────────────────
  const demoAccounts = [
    { email: 'admin@addy.com',   password: 'addy-admin-2026', role: 'admin', name: 'Admin',    tier: 1 },
    { email: 'demo@addy.com',    password: 'addy-dsd-2026',   role: 'dsd',   name: 'Demo DSD', tier: 1 },
  ];
  for (const acc of demoAccounts) {
    const exists = await one('SELECT id FROM users WHERE email=$1', [acc.email]);
    if (!exists) {
      const hash = bcrypt.hashSync(acc.password, 10);
      await q(
        "INSERT INTO users (email,name,phone,role,password_hash,status,tier) VALUES ($1,$2,'','$3',$4,'active',$5)".replace("'$3'", "'" + acc.role + "'"),
        [acc.email, acc.name, hash, acc.tier]
      );
      console.log('✅ Demo account created: ' + acc.email);
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

// ADDY DSD tier margins: Tier1=35%, Tier2=30%, Tier3=25%
const TIER_MULTIPLIERS = { 1: 0.65, 2: 0.70, 3: 0.75 };

async function getPriceForUser(productId, userId, role) {
  // 1. Check per-user price override (admin can set custom price per DSD)
  const userPrice = await one('SELECT price FROM product_prices WHERE product_id=$1 AND user_id=$2', [productId, userId]);
  if (userPrice) return parseFloat(userPrice.price);
  // 2. Calculate tier-based price from cost_price
  const user = await one('SELECT tier FROM users WHERE id=$1', [userId]);
  const product = await one('SELECT cost_price FROM products WHERE id=$1', [productId]);
  const tier = user?.tier || 1;
  const cost = parseFloat(product?.cost_price || 0);
  if (cost > 0) return Math.round(cost * TIER_MULTIPLIERS[tier] * 100) / 100;
  // 3. Fallback to role-based price
  const rolePrice = await one('SELECT price FROM product_prices WHERE product_id=$1 AND role=$2 AND user_id IS NULL ORDER BY id DESC', [productId, role]);
  return rolePrice ? parseFloat(rolePrice.price) : null;
}

async function calculateAndSaveCommissions(orderId, buyerId, orderTotal) {
  try {
    const buyer = await one('SELECT id, tier, referred_by FROM users WHERE id=$1', [buyerId]);
    if (!buyer || !buyer.referred_by) return;

    const recruiter = await one('SELECT id, tier, referred_by FROM users WHERE id=$1', [buyer.referred_by]);
    if (!recruiter) return;

    // Level 1 commission: direct recruiter earns based on buyer tier
    const level1Rate = buyer.tier === 2 ? 0.05 : buyer.tier === 3 ? 0.05 : 0;
    if (level1Rate > 0) {
      const commission = Math.round(orderTotal * level1Rate * 100) / 100;
      await q('INSERT INTO commissions (earner_id,order_id,buyer_id,amount,rate,level) VALUES ($1,$2,$3,$4,$5,1)',
        [recruiter.id, orderId, buyerId, commission, level1Rate]);
      await q('UPDATE users SET commission_balance=commission_balance+$1 WHERE id=$2', [commission, recruiter.id]);
    }

    // Level 2 commission: recruiter's recruiter earns 3% on Tier 3 sales only
    if (buyer.tier === 3 && recruiter.referred_by) {
      const grandRecruiter = await one('SELECT id FROM users WHERE id=$1', [recruiter.referred_by]);
      if (grandRecruiter) {
        const level2Rate = 0.03;
        const commission2 = Math.round(orderTotal * level2Rate * 100) / 100;
        await q('INSERT INTO commissions (earner_id,order_id,buyer_id,amount,rate,level) VALUES ($1,$2,$3,$4,$5,2)',
          [grandRecruiter.id, orderId, buyerId, commission2, level2Rate]);
        await q('UPDATE users SET commission_balance=commission_balance+$1 WHERE id=$2', [commission2, grandRecruiter.id]);
      }
    }
  } catch(e) { console.error('Commission calculation error:', e.message); }
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
      const roleFileMap = { admin:'admin', investor:'investor', dsd:'owner', dsd:'dsd', rep:'rep' };
      res.sendFile(path.join(__dirname, 'public', `dashboard-${roleFileMap[user.role]}.html`));
    } catch { res.redirect('/login.html'); }
  };
}
app.get('/dashboard-admin.html', serveDashboard(['admin']));
app.get('/dashboard-dsd.html', serveDashboard(['investor']));
app.get('/dashboard-dsd.html', serveDashboard(['dsd']));
app.get('/dashboard-dsd.html', serveDashboard(['dsd']));
app.get('/dashboard-dsd.html', serveDashboard(['rep']));

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
      const recruiter = await one("SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND role='dsd'", [referral_code.trim()]);
      if (recruiter) referredById = recruiter.id;
    }

    const hash = bcrypt.hashSync(password, 10);
    // New DSDs default to Tier 3 — admin promotes them
    await q(
      "INSERT INTO users (email,password_hash,role,name,phone,status,tier,referred_by) VALUES ($1,$2,'dsd',$3,$4,'pending',3,$5)",
      [email.toLowerCase(), hash, name, phone||'', referredById]
    );

    await logActivity('signup_request', `${name} (DSD)`, email.toLowerCase());

    // Email notification
    const roleLabel = role === 'dsd' ? 'DSD' : role === 'dsd' ? 'DSD' : 'DSD';
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
            ${role === 'dsd' ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Store</td><td style="padding:6px 0;font-size:13px;">${store_name || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;font-size:13px;">Location</td><td style="padding:6px 0;font-size:13px;">${city || ''} ${state || ''}</td></tr>` : ''}
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

app.get('/api/me', authenticate, (req, res) => res.json(req.user));

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

    if (role === 'dsd') {
      const stores = await all(
        'SELECT s.* FROM stores s INNER JOIN dsd_stores ds ON ds.store_id=s.id WHERE ds.dsd_id=$1 ORDER BY s.name',
        [userId]
      );
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
      GROUP BY p.name ORDER BY revenue DESC LIMIT 10
    `);
    // Orders over time (last 30 days)
    const ordersOverTime = await all(`
      SELECT DATE(created_at) as date, COUNT(*) as orders, SUM(total) as revenue
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '30 days'
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

app.get('/api/stores/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json(store);
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/stores', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, owner_name, email, address, city, state, zip, category, monthly_revenue, wholesale_price, retail_price, distribution_cost, status } = req.body;
    if (!name || !owner_name || !email) return res.status(400).json({ error: 'Name, owner, and email are required' });
    const result = await one(
      `INSERT INTO stores (name,owner_name,email,address,city,state,zip,category,monthly_revenue,wholesale_price,retail_price,distribution_cost,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [name,owner_name,email,address||'',city||'',state||'',zip||'',category||'General',
       monthly_revenue||0,wholesale_price||0,retail_price||0,distribution_cost||0,status||'active']
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
  try { res.json(await all('SELECT id,email,name,phone,role,status,pricing_tier FROM users ORDER BY role,name')); }
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

// Set per-user product pricing
app.patch('/api/users/:id/pricing', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { product_id, price } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    if (price === null || price === undefined || price === '') {
      // Remove custom price — revert to default
      await q('DELETE FROM product_prices WHERE user_id=$1 AND product_id=$2', [req.params.id, product_id]);
    } else {
      await q(
        "INSERT INTO product_prices (product_id, user_id, role, price) VALUES ($1,$2,'dsd',$3) ON CONFLICT (product_id, user_id, role) DO UPDATE SET price=EXCLUDED.price",
        [product_id, req.params.id, parseFloat(price)]
      );
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// Set/change pricing tier for any user
async function applyPricingTier(userId, tier, customPrices) {
  const products = await all('SELECT id FROM products WHERE active=1');
  for (const p of products) {
    let price = null;
    if (tier === 'custom' && customPrices && customPrices[p.id] !== undefined) {
      price = parseFloat(customPrices[p.id]);
    } else if (tier !== 'custom') {
      const rp = await one('SELECT price FROM product_prices WHERE product_id=$1 AND role=$2 AND user_id IS NULL', [p.id, tier]);
      if (rp) price = parseFloat(rp.price);
    }
    if (price !== null && !isNaN(price)) {
      await q(
        `INSERT INTO product_prices (product_id,user_id,role,price) VALUES ($1,$2,NULL,$3)
         ON CONFLICT (product_id,user_id,role) DO UPDATE SET price=EXCLUDED.price`,
        [p.id, userId, price]
      );
    }
  }
  // Persist the tier name on the user so it can be displayed in the admin UI
  await q('UPDATE users SET pricing_tier=$1 WHERE id=$2', [tier, userId]);
}

app.patch('/api/users/:id/pricing', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { tier, custom_prices } = req.body || {};
    if (!tier) return res.status(400).json({ error: 'Tier is required' });
    await applyPricingTier(parseInt(req.params.id), tier, custom_prices);
    await logActivity('pricing_updated', user.name||user.email, req.user.email);
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.patch('/api/users/:id/approve', authenticate, authorize('admin'), async (req, res) => {
  try {
    const user = await one('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await q("UPDATE users SET status='active' WHERE id=$1", [req.params.id]);
    if (user.store_id) await q("UPDATE stores SET status='active' WHERE id=$1", [user.store_id]);
    const { tier, custom_prices } = req.body || {};
    if (tier) await applyPricingTier(parseInt(req.params.id), tier, custom_prices);
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
app.get('/api/reps', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    if (role === 'rep') {
      const rep = await one('SELECT r.*,u.name,u.email,u.phone FROM reps r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1', [userId]);
      if (!rep) return res.json({ rep: null });
      const storeCount = (await one('SELECT COUNT(*) as count FROM rep_store_assignments WHERE rep_id=$1', [rep.id])).count;
      const stores = await all(
        'SELECT s.id,s.name,s.monthly_revenue,s.category,s.city,s.state FROM stores s JOIN rep_store_assignments rsa ON rsa.store_id=s.id WHERE rsa.rep_id=$1',
        [rep.id]
      );
      const storeRevenue = stores.reduce((a,s)=>a+parseFloat(s.monthly_revenue),0);
      const myCommission = storeRevenue * parseFloat(rep.commission_rate);
      const downline = await all(
        `SELECT r.id,r.commission_rate,u.name,u.email,
                (SELECT COUNT(*) FROM rep_store_assignments WHERE rep_id=r.id) as store_count,
                COALESCE((SELECT SUM(s2.monthly_revenue) FROM stores s2 JOIN rep_store_assignments rsa2 ON rsa2.store_id=s2.id WHERE rsa2.rep_id=r.id),0) as store_revenue
         FROM reps r JOIN users u ON u.id=r.user_id WHERE r.sponsor_id=$1`,
        [rep.id]
      );
      const sponsorCommission = downline.reduce((a,d)=>a+(parseFloat(d.store_revenue)*parseFloat(d.commission_rate)*0.05),0);
      return res.json({ rep, storeCount, stores, storeRevenue, myCommission, downline, sponsorCommission, totalEarnings: myCommission+sponsorCommission });
    }
    if (role === 'admin') {
      const reps = await all(
        `SELECT r.id,r.sponsor_id,r.commission_rate,u.id as user_id,u.name,u.email,u.phone,u.status,
                su.name as sponsor_name,
                (SELECT COUNT(*) FROM rep_store_assignments WHERE rep_id=r.id) as store_count,
                COALESCE((SELECT SUM(s.monthly_revenue) FROM stores s JOIN rep_store_assignments rsa ON rsa.store_id=s.id WHERE rsa.rep_id=r.id),0) as store_revenue
         FROM reps r JOIN users u ON u.id=r.user_id
         LEFT JOIN reps sr ON sr.id=r.sponsor_id LEFT JOIN users su ON su.id=sr.user_id`
      );
      return res.json(reps);
    }
    res.status(403).json({ error: 'Access denied' });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/reps/enroll', authenticate, authorize('rep'), async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
    const sponsorDSD = await one('SELECT id FROM reps WHERE user_id=$1', [req.user.id]);
    if (!sponsorDSD) return res.status(400).json({ error: 'Sponsor rep not found' });
    const client = await pool.connect();
    let newUserId;
    try {
      await client.query('BEGIN');
      const ur = await client.query(
        `INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ($1,$2,'rep',$3,$4,'active') RETURNING id`,
        [email.toLowerCase(), bcrypt.hashSync(password,10), name, phone||'']
      );
      newUserId = ur.rows[0].id;
      await client.query('INSERT INTO reps (user_id,sponsor_id,commission_rate) VALUES ($1,$2,0.10)', [newUserId, sponsorDSD.id]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    await logActivity('enrolled_rep', name, req.user.email);
    res.status(201).json({ success: true, userId: newUserId });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/reps', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, email, password, phone, sponsor_rep_id } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
    const existing = await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already in use' });
    const client = await pool.connect();
    let newUserId;
    try {
      await client.query('BEGIN');
      const ur = await client.query(
        `INSERT INTO users (email,password_hash,role,name,phone,status) VALUES ($1,$2,'rep',$3,$4,'active') RETURNING id`,
        [email.toLowerCase(), bcrypt.hashSync(password,10), name, phone||'']
      );
      newUserId = ur.rows[0].id;
      await client.query('INSERT INTO reps (user_id,sponsor_id,commission_rate) VALUES ($1,$2,0.10)', [newUserId, sponsor_rep_id||null]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    await logActivity('created_rep', name, req.user.email);
    res.status(201).json({ success: true, userId: newUserId });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/reps/:id/stores', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { store_ids } = req.body;
    if (!store_ids || !Array.isArray(store_ids)) return res.status(400).json({ error: 'store_ids array required' });
    for (const sid of store_ids) {
      await q('INSERT INTO rep_store_assignments (rep_id,store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, sid]);
    }
    res.json({ success: true });
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
    const p = await one(
      'INSERT INTO products (name,description,image_url,sku,stock) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, description||'', image_url||'', sku||'', stock||0]
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
    const { name, description, image_url, sku, stock, cost_price, active, prices } = req.body;
    const p = await one('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const updated = await one(
      'UPDATE products SET name=$1,description=$2,image_url=$3,sku=$4,stock=$5,active=$6 WHERE id=$7 RETURNING *',
      [name??p.name, description??p.description, image_url??p.image_url, sku??p.sku, stock??p.stock, active??p.active, req.params.id]
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
    const statusColor = invoice.payment_status === 'paid' ? '#16a34a' : invoice.payment_status === 'overdue' ? '#dc2626' : '#d97706';
    const statusBg = invoice.payment_status === 'paid' ? '#f0fdf4' : invoice.payment_status === 'overdue' ? '#fef2f2' : '#fffbeb';
    const statusLabel = invoice.payment_status.charAt(0).toUpperCase() + invoice.payment_status.slice(1);
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

    const cart = store_id
      ? await one('SELECT * FROM carts WHERE user_id=$1 AND store_id=$2', [userId, store_id])
      : await one('SELECT * FROM carts WHERE user_id=$1 AND store_id IS NULL', [userId]);
    if (!cart) return res.status(400).json({ error: 'Cart not found' });

    const items = await all('SELECT ci.*,p.name,p.stock FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.cart_id=$1', [cart.id]);
    if (!items.length) return res.status(400).json({ error: 'Cart is empty' });
    for (const item of items) {
      if (item.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${item.name}` });
    }

    const subtotal = items.reduce((a,i)=>a+parseFloat(i.price_at_add)*i.quantity,0);
    const shipping_cost = subtotal > 500 ? 0 : 15;
    const total = subtotal + shipping_cost;
    const payment_status = payment_method === 'card' ? 'paid' : 'unpaid';

    const client = await pool.connect();
    let order;
    try {
      await client.query('BEGIN');
      const or = await client.query(
        `INSERT INTO orders (user_id,store_id,payment_method,payment_status,subtotal,shipping_cost,total,shipping_name,shipping_address,shipping_city,shipping_state,shipping_zip,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [userId, store_id||null, payment_method, payment_status, subtotal, shipping_cost, total,
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
    await calculateAndSaveCommissions(order.id, req.user.id, parseFloat(order.total));

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
    await q('UPDATE orders SET status=$1 WHERE id=$2', [status, req.params.id]);
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
    res.json({ success: true });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ── INVENTORY ─────────────────────────────────────────────────────────────────
app.get('/api/inventory/:store_id', authenticate, async (req, res) => {
  try {
    const { role, id: userId } = req.user;
    const storeId = parseInt(req.params.store_id);
    if (role === 'dsd') {
      const user = await one('SELECT store_id FROM users WHERE id=$1', [userId]);
      if (user.store_id !== storeId) return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'dsd') {
      const assigned = await one('SELECT 1 FROM dsd_stores WHERE dsd_id=$1 AND store_id=$2', [userId, storeId]);
      if (!assigned) return res.status(403).json({ error: 'Access denied' });
    }
    if (role === 'rep') {
      const rep = await one('SELECT id FROM reps WHERE user_id=$1', [userId]);
      if (!rep) return res.status(403).json({ error: 'Access denied' });
      const assigned = await one('SELECT 1 FROM rep_store_assignments WHERE rep_id=$1 AND store_id=$2', [rep.id, storeId]);
      if (!assigned) return res.status(403).json({ error: 'Access denied' });
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


// ── ADDY DSD TIER & COMMISSION ENDPOINTS ──────────────────────────────────────

// Update DSD rep tier (admin only)
app.patch('/api/users/:id/tier', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { tier } = req.body;
    if (![1,2,3].includes(parseInt(tier))) return res.status(400).json({ error: 'Tier must be 1, 2 or 3' });
    const user = await one('SELECT name, email FROM users WHERE id=$1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await q('UPDATE users SET tier=$1 WHERE id=$2', [parseInt(tier), req.params.id]);
    await logActivity('changed_tier', `${user.name || user.email} → Tier ${tier}`, req.user.email);
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
    const user = await one('SELECT commission_balance, name, email FROM users WHERE id=$1', [req.user.id]);
    const balance = parseFloat(user.commission_balance || 0);
    if (balance <= 0) return res.status(400).json({ error: 'No commission balance available' });
    const existing = await one("SELECT id FROM payout_requests WHERE user_id=$1 AND status='pending'", [req.user.id]);
    if (existing) return res.status(400).json({ error: 'You already have a pending payout request' });
    const pr = await one(
      'INSERT INTO payout_requests (user_id, amount) VALUES ($1,$2) RETURNING id',
      [req.user.id, balance]
    );
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
    const { name, address, city, state, zip, phone, email, category } = req.body;
    if (!name) return res.status(400).json({ error: 'Store name required' });
    // Check if store already claimed
    const existing = await one('SELECT id,exclusive_rep_id FROM stores WHERE LOWER(name)=LOWER($1) AND LOWER(city)=LOWER($2)', [name, city||'']);
    if (existing?.exclusive_rep_id) return res.status(409).json({ error: 'This store is already claimed by another rep' });
    const store = await one(
      "INSERT INTO stores (name,address,city,state,zip,phone,email,category,store_approval_status,exclusive_rep_id,monthly_revenue,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,0,'active') RETURNING id",
      [name, address||'', city||'', state||'', zip||'', phone||'', email||'', category||'General', req.user.id]
    );
    await logActivity('claimed_store', `${name} by rep #${req.user.id}`, req.user.email);
    res.json({ success: true, id: store.id, message: 'Store submitted for approval' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin approve/reject store claim
app.patch('/api/stores/:id/approve-claim', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { approved } = req.body;
    const store = await one('SELECT * FROM stores WHERE id=$1', [req.params.id]);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    await q('UPDATE stores SET store_approval_status=$1 WHERE id=$2', [approved ? 'approved' : 'rejected', req.params.id]);
    await logActivity(approved ? 'approved_store' : 'rejected_store', store.name, req.user.email);
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
app.get('/api/stores/pending-claims', authenticate, authorize('admin'), async (req, res) => {
  try {
    const stores = await all(
      "SELECT s.*, u.name as rep_name, u.email as rep_email FROM stores s JOIN users u ON u.id=s.exclusive_rep_id WHERE s.store_approval_status='pending' ORDER BY s.id DESC"
    );
    res.json(stores);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
migrate().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`⚡ ADDY running on port ${PORT}`));
}).catch(err => {
  console.error('❌ Failed to start:', err);
  process.exit(1);
});

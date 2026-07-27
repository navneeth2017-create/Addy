/**
 * Shared plumbing for the Addy suites.
 *
 * Two rules learned the hard way while writing these:
 *
 *  1. Never assert on a wall-clock window ("orders created in the last 10
 *     seconds"). Sibling suites legitimately create rows at the same moment
 *     and you get baffling intermittent failures. Take an id baseline instead.
 *  2. Every test seeds its own data under a unique suffix and deletes it in a
 *     finally block, so suites can run in any order, repeatedly, against a
 *     database that already has real rows in it.
 */
import pg from '../../node_modules/pg/lib/index.js';
import bcrypt from '../../node_modules/bcryptjs/index.js';
import jwt from '../../node_modules/jsonwebtoken/index.js';

export const INVOICE_URL = process.env.ADDY_URL || 'http://localhost:8123';
export const CARD_URL = process.env.ADDY_CARD_URL || 'http://localhost:8126';
export const STUB_URL = process.env.STRIPE_STUB_URL || 'http://localhost:9922';
const JWT_SECRET = process.env.JWT_SECRET || 'testsecret';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://monarch:monarch@127.0.0.1:5432/addy',
});
// Addy's tables live in the `addy` schema, not public.
export async function db(sql, params) {
  const c = await pool.connect();
  try {
    await c.query('SET search_path = addy, public');
    return await c.query(sql, params);
  } finally { c.release(); }
}

// ── assertions ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
export function ok(cond, label, detail = '') {
  cond ? passed++ : failed++;
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}
export function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

// ── http ────────────────────────────────────────────────────────────────────
export function client(baseUrl, token) {
  return (path, options = {}) => fetch(baseUrl + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
}
/**
 * Signs in over HTTP, waiting out the login rate limiter (10/min per IP)
 * rather than failing on it. Running the suite twice inside a minute would
 * otherwise report nine spurious failures that look like broken auth.
 */
export async function login(baseUrl, email, password) {
  const anon = client(baseUrl);
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await anon('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (res.status !== 429) return { status: res.status, body: await res.json().catch(() => ({})) };
    if (attempt === 0) console.log('   (login rate limit hit — waiting it out)');
    await new Promise(r => setTimeout(r, 10_000));
  }
  return { status: 429, body: { error: 'rate limited for over a minute' } };
}

export const tokenFor = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role, store_id: user.store_id ?? null },
    JWT_SECRET, { expiresIn: '1h' });

// ── seeding ─────────────────────────────────────────────────────────────────
export const PASSWORD = 'harness-pass-2026';
const HASH = bcrypt.hashSync(PASSWORD, 10);

/** Creates a user with a known password. Returns { id, email, role, token }. */
export async function makeUser(role, tag, extra = {}) {
  const email = `harness_${role}_${tag}@test.invalid`;
  const r = await db(
    `INSERT INTO users (email, name, phone, role, password_hash, status, tier, can_pay_invoice)
     VALUES ($1,$2,'',$3,$4,'active',1,$5) RETURNING id, email, role, store_id`,
    [email, `Harness ${role}`, role, HASH, extra.can_pay_invoice ?? true]
  );
  const u = r.rows[0];
  if (extra.parent_id) await db('UPDATE users SET parent_id=$1 WHERE id=$2', [extra.parent_id, u.id]);
  if (extra.locked_discount_pct != null) {
    await db('UPDATE users SET locked_discount_pct=$1 WHERE id=$2', [extra.locked_discount_pct, u.id]);
  }
  return { ...u, token: tokenFor(u) };
}

export async function makeStore(tag, fields = {}) {
  const r = await db(
    `INSERT INTO stores (name, address, city, state, zip, status, category)
     VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING id, name`,
    [fields.name || `Harness Store ${tag}`, fields.address || '1 Test St',
     fields.city || 'Phoenix', fields.state || 'AZ', fields.zip || '85001',
     fields.category || 'other']
  );
  return r.rows[0];
}

/** A master box (box_type set) so order minimums are satisfiable. */
export async function makeProduct(tag, fields = {}) {
  const r = await db(
    `INSERT INTO products (name, sku, retail_price, stock, box_type, free_shipping, active)
     VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id, name, retail_price, box_type`,
    [fields.name || `Harness Product ${tag}`, `HRN-${tag}`,
     fields.retail_price ?? 60, fields.stock ?? 9999,
     fields.box_type ?? 'gummies', fields.free_shipping ?? false]
  );
  return r.rows[0];
}

/** Deletes everything this run created, children first. Safe to call twice. */
export async function cleanup(tag) {
  const like = `%${tag}%`;
  await db(`DELETE FROM order_items WHERE order_id IN
              (SELECT o.id FROM orders o LEFT JOIN users u ON u.id=o.user_id
               WHERE u.email LIKE $1)`, [`harness_%_${tag}@test.invalid`]).catch(()=>{});
  await db(`DELETE FROM invoices WHERE order_id IN
              (SELECT o.id FROM orders o LEFT JOIN users u ON u.id=o.user_id
               WHERE u.email LIKE $1)`, [`harness_%_${tag}@test.invalid`]).catch(()=>{});
  await db(`DELETE FROM commissions WHERE order_id IN
              (SELECT o.id FROM orders o LEFT JOIN users u ON u.id=o.user_id
               WHERE u.email LIKE $1)`, [`harness_%_${tag}@test.invalid`]).catch(()=>{});
  await db(`DELETE FROM orders WHERE user_id IN
              (SELECT id FROM users WHERE email LIKE $1)`, [`harness_%_${tag}@test.invalid`]).catch(()=>{});
  await db(`DELETE FROM cart_items WHERE cart_id IN (SELECT c.id FROM carts c JOIN users u ON u.id=c.user_id
              WHERE u.email LIKE $1)`, [`harness_%_${tag}@test.invalid`]).catch(()=>{});
  await db(`DELETE FROM carts WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`harness_%_${tag}@test.invalid`]).catch(()=>{});
  await db(`DELETE FROM store_inventory WHERE store_id IN (SELECT id FROM stores WHERE name LIKE $1)`, [like]).catch(()=>{});
  await db(`DELETE FROM dsd_stores   WHERE store_id IN (SELECT id FROM stores WHERE name LIKE $1)`, [like]).catch(()=>{});
  await db(`DELETE FROM owner_stores WHERE store_id IN (SELECT id FROM stores WHERE name LIKE $1)`, [like]).catch(()=>{});
  await db(`DELETE FROM stores   WHERE name LIKE $1`, [like]).catch(()=>{});
  await db(`DELETE FROM products WHERE sku LIKE $1`, [`HRN-${tag}%`]).catch(()=>{});
  await db(`DELETE FROM users    WHERE email LIKE $1`, [`harness_%_${tag}@test.invalid`]).catch(()=>{});
}

/** Ends the run: prints the tally, cleans up, exits non-zero on failure. */
export async function finish(tag) {
  const failures = report();
  try { await cleanup(tag); } catch (e) { console.error('cleanup warning:', e.message); }
  await pool.end();
  process.exit(failures ? 1 : 0);
}

export const tag = () => `${process.pid}${Date.now().toString(36)}`;
export const SHIP = {
  shipping_name: 'Harness', shipping_address: '1 Test St',
  shipping_city: 'Phoenix', shipping_state: 'AZ', shipping_zip: '85001',
};

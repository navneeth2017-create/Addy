CREATE TABLE IF NOT EXISTS stores (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  category TEXT NOT NULL,
  monthly_revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  wholesale_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  retail_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  distribution_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'pending'))
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','dsd')),
  store_id INTEGER REFERENCES stores(id),
  name TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'pending', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dsd_stores (
  dsd_id INTEGER NOT NULL REFERENCES users(id),
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (dsd_id, store_id)
);

CREATE TABLE IF NOT EXISTS reps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  sponsor_id INTEGER REFERENCES reps(id),
  commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.10
);

CREATE TABLE IF NOT EXISTS rep_store_assignments (
  rep_id INTEGER NOT NULL REFERENCES reps(id),
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (rep_id, store_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  target_name TEXT,
  user_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_notes (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  sku TEXT UNIQUE,
  stock INTEGER NOT NULL DEFAULT 0,
  cost_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_prices (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT,
  price NUMERIC(10,2) NOT NULL,
  UNIQUE(product_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS carts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  price_at_add NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  store_id INTEGER REFERENCES stores(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','shipped','delivered','cancelled')),
  payment_method TEXT NOT NULL DEFAULT 'invoice' CHECK(payment_method IN ('card','invoice')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid','failed')),
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  shipping_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL DEFAULT 0,
  shipping_name TEXT,
  shipping_address TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_zip TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  total_price NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS store_inventory (
  id SERIAL PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_id, product_id)
);

CREATE TABLE IF NOT EXISTS owner_stores (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_id, store_id)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notification_emails (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL UNIQUE,
  due_date DATE NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid','overdue')),
  paid_at TIMESTAMPTZ,
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS preorders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

-- Migration: add pricing_tier to users if not already present
ALTER TABLE users ADD COLUMN IF NOT EXISTS pricing_tier TEXT;

-- ── ADDY DSD TIER & COMMISSION SYSTEM ────────────────────────────────────────

-- Tier info on users (added via migration, safe to run multiple times)
-- tier: 1=Tier1(35%), 2=Tier2(30%), 3=Tier3(25%)
-- referred_by: user_id of who recruited this rep
-- commission_balance: running total of unpaid commissions owed to this rep

CREATE TABLE IF NOT EXISTS commissions (
  id SERIAL PRIMARY KEY,
  earner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  buyer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount NUMERIC(10,2) NOT NULL,
  rate NUMERIC(5,4) NOT NULL,
  level INTEGER NOT NULL CHECK(level IN (1,2)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payout_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
  stripe_transfer_id TEXT,
  admin_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);


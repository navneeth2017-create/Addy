/**
 * The ordering lifecycle end to end: cart, minimums, stock, totals, and
 * whether the finished order actually shows up where people look for it —
 * the buyer's own list, the admin list, and the invoice list.
 *
 * Runs against the invoice-mode server (no Stripe). The card path has its own
 * suite; this one is about everything around it.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, makeProduct, SHIP, tag,
} from './lib/harness.mjs';

const T = tag();
const admin = await makeUser('admin', T);
const buyer = await makeUser('dsd', T, { can_pay_invoice: true });
const box = await makeProduct(T, { retail_price: 60, stock: 500, box_type: 'gummies' });
const capsules = await makeProduct(T + 'c', { retail_price: 60, stock: 500, box_type: 'blister_card' });

const asBuyer = client(INVOICE_URL, buyer.token);
const asAdmin = client(INVOICE_URL, admin.token);
const clear = () => asBuyer('/api/cart', { method: 'DELETE' });
const add = (product_id, quantity) =>
  asBuyer('/api/cart/add', { method: 'POST', body: JSON.stringify({ product_id, quantity }) });
const order = (extra = {}) =>
  asBuyer('/api/orders', { method: 'POST', body: JSON.stringify({ payment_method: 'invoice', ...SHIP, ...extra }) });

// ── cart ────────────────────────────────────────────────────────────────────
await clear();
let res = await add(box.id, 3);
ok(res.status === 200, 'items can be added to the cart', `HTTP ${res.status}`);
let cart = await res.json();
ok(cart.items?.length === 1 && cart.items[0].quantity === 3, 'the cart reflects what was added',
   `${cart.items?.[0]?.quantity} × ${cart.items?.length} line(s)`);

res = await order();
ok(res.status === 201, 'a first order of 3 boxes is accepted', `HTTP ${res.status}`);
const first = await res.json();

// ── the cart is emptied, not left behind ────────────────────────────────────
const leftover = (await db('SELECT count(*)::int c FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE c.user_id=$1', [buyer.id])).rows[0].c;
ok(leftover === 0, 'the cart is emptied once the order is placed', `${leftover} item(s) left`);

// ── it shows up where people look ───────────────────────────────────────────
const mine = await (await asBuyer('/api/orders')).json();
ok(Array.isArray(mine) && mine.some(o => o.id === first.id), "the order appears in the BUYER's list");
const all = await (await asAdmin('/api/orders')).json();
const adminRow = Array.isArray(all) && all.find(o => o.id === first.id);
ok(!!adminRow, 'the order appears in the ADMIN list');
ok(adminRow?.user_email === buyer.email, 'attributed to the right buyer', adminRow?.user_email);

const inv = (await db('SELECT invoice_number, payment_status FROM invoices WHERE order_id=$1', [first.id])).rows[0];
ok(!!inv?.invoice_number, 'an invoice was generated', inv?.invoice_number);
const invList = await (await asAdmin('/api/invoices')).json();
ok(Array.isArray(invList) && invList.some(i => i.order_id === first.id), 'and shows on the admin invoice list');

// ── invoice numbers are unique under concurrency ────────────────────────────
const racers = [];
for (let i = 0; i < 3; i++) {
  const u = await makeUser('dsd', `${T}r${i}`, { can_pay_invoice: true });
  const c = client(INVOICE_URL, u.token);
  await c('/api/cart', { method: 'DELETE' });
  await c('/api/cart/add', { method: 'POST', body: JSON.stringify({ product_id: box.id, quantity: 3 }) });
  racers.push(c);
}
const placed = (await Promise.all(racers.map(c =>
  c('/api/orders', { method: 'POST', body: JSON.stringify({ payment_method: 'invoice', ...SHIP }) })
    .then(r => r.json()).catch(() => null)))).filter(o => o?.invoice_number);
ok(placed.length === 3, 'three simultaneous checkouts all succeeded', `${placed.length}/3`);
const nums = placed.map(o => o.invoice_number);
ok(new Set(nums).size === nums.length, 'each got a DISTINCT invoice number', nums.join(' '));
const dupes = await db('SELECT invoice_number FROM invoices GROUP BY invoice_number HAVING count(*)>1');
ok(dupes.rowCount === 0, 'no duplicate invoice numbers anywhere in the table');

// ── stock ───────────────────────────────────────────────────────────────────
const before = Number((await db('SELECT stock FROM products WHERE id=$1', [box.id])).rows[0].stock);
await clear(); await add(box.id, 5);
await order();
const after = Number((await db('SELECT stock FROM products WHERE id=$1', [box.id])).rows[0].stock);
ok(before - after === 5, 'stock is decremented by the quantity ordered', `${before} -> ${after}`);

// Ordering more than exists is refused, and nothing is committed.
await db('UPDATE products SET stock=2 WHERE id=$1', [box.id]);
await clear(); await add(box.id, 2);
await db('UPDATE products SET stock=1 WHERE id=$1', [box.id]); // sells out underneath the cart
const ordersBefore = (await db('SELECT count(*)::int c FROM orders')).rows[0].c;
res = await order();
const ordersAfter = (await db('SELECT count(*)::int c FROM orders')).rows[0].c;
ok([400, 409].includes(res.status), 'a checkout that outruns stock is refused', `HTTP ${res.status}`);
ok(ordersAfter === ordersBefore, 'and no order row is committed');
ok(Number((await db('SELECT stock FROM products WHERE id=$1', [box.id])).rows[0].stock) === 1,
   'stock never goes negative');
await db('UPDATE products SET stock=500 WHERE id=$1', [box.id]);

// ── shipping and totals ─────────────────────────────────────────────────────
for (const [state, expected] of [['AZ', 15], ['CA', 25], ['MO', 35], ['NY', 45], ['HI', 60]]) {
  await clear(); await add(box.id, 3);
  const o = await (await order({ shipping_state: state })).json();
  ok(Number(o.shipping_cost) === expected, `3 boxes to ${state} ship at $${expected}`, `$${o.shipping_cost}`);
}
await clear(); await add(box.id, 6);
let o = await (await order({ shipping_state: 'NY' })).json();
ok(Number(o.shipping_cost) === 0, '6+ boxes ship free even to the far zone', `$${o.shipping_cost}`);
await clear(); await add(capsules.id, 2);
o = await (await order({ shipping_state: 'NY' })).json();
ok(Number(o.shipping_cost) === 0, 'an order with a capsules box ships free', `$${o.shipping_cost}`);

await clear(); await add(box.id, 3);
o = await (await order({ shipping_state: 'NY' })).json();
const sum = Math.round((Number(o.subtotal) + Number(o.shipping_cost) + Number(o.processing_fee)) * 100) / 100;
ok(Math.abs(sum - Number(o.total)) < 0.005, 'subtotal + shipping + fee === total', `${sum} vs ${o.total}`);
ok(Number(o.processing_fee) === 0, 'invoice orders carry no card processing fee', `$${o.processing_fee}`);

// ── pallet tiers ────────────────────────────────────────────────────────────
const unitAt = async (qty) => {
  await clear(); await add(box.id, qty);
  const r = await (await order()).json();
  return Number(r.subtotal) / qty;
};
const [u3, u15, u27] = [await unitAt(3), await unitAt(15), await unitAt(27)];
ok(u15 < u3, 'a half pallet (15) beats the 3-box unit price', `$${u3.toFixed(2)} -> $${u15.toFixed(2)}`);
ok(u27 < u15, 'a full pallet (27) beats the half-pallet price', `$${u15.toFixed(2)} -> $${u27.toFixed(2)}`);

// ── invoice permission is enforced server-side ──────────────────────────────
const cardOnly = await makeUser('dsd', `${T}co`, { can_pay_invoice: false });
const asCardOnly = client(INVOICE_URL, cardOnly.token);
await asCardOnly('/api/cart', { method: 'DELETE' });
await asCardOnly('/api/cart/add', { method: 'POST', body: JSON.stringify({ product_id: box.id, quantity: 3 }) });
res = await asCardOnly('/api/orders', { method: 'POST', body: JSON.stringify({ payment_method: 'invoice', ...SHIP }) });
ok(res.status === 403, 'a buyer without invoice access cannot pay by invoice', `HTTP ${res.status}`);

// ── orders outlive their buyer ──────────────────────────────────────────────
await db('UPDATE orders SET user_id=NULL WHERE id=$1', [first.id]);
const afterDelete = await (await asAdmin('/api/orders')).json();
ok(Array.isArray(afterDelete) && afterDelete.some(x => x.id === first.id),
   'an order whose buyer was removed still shows for the admin');

await finish(T);

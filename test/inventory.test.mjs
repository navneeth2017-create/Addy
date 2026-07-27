/**
 * Per-store inventory: who may read it, who may write it, and whether a
 * partial update works.
 *
 * Regression for two bugs found on 2026-07-27:
 *   - the write path checked users.store_id, which is NULL for DSD owners
 *     (they claim stores through dsd_stores), so an owner got 403 on their OWN
 *     store and members and reps were locked out entirely;
 *   - underneath that, quantity and low_stock_threshold are NOT NULL with
 *     defaults, but NULL was passed through — so setting ONLY the quantity on
 *     a product with no stock row yet threw a not-null violation and 500'd.
 *     Nobody had hit it because nobody could get past the 403.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, makeStore, makeProduct, tag,
} from './lib/harness.mjs';

const T = tag();
const admin = await makeUser('admin', T);
const owner = await makeUser('dsd', T);
const other = await makeUser('dsd', `${T}o`);
const staff = await makeUser('member', T, { parent_id: owner.id });
const mine = await makeStore(T, { name: `Harness Mine ${T}` });
const theirs = await makeStore(`${T}o`, { name: `Harness Theirs ${T}o` });
const product = await makeProduct(T);

// The owner claims their store the way the app does.
await db('INSERT INTO dsd_stores (dsd_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [owner.id, mine.id]);
await db('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [owner.id, mine.id]);
await db('INSERT INTO dsd_stores (dsd_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [other.id, theirs.id]);

const as = (u) => client(INVOICE_URL, u.token);
const setStock = (u, storeId, body) =>
  as(u)(`/api/inventory/${storeId}/${product.id}`, { method: 'PATCH', body: JSON.stringify(body) });

// ── writing ─────────────────────────────────────────────────────────────────
let res = await setStock(owner, mine.id, { quantity: 7 });
ok(res.status === 200, 'a DSD owner CAN set stock on the store they claimed', `HTTP ${res.status}`);
const row = (await db('SELECT quantity, low_stock_threshold FROM store_inventory WHERE store_id=$1 AND product_id=$2',
  [mine.id, product.id])).rows[0];
ok(Number(row?.quantity) === 7, 'the quantity actually persisted', `qty=${row?.quantity}`);
ok(row?.low_stock_threshold != null, 'the threshold fell back to its default rather than NULL',
   `threshold=${row?.low_stock_threshold}`);

res = await setStock(staff, mine.id, { quantity: 9 });
ok(res.status === 200, "a member CAN set stock on their parent DSD's store", `HTTP ${res.status}`);

res = await setStock(admin, mine.id, { quantity: 11 });
ok(res.status === 200, 'an admin can set stock anywhere', `HTTP ${res.status}`);

res = await setStock(other, mine.id, { quantity: 999 });
ok(res.status === 403, 'a different DSD CANNOT touch a store they have not claimed', `HTTP ${res.status}`);
ok(Number((await db('SELECT quantity FROM store_inventory WHERE store_id=$1 AND product_id=$2',
  [mine.id, product.id])).rows[0].quantity) === 11, "and the owner's number is unchanged");

// Threshold-only update must not wipe the quantity.
res = await setStock(owner, mine.id, { low_stock_threshold: 4 });
const after = (await db('SELECT quantity, low_stock_threshold FROM store_inventory WHERE store_id=$1 AND product_id=$2',
  [mine.id, product.id])).rows[0];
ok(res.status === 200 && Number(after.quantity) === 11 && Number(after.low_stock_threshold) === 4,
   'updating only the threshold leaves the quantity alone', `qty=${after.quantity} threshold=${after.low_stock_threshold}`);

// A product with no stock row yet, quantity only — the not-null case.
const fresh = await makeProduct(`${T}f`);
res = await as(owner)(`/api/inventory/${mine.id}/${fresh.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: 5 }) });
ok(res.status === 200, 'setting only the quantity on a brand-new stock row works', `HTTP ${res.status}`);
const freshRow = (await db('SELECT quantity, low_stock_threshold FROM store_inventory WHERE store_id=$1 AND product_id=$2',
  [mine.id, fresh.id])).rows[0];
ok(freshRow && Number(freshRow.quantity) === 5 && freshRow.low_stock_threshold != null,
   'and both columns are populated', `qty=${freshRow?.quantity} threshold=${freshRow?.low_stock_threshold}`);

// ── reading ─────────────────────────────────────────────────────────────────
ok((await as(owner)(`/api/inventory/${mine.id}`)).status === 200, 'the owner can read their own store');
ok((await as(staff)(`/api/inventory/${mine.id}`)).status === 200, "a member can read their parent's store");
ok((await as(admin)(`/api/inventory/${mine.id}`)).status === 200, 'an admin can read any store');
ok((await as(owner)(`/api/inventory/${theirs.id}`)).status === 403, "a DSD cannot read another DSD's store");
ok((await as(staff)(`/api/inventory/${theirs.id}`)).status === 403, "nor can their member");

const list = await (await as(owner)('/api/inventory')).json();
ok(Array.isArray(list) || typeof list === 'object', "the owner's inventory list loads");
const listed = JSON.stringify(list);
ok(!listed.includes(`Harness Theirs ${T}o`), "and does not include another DSD's store");

await finish(T);

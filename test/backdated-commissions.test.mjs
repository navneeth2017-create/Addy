/**
 * Orders taken before the site was live, and who they pay.
 *
 * Commission was only ever calculated inside checkout, which a rep has to walk
 * through themselves. Anything sold off-site paid nobody — no commission rows,
 * no movement in a balance — and there was no admin path to enter an order at
 * all. This covers the tool that records those, and the split it produces.
 *
 * Also covers the grandfathering flag, which decided 5% vs 2% of real money and
 * could previously only be set by a one-shot boot migration: no way to grant it
 * afterwards, and no way to see who had it, because the users list didn't
 * return the column.
 *
 * And the privacy rule underneath all of it: the house partner sees who is
 * earning him money; the reps generating it never see that they are.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, makeProduct, tag,
} from './lib/harness.mjs';

const T = tag();
const admin = await makeUser('admin', T);
const asAdmin = client(INVOICE_URL, admin.token);

// Danny. Exactly one house partner exists globally, so borrow it for the run
// and hand it back at the end rather than minting a second one.
const prior = (await db('SELECT id FROM users WHERE house_partner=TRUE')).rows.map(r => r.id);
if (prior.length) await db('UPDATE users SET house_partner=FALSE WHERE id = ANY($1)', [prior]);
const house = await makeUser('dsd', T, { emailRole: 'house' });
await db('UPDATE users SET house_partner=TRUE, house_5pct=FALSE WHERE id=$1', [house.id]);
const asHouse = client(INVOICE_URL, house.token);

const grandfathered = await makeUser('dsd', T, { emailRole: 'gf' });
await db('UPDATE users SET house_5pct=TRUE WHERE id=$1', [grandfathered.id]);
const newcomer = await makeUser('dsd', T, { emailRole: 'new' });   // not grandfathered -> 2%
const recruit = await makeUser('dsd', T, { emailRole: 'recruit' }); // referred BY the house
await db('UPDATE users SET referred_by=$1, house_5pct=TRUE WHERE id=$2', [house.id, recruit.id]);

const product = await makeProduct(T, { retail_price: 100, stock: 1000 });
const stockBefore = (await db('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock;

const record = (buyer, extra = {}) => asAdmin('/api/admin/orders/backdated', {
  method: 'POST',
  body: JSON.stringify({
    user_id: buyer.id,
    items: [{ product_id: product.id, quantity: 2, unit_price: 50 }],
    shipping_cost: 15, placed_at: '2026-06-01T12:00:00Z', ...extra,
  }),
});
const commissionsFor = (orderId) =>
  db('SELECT earner_id, amount, rate, level FROM commissions WHERE order_id=$1 ORDER BY level', [orderId]);

// ── a grandfathered rep pays the house 5% ───────────────────────────────────
const r1 = await record(grandfathered);
const b1 = await r1.json();
ok(r1.status === 201, 'an admin can record an order that happened off-site', `HTTP ${r1.status} ${b1.error || ''}`);
ok(Number(b1.order.total) === 115, 'total is subtotal + shipping', `$${b1.order.total}`);
const c1 = (await commissionsFor(b1.order.id)).rows;
ok(c1.length === 1, 'exactly one commission was written', `${c1.length}`);
ok(c1[0]?.earner_id === house.id, 'and it goes to the house partner');
ok(Number(c1[0]?.rate) === 0.05, 'a GRANDFATHERED rep pays 5%', `${Number(c1[0]?.rate) * 100}%`);
ok(Number(c1[0]?.amount) === 5.75, '5% of the whole total, shipping included', `$${c1[0]?.amount}`);

// ── everyone else pays 2% ───────────────────────────────────────────────────
const r2 = await record(newcomer);
const b2 = await r2.json();
const c2 = (await commissionsFor(b2.order.id)).rows;
ok(Number(c2[0]?.rate) === 0.02, 'a rep who is NOT grandfathered pays 2%', `${Number(c2[0]?.rate) * 100}%`);
ok(Number(c2[0]?.amount) === 2.30, 'at 2% of the total', `$${c2[0]?.amount}`);

// ── the house cut never stacks on his own recruit ───────────────────────────
const r3 = await record(recruit);
const b3 = await r3.json();
const c3 = (await commissionsFor(b3.order.id)).rows;
ok(c3.length === 1, "his own recruit pays him ONCE, not twice", `${c3.length} row(s)`);
ok(Number(c3[0]?.rate) === 0.05 && c3[0]?.level === 1,
   'as the 5% referral, with the house cut skipped', `rate ${Number(c3[0]?.rate)} level ${c3[0]?.level}`);

// ── the balance actually moves ──────────────────────────────────────────────
const bal = (await db('SELECT commission_balance FROM users WHERE id=$1', [house.id])).rows[0];
ok(Math.abs(Number(bal.commission_balance) - (5.75 + 2.30 + 5.75)) < 0.01,
   "the house partner's payable balance went up by all three", `$${bal.commission_balance}`);

// ── the goods already shipped, so stock must not move ───────────────────────
const stockAfter = (await db('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock;
ok(stockAfter === stockBefore, 'recording a past order does NOT take stock again',
   `${stockBefore} -> ${stockAfter}`);

// ── the date is respected, not stamped as today ─────────────────────────────
const placed = (await db('SELECT created_at FROM orders WHERE id=$1', [b1.order.id])).rows[0];
ok(new Date(placed.created_at).toISOString().startsWith('2026-06-01'),
   'the order is dated when it actually happened', new Date(placed.created_at).toISOString().slice(0, 10));

// ── refuses the obviously wrong ─────────────────────────────────────────────
const future = await record(newcomer, { placed_at: '2099-01-01T00:00:00Z' });
ok(future.status === 400, 'a future date is refused', `HTTP ${future.status}`);
const noItems = await asAdmin('/api/admin/orders/backdated', {
  method: 'POST', body: JSON.stringify({ user_id: newcomer.id, items: [] }),
});
ok(noItems.status === 400, 'an empty order is refused', `HTTP ${noItems.status}`);
const badQty = await record(newcomer, { items: [{ product_id: product.id, quantity: 0, unit_price: 50 }] });
ok(badQty.status === 400, 'a zero quantity is refused', `HTTP ${badQty.status}`);
const ghost = await record(newcomer, { items: [{ product_id: 99999999, quantity: 1, unit_price: 5 }] });
ok(ghost.status === 400, 'an unknown product is refused', `HTTP ${ghost.status}`);

const repTry = await client(INVOICE_URL, newcomer.token)('/api/admin/orders/backdated', {
  method: 'POST', body: JSON.stringify({ user_id: newcomer.id, items: [{ product_id: product.id, quantity: 1, unit_price: 5 }] }),
});
ok(repTry.status === 403, 'a rep cannot record orders for anyone', `HTTP ${repTry.status}`);

// ── grandfathering is now settable, and visible ─────────────────────────────
const promote = await asAdmin(`/api/users/${newcomer.id}/house-rate`, {
  method: 'PATCH', body: JSON.stringify({ grandfathered: true }),
});
ok(promote.status === 200, 'an admin can grandfather a rep onto 5%', `HTTP ${promote.status}`);
ok((await db('SELECT house_5pct FROM users WHERE id=$1', [newcomer.id])).rows[0].house_5pct === true,
   'and the flag is set');
const nowFive = (await commissionsFor((await (await record(newcomer)).json()).order.id)).rows;
ok(Number(nowFive[0]?.rate) === 0.05, 'their NEXT order pays 5%', `${Number(nowFive[0]?.rate) * 100}%`);
ok(Number((await commissionsFor(b2.order.id)).rows[0].rate) === 0.02,
   'while the earlier order keeps the 2% it was placed at — not retroactive');

const demote = await asAdmin(`/api/users/${newcomer.id}/house-rate`, {
  method: 'PATCH', body: JSON.stringify({ grandfathered: false }),
});
ok(demote.status === 200, 'and can be taken back off');
const selfPay = await asAdmin(`/api/users/${house.id}/house-rate`, {
  method: 'PATCH', body: JSON.stringify({ grandfathered: true }),
});
ok(selfPay.status === 400, 'the house partner cannot be set to pay himself', `HTTP ${selfPay.status}`);
const repSets = await client(INVOICE_URL, newcomer.token)(`/api/users/${newcomer.id}/house-rate`, {
  method: 'PATCH', body: JSON.stringify({ grandfathered: true }),
});
ok(repSets.status === 403, 'a rep cannot grandfather themselves', `HTTP ${repSets.status}`);

const userList = await (await asAdmin('/api/users')).json();
ok(userList.some(u => 'house_5pct' in u), 'the admin user list reports who is grandfathered');

// ── the roster: he sees them, they never see him ────────────────────────────
const roster = await (await asHouse('/api/my-reps')).json();
const byId = Object.fromEntries((roster.reps || []).map(r => [r.id, r]));
ok(!!byId[grandfathered.id], 'the house partner SEES a grandfathered rep in his roster');
ok(!!byId[recruit.id], 'and his own recruit');
ok(byId[grandfathered.id]?.your_rate === 5, 'a grandfathered rep is shown at 5%', String(byId[grandfathered.id]?.your_rate));
ok(!!byId[newcomer.id],
   'AND a plain network rep who is neither grandfathered nor recruited — they used to be invisible');
ok(byId[newcomer.id]?.your_rate === 2,
   'shown at 2%, not the flat 5% it used to claim for everyone', String(byId[newcomer.id]?.your_rate));
ok(byId[house.id] === undefined, 'he never appears in his own roster');
ok(byId[grandfathered.id]?.earned_total > 0, 'with what they have actually earned him',
   `$${byId[grandfathered.id]?.earned_total}`);

// The rep on the paying end must see none of it.
const theirs = await (await client(INVOICE_URL, grandfathered.token)('/api/commissions')).json();
ok(Array.isArray(theirs) && theirs.every(c => c.earner_id === grandfathered.id),
   'a rep only ever sees commissions THEY earn, never the house cut on their own orders',
   `${theirs.length} row(s)`);
ok(!JSON.stringify(theirs).includes(String(house.id)) || theirs.length === 0,
   "so the house partner's earnings never appear on their tab");
const theirRoster = await (await client(INVOICE_URL, grandfathered.token)('/api/my-reps')).json();
ok((theirRoster.reps || []).length === 0 && theirRoster.flat_rate_others === null,
   'and a plain rep gets no roster and no house rate at all');

// Put the real house partner back.
await db('UPDATE users SET house_partner=FALSE WHERE id=$1', [house.id]);
if (prior.length) await db('UPDATE users SET house_partner=TRUE WHERE id = ANY($1)', [prior]);
await db('DELETE FROM commissions WHERE buyer_id = ANY($1)',
  [[grandfathered.id, newcomer.id, recruit.id, house.id]]).catch(() => {});

await finish(T);

/**
 * The store's sales-tax resale certificate.
 *
 * A distributor sells to a store tax-free on the strength of this number — the
 * store is buying to resell, so tax is collected from the shopper at the
 * register rather than from the store at wholesale. The seller has to be able
 * to produce the buyer's certificate if a state asks, which is why it is
 * collected at onboarding and copied onto the order.
 *
 * The copy is the part worth testing. Reading it live off the store would mean
 * an old invoice silently changes its certificate number the day a store
 * renews — the invoice has to keep showing what was actually relied on for
 * THAT sale.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, makeStore, makeProduct, tag,
} from './lib/harness.mjs';

const T = tag();
const rep = await makeUser('dsd', T);
const admin = await makeUser('admin', T);
const asRep = client(INVOICE_URL, rep.token);
const asAdmin = client(INVOICE_URL, admin.token);

// ── collected when the rep onboards the store ───────────────────────────────
const claim = await asRep('/api/stores/claim', {
  method: 'POST',
  body: JSON.stringify({
    name: `Resale Store ${T}`, address: '1 Main St', city: 'Miami', state: 'FL', zip: '33132',
    resale_number: 'FL-85-1234567',
  }),
});
const claimed = await claim.json();
ok(claim.status === 200 && claimed.success, 'a rep can add a store with its resale number', `HTTP ${claim.status}`);

const stored = (await db('SELECT id, resale_number FROM stores WHERE id=$1', [claimed.id])).rows[0];
ok(stored.resale_number === 'FL-85-1234567', 'it is stored on the store record', stored.resale_number || 'MISSING');

// Optional — a rep who does not have it yet must still be able to add the store.
const noCert = await asRep('/api/stores/claim', {
  method: 'POST',
  body: JSON.stringify({ name: `No Cert ${T}`, city: 'Tampa', state: 'FL' }),
});
const noCertBody = await noCert.json();
ok(noCert.status === 200 && noCertBody.success, 'and a store with NO certificate can still be added', `HTTP ${noCert.status}`);
const blank = (await db('SELECT resale_number FROM stores WHERE id=$1', [noCertBody.id])).rows[0];
ok(blank.resale_number === null, 'missing is stored as NULL, not an empty string', String(blank.resale_number));

// ── editable, and clearable ─────────────────────────────────────────────────
const patched = await asRep(`/api/stores/${claimed.id}`, {
  method: 'PATCH', body: JSON.stringify({ resale_number: 'FL-85-7654321' }),
});
ok(patched.status === 200, 'the certificate can be corrected later', `HTTP ${patched.status}`);
ok((await db('SELECT resale_number FROM stores WHERE id=$1', [claimed.id])).rows[0].resale_number === 'FL-85-7654321',
   'and the new number is saved');

await asRep(`/api/stores/${claimed.id}`, { method: 'PATCH', body: JSON.stringify({ resale_number: '  ' }) });
ok((await db('SELECT resale_number FROM stores WHERE id=$1', [claimed.id])).rows[0].resale_number === null,
   'blanking it clears to NULL — a wrong number is not permanent');

// Put it back for the ordering checks below.
await asRep(`/api/stores/${claimed.id}`, { method: 'PATCH', body: JSON.stringify({ resale_number: 'FL-85-7654321' }) });

// ── someone else's store is still someone else's ────────────────────────────
const other = await makeUser('dsd', T, { emailRole: 'dsd2' });
const stranger = await client(INVOICE_URL, other.token)(`/api/stores/${claimed.id}`, {
  method: 'PATCH', body: JSON.stringify({ resale_number: 'HACKED' }),
});
ok(stranger.status === 403, "another rep cannot edit your store's certificate", `HTTP ${stranger.status}`);

// ── copied onto the order, not read live ────────────────────────────────────
// Orders are placed from the server-side cart, not from posted line items —
// pricing is quoted there, so the client can't name its own total.
const product = await makeProduct(T, { stock: 500 });
async function placeFor(storeId, qty = 3) {
  // Carts are per store, so the cart has to be built against the same store
  // the order names — quoteCart looks it up by (user, store).
  await asRep('/api/cart', { method: 'DELETE' });
  await asRep('/api/cart/add', {
    method: 'POST',
    body: JSON.stringify({ product_id: product.id, quantity: qty, store_id: storeId }),
  });
  const r = await asRep('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      store_id: storeId, payment_method: 'invoice', shipping_name: 'T',
      shipping_address: '1 Main St', shipping_city: 'Miami', shipping_state: 'FL', shipping_zip: '33132',
    }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const place = await placeFor(claimed.id);
const order = place.body;
ok(place.status === 201, 'an order is placed for that store', `HTTP ${place.status} ${place.body?.error || ''}`);
const onOrder = (await db('SELECT resale_number FROM orders WHERE id=$1', [order.id])).rows[0];
ok(onOrder.resale_number === 'FL-85-7654321', 'the certificate is COPIED onto the order', onOrder.resale_number || 'MISSING');

// The store renews. The order must not change underneath it.
await asRep(`/api/stores/${claimed.id}`, { method: 'PATCH', body: JSON.stringify({ resale_number: 'FL-99-0000001' }) });
const afterRenewal = (await db('SELECT resale_number FROM orders WHERE id=$1', [order.id])).rows[0];
ok(afterRenewal.resale_number === 'FL-85-7654321',
   'and does NOT change when the store later renews its certificate', afterRenewal.resale_number);

// ── and it reaches the invoice ──────────────────────────────────────────────
const inv = await asRep(`/api/invoices/${order.id}/print`);
const html = await inv.text();
ok(inv.status === 200, 'the invoice renders', `HTTP ${inv.status}`);
ok(html.includes('FL-85-7654321'), 'the invoice shows the certificate relied on for this sale');
ok(!html.includes('FL-99-0000001'), 'not the renewed one the store has today');
ok(/Resale cert/.test(html), 'and labels it so a state auditor can find it');

// A store with no certificate is called out rather than left silently blank.
const bare = await makeStore(T);
await db('UPDATE stores SET exclusive_rep_id=$1 WHERE id=$2', [rep.id, bare.id]);
await db('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rep.id, bare.id]);
const bareOrder = (await placeFor(bare.id, 1)).body;
const bareHtml = await (await asRep(`/api/invoices/${bareOrder.id}/print`)).text();
ok(/No resale certificate on file/.test(bareHtml),
   'an invoice with no certificate says so instead of showing a blank line');

// ── the admin path carries it too ───────────────────────────────────────────
const adminStore = await (await asAdmin('/api/stores', {
  method: 'POST',
  body: JSON.stringify({ name: `Admin Store ${T}`, city: 'Orlando', state: 'FL', resale_number: 'FL-11-2222222' }),
})).json();
ok((await db('SELECT resale_number FROM stores WHERE id=$1', [adminStore.id])).rows[0].resale_number === 'FL-11-2222222',
   'an admin creating a store can record the certificate too');

// ── it travels to the Sales Suite ───────────────────────────────────────────
const INTEGRATION = await (await client(INVOICE_URL)('/js/app.js')).text();
ok(/cs-resale/.test(INTEGRATION), 'the claim form collects it');
const HTML = await (await client(INVOICE_URL)('/dashboard-dsd.html')).text();
ok(/id="cs-resale"/.test(HTML), 'and the field exists on the add-store modal');

await finish(T);

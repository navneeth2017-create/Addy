/**
 * Adding a store you are not standing in front of.
 *
 * Reps enter stores from home. The photo modal had no way past it for a manual
 * claim — no skip control, no close button — so a rep at a kitchen table simply
 * could not add a store at all. Danny hit exactly this.
 *
 * Deferring is now allowed, but it is a real commitment rather than a dismissal:
 *  - the deadline moves ON THE SERVER (the old skip only hid the modal, leaving
 *    the 24-hour claim deadline in place, so a "skipped" store was overdue by
 *    the next morning),
 *  - it costs an explicit agreement,
 *  - it can only be taken once per store, or the requirement means nothing,
 *  - and the 120 days run from when the store was ENTERED, so sitting on the
 *    prompt doesn't buy extra time.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, makeStore, tag,
} from './lib/harness.mjs';

const T = tag();
const rep = await makeUser('dsd', T);
const other = await makeUser('dsd', T, { emailRole: 'dsd2' });
const asRep = client(INVOICE_URL, rep.token);
const asOther = client(INVOICE_URL, other.token);

/** Claim a fresh store for `rep` the way the app does, with the 24h deadline. */
async function claimedStore(claimedDaysAgo = 0) {
  const s = await makeStore(T);
  await db(
    `UPDATE stores SET exclusive_rep_id=$1, store_approval_status='approved',
            photos_due_at=NOW() + INTERVAL '24 hours', photos_complete=false,
            photos_deferred_at=NULL, claimed_via='manual',
            claimed_at=NOW() - ($2 || ' days')::interval
     WHERE id=$3`, [rep.id, String(claimedDaysAgo), s.id]);
  await db('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rep.id, s.id]);
  return s;
}

const hoursUntil = (ts) => (new Date(ts).getTime() - Date.now()) / 3_600_000;

// ── the deferral itself ─────────────────────────────────────────────────────
const store = await claimedStore();
const before = (await db('SELECT photos_due_at FROM stores WHERE id=$1', [store.id])).rows[0];
ok(hoursUntil(before.photos_due_at) < 25, 'a fresh manual claim is due within 24 hours',
   `${hoursUntil(before.photos_due_at).toFixed(1)}h`);

const res = await asRep(`/api/stores/${store.id}/photos/defer`, {
  method: 'POST', body: JSON.stringify({ agreed: true }),
});
const body = await res.json();
ok(res.status === 200, 'a rep can defer the photos', `HTTP ${res.status}`);
ok(body.days === 120, 'the agreement is for 120 days', `${body.days} days`);

const after = (await db('SELECT photos_due_at, photos_deferred_at FROM stores WHERE id=$1', [store.id])).rows[0];
const days = hoursUntil(after.photos_due_at) / 24;
ok(days > 119 && days < 121, 'the deadline REALLY moved, in the database', `${days.toFixed(1)} days`);
ok(!!after.photos_deferred_at, 'and the agreement is recorded for audit');

// ── the clock runs from when the store was entered ──────────────────────────
// Sitting on the prompt for a month must not buy a month of extra time.
const old = await claimedStore(30);
await asRep(`/api/stores/${old.id}/photos/defer`, { method: 'POST', body: JSON.stringify({ agreed: true }) });
const oldDays = hoursUntil((await db('SELECT photos_due_at FROM stores WHERE id=$1', [old.id])).rows[0].photos_due_at) / 24;
ok(oldDays > 89 && oldDays < 91,
   'a store entered 30 days ago has 90 days left, not a fresh 120', `${oldDays.toFixed(1)} days`);

// ...but a store entered long ago must not be born overdue, which would make
// deferring pointless. A floor keeps the agreement worth taking.
const ancient = await claimedStore(400);
await asRep(`/api/stores/${ancient.id}/photos/defer`, { method: 'POST', body: JSON.stringify({ agreed: true }) });
const ancientDays = hoursUntil((await db('SELECT photos_due_at FROM stores WHERE id=$1', [ancient.id])).rows[0].photos_due_at) / 24;
ok(ancientDays > 29 && ancientDays < 31,
   'a very old store still gets a 30-day floor rather than being instantly overdue',
   `${ancientDays.toFixed(1)} days`);

// ── it is a commitment, not a dismissal ─────────────────────────────────────
const store2 = await claimedStore();
const noAgree = await asRep(`/api/stores/${store2.id}/photos/defer`, {
  method: 'POST', body: JSON.stringify({}),
});
ok(noAgree.status === 400, 'deferring without agreeing is refused', `HTTP ${noAgree.status}`);
const stillDue = (await db('SELECT photos_due_at, photos_deferred_at FROM stores WHERE id=$1', [store2.id])).rows[0];
ok(hoursUntil(stillDue.photos_due_at) < 25, 'and the deadline did not move');
ok(!stillDue.photos_deferred_at, 'and nothing was recorded');

const lied = await asRep(`/api/stores/${store2.id}/photos/defer`, {
  method: 'POST', body: JSON.stringify({ agreed: 'yes' }),
});
ok(lied.status === 400, 'a truthy non-true "agreed" is not agreement', `HTTP ${lied.status}`);

// ── once per store, or the requirement is meaningless ───────────────────────
const twice = await asRep(`/api/stores/${store.id}/photos/defer`, {
  method: 'POST', body: JSON.stringify({ agreed: true }),
});
ok(twice.status === 409, 'the SAME store cannot be deferred a second time', `HTTP ${twice.status}`);
const unmoved = (await db('SELECT photos_due_at FROM stores WHERE id=$1', [store.id])).rows[0];
ok(hoursUntil(unmoved.photos_due_at) / 24 < 121, 'so the deadline cannot be rolled forever');

// ── it is still someone else's store ────────────────────────────────────────
const store3 = await claimedStore();
const stranger = await asOther(`/api/stores/${store3.id}/photos/defer`, {
  method: 'POST', body: JSON.stringify({ agreed: true }),
});
ok(stranger.status === 403, "another rep cannot defer a store they don't own", `HTTP ${stranger.status}`);

const missing = await asRep('/api/stores/99999999/photos/defer', {
  method: 'POST', body: JSON.stringify({ agreed: true }),
});
ok(missing.status === 404, 'an unknown store is a 404, not a crash', `HTTP ${missing.status}`);

// ── coordinates: a fill-once cache, not an edit ─────────────────────────────
const geoStore = await claimedStore();
const geo = await asRep(`/api/stores/${geoStore.id}/geo`, {
  method: 'POST', body: JSON.stringify({ latitude: 25.7617, longitude: -80.1918 }),
});
ok(geo.status === 200, 'a rep can cache their own store coordinates', `HTTP ${geo.status}`);
const coords = (await db('SELECT latitude, longitude FROM stores WHERE id=$1', [geoStore.id])).rows[0];
ok(Math.abs(coords.latitude - 25.7617) < 0.001, 'the coordinates were stored', String(coords.latitude));

await asRep(`/api/stores/${geoStore.id}/geo`, {
  method: 'POST', body: JSON.stringify({ latitude: 0, longitude: 0 }),
});
const unchanged = (await db('SELECT latitude FROM stores WHERE id=$1', [geoStore.id])).rows[0];
ok(Math.abs(unchanged.latitude - 25.7617) < 0.001,
   'a second write does NOT move an already-placed store', String(unchanged.latitude));

const badGeo = await asRep(`/api/stores/${geoStore.id}/geo`, {
  method: 'POST', body: JSON.stringify({ latitude: 999, longitude: 'north' }),
});
ok(badGeo.status === 400, 'nonsense coordinates are refused', `HTTP ${badGeo.status}`);

const geoStranger = await asOther(`/api/stores/${geoStore.id}/geo`, {
  method: 'POST', body: JSON.stringify({ latitude: 1, longitude: 1 }),
});
ok(geoStranger.status === 403, "and you cannot place someone else's store", `HTTP ${geoStranger.status}`);

// ── the reminder needs an address to work with ──────────────────────────────
const pending = await (await asRep('/api/my-stores/photos-pending')).json();
const row = pending.find(s => s.id === geoStore.id);
ok(!!row, 'a deferred store still shows as owing photos');
ok('latitude' in row && 'address' in row,
   'and carries what the arrival reminder needs (coords + address)',
   row ? Object.keys(row).join(',') : 'missing');

// ── the front end no longer dead-ends ───────────────────────────────────────
const APP = await (await client(INVOICE_URL)('/js/app.js')).text();
const HTML = await (await client(INVOICE_URL)('/dashboard-dsd.html')).text();
ok(!/skipPhotosForNow/.test(APP), 'the client-only "skip" that never told the server is gone');
ok(/photos\/defer/.test(APP), 'the modal calls the real defer endpoint');
ok(/photo-defer-agree/.test(HTML), 'and makes you tick the agreement first');
ok(/<strong>within 120 days<\/strong>/.test(HTML), 'which states the 120-day deadline plainly');
ok(!/ARRIVAL_QUIET_MS/.test(APP) && /ARRIVAL_EXIT_M/.test(APP),
   'the reminder fires per VISIT, not on an hourly timer');
ok(!/display\s*=\s*isBulk \? 'block' : 'none'/.test(APP),
   'the defer control is no longer hidden for manual claims — the bug Danny hit');

await finish(T);

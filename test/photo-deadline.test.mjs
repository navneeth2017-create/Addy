/**
 * How long a rep actually has to photograph a store, and which stores the
 * reminder can see.
 *
 * Both of these were wrong in ways that only showed up on a real account:
 *
 *  - A claim set 24 hours unless the rep explicitly deferred. A rep who simply
 *    closed the modal was overdue by the next morning, having never been told
 *    that was the deal. The CSV path set 60 days over 25 rows and 24 hours
 *    under, so the deadline depended on how someone split their file.
 *  - The reminder required photos_due_at IS NOT NULL and read ownership from
 *    exclusive_rep_id alone. A store claimed through the CSV path as an
 *    existing record got no deadline at all and was therefore invisible to it —
 *    which is how a rep with two storeless-of-photos stores was told one.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, makeStore, tag,
} from './lib/harness.mjs';

const T = tag();
const rep = await makeUser('dsd', T);
const asRep = client(INVOICE_URL, rep.token);
const daysUntil = (ts) => (new Date(ts).getTime() - Date.now()) / 86_400_000;

// ── claiming a store gives 120 days, not 24 hours ───────────────────────────
const claim = await asRep('/api/stores/claim', {
  method: 'POST',
  body: JSON.stringify({ name: `Deadline Store ${T}`, address: '1 Main St', city: 'Miami', state: 'FL', zip: '33132' }),
});
const claimed = await claim.json();
ok(claim.status === 200 && claimed.success, 'a rep claims a store', `HTTP ${claim.status}`);

const row = (await db('SELECT photos_due_at, claimed_at FROM stores WHERE id=$1', [claimed.id])).rows[0];
const days = daysUntil(row.photos_due_at);
ok(days > 119 && days < 121, 'the photo deadline is 120 days, straight from the claim', `${days.toFixed(1)} days`);
ok(!!row.claimed_at, 'and the claim time is recorded to measure it from');

// ── deferring agrees to the same date, it does not extend it ────────────────
const defer = await asRep(`/api/stores/${claimed.id}/photos/defer`, {
  method: 'POST', body: JSON.stringify({ agreed: true }),
});
ok(defer.status === 200, 'the rep can still record the agreement', `HTTP ${defer.status}`);
const afterDefer = daysUntil((await db('SELECT photos_due_at FROM stores WHERE id=$1', [claimed.id])).rows[0].photos_due_at);
ok(Math.abs(afterDefer - days) < 1,
   'and it lands on the same date — agreeing does not buy extra time', `${afterDefer.toFixed(1)} days`);

// ── the reminder counts EVERY store that owes photos ────────────────────────
// The second store is linked the way the old CSV path left them: owned, but
// with no deadline written at all.
const noDeadline = await makeStore(T);
await db('UPDATE stores SET exclusive_rep_id=$1, photos_complete=false, photos_due_at=NULL WHERE id=$2',
  [rep.id, noDeadline.id]);
await db('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rep.id, noDeadline.id]);

// And a third linked only through owner_stores, with no exclusive_rep_id.
const ownerOnly = await makeStore(T);
await db('UPDATE stores SET exclusive_rep_id=NULL, photos_complete=false, photos_due_at=NOW() + INTERVAL \'10 days\' WHERE id=$1',
  [ownerOnly.id]);
await db('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rep.id, ownerOnly.id]);

const pending = await (await asRep('/api/my-stores/photos-pending')).json();
const ids = pending.map(p => p.id);
ok(ids.includes(claimed.id), 'the claimed store is listed as owing photos');
ok(ids.includes(noDeadline.id),
   'so is one with NO deadline recorded — it used to be filtered out and silently uncounted');
ok(ids.includes(ownerOnly.id),
   'and one linked only through owner_stores — the ownership drift hid it too');
ok(pending.length >= 3, 'the count matches what the rep actually owes', `${pending.length} store(s)`);

// ── a store with both photos drops off ──────────────────────────────────────
await db('UPDATE stores SET photos_complete=true WHERE id=$1', [ownerOnly.id]);
const after = await (await asRep('/api/my-stores/photos-pending')).json();
ok(!after.map(p => p.id).includes(ownerOnly.id), 'a finished store stops being nagged about');

// ── the CSV path no longer changes the deadline by batch size ───────────────
const SRC = await (await client(INVOICE_URL)('/js/app.js')).text();
ok(!/60 \* 24 \* 60 \* 60 \* 1000/.test(SRC), 'no stray 60-day path left on the client');

await finish(T);

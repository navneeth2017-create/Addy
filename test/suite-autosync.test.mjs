/**
 * A store added in Addy reaches the rep's Sales Suite by itself.
 *
 * The mirror used to run only on a CSV import, so a rep typing in one store —
 * which is how most stores get added, one at a time on the road — had to enter
 * it a second time in Monarch. It now runs on a single claim too.
 *
 * That path is fire-and-forget on purpose: a slow or unreachable Monarch must
 * never block or fail an Addy claim. Which means Addy's own response cannot
 * tell you the store landed, and a test that only checks Addy's reply proves
 * nothing. So this one reads what the fake Monarch actually received.
 */
import fs from 'node:fs';
import path from 'node:path';
import { INVOICE_URL, client, db, ok, finish, makeUser, tag } from './lib/harness.mjs';

const RECEIVED = path.join(new URL('.', import.meta.url).pathname, '.fake-monarch.json');
const landed = () => { try { return JSON.parse(fs.readFileSync(RECEIVED, 'utf8')); } catch (e) { return []; } };

/** The mirror is background, so give it a moment before declaring it absent. */
async function waitForStore(nameFragment, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = landed().find(r => (r.name || '').includes(nameFragment));
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

const T = tag();
const rep = await makeUser('dsd', T);
const asRep = client(INVOICE_URL, rep.token);

// Give this rep a live Suite. Without one the mirror correctly does nothing.
await db(
  `INSERT INTO monarch_workspaces (user_id, slug, tier, status, monarch_provisioned, monarch_email)
   VALUES ($1,$2,'pro','active',true,$3)
   ON CONFLICT (user_id) DO UPDATE SET status='active', monarch_provisioned=true`,
  [rep.id, `harness-${T}`, rep.email]
);

// ── one store, typed in by hand ─────────────────────────────────────────────
const res = await asRep('/api/stores/claim', {
  method: 'POST',
  body: JSON.stringify({
    name: `AutoSync ${T}`, address: '123 New St', city: 'Sarasota', state: 'FL', zip: '34231',
    phone: '9415557777', email: `store_${T}@example.com`, owner_name: 'Raj',
    resale_number: 'FL-55-1234567',
  }),
});
const body = await res.json();
ok(res.status === 200 && body.success, 'a rep adds a single store by hand', `HTTP ${res.status}`);
ok(body.suite_mirror === true, 'and is told it is going to their Suite too');

const sent = await waitForStore(`AutoSync ${T}`);
ok(!!sent, 'Monarch RECEIVED it with no button pressed',
   sent ? sent.name : `nothing arrived (${landed().length} row(s) total)`);

if (sent) {
  ok(sent.address_line1 === '123 New St' && sent.city === 'Sarasota' && sent.state === 'FL',
     'with the address', `${sent.address_line1}, ${sent.city} ${sent.state}`);
  ok(sent.phone === '9415557777', 'the phone', sent.phone);
  ok(sent.contact_name === 'Raj', 'the contact', sent.contact_name);
  ok(sent.resale_number === 'FL-55-1234567',
     'and the resale certificate — collected once, not asked for twice', sent.resale_number);
  ok(sent.relationship_status === 'current',
     'filed as a customer rather than a lead — they are already buying', sent.relationship_status);
}

// ── a rep with no Suite is unaffected ───────────────────────────────────────
const plain = await makeUser('dsd', T, { emailRole: 'nosuite' });
const noSuite = await client(INVOICE_URL, plain.token)('/api/stores/claim', {
  method: 'POST', body: JSON.stringify({ name: `NoSuite ${T}`, city: 'Tampa', state: 'FL' }),
});
const noSuiteBody = await noSuite.json();
ok(noSuite.status === 200 && noSuiteBody.success,
   'a rep without a Suite still adds stores normally', `HTTP ${noSuite.status}`);
ok(!noSuiteBody.suite_mirror, 'and nothing is claimed about a Suite they do not have');
ok(!(await waitForStore(`NoSuite ${T}`, 1500)), 'their store is not sent anywhere');

// ── the backlog button pushes what is already there ─────────────────────────
const sync = await asRep('/api/monarch/sync-stores', { method: 'POST', body: JSON.stringify({}) });
const syncBody = await sync.json();
ok(sync.status === 200 && syncBody.success, 'the manual send still works for older stores', `HTTP ${sync.status}`);
ok(typeof syncBody.created === 'number',
   'and reports what actually happened rather than a flat count', syncBody.message);

await db('DELETE FROM monarch_workspaces WHERE user_id=$1', [rep.id]).catch(() => {});
await finish(T);

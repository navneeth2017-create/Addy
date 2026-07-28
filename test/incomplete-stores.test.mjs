/**
 * Stores that arrive from a spreadsheet with gaps in them.
 *
 * A rep drops in an export of their route and some rows are half-filled — no
 * phone on one, no ZIP on another, no resale certificate on a third. The import
 * mentioned that once in the result dialog and then forgot it: nothing was
 * recorded, so the moment the dialog closed there was no way to find those
 * stores again. They sat there with no number to ring and no address to
 * navigate to until somebody happened to open one.
 *
 * Gaps are deliberately never a hard failure. A half-filled row is still a real
 * store, and rejecting it would just send the rep back to their spreadsheet.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, tag,
} from './lib/harness.mjs';

const T = tag();
const rep = await makeUser('dsd', T);
const asRep = client(INVOICE_URL, rep.token);

const full = {
  name: `Complete ${T}`, address: '1 Main St', city: 'Miami', state: 'FL',
  zip: '33132', phone: '3055550100', resale_number: 'FL-85-1111111',
};
const noPhone   = { name: `NoPhone ${T}`,  address: '2 Oak Ave', city: 'Tampa',   state: 'FL', zip: '33602', resale_number: 'FL-85-2222222' };
const noAddress = { name: `NoAddr ${T}`,   city: 'Orlando', state: 'FL', phone: '4075550100', resale_number: 'FL-85-3333333' };
const bare      = { name: `Bare ${T}` };
const naZip     = { name: `NaZip ${T}`,    address: '4 Elm St', city: 'Naples', state: 'FL', zip: 'N/A', phone: '2395550100', resale_number: 'FL-85-4444444' };

const res = await asRep('/api/stores/bulk-import', {
  method: 'POST', body: JSON.stringify({ rows: [full, noPhone, noAddress, bare, naZip] }),
});
const body = await res.json();
ok(res.status === 200, 'the import runs', `HTTP ${res.status}`);
ok(body.created === 5, 'every row is imported — a gap is never a hard failure', `${body.created} created`);
ok(body.incomplete === 4, 'and the four short rows are counted', `${body.incomplete} incomplete`);

const byName = Object.fromEntries((body.results || []).filter(r => r.name).map(r => [r.name, r]));
ok(!byName[full.name]?.missing, 'a complete row is not flagged');
ok(byName[noPhone.name]?.missing?.includes('phone'), 'a row with no phone says so',
   (byName[noPhone.name]?.missing || []).join(', '));
ok(byName[noAddress.name]?.missing?.includes('street address') && byName[noAddress.name]?.missing?.includes('ZIP'),
   'a row with no address names every field it lacks', (byName[noAddress.name]?.missing || []).join(', '));
ok((byName[bare.name]?.missing || []).length === 6, 'a name-only row flags all six', `${(byName[bare.name]?.missing || []).length}`);
ok(byName[naZip.name]?.missing?.includes('ZIP'),
   '"N/A" counts as missing — a placeholder is not an answer', (byName[naZip.name]?.missing || []).join(', '));

// ── and they stay findable long after the dialog closes ─────────────────────
const stores = await (await asRep('/api/my-stores')).json();
const mine = Object.fromEntries(stores.map(s => [s.name, s]));
ok('missing_fields' in (stores[0] || {}), 'every store reports what it still needs');
ok((mine[full.name]?.missing_fields || []).length === 0, 'the complete one needs nothing');
ok(mine[noPhone.name]?.missing_fields?.includes('phone'), 'the phoneless one is still flagged later');
ok(stores.filter(s => (s.missing_fields || []).length).length === 4,
   'all four remain findable after the import dialog is gone',
   `${stores.filter(s => (s.missing_fields || []).length).length}`);

// ── filling a gap clears the flag, with no second step ──────────────────────
const target = mine[noPhone.name];
await asRep(`/api/stores/${target.id}`, { method: 'PATCH', body: JSON.stringify({ phone: '8135550199' }) });
const after = (await (await asRep('/api/my-stores')).json()).find(s => s.id === target.id);
ok((after.missing_fields || []).length === 0,
   'filling the phone clears it by itself — nothing to recompute or forget',
   (after.missing_fields || []).join(', ') || 'nothing missing');

// ── the deadline it reports is the real one ─────────────────────────────────
ok(body.photoDeadlineDays === 120,
   'the import reports the real photo deadline, not the old 60/1 by batch size', String(body.photoDeadlineDays));

// ── the sample file shows the columns we now ask for ────────────────────────
const csv = await (await asRep('/api/stores/example-csv')).text();
ok(/resale_number/.test(csv), 'the example CSV includes the resale number column');

await finish(T);

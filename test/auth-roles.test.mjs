/**
 * Who can sign in, where they land, and what their token opens.
 *
 * Includes regressions for the two login failures found on 2026-07-27:
 *   - an unrecognised role fell through to the admin dashboard, which requires
 *     'admin', so the user bounced back to login forever with no explanation;
 *   - a leftover admin "View as" preview outlived sign-out and hijacked the
 *     next login in that tab.
 * Both were reachable in production and neither was caught by reading the code.
 */
import {
  INVOICE_URL, client, db, ok, finish, makeUser, makeStore, PASSWORD, tag, login,
} from './lib/harness.mjs';

const T = tag();
const anon = client(INVOICE_URL);

const admin = await makeUser('admin', T);
const dsd = await makeUser('dsd', T);
const member = await makeUser('member', T, { parent_id: dsd.id });

// ── sign-in ─────────────────────────────────────────────────────────────────
for (const u of [admin, dsd, member]) {
  const { status, body } = await login(INVOICE_URL, u.email, PASSWORD);
  ok(status === 200 && !!body.token, `${u.role} can sign in`, `HTTP ${status}`);
  ok(body.role === u.role, `${u.role} is told the right role`, `got "${body.role}"`);
}

let res = await login(INVOICE_URL, admin.email, 'wrong');
ok(res.status === 401, 'a wrong password is rejected', `HTTP ${res.status}`);
res = await login(INVOICE_URL, `nobody_${T}@test.invalid`, PASSWORD);
ok(res.status === 401, 'an unknown email is rejected', `HTTP ${res.status}`);

// A deactivated account must not get in even with the right password.
await db('UPDATE users SET status=$1 WHERE id=$2', ['inactive', member.id]);
res = await login(INVOICE_URL, member.email, PASSWORD);
ok(res.status === 403, 'a deactivated account cannot sign in', `HTTP ${res.status}`);
await db('UPDATE users SET status=$1 WHERE id=$2', ['active', member.id]);

// ── every role lands on a dashboard that accepts it ─────────────────────────
// The login page maps role -> dashboard. Any role that has no mapping used to
// fall through to the ADMIN dashboard and bounce forever; assert every role we
// can actually create maps to a page whose own guard allows it.
const APP = await (await anon('/js/app.js')).text();
const mapBlock = APP.slice(APP.indexOf('const DASHBOARDS'), APP.indexOf('const DASHBOARDS') + 400);
for (const role of ['admin', 'dsd', 'member']) {
  ok(new RegExp(`\\b${role}:\\s*'dashboard-`).test(mapBlock), `login maps "${role}" to a dashboard`);
}
ok(/if \(!dest\)/.test(APP), 'an unmapped role is handled explicitly, not sent to the admin dashboard');
ok(!/default:\s*window\.location\.href = `\/dashboard-admin/.test(APP),
   'the old "unknown role -> admin dashboard" fallthrough is gone');

// The DSD dashboard guard must admit members, or every employee is locked out.
ok(/requireAuth\(\['dsd','member'\]\)/.test(APP.replace(/\s/g, '')) ||
   /requireAuth\(\['dsd', 'member'\]\)/.test(APP),
   'the DSD dashboard admits members as well as owners');

// ── a stale "View as" preview must not outlive sign-out ─────────────────────
ok(/function clearPreviewSession/.test(APP), 'there is a way to end an impersonation preview');

/** The text of a top-level function, start marker to the next one. A fixed
 *  character window is brittle — a comment growing by a line silently moves
 *  the assertion off the end of what it meant to check. */
function bodyOf(src, marker) {
  const from = src.indexOf(marker);
  if (from < 0) return '';
  const next = src.indexOf('\nfunction ', from + marker.length);
  return src.slice(from, next < 0 ? src.length : next);
}
ok(/clearPreviewSession\(\)/.test(bodyOf(APP, 'function logout()')), 'signing OUT ends any preview');
ok(/clearPreviewSession\(\)/.test(bodyOf(APP, 'async function handleLogin')), 'signing IN ends any leftover preview');
ok(/addy_preview_role/.test(APP.slice(APP.indexOf('function getRole'), APP.indexOf('function getRole') + 200)),
   'getRole still prefers an ACTIVE preview (the feature itself still works)');

// ── an unexpected sign-out explains itself ──────────────────────────────────
ok(/function recordSignout/.test(APP), 'sign-out reasons are recorded');
for (const marker of ['This page is for', 'No saved session', 'rejected your session']) {
  ok(APP.includes(marker), `a reason exists for: "${marker}…"`);
}
const LOGIN_HTML = await (await anon('/login.html')).text();
ok(LOGIN_HTML.includes('signout-reason'), 'the login page can display the reason');

// ── what a token actually opens ─────────────────────────────────────────────
const store = await makeStore(T);
const asAdmin = client(INVOICE_URL, admin.token);
const asDsd = client(INVOICE_URL, dsd.token);
const asMember = client(INVOICE_URL, member.token);

ok((await anon('/api/orders')).status === 401, 'no token means 401');
ok((await client(INVOICE_URL, 'not-a-jwt')('/api/orders')).status === 401, 'a malformed token means 401');
ok((await asAdmin('/api/activity-log')).status === 200, 'admin reaches an admin-only route');
ok((await asDsd('/api/activity-log')).status === 403, 'a DSD does NOT reach an admin-only route');
ok((await asMember('/api/activity-log')).status === 403, 'a member does NOT reach an admin-only route');

// Store editing follows ownership, not role alone.
ok((await asDsd(`/api/stores/${store.id}`, { method:'PATCH', body: JSON.stringify({ wholesale_price: 1 }) })).status === 403,
   'a DSD cannot edit a store they have not claimed');
await db('INSERT INTO owner_stores (owner_id, store_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [dsd.id, store.id]);
ok((await asDsd(`/api/stores/${store.id}`, { method:'PATCH', body: JSON.stringify({ wholesale_price: 4.25 }) })).status === 200,
   'a DSD CAN edit the store they own');

await finish(T);

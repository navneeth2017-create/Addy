/**
 * The Settings payments card: which Stripe account this portal charges into,
 * answered from the dashboard instead of by searching inboxes for the signup
 * email. Identity only — the endpoint must never echo a key.
 */
import {
  INVOICE_URL, CARD_URL, client, makeUser, cleanup, ok, report,
} from './lib/harness.mjs';

const T = `ss${Date.now().toString(36)}`;
const admin = await makeUser('admin', T);
const rep = await makeUser('dsd', T);

try {
  // ── who may ask ───────────────────────────────────────────────────────────
  {
    const r = await client(INVOICE_URL, rep.token)('/api/admin/stripe-status');
    ok(r.status === 403, 'a DSD cannot read the payments status', `got ${r.status}`);
    const r2 = await client(INVOICE_URL)('/api/admin/stripe-status');
    ok(r2.status === 401, 'no token, no answer', `got ${r2.status}`);
  }

  // ── invoice-only server (no Stripe key) ──────────────────────────────────
  {
    const s = await (await client(INVOICE_URL, admin.token)('/api/admin/stripe-status')).json();
    ok(s.configured === false, 'no key reports card payments off', JSON.stringify(s));
  }

  // ── card server (fake Stripe) ────────────────────────────────────────────
  {
    const s = await (await client(CARD_URL, admin.token)('/api/admin/stripe-status')).json();
    ok(s.configured === true, 'with a key it reports configured');
    ok(s.mode === 'test', 'sk_test is labelled test mode', s.mode);
    ok(s.account && s.account.email === 'owner@fake-stripe.test',
      'and names the account email — the thing the owner forgot', s.account && s.account.email);
    ok(s.account && s.account.business_name === 'Fake Stripe LLC', 'and the business name');
    ok(s.account && s.account.charges_enabled === true, 'and whether it can actually charge');
    const raw = JSON.stringify(s);
    ok(!/sk_(test|live)_\w{8}/.test(raw), 'the response never echoes a secret key');
  }
} finally {
  await cleanup(T);
}
process.exit(report());

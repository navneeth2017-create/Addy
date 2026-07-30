/**
 * The admin Mail tab: every email Addy sends, every email addydsd.com
 * receives, in one place an admin can actually read.
 *
 * Outbound is logged at the send facade, so the log is complete by
 * construction rather than by each route remembering. Inbound arrives from
 * Resend's email.received webhook. Both land in email_log; these tests hold
 * that table and the admin API to their contract.
 *
 * The harness runs without RESEND_WEBHOOK_SECRET and outside production, so
 * the webhook accepts unsigned events here — production refuses them outright
 * (an open endpoint that writes into the admin's inbox is a phishing machine).
 */
import {
  INVOICE_URL, client, makeUser, cleanup, db, ok, report,
} from './lib/harness.mjs';

const T = `mail${Date.now().toString(36)}`;
const admin = await makeUser('admin', T);
const rep = await makeUser('dsd', T);
const api = client(INVOICE_URL, admin.token);
const repApi = client(INVOICE_URL, rep.token);
const anon = client(INVOICE_URL);

const hook = (event) => anon('/api/webhooks/resend-inbound', {
  method: 'POST', body: JSON.stringify(event),
});
const inboundEvent = (id, over = {}) => ({
  type: 'email.received',
  data: {
    email_id: id,
    from: `Store Owner <owner+${T}@example.com>`,
    to: ['admin@addydsd.com'],
    subject: `Harness inbound ${T}`,
    ...over,
  },
});

try {
  // ── who may read the mailbox ──────────────────────────────────────────────
  {
    const r = await repApi('/api/admin/mail');
    ok(r.status === 403, 'a DSD cannot read the admin mailbox', `got ${r.status}`);
    const r2 = await anon('/api/admin/mail');
    ok(r2.status === 401, 'no token, no mailbox', `got ${r2.status}`);
    const r3 = await repApi('/api/admin/mail/send', {
      method: 'POST', body: JSON.stringify({ to: 'x@y.com', subject: 'hi', body: 'hi' }),
    });
    ok(r3.status === 403, 'a DSD cannot send as the portal', `got ${r3.status}`);
  }

  // ── inbound webhook ──────────────────────────────────────────────────────
  {
    const r = await hook(inboundEvent(`prov-${T}-1`));
    ok(r.status === 200, 'email.received is accepted', `got ${r.status}`);

    const list = await (await api('/api/admin/mail?box=inbox')).json();
    const mine = (list.messages || []).find(m => m.subject === `Harness inbound ${T}`);
    ok(!!mine, 'the email appears in the inbox');
    ok(mine && !mine.read_at, 'and lands unread');
    ok(list.unread >= 1, 'the unread count sees it', `unread=${list.unread}`);
    ok(mine && /owner\+/.test(mine.from_addr || ''), 'sender is recorded', mine && mine.from_addr);

    // Resend retries webhooks until acknowledged — the same email twice must
    // not become two inbox rows.
    await hook(inboundEvent(`prov-${T}-1`));
    const again = await (await api('/api/admin/mail?box=inbox')).json();
    const copies = (again.messages || []).filter(m => m.subject === `Harness inbound ${T}`);
    ok(copies.length === 1, 'a retried webhook does not duplicate the email', `found ${copies.length}`);

    // Opening marks it read and the unread count falls.
    const opened = await (await api(`/api/admin/mail/${mine.id}`)).json();
    ok(opened.id === mine.id, 'the message opens');
    const after = await (await api('/api/admin/mail?box=inbox')).json();
    const reread = (after.messages || []).find(m => m.id === mine.id);
    ok(reread && !!reread.read_at, 'opening marks it read');
  }

  // ── events that are not inbound mail ─────────────────────────────────────
  {
    const before = await (await api('/api/admin/mail?box=inbox')).json();
    const r = await hook({ type: 'email.delivered', data: { email_id: `prov-${T}-x` } });
    ok(r.status === 200, 'other event types are acknowledged (so Resend stops retrying)');
    const afterCount = await (await api('/api/admin/mail?box=inbox')).json();
    ok(afterCount.messages.length === before.messages.length,
      'but they do not become inbox rows');
  }

  // ── outbound: compose from the Mail tab ──────────────────────────────────
  {
    for (const [bad, why] of [
      [{ to: 'not-an-address', subject: 's', body: 'b' }, 'a bad address'],
      [{ to: 'a@b.co', subject: '', body: 'b' }, 'no subject'],
      [{ to: 'a@b.co', subject: 's', body: '   ' }, 'an empty message'],
    ]) {
      const r = await api('/api/admin/mail/send', { method: 'POST', body: JSON.stringify(bad) });
      ok(r.status === 400, `compose refuses ${why}`, `got ${r.status}`);
    }

    // The harness has no Resend key and no house workspace seeded, so this
    // send FAILS — and the failure must land in Sent with its reason, because
    // an outbox that only shows the successes is how mail goes missing
    // quietly.
    const r = await api('/api/admin/mail/send', {
      method: 'POST',
      body: JSON.stringify({ to: `dest+${T}@example.com`, subject: `Harness out ${T}`, body: 'hello from the harness' }),
    });
    ok(r.status === 200 || r.status === 500, 'compose reaches the mailer', `got ${r.status}`);
    const sent = await (await api('/api/admin/mail?box=sent')).json();
    const mine = (sent.messages || []).find(m => m.subject === `Harness out ${T}`);
    ok(!!mine, 'the attempt is in Sent either way');
    if (r.status === 500) {
      ok(mine && mine.status === 'failed' && !!mine.error, 'a failed send says so, with a reason',
        mine && `${mine.status}: ${mine.error}`);
    } else {
      ok(mine && mine.status !== 'failed', 'a delivered send is not marked failed', mine && mine.status);
    }

    // The full record keeps the branded body (the logo header the facade adds).
    const full = await (await api(`/api/admin/mail/${mine.id}`)).json();
    ok(/addy-mail-head/.test(full.body_html || ''), 'outbound bodies carry the ADDY logo header');
  }
} finally {
  await db(`DELETE FROM email_log WHERE subject LIKE $1 OR to_addr LIKE $2`, [`%${T}%`, `%${T}%`]).catch(() => {});
  await cleanup(T);
}
process.exit(report());

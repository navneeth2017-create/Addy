/**
 * Security regressions. Each of these was a live hole, and each is the kind
 * that comes back quietly during a refactor.
 *
 *  - The password-reset code was returned in the HTTP response whenever mail
 *    happened to be unconfigured. Anyone could post an admin's address, read
 *    the code out of the reply and take the account over without ever touching
 *    the mailbox.
 *  - The reset code came from Math.random(), a predictable PRNG.
 *  - /api/reset-password had no rate limit, so a six-digit code could simply
 *    be guessed through.
 *  - JWT_SECRET fell back to a fixed string committed to this repository, so
 *    any deployment missing the env var could have admin tokens forged by
 *    anyone who read the source.
 *  - No security headers were sent at all.
 */
import { execFile } from 'node:child_process';
import {
  INVOICE_URL, client, db, ok, finish, makeUser, PASSWORD, tag,
} from './lib/harness.mjs';

const T = tag();
const anon = client(INVOICE_URL);
const victim = await makeUser('admin', T);

// ── the reset code must never reach the caller ──────────────────────────────
const res = await anon('/api/forgot-password', { method: 'POST', body: JSON.stringify({ email: victim.email }) });
const body = await res.json();
ok(res.status === 200, 'forgot-password responds', `HTTP ${res.status}`);
ok(!('code' in body), 'the reset code is NOT in the response body', JSON.stringify(body));
ok(!JSON.stringify(body).match(/\b\d{6}\b/), 'no six-digit code leaks anywhere in the payload');

// It was still generated and stored — the flow works, it just isn't disclosed.
const stored = (await db(
  'SELECT code FROM password_resets WHERE user_id=$1 AND used=0 ORDER BY id DESC LIMIT 1', [victim.id]
)).rows[0];
ok(!!stored?.code, 'a code was still issued server-side', stored ? `${String(stored.code).length} digits` : 'none');

// ── the code must not be predictable ────────────────────────────────────────
const codes = new Set();
for (let i = 0; i < 5; i++) {
  await anon('/api/forgot-password', { method: 'POST', body: JSON.stringify({ email: victim.email }) });
  const r = (await db('SELECT code FROM password_resets WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [victim.id])).rows[0];
  if (r) codes.add(r.code);
}
ok(codes.size > 1, 'successive reset codes differ', `${codes.size} distinct`);
ok([...codes].every(c => /^\d{6}$/.test(String(c))), 'each is a six-digit code');

// ── guessing the code must be rate limited ──────────────────────────────────
let limited = false;
for (let i = 0; i < 14; i++) {
  const r = await anon('/api/reset-password', {
    method: 'POST',
    body: JSON.stringify({ email: victim.email, code: String(100000 + i), new_password: 'irrelevant123' }),
  });
  if (r.status === 429) { limited = true; break; }
}
ok(limited, 'repeated wrong codes get rate limited (429)', limited ? 'limiter fired' : 'NO LIMIT — brute-forceable');

// ── baseline security headers ───────────────────────────────────────────────
const page = await anon('/login.html');
const want = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
};
for (const [header, expected] of Object.entries(want)) {
  const got = page.headers.get(header);
  ok(got && got.toLowerCase() === expected.toLowerCase(), `${header} is set`, got || 'MISSING');
}
ok(/frame-ancestors/.test(page.headers.get('content-security-policy') || ''),
   'a frame-ancestors policy is set (clickjacking)', page.headers.get('content-security-policy') || 'MISSING');

// ── the app must refuse to run on the public fallback secret ────────────────
const bootResult = await new Promise((resolve) => {
  const child = execFile('node', ['boot.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '', PORT: '8987' },
    timeout: 20000,
  }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }));
  child.on('error', () => resolve({ code: -1, out: '' }));
});
ok(bootResult.code === 1, 'production boot without JWT_SECRET exits non-zero', `exit ${bootResult.code}`);
ok(/JWT_SECRET is not set/.test(bootResult.out), 'and says exactly what is wrong');
ok(!/running on port/i.test(bootResult.out), 'and never starts serving');

// ── authentication still actually works ─────────────────────────────────────
ok((await anon('/api/orders')).status === 401, 'an unauthenticated request is still refused');
ok((await client(INVOICE_URL, 'forged.token.here')('/api/orders')).status === 401, 'a forged token is refused');

await finish(T);

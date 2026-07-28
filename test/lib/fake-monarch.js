/**
 * A stand-in for Monarch, just large enough to prove Addy sends stores to it.
 *
 * The mirror is fire-and-forget by design — a slow or down Monarch must never
 * block an Addy claim — which also means nothing in Addy's own responses can
 * tell you the store actually arrived. Without something on the other end, the
 * only honest test is "we called a function", which is exactly the kind of test
 * that passes while the feature is broken.
 *
 * Writes everything it receives to test/.fake-monarch.json so a suite can read
 * back what landed.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', '.fake-monarch.json');
const PORT = Number(process.env.FAKE_MONARCH_PORT || 9977);

let received = [];
try { fs.unlinkSync(OUT); } catch (e) { /* first run */ }

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');

    // Partner SSO: hand back any staff token; Addy only passes it straight back.
    if (req.url.includes('/sso')) return res.end(JSON.stringify({ token: 'fake-staff-token' }));

    if (req.url === '/api/imports/stores') {
      const rows = (() => { try { return JSON.parse(body).rows || []; } catch (e) { return []; } })();
      received.push(...rows);
      fs.writeFileSync(OUT, JSON.stringify(received, null, 2));
      return res.end(JSON.stringify({ created: rows.length, skipped: 0, errors: 0 }));
    }

    // /plans and anything else the status card probes for.
    res.end(JSON.stringify({ plans: [] }));
  });
}).listen(PORT, () => console.log(`fake Monarch listening on ${PORT}`));

/**
 * Boots the REAL Addy server with a fake Stripe in place of the SDK, so every
 * branch of the payment code actually executes: intent creation, the
 * amount_received underpayment check, the intent-reuse check, and the
 * refund-on-out-of-stock path. Test-only — never loaded in production.
 */
const http = require('http');

const intents = new Map();
const calls = [];
let seq = 0;
// Namespace ids per boot. The database outlives the stub, so a fixed counter
// hands run #2 the same pi_fake_1 that run #1 already recorded on an invoice —
// and the (correct) intent-reuse check then rejects the happy path.
const RUN = `${process.pid}${Date.now().toString(36)}`;

function makeIntent({ amount, amount_received, status = 'succeeded' }) {
  const id = `pi_fake_${RUN}_${++seq}`;
  const intent = {
    id, amount,
    amount_received: amount_received === undefined ? amount : amount_received,
    status,
    client_secret: `${id}_secret`,
  };
  intents.set(id, intent);
  return intent;
}

const fakeStripe = {
  paymentIntents: {
    async create(args) {
      calls.push({ method: 'paymentIntents.create', args });
      return makeIntent({ amount: args.amount });
    },
    async retrieve(id) {
      calls.push({ method: 'paymentIntents.retrieve', args: { id } });
      const i = intents.get(String(id));
      if (!i) { const e = new Error(`No such payment_intent: ${id}`); e.statusCode = 404; throw e; }
      return i;
    },
  },
  accounts: {
    async retrieve() {
      calls.push({ method: 'accounts.retrieve', args: {} });
      return {
        email: 'owner@fake-stripe.test',
        business_profile: { name: 'Fake Stripe LLC' },
        charges_enabled: true,
        payouts_enabled: true,
      };
    },
  },
  refunds: {
    async create(args) {
      calls.push({ method: 'refunds.create', args });
      return { id: `re_fake_${RUN}_${++seq}`, payment_intent: args.payment_intent, status: 'succeeded' };
    },
  },
};

// Control plane so the test can seed intents the server didn't create
// (underpaid, still-processing) and inspect what the server asked Stripe to do.
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/seed' && req.method === 'POST') {
      return res.end(JSON.stringify(makeIntent(JSON.parse(body || '{}'))));
    }
    if (req.url === '/calls') return res.end(JSON.stringify(calls));
    if (req.url === '/reset' && req.method === 'POST') { calls.length = 0; return res.end('{"ok":true}'); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(9922);

const resolved = require.resolve('stripe', { paths: ['/workspace/addy'] });
require.cache[resolved] = {
  id: resolved, filename: resolved, loaded: true, children: [], paths: [],
  exports: () => fakeStripe,
};

require('/workspace/addy/boot.js');

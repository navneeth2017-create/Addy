# Payment + pricing tests

These cover the money path: what we charge, what we record, and what we give
back when an order can't be completed. They talk to a real server and a real
Postgres — nothing is mocked except Stripe.

## Why Stripe is faked

`fake-stripe-boot.js` swaps the Stripe SDK for an in-process stand-in before
`boot.js` loads, then serves a small control API on port 9922 so a test can
seed intents the server didn't create (underpaid, still-processing) and read
back exactly what the server asked Stripe to do.

That means the **real** payment code runs — the amount check, the intent-reuse
check, the refund calls — rather than being stubbed out. It is not a substitute
for one live test-mode order before a Stripe change goes out, but it does keep
every branch honest without needing card credentials in CI.

`fake-stripe-boot.js` is test-only and is never loaded by `npm start`.

## Running them

Needs Postgres with the schema applied.

    createdb addy   # if you haven't
    npm run test:payments

That boots two servers (8123 invoice-only, 8126 with fake Stripe) and runs all
four suites. They seed and clean up after themselves, but they DO write to the
database named in `DATABASE_URL` — point it at a scratch database, not
production.

## What's covered

- `pricing.test.mjs` — zone shipping, the free-shipping perks, the 15/27-box
  pallet tiers, the locked-margin floor, and that totals add up.
- `card-payments.test.mjs` — the amount sent to Stripe is the server's own
  quote; underpaid, unpaid, unknown and reused intents are all refused; the
  invoice records the intent so a refund is possible; you cannot settle
  someone else's order with your own payment.
- `refund-on-rollback.test.mjs` — the case that bit us: the browser charges the
  card before it posts the order, so an order that then fails leaves a real
  charge behind. Holds the product row in an uncommitted transaction to force
  the stock rollback deterministically, and asserts the refund goes out.

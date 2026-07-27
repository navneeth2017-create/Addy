# Addy tests

Regression cover for the parts that cost money or lock people out. They talk
to a real server and a real Postgres — nothing is mocked except Stripe.

## Running them

Needs Postgres with the schema applied.

    npm test

That boots two servers (8123 invoice-only, 8126 with a fake Stripe) and runs
every suite. Each seeds its own data under a unique tag and deletes it
afterwards, so they can run in any order, repeatedly, against a database that
already has real rows in it.

They DO write to the database named in `DATABASE_URL` — point it at a scratch
database, not production.

## The suites

| File | Covers |
|---|---|
| `auth-roles.test.mjs` | Who can sign in, where each role lands, what a token opens |
| `ordering.test.mjs` | Cart → order → invoice, stock, shipping zones, pallet tiers, both list views |
| `inventory.test.mjs` | Per-store stock: who may read, who may write, partial updates |
| `pricing.test.mjs` | Zone rates, free-shipping perks, pallet tiers, locked-margin floor |
| `card-payments.test.mjs` | Server-side quoting, underpaid/unpaid/unknown/reused intents, cross-user confirm |
| `refund-on-rollback.test.mjs` | A charge whose order fails is refunded, not stranded |

## Why Stripe is faked

`fake-stripe-boot.js` swaps the Stripe SDK for an in-process stand-in before
`boot.js` loads, then serves a small control API on port 9922 so a test can
seed intents the server didn't create (underpaid, still-processing) and read
back exactly what the server asked Stripe to do.

That means the **real** payment code runs — the amount check, the intent-reuse
check, the refund calls — rather than being stubbed out. It is not a substitute
for one live test-mode order before a Stripe change goes out, but it keeps
every branch honest without card credentials in CI.

`fake-stripe-boot.js` is test-only and is never loaded by `npm start`.

## Bugs these exist to catch

Every one of these was live in production at some point:

- An order marked `paid` with no proof of payment — anyone could POST
  `{payment_method:'card'}` and get a paid order for free.
- The charge amount taken from the browser rather than computed server-side.
- A charge stranded with no order and no refund when checkout failed after the
  card was taken.
- Two checkouts racing for the last box, both succeeding, stock going negative.
- Simultaneous checkouts receiving the same invoice number.
- DSD owners getting a 403 on their own store's inventory, and a not-null
  violation hiding underneath that 403.
- An unrecognised role falling through to the admin dashboard and bouncing the
  user back to login forever, with nothing on screen explaining it.
- A leftover admin "View as" preview outliving sign-out and hijacking the next
  login in that tab.

## Writing more

Two rules, both learned by getting them wrong:

1. **Never assert on a wall-clock window** ("orders created in the last 10
   seconds"). Sibling suites legitimately create rows at the same moment, and
   you get intermittent failures that look like real bugs. Take an id baseline.
2. **Never assert on a fixed character window** of a source file. A comment
   growing by a line silently moves the assertion off the end of what it meant
   to check. `bodyOf()` in `auth-roles.test.mjs` shows the safer approach.

`lib/harness.mjs` has the shared plumbing: `makeUser`/`makeStore`/`makeProduct`
for seeding, `client()` for authenticated requests, `login()` which waits out
the login rate limiter, and `ok()`/`finish()` for assertions and cleanup.

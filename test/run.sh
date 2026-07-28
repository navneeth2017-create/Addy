#!/usr/bin/env bash
# Boots both servers and runs every suite. See test/README.md.
set -uo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://monarch:monarch@127.0.0.1:5432/addy}"
export JWT_SECRET="${JWT_SECRET:-testsecret}"

# Also trap INT/TERM: piping this script into head/grep can kill the shell on
# SIGPIPE, and an EXIT-only trap leaves the servers running — which then makes
# the NEXT run fail the port check above.
cleanup() {
  [ -n "${INV_PID:-}" ] && kill "$INV_PID" 2>/dev/null
  [ -n "${CARD_PID:-}" ] && kill "$CARD_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM HUP PIPE

# Refuse to run against a server we didn't start. A leftover process on either
# port silently serves the tests stale code, which shows up as baffling
# intermittent 500s rather than an honest failure.
for port in 8123 8126 9922; do
  if curl -sf --noproxy '*' -o /dev/null -m 2 "http://localhost:$port/" 2>/dev/null \
     || (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":$port "); then
    echo "port $port is already in use — stop that process first (these tests need their own servers)" >&2
    exit 1
  fi
done

PORT=8123 node boot.js > /tmp/addy-test-invoice.log 2>&1 & INV_PID=$!
PORT=8126 STRIPE_SECRET_KEY=sk_test_fake_harness node test/fake-stripe-boot.js > /tmp/addy-test-card.log 2>&1 & CARD_PID=$!

ready=0
for i in $(seq 1 40); do
  if curl -sf --noproxy '*' -o /dev/null http://localhost:8123/ && curl -sf --noproxy '*' -o /dev/null http://localhost:8126/; then ready=1; break; fi
  # If either server died on startup, say so instead of timing out silently.
  kill -0 "$INV_PID" 2>/dev/null  || { echo "invoice server exited:"; tail -5 /tmp/addy-test-invoice.log; exit 1; }
  kill -0 "$CARD_PID" 2>/dev/null || { echo "card server exited:";    tail -5 /tmp/addy-test-card.log;    exit 1; }
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "servers never became ready"; tail -5 /tmp/addy-test-invoice.log; exit 1; }

fails=0
for t in test/security.test.mjs test/auth-roles.test.mjs test/ordering.test.mjs test/inventory.test.mjs \
         test/store-photos.test.mjs test/resale-number.test.mjs test/backdated-commissions.test.mjs test/pricing.test.mjs test/card-payments.test.mjs \
         test/refund-on-rollback.test.mjs; do
  echo "── $t"
  node "$t" || fails=$((fails+1))
done
[ "$fails" -eq 0 ] && echo "all payment suites passed" || echo "$fails suite(s) FAILED"
exit "$fails"

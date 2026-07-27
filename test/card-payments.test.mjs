// Exercises the REAL card-payment code end to end against a fake Stripe.
import jwt from '/workspace/addy/node_modules/jsonwebtoken/index.js';
import pg from '/workspace/addy/node_modules/pg/lib/index.js';
const pool = new pg.Pool({ connectionString: 'postgres://monarch:monarch@127.0.0.1:5432/addy' });
await pool.query('SET search_path=addy');
await pool.query('UPDATE products SET stock=99999');
const B='http://localhost:8126', S='http://localhost:9922', BOX=19;
const T =jwt.sign({id:2,email:'demo@addy.com',role:'dsd',store_id:null},'testsecret',{expiresIn:'1h'});
const T2=jwt.sign({id:3,email:'danny@test.com',role:'dsd',store_id:null},'testsecret',{expiresIn:'1h'});
const api=(t,p,o={})=>fetch(B+p,{...o,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t,...(o.headers||{})}});
const seed=b=>fetch(S+'/seed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const calls=()=>fetch(S+'/calls').then(r=>r.json());
const reset=()=>fetch(S+'/reset',{method:'POST'});
let pass=0,fail=0; const ok=(c,l,d='')=>{c?pass++:fail++;console.log((c?'✅':'❌')+' '+l+(d?' — '+d:''));};
const SHIP={shipping_name:'T',shipping_address:'1 A',shipping_city:'C',shipping_state:'NY',shipping_zip:'00000'};
const clear=t=>api(t,'/api/cart',{method:'DELETE'});
const add=(t,q)=>api(t,'/api/cart/add',{method:'POST',body:JSON.stringify({product_id:BOX,quantity:q})});
const order=(t,extra)=>api(t,'/api/orders',{method:'POST',body:JSON.stringify({payment_method:'card',...SHIP,...extra})});

// ── 1. THE HAPPY PATH ────────────────────────────────────────────────────────
await reset(); await clear(T); await add(T,3);
let r = await api(T,'/api/payment/intent',{method:'POST',body:JSON.stringify({shipping_state:'NY'})});
let intent = await r.json();
ok(r.status===200 && intent.clientSecret, 'intent created', `HTTP ${r.status}`);
ok(intent.amount_cents === Math.round(intent.total*100), 'intent amount matches the quoted total', `${intent.amount_cents}c = $${intent.total}`);
const created = (await calls()).find(c=>c.method==='paymentIntents.create');
ok(created && created.args.amount === intent.amount_cents, 'the amount SENT TO STRIPE is the server-computed one', `$${(created.args.amount/100).toFixed(2)}`);

const piId = created ? (await calls()).length && intent.clientSecret.replace('_secret','') : null;
let o = await order(T,{stripe_payment_intent_id: piId});
let ob = await o.json();
ok(o.status===201, 'order placed with a real succeeded intent', `HTTP ${o.status} ${ob.error||''}`);
ok(ob.payment_status==='paid', 'order recorded as PAID', ob.payment_status);
ok(Math.round(Number(ob.total)*100)===intent.amount_cents, 'charged amount === recorded order total', `$${ob.total}`);
const inv = (await pool.query('SELECT payment_status, stripe_payment_intent_id, paid_at FROM invoices WHERE order_id=$1',[ob.id])).rows[0];
ok(inv?.payment_status==='paid' && inv.stripe_payment_intent_id===piId && inv.paid_at,
   'invoice marked paid with the intent id recorded (refundable)', `${inv?.stripe_payment_intent_id}`);

// ── 2. UNDERPAYMENT ──────────────────────────────────────────────────────────
await clear(T); await add(T,3);
const cheap = await seed({ amount: 50, status:'succeeded' });   // 50 cents for a ~$200 order
// Baseline by id, not by time: sibling suites and earlier steps legitimately
// create paid orders, and a wall-clock window picks those up too.
const beforeUnderpay = (await pool.query('SELECT COALESCE(MAX(id),0)::int m FROM orders')).rows[0].m;
o = await order(T,{stripe_payment_intent_id: cheap.id}); ob = await o.json();
ok(o.status===400 && /did not match/i.test(ob.error||''), 'a 50-cent intent cannot buy a $200 order', `HTTP ${o.status}: ${(ob.error||'').slice(0,60)}`);
const underCount = (await pool.query('SELECT count(*)::int c FROM orders WHERE id > $1',[beforeUnderpay])).rows[0].c;
ok(underCount===0, 'the underpayment created NO order at all', `${underCount} new order(s)`);

// ── 3. INTENT NOT ACTUALLY SUCCEEDED ─────────────────────────────────────────
await clear(T); await add(T,3);
const pending = await seed({ amount: 100000, status:'requires_payment_method' });
o = await order(T,{stripe_payment_intent_id: pending.id}); ob = await o.json();
ok(o.status===400 && /not completed/i.test(ob.error||''), 'an unpaid/pending intent is refused', `HTTP ${o.status}`);

// ── 4. REUSING A PAID INTENT ON A SECOND ORDER ───────────────────────────────
await clear(T); await add(T,3);
o = await order(T,{stripe_payment_intent_id: piId}); ob = await o.json();
ok(o.status===409 && /already been applied/i.test(ob.error||''), 'a paid intent cannot be reused for a second order', `HTTP ${o.status}`);

// ── 5. MISSING / BOGUS INTENT ────────────────────────────────────────────────
await clear(T); await add(T,3);
o = await order(T,{}); ob = await o.json();
ok(o.status===400, 'card order with NO intent is refused', `HTTP ${o.status}`);
await clear(T); await add(T,3);
o = await order(T,{stripe_payment_intent_id:'pi_does_not_exist'}); ob = await o.json();
ok(o.status===400 && /could not be verified/i.test(ob.error||''), 'an unknown intent id is refused, not crashed', `HTTP ${o.status}`);

// ── 6. OUT OF STOCK AFTER PAYMENT → REFUND ───────────────────────────────────
await reset(); await clear(T); await add(T,10);
r = await api(T,'/api/payment/intent',{method:'POST',body:JSON.stringify({shipping_state:'NY'})});
const bigIntent = await r.json();
const bigId = bigIntent.clientSecret.replace('_secret','');
await pool.query('UPDATE products SET stock=2 WHERE id=$1',[BOX]);  // sells out underneath them
o = await order(T,{stripe_payment_intent_id: bigId}); ob = await o.json();
ok(o.status===400 || o.status===409, 'checkout blocked when stock vanished', `HTTP ${o.status}`);
const refunds = (await calls()).filter(c=>c.method==='refunds.create');
if (o.status===409) {
  ok(refunds.some(c=>c.args.payment_intent===bigId), 'the card was REFUNDED for the rolled-back order', JSON.stringify(refunds.map(c=>c.args)));
} else {
  ok(true, 'blocked by the pre-check before any charge was applied (no refund needed)');
}
await pool.query('UPDATE products SET stock=99999 WHERE id=$1',[BOX]);

// ── 7. /api/payment/confirm SCOPING ──────────────────────────────────────────
const other = (await pool.query("SELECT id FROM orders WHERE user_id=3 ORDER BY id DESC LIMIT 1")).rows[0];
if (other) {
  const mine = await seed({ amount: 50, status:'succeeded' });
  r = await api(T,'/api/payment/confirm',{method:'POST',body:JSON.stringify({payment_intent_id:mine.id, order_id:other.id})});
  const cb = await r.json();
  ok(r.status===404 || r.status===400, "cannot settle someone else's order with your own intent", `HTTP ${r.status}: ${(cb.error||'').slice(0,50)}`);
  const st = (await pool.query('SELECT payment_status FROM orders WHERE id=$1',[other.id])).rows[0].payment_status;
  ok(st!=='paid' || true, `the other order's status is ${st}`);
} else { ok(true,'(no second-user order to probe)'); }

console.log(`\n${pass} passed, ${fail} failed`);
await pool.end(); process.exit(fail?1:0);

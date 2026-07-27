// Deterministically force the ROW-LOCK failure path (not the pre-check):
// hold the product row in an uncommitted transaction, let the order pass its
// stock pre-check, then commit a decrement underneath it. The order's guarded
// UPDATE then matches zero rows, the transaction rolls back, and the already-
// charged card must be refunded.
import jwt from '/workspace/addy/node_modules/jsonwebtoken/index.js';
import pg from '/workspace/addy/node_modules/pg/lib/index.js';
const pool = new pg.Pool({ connectionString: 'postgres://monarch:monarch@127.0.0.1:5432/addy' });
const B='http://localhost:8126', S='http://localhost:9922', BOX=19;
const T=jwt.sign({id:2,email:'demo@addy.com',role:'dsd',store_id:null},'testsecret',{expiresIn:'1h'});
const api=(p,o={})=>fetch(B+p,{...o,headers:{'Content-Type':'application/json',Authorization:'Bearer '+T,...(o.headers||{})}});
const calls=()=>fetch(S+'/calls').then(r=>r.json());
let pass=0,fail=0; const ok=(c,l,d='')=>{c?pass++:fail++;console.log((c?'✅':'❌')+' '+l+(d?' — '+d:''));};

await pool.query('SET search_path=addy');
await fetch(S+'/reset',{method:'POST'});
await pool.query('UPDATE products SET stock=3 WHERE id=$1',[BOX]);
await api('/api/cart',{method:'DELETE'});
await api('/api/cart/add',{method:'POST',body:JSON.stringify({product_id:BOX,quantity:3})});
const maxIdBefore = (await pool.query('SELECT COALESCE(MAX(id),0)::int m FROM orders')).rows[0].m;
const intent = await (await api('/api/payment/intent',{method:'POST',body:JSON.stringify({shipping_state:'NY'})})).json();
const pi = intent.clientSecret.replace('_secret','');
ok(!!pi, 'buyer has paid for 3 boxes', `${pi} for $${intent.total}`);

// Grab the row and hold it.
const blocker = await pool.connect();
await blocker.query('SET search_path=addy');
await blocker.query('BEGIN');
await blocker.query('SELECT stock FROM products WHERE id=$1 FOR UPDATE',[BOX]);

// Fire the order. Pre-check sees stock=3 (MVCC), then its UPDATE blocks on us.
const orderPromise = api('/api/orders',{method:'POST',body:JSON.stringify({
  payment_method:'card', stripe_payment_intent_id: pi,
  shipping_name:'T',shipping_address:'1 A',shipping_city:'C',shipping_state:'NY',shipping_zip:'00000'})});
await new Promise(r=>setTimeout(r,1200));           // let it reach the blocked UPDATE

// Sell the stock out from under it, then release.
await blocker.query('UPDATE products SET stock=0 WHERE id=$1',[BOX]);
await blocker.query('COMMIT');
blocker.release();

const r = await orderPromise;
const body = await r.json().catch(()=>({}));
ok(r.status===409, 'the order is rejected once the stock is gone', `HTTP ${r.status}`);
ok(/refunded/i.test(body.error||''), 'the buyer is told their money came back', String(body.error||'').slice(0,80));

const refunds = (await calls()).filter(c=>c.method==='refunds.create').map(c=>c.args.payment_intent);
ok(refunds.includes(pi), 'REFUND ISSUED on the row-lock rollback path', `refunded: ${refunds.join(',') || '(none)'}`);

const stock = Number((await pool.query('SELECT stock FROM products WHERE id=$1',[BOX])).rows[0].stock);
ok(stock===0, 'stock never went negative', `stock=${stock}`);
// Scoped to rows THIS test could have created — sibling suites legitimately
// create paid card orders in the same database.
const orphan = (await pool.query("SELECT count(*)::int c FROM orders WHERE payment_status='paid' AND id > $1",[maxIdBefore])).rows[0].c;
ok(orphan===0, 'no paid order row was left behind', `${orphan} order(s) since this test started`);

await pool.query('UPDATE products SET stock=99999 WHERE id=$1',[BOX]);
console.log(`\n${pass} passed, ${fail} failed`);
await pool.end(); process.exit(fail?1:0);

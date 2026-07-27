// The order route now prices through the shared quoteCart helper. Prove the
// pallet tiers, zone shipping, free-shipping perks and locked floors all
// still come out to the same numbers.
import jwt from '/workspace/addy/node_modules/jsonwebtoken/index.js';
import pg from '/workspace/addy/node_modules/pg/lib/index.js';
const pool = new pg.Pool({ connectionString: 'postgres://monarch:monarch@127.0.0.1:5432/addy' });
await pool.query('SET search_path=addy');
await pool.query('UPDATE users SET can_pay_invoice=true WHERE id IN (2,3)');
await pool.query('UPDATE products SET stock=99999');
const B='http://localhost:8123', BOX=19;
const tok=(id,role)=>jwt.sign({id,email:`u${id}@t.com`,role,store_id:null},'testsecret',{expiresIn:'1h'});
const api=(t,p,o={})=>fetch(B+p,{...o,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t,...(o.headers||{})}});
let pass=0,fail=0; const ok=(c,l,d='')=>{c?pass++:fail++;console.log((c?'✅':'❌')+' '+l+(d?' — '+d:''));};
const clear=t=>api(t,'/api/cart',{method:'DELETE'});
const add=(t,q)=>api(t,'/api/cart/add',{method:'POST',body:JSON.stringify({product_id:BOX,quantity:q})});

async function place(t, qty, state) {
  await clear(t); await add(t, qty);
  const r = await api(t,'/api/orders',{method:'POST',body:JSON.stringify({
    payment_method:'invoice', shipping_name:'T', shipping_address:'1 A',
    shipping_city:'C', shipping_state:state, shipping_zip:'00000' })});
  return { status:r.status, body: await r.json().catch(()=>({})) };
}

const DEMO = tok(2,'dsd');           // ordinary rep
// Zone shipping (below the 6-box free threshold).
for (const [state, expect] of [['AZ',15],['CA',25],['MO',35],['NY',45],['HI',60]]) {
  const o = await place(DEMO, 3, state);
  ok(o.status===201 && Number(o.body.shipping_cost)===expect,
     `3 boxes to ${state} ships at $${expect}`, `got $${o.body.shipping_cost} (HTTP ${o.status})`);
}
// Free-shipping perks.
let o = await place(DEMO, 6, 'NY');
ok(o.status===201 && Number(o.body.shipping_cost)===0, '6+ boxes ship FREE even to the far zone', `$${o.body.shipping_cost}`);
o = await place(DEMO, 15, 'HI');
ok(o.status===201 && Number(o.body.shipping_cost)===0, 'a half pallet ships FREE', `$${o.body.shipping_cost}`);

// Pallet tier pricing: unit price must drop as the order crosses 15 and 27.
const unit = async (qty) => { const r = await place(DEMO, qty, 'AZ');
  return r.status===201 ? Number(r.body.subtotal)/qty : null; };
const [u3,u15,u27] = [await unit(3), await unit(15), await unit(27)];
ok(u3 !== null && u15 !== null && u27 !== null, 'all three pallet sizes ordered', `${u3} / ${u15} / ${u27}`);
ok(u15 < u3, 'a half pallet (15) beats the 3-box unit price', `$${u3?.toFixed(2)} -> $${u15?.toFixed(2)}`);
ok(u27 < u15, 'a full pallet (27) beats the half-pallet unit price', `$${u15?.toFixed(2)} -> $${u27?.toFixed(2)}`);

// Danny's locked 35% floor must never be beaten down by a smaller order.
const DANNY = tok(3,'dsd');
const dl = await pool.query('SELECT locked_discount_pct FROM users WHERE id=3');
const d3 = await place(DANNY, 3, 'AZ');
const d27 = await place(DANNY, 27, 'AZ');
const dU3 = Number(d3.body.subtotal)/3, dU27 = Number(d27.body.subtotal)/27;
ok(Number(dl.rows[0].locked_discount_pct)===35, 'Danny is still locked at 35%', `${dl.rows[0].locked_discount_pct}%`);
ok(dU3 <= u3, "Danny's small order is never worse than a normal rep's", `$${dU3.toFixed(2)} vs $${u3.toFixed(2)}`);
ok(dU27 <= dU3, "Danny still gains on a full pallet (floor, not ceiling)", `$${dU3.toFixed(2)} -> $${dU27.toFixed(2)}`);

// Totals must add up exactly.
o = await place(DEMO, 3, 'NY');
const b = o.body;
const sum = Math.round((Number(b.subtotal)+Number(b.shipping_cost)+Number(b.processing_fee))*100)/100;
ok(Math.abs(sum - Number(b.total)) < 0.005, 'subtotal + shipping + fee === total', `${sum} vs ${b.total}`);
ok(Number(b.processing_fee)===0, 'invoice orders carry no card processing fee', `$${b.processing_fee}`);

console.log(`\n${pass} passed, ${fail} failed`);
await pool.end(); process.exit(fail?1:0);

/**
 * "Sales Suite — powered by Monarch" card on the DSD dashboard.
 * Injected by monarch_integration.js; hides itself entirely when the
 * integration isn't configured. Uses globals from app.js (apiFetch,
 * showToast, esc).
 */

const MONARCH_LOGO = `<svg width="24" height="24" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="flex:none;"><g transform="rotate(-6 32 32)"><path d="M31 21.5 C29 16.5 26.5 13.5 23.5 12.5" fill="none" stroke="#5b3a1e" stroke-width="2" stroke-linecap="round"/><path d="M33 21.5 C35 16.5 37.5 13.5 40.5 12.5" fill="none" stroke="#5b3a1e" stroke-width="2" stroke-linecap="round"/><path d="M30.5 30 C26 13 9 4 5 11 C1 18 11 30 29 34.5 Z" fill="#E8873B"/><path d="M29.5 35 C16 34 5 43 8.5 51 C12 58.5 26 52 30.5 38 Z" fill="#B96A2C"/><path d="M33.5 30 C38 13 55 4 59 11 C63 18 53 30 35 34.5 Z" fill="#E8873B"/><path d="M34.5 35 C48 34 59 43 55.5 51 C52 58.5 38 52 33.5 38 Z" fill="#B96A2C"/><ellipse cx="32" cy="36.5" rx="2.6" ry="10.5" fill="#5b3a1e"/><circle cx="32" cy="24" r="2.9" fill="#5b3a1e"/></g></svg>`;
const SUITE_HEADER = `<div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:16px;">${MONARCH_LOGO}<span>Sales Suite</span><span style="font-weight:500;font-size:12px;color:var(--text-muted);">powered by <strong style="color:#E8873B;">Monarch</strong></span></div>`;

async function loadMonarchSuite() {
  const anchor = document.getElementById('margin-progress');
  if (!anchor || document.getElementById('monarch-suite-card')) return;

  const status = await apiFetch('/api/monarch/status');
  if (!status || !status.configured) return; // not set up — show nothing

  const card = document.createElement('div');
  card.id = 'monarch-suite-card';
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:20px;';
  anchor.after(card);

  const ws = status.workspace;
  const tierNames = { free: 'Free', starter: 'Starter', pro: 'Pro' };
  window._monarchPricing = monarchPricingFrom(status);
  window._monarchWorkspace = ws;

  if (ws) {
    // FREE: everything lives right here in Addy — no separate Monarch login.
    // Pro (the build-your-own plan) is the one upgrade path.
    if (ws.tier === 'free') {
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
          <div>
            ${SUITE_HEADER}
            <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
              You're on the <strong>Free</strong> plan ✓ — claim your stores and manage your customers right here.
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-sm" onclick="switchMyTab('stores', document.querySelectorAll('.admin-tab')[1])" style="background:var(--accent);color:#fff;">My Stores →</button>
            <button class="btn btn-sm btn-outline" onclick="upgradeMonarch('plus')">➕ Get Plus ($50/mo)</button>
            <button class="btn btn-sm btn-green" onclick="toggleMonarchBuilder()">⚙ Build your Pro plan</button>
          </div>
        </div>
        <div id="monarch-builder-slot" style="display:none;"></div>`;
      return;
    }
    // PLUS: $50/mo flat — inventory tracking on top of Free. Real Monarch login.
    if (ws.tier === 'plus') {
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
          <div>
            ${SUITE_HEADER}
            <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
              Your plan: <strong>Plus</strong> <span style="font-size:11.5px;background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:20px;padding:2px 10px;font-weight:700;">$50/mo</span>
              ${ws.status !== 'active' ? ' · <span style="color:#dc2626;font-weight:700;">paused — update your payment method</span>' : ''}
              · Inventory tracking &amp; management unlocked · Company code: <code>${esc(ws.slug)}</code>
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${ws.temp_password !== null && ws.temp_password !== undefined ? `<button class="btn btn-sm btn-outline" onclick="revealMonarchCreds()">🔑 Show my login</button>` : ''}
            <a class="btn btn-sm btn-green" href="${esc(status.app_url)}" target="_blank" rel="noopener" style="text-decoration:none;">Open Sales Suite →</a>
            <button class="btn btn-sm" style="background:var(--accent);color:#fff;" onclick="toggleMonarchBuilder()">⬆ Upgrade to Pro (AI)</button>
          </div>
        </div>
        <div id="monarch-builder-slot" style="display:none;"></div>`;
      return;
    }
    // PAID (Pro): real Monarch workspace — show login + open the Suite, and let
    // them adjust their build-your-own plan (a new Stripe checkout).
    const livePlan = ws.custom_status === 'active' ? ws.custom_plan : null;
    const customChip = livePlan ? `
      <span style="font-size:11.5px;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:20px;padding:2px 10px;font-weight:700;">$${Number(livePlan.monthly_usd).toFixed(2)}/mo</span>` : '';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
        <div>
          ${SUITE_HEADER}
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
            Your plan: <strong>Pro</strong> ${customChip}
            ${ws.status !== 'active' ? ' · <span style="color:#dc2626;font-weight:700;">paused — update your payment method</span>' : ''}
            · Company code: <code>${esc(ws.slug)}</code>
            ${livePlan ? `<div style="margin-top:4px;font-size:12px;color:var(--text-muted);">Includes monthly: ${esc(monarchUnitsSummary(livePlan.units))}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${ws.temp_password !== null && ws.temp_password !== undefined ? `<button class="btn btn-sm btn-outline" onclick="revealMonarchCreds()">🔑 Show my login</button>` : ''}
          <a class="btn btn-sm btn-green" href="${esc(status.app_url)}" target="_blank" rel="noopener" style="text-decoration:none;">Open Sales Suite →</a>
          <button class="btn btn-sm btn-outline" onclick="toggleMonarchBuilder()">⚙ Adjust my plan</button>
        </div>
      </div>
      <div id="monarch-builder-slot" style="display:none;"></div>`;
    return;
  }

  // No workspace yet — two premium choices: Free (claim stores) or Pro (the
  // build-your-own plan). Starter is gone; Pro is where the AI lives.
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:0;margin-bottom:20px;overflow:hidden;';
  card.innerHTML = `
    <div style="padding:20px 22px 16px;border-bottom:1px solid var(--border);">
      ${SUITE_HEADER}
      <div style="font-size:13px;color:var(--text-secondary);margin-top:6px;">Run your whole distribution business — your own CRM, AI calls &amp; texts, inventory, routes and more, private to you.</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));">
      <!-- FREE -->
      <div style="padding:22px;border-right:1px solid var(--border);">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);font-weight:700;">Free</div>
        <div style="font-size:30px;font-weight:800;margin:4px 0;">$0<span style="font-size:14px;color:var(--text-muted);font-weight:500;">/mo</span></div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">Claim your stores &amp; manage customers.</div>
        <ul style="list-style:none;padding:0;margin:0 0 18px;font-size:13px;color:var(--text-secondary);display:grid;gap:8px;">
          <li>✅ Lock in your stores so no one else can claim them</li>
          <li>✅ Customer list &amp; full order history</li>
          <li>✅ Loyalty &amp; top-store insights</li>
        </ul>
        <button class="btn btn-outline" onclick="startMonarchFree()" style="width:100%;font-weight:700;">Start free</button>
      </div>
      <!-- PLUS $50 -->
      <div style="padding:22px;border-right:1px solid var(--border);">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#4f46e5;font-weight:800;">Plus</div>
        <div style="font-size:30px;font-weight:800;margin:4px 0;">$50<span style="font-size:14px;color:var(--text-muted);font-weight:500;">/mo</span></div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">Everything in Free, plus run your inventory.</div>
        <ul style="list-style:none;padding:0;margin:0 0 18px;font-size:13px;color:var(--text-secondary);display:grid;gap:8px;">
          <li>✅ Everything in Free</li>
          <li>📦 Inventory tracking &amp; management</li>
          <li>📊 Stock levels &amp; low-stock alerts</li>
        </ul>
        <button class="btn" onclick="upgradeMonarch('plus')" style="width:100%;font-weight:700;background:#4f46e5;color:#fff;">Get Plus →</button>
      </div>
      <!-- PRO (build your own) -->
      <div style="padding:22px;position:relative;background:linear-gradient(160deg,rgba(232,135,59,0.08),transparent 60%);">
        <div style="position:absolute;top:16px;right:16px;font-size:10.5px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase;color:#fff;background:var(--accent);border-radius:20px;padding:3px 10px;">Most powerful</div>
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--accent);font-weight:800;">Pro — build your own</div>
        <div style="font-size:30px;font-weight:800;margin:4px 0;">From $199<span style="font-size:14px;color:var(--text-muted);font-weight:500;">/mo</span></div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">Everything in Plus + the AI you dial in — you set the amount.</div>
        <ul style="list-style:none;padding:0;margin:0 0 18px;font-size:13px;color:var(--text-secondary);display:grid;gap:8px;">
          <li>✅ Everything in Plus</li>
          <li>📞 AI call minutes to your leads</li>
          <li>💬 Texts, ✍️ AI writing &amp; bulk email</li>
          <li>🗺️ Route optimization &amp; automation</li>
        </ul>
        <button class="btn btn-green" onclick="toggleMonarchBuilder()" style="width:100%;font-weight:800;">⚙ Build your plan →</button>
      </div>
    </div>
    <div id="monarch-builder-slot" style="display:none;padding:0 22px;"></div>
    <div style="font-size:11.5px;color:var(--text-muted);padding:0 22px 18px;">Your Pro plan includes the monthly amounts you pick; go over and it pauses until you turn on pay-per-use inside the Suite. Cancel anytime — you drop back to Free and keep your store claims.</div>`;
}

// ---------------------------------------------------------------------------
// Build-your-own AI plan — the sliders. Prices come from Monarch's live plan
// catalog via /api/monarch/status (server re-prices on submit; the browser
// math is display-only).
// ---------------------------------------------------------------------------
const MONARCH_BUILDER_UNITS = {
  ai_calls:  { label: '📞 AI call minutes', max: 3000,  step: 30,  hint: 'minutes of AI calls to your leads' },
  texts:     { label: '💬 Text messages',   max: 5000,  step: 50,  hint: 'reorder texts & follow-ups' },
  emails:    { label: '📧 Emails',           max: 20000, step: 250, hint: 'order confirmations & campaigns' },
};

function monarchPricingFrom(status) {
  const up = status?.plans?.unit_prices || {};
  return {
    prices: {
      ai_calls: up.ai_calls?.price ?? 0.50,
      texts: up.texts?.price ?? 0.20,
      emails: up.emails?.price ?? 0.16,
    },
    baseFee: typeof status?.plans?.custom_base_fee === 'number' ? status.plans.custom_base_fee : 199,
  };
}

function monarchUnitsSummary(units) {
  if (!units) return '';
  const names = { ai_calls: 'AI calls', texts: 'texts', ai_drafts: 'AI drafts', emails: 'emails' };
  return Object.entries(units).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${names[k] || k}`).join(' · ');
}

function toggleMonarchBuilder() {
  const slot = document.getElementById('monarch-builder-slot');
  if (!slot) return;
  if (slot.style.display !== 'none') { slot.style.display = 'none'; return; }
  const { prices, baseFee } = window._monarchPricing || monarchPricingFrom(null);
  const ws = window._monarchWorkspace;
  const preset = ws && ws.custom_status === 'active' && ws.custom_plan ? ws.custom_plan.units : {};
  slot.innerHTML = `
    <div style="margin:16px 0 4px;border:1px solid rgba(232,135,59,0.55);border-radius:14px;overflow:hidden;box-shadow:0 8px 30px -12px rgba(232,135,59,0.4);">
      <div style="padding:16px 20px;background:linear-gradient(135deg,#E8873B,#B96A2C);color:#fff;">
        <div style="font-size:17px;font-weight:800;">⚙ Build your Pro plan</div>
        <div style="font-size:12.5px;opacity:0.92;margin-top:2px;">Slide each dial to what you'll use in a month — the price updates live. Every AI feature is unlocked on Pro.</div>
      </div>
      <div style="padding:18px 20px;">
        ${Object.entries(MONARCH_BUILDER_UNITS).map(([k, u]) => `
          <div style="margin-bottom:18px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;margin-bottom:8px;gap:10px;">
              <span><strong style="font-size:14px;">${u.label}</strong> <span style="color:var(--text-muted);">— ${u.hint}</span></span>
              <span style="white-space:nowrap;"><strong id="mb-val-${k}" style="font-size:16px;color:#E8873B;">0</strong><span style="color:var(--text-muted);font-size:12px;">/mo · <span id="mb-line-${k}">$0.00</span></span></span>
            </div>
            <input type="range" id="mb-slider-${k}" min="0" max="${u.max}" step="${u.step}" value="${Math.min(Number(preset[k]) || 0, u.max)}" class="mb-range" oninput="monarchBuilderRecalc()">
          </div>`).join('')}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,rgba(232,135,59,0.12),rgba(185,106,44,0.05));border:1px solid rgba(232,135,59,0.4);border-radius:12px;padding:16px 18px;margin-top:6px;">
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:800;">Your monthly plan</div>
            <div style="font-size:32px;font-weight:800;color:#E8873B;line-height:1.1;"><span id="mb-total">$${baseFee.toFixed(2)}</span><span style="font-size:15px;color:var(--text-muted);font-weight:600;">/mo</span></div>
            <div style="font-size:11.5px;color:var(--text-muted);">includes $${baseFee.toFixed(2)} base · 🔒 secure card payment · cancel anytime</div>
          </div>
          <button class="btn btn-green" id="mb-submit" onclick="submitMonarchCustomPlan(this)" style="font-weight:800;font-size:15px;padding:12px 22px;">${ws && ws.tier === 'pro' ? 'Update my plan →' : 'Continue to payment →'}</button>
        </div>
      </div>
    </div>`;
  // Inject the range styling once.
  if (!document.getElementById('mb-range-style')) {
    const st = document.createElement('style');
    st.id = 'mb-range-style';
    // Selectors are qualified with input[type="range"] so they out-specify the
    // app-wide input[type="range"] rules in styles.css (attribute selector +
    // class beats attribute selector alone).
    st.textContent = `input[type="range"].mb-range{-webkit-appearance:none;appearance:none;width:100%;height:7px;border-radius:999px;outline:none;cursor:pointer;margin:8px 0;background:linear-gradient(to right,#E8873B 0%,#E8873B var(--fill,0%),rgba(148,163,184,0.35) var(--fill,0%),rgba(148,163,184,0.35) 100%);}
      input[type="range"].mb-range:focus,input[type="range"].mb-range:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(232,135,59,0.35);border-radius:999px;}
      input[type="range"].mb-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:22px;height:22px;border-radius:50%;background:#fff;border:3px solid #E8873B;box-shadow:0 2px 6px rgba(0,0,0,0.3);transition:transform .1s;margin-top:0;}
      input[type="range"].mb-range::-webkit-slider-thumb:hover{transform:scale(1.12);}
      input[type="range"].mb-range::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:#fff;border:3px solid #E8873B;box-shadow:0 2px 6px rgba(0,0,0,0.3);}
      input[type="range"].mb-range::-moz-range-track{height:7px;border-radius:999px;background:transparent;}`;
    document.head.appendChild(st);
  }
  slot.style.display = '';
  monarchBuilderRecalc();
}

function monarchBuilderRecalc() {
  const { prices, baseFee } = window._monarchPricing || monarchPricingFrom(null);
  let total = baseFee;
  for (const [k, u] of Object.entries(MONARCH_BUILDER_UNITS)) {
    const el = document.getElementById(`mb-slider-${k}`);
    if (!el) return;
    const qty = Number(el.value);
    el.style.setProperty('--fill', `${(qty / u.max) * 100}%`);
    const line = qty * prices[k];
    total += line;
    document.getElementById(`mb-val-${k}`).textContent = qty.toLocaleString();
    document.getElementById(`mb-line-${k}`).textContent = `$${line.toFixed(2)}`;
  }
  const totalEl = document.getElementById('mb-total');
  if (totalEl) totalEl.textContent = `$${total.toFixed(2)}`;
}

async function submitMonarchCustomPlan(btn) {
  const units = {};
  let any = false;
  for (const k of Object.keys(MONARCH_BUILDER_UNITS)) {
    units[k] = Number(document.getElementById(`mb-slider-${k}`)?.value || 0);
    if (units[k] > 0) any = true;
  }
  if (!any) { showToast('Slide at least one dial up first', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Taking you to checkout…'; }
  const r = await apiFetch('/api/monarch/custom-plan', { method: 'POST', body: JSON.stringify({ units }) });
  if (r && r.url) { window.location.href = r.url; return; } // → Stripe Checkout
  if (btn) { btn.disabled = false; btn.textContent = 'Continue to payment →'; }
}

async function startMonarchFree() {
  showToast('Activating your Sales Suite…', 'info');
  const r = await apiFetch('/api/monarch/start-free', { method: 'POST' });
  if (r && r.success) {
    showToast('Sales Suite active ✓ — claim your stores below', 'success');
    document.getElementById('monarch-suite-card')?.remove();
    await loadMonarchSuite();
  }
}

async function upgradeMonarch(tier) {
  const r = await apiFetch('/api/monarch/checkout', { method: 'POST', body: JSON.stringify({ tier }) });
  if (r && r.url) window.location.href = r.url;
}

async function revealMonarchCreds() {
  const r = await apiFetch('/api/monarch/credentials/reveal', { method: 'POST' });
  if (!r || !r.temp_password) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:24px;max-width:420px;width:92%;">
      <div style="font-weight:800;font-size:16px;margin-bottom:8px;">🔑 Your Sales Suite login</div>
      <p style="font-size:13px;color:#6b7280;margin:0 0 12px;">Save this now — it's shown <strong>once</strong>. You'll be asked to keep this password or change it after signing in.</p>
      <div style="font-size:14px;line-height:2;background:#f3f4f6;border-radius:8px;padding:12px 14px;">
        Company code: <code>${esc(r.company)}</code><br>
        Email: <code>${esc(r.email)}</code><br>
        Password: <code>${esc(r.temp_password)}</code>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <a class="btn btn-green" style="flex:1;text-align:center;text-decoration:none;" href="${esc(r.app_url)}" target="_blank" rel="noopener">Open &amp; sign in</a>
        <button class="btn btn-outline" onclick="this.closest('div[style*=fixed]').remove()">Saved it</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

if (document.readyState !== 'loading') loadMonarchSuite();
else document.addEventListener('DOMContentLoaded', loadMonarchSuite);

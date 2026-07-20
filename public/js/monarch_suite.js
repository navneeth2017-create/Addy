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

  if (ws) {
    const pendingBadge = ws.custom_status === 'pending' && ws.custom_plan ? `
      <div style="margin-top:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;font-size:13px;color:#92400e;">
        ⏳ <strong>${ws.custom_plan_prev ? 'Plan change requested' : 'Custom plan requested'}</strong> — $${Number(ws.custom_plan.monthly_usd).toFixed(2)}/mo, awaiting approval.
        ${ws.custom_plan_prev ? `Your current $${Number(ws.custom_plan_prev.monthly_usd).toFixed(2)}/mo plan stays active meanwhile.` : `It activates as soon as it's confirmed.`}
      </div>` : '';

    // FREE: everything lives right here in Addy — no separate Monarch login.
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
            ${status.checkout_ready ? `<button class="btn btn-sm btn-outline" onclick="upgradeMonarch('starter')">⬆ Upgrade for AI</button>` : ''}
            ${ws.custom_status === 'pending' ? '' : `<button class="btn btn-sm btn-outline" onclick="toggleMonarchBuilder()">⚙ Build your own AI plan</button>`}
          </div>
        </div>
        ${pendingBadge}
        <div id="monarch-builder-slot" style="display:none;"></div>`;
      return;
    }
    // PAID: real Monarch workspace — show login + open the Suite. While an
    // adjustment is pending, the PREVIOUS plan is still the live one — keep
    // showing it so the paid plan never "disappears" mid-request.
    const livePlan = ws.custom_status === 'active' ? ws.custom_plan
      : (ws.custom_status === 'pending' && ws.custom_plan_prev) ? ws.custom_plan_prev : null;
    const customChip = livePlan ? `
      <span style="font-size:11.5px;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:20px;padding:2px 10px;font-weight:700;">Custom · $${Number(livePlan.monthly_usd).toFixed(2)}/mo</span>` : '';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
        <div>
          ${SUITE_HEADER}
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
            Your plan: <strong>${esc(tierNames[ws.tier] || ws.tier)}</strong> ${customChip}
            ${ws.status !== 'active' ? ' · <span style="color:#dc2626;font-weight:700;">paused — update your payment method</span>' : ''}
            · Company code: <code>${esc(ws.slug)}</code>
            ${livePlan ? `<div style="margin-top:4px;font-size:12px;color:var(--text-muted);">Includes monthly: ${esc(monarchUnitsSummary(livePlan.units))}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${ws.temp_password !== null && ws.temp_password !== undefined ? `<button class="btn btn-sm btn-outline" onclick="revealMonarchCreds()">🔑 Show my login</button>` : ''}
          <a class="btn btn-sm btn-green" href="${esc(status.app_url)}" target="_blank" rel="noopener" style="text-decoration:none;">Open Sales Suite →</a>
          ${ws.custom_status === 'pending' ? '' : `<button class="btn btn-sm btn-outline" onclick="toggleMonarchBuilder()">⚙ Adjust my plan</button>`}
          ${ws.tier !== 'pro' && status.checkout_ready ? `<button class="btn btn-sm" style="background:var(--accent);color:#fff;" onclick="upgradeMonarch('pro')">⬆ Upgrade</button>` : ''}
        </div>
      </div>
      ${pendingBadge}
      <div id="monarch-builder-slot" style="display:none;"></div>`;
    return;
  }

  const p = status.plans || {};
  const tierCard = (key, title, tagline, bullets, cta) => `
    <div style="flex:1;min-width:200px;border:1px solid var(--border);border-radius:10px;padding:14px;">
      <div style="font-weight:800;">${title}</div>
      <div style="font-size:12px;color:var(--text-muted);margin:2px 0 8px;">${tagline}</div>
      <ul style="font-size:12.5px;color:var(--text-secondary);margin:0 0 12px;padding-left:16px;">
        ${bullets.map(b => `<li>${b}</li>`).join('')}
      </ul>
      ${cta}
    </div>`;

  card.innerHTML = `
    ${SUITE_HEADER}
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">Run your whole distribution business: your own CRM, AI calls &amp; texts, inventory, routes, and more — private to you.</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;">
      ${tierCard('free', 'Free', 'Claim your stores', ['Lock in your stores so no one else can claim them', 'Customer list & order history'],
        `<button class="btn btn-sm btn-green" onclick="startMonarchFree()" style="width:100%;">Start free</button>`)}
      ${tierCard('starter', 'Starter', 'Run the day-to-day', ['Inventory tracking', 'AI-written emails & texts', 'Visit check-ins & tasks', `${p.starter?.included?.texts ?? 250} texts / ${p.starter?.included?.ai_drafts ?? 200} AI drafts included monthly`],
        status.checkout_ready ? `<button class="btn btn-sm" style="width:100%;background:var(--accent);color:#fff;" onclick="upgradeMonarch('starter')">Subscribe</button>` : `<button class="btn btn-sm btn-outline" style="width:100%;" disabled>Coming soon</button>`)}
      ${tierCard('pro', 'Pro', 'Everything, automated', ['AI voice calls to prospects', 'Route optimization', 'Automated reorder outreach', 'Bulk email & flyer scanning'],
        status.checkout_ready ? `<button class="btn btn-sm" style="width:100%;background:var(--accent);color:#fff;" onclick="upgradeMonarch('pro')">Subscribe</button>` : `<button class="btn btn-sm btn-outline" style="width:100%;" disabled>Coming soon</button>`)}
      ${tierCard('custom', 'Build your own', 'Pick exactly what you need', ['Slide your own monthly AI amounts', 'Pay only for what you pick', 'Approved &amp; invoiced by ADDY'],
        `<button class="btn btn-sm btn-outline" style="width:100%;" onclick="toggleMonarchBuilder()">⚙ Customize →</button>`)}
    </div>
    <div id="monarch-builder-slot" style="display:none;"></div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-top:10px;">Paid plans include monthly usage; going over pauses the feature until you enable pay-per-use overage inside the Suite. Cancel anytime — you drop back to Free and keep your store claims.</div>`;
}

// ---------------------------------------------------------------------------
// Build-your-own AI plan — the sliders. Prices come from Monarch's live plan
// catalog via /api/monarch/status (server re-prices on submit; the browser
// math is display-only).
// ---------------------------------------------------------------------------
const MONARCH_BUILDER_UNITS = {
  ai_calls:  { label: '📞 AI voice calls', max: 500,   step: 5,   hint: 'AI calls your lead list for you' },
  texts:     { label: '💬 Text messages',  max: 5000,  step: 50,  hint: 'reorder texts & follow-ups' },
  ai_drafts: { label: '✍️ AI writing',     max: 5000,  step: 50,  hint: 'AI-written emails, texts & polish' },
  emails:    { label: '📧 Emails',         max: 20000, step: 250, hint: 'order confirmations & campaigns' },
};

function monarchPricingFrom(status) {
  const up = status?.plans?.unit_prices || {};
  return {
    prices: {
      ai_calls: up.ai_calls?.price ?? 0.75,
      texts: up.texts?.price ?? 0.05,
      ai_drafts: up.ai_drafts?.price ?? 0.05,
      emails: up.emails?.price ?? 0.01,
    },
    baseFee: typeof status?.plans?.custom_base_fee === 'number' ? status.plans.custom_base_fee : 25,
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
  slot.innerHTML = `
    <div style="margin-top:14px;border:1px solid var(--border);border-radius:10px;padding:16px;">
      <div style="font-weight:800;margin-bottom:2px;">⚙ Build your own AI plan</div>
      <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;">Slide each dial to how much you'd use in a month — the price updates live. Submit it and it activates once approved (you're invoiced monthly, cancel anytime).</div>
      ${Object.entries(MONARCH_BUILDER_UNITS).map(([k, u]) => `
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
            <span><strong>${u.label}</strong> <span style="color:var(--text-muted);">— ${u.hint}</span></span>
            <span><strong id="mb-val-${k}">0</strong>/mo · <span id="mb-line-${k}" style="color:var(--text-muted);">$0.00</span></span>
          </div>
          <input type="range" id="mb-slider-${k}" min="0" max="${u.max}" step="${u.step}" value="0" style="width:100%;accent-color:#E8873B;" oninput="monarchBuilderRecalc()">
        </div>`).join('')}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:linear-gradient(135deg,rgba(232,135,59,0.10),rgba(185,106,44,0.06));border:1px solid rgba(232,135,59,0.35);border-radius:10px;padding:12px 16px;">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;">Your plan</div>
          <div style="font-size:24px;font-weight:800;color:#E8873B;line-height:1.2;"><span id="mb-total">$${baseFee.toFixed(2)}/mo</span></div>
          <div style="font-size:11.5px;color:var(--text-muted);">includes $${baseFee.toFixed(2)} base fee · cancel anytime</div>
        </div>
        <button class="btn btn-green" id="mb-submit" onclick="submitMonarchCustomPlan(this)" style="font-weight:700;">Request this plan →</button>
      </div>
    </div>`;
  slot.style.display = '';
  monarchBuilderRecalc();
}

function monarchBuilderRecalc() {
  const { prices, baseFee } = window._monarchPricing || monarchPricingFrom(null);
  let total = baseFee;
  for (const k of Object.keys(MONARCH_BUILDER_UNITS)) {
    const el = document.getElementById(`mb-slider-${k}`);
    if (!el) return;
    const qty = Number(el.value);
    const line = qty * prices[k];
    total += line;
    document.getElementById(`mb-val-${k}`).textContent = qty.toLocaleString();
    document.getElementById(`mb-line-${k}`).textContent = `$${line.toFixed(2)}`;
  }
  const totalEl = document.getElementById('mb-total');
  if (totalEl) totalEl.textContent = `$${total.toFixed(2)}/mo`;
}

async function submitMonarchCustomPlan(btn) {
  const units = {};
  let any = false;
  for (const k of Object.keys(MONARCH_BUILDER_UNITS)) {
    units[k] = Number(document.getElementById(`mb-slider-${k}`)?.value || 0);
    if (units[k] > 0) any = true;
  }
  if (!any) { showToast('Slide at least one dial up first', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }
  const r = await apiFetch('/api/monarch/custom-plan', { method: 'POST', body: JSON.stringify({ units }) });
  if (btn) { btn.disabled = false; btn.textContent = 'Request this plan →'; }
  if (r && r.success) {
    showToast(`Custom plan requested — $${Number(r.monthly_usd).toFixed(2)}/mo, pending approval ✓`, 'success');
    document.getElementById('monarch-suite-card')?.remove();
    await loadMonarchSuite();
  }
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

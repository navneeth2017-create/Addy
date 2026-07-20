/**
 * "Sales Suite — powered by Monarch" card on the DSD dashboard.
 * Injected by monarch_integration.js; hides itself entirely when the
 * integration isn't configured. Uses globals from app.js (apiFetch,
 * showToast, esc).
 */

async function loadMonarchSuite() {
  const anchor = document.getElementById('margin-progress');
  if (!anchor || document.getElementById('monarch-suite-card')) return;

  const status = await apiFetch('/api/monarch/status');
  if (!status || !status.configured) return; // not set up — show nothing

  const card = document.createElement('div');
  card.id = 'monarch-suite-card';
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:20px;';
  anchor.after(card);

  // Monarch configured but unreachable — say so plainly instead of failing on click.
  if (status.monarch_reachable === false) {
    card.innerHTML = `
      <div style="font-weight:800;font-size:16px;margin-bottom:6px;">🚀 Sales Suite <span style="font-weight:500;font-size:12px;color:var(--text-muted);">powered by Monarch</span></div>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 14px;font-size:13px;color:#991b1b;">
        ⚠️ Can't reach Monarch right now.<br><span style="color:#7f1d1d;">${esc(status.monarch_error || 'connection failed')}</span>
        <div style="margin-top:8px;color:#7f1d1d;font-size:12px;">Check that Monarch is deployed and that <code>MONARCH_API_URL</code> (Addy) points to it, with <code>PARTNER_API_KEY</code> set on Monarch.</div>
      </div>`;
    return;
  }

  const ws = status.workspace;
  const tierNames = { free: 'Free', starter: 'Starter', pro: 'Pro' };

  if (ws) {
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:800;font-size:16px;">🚀 Sales Suite <span style="font-weight:500;font-size:12px;color:var(--text-muted);">powered by Monarch</span></div>
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
            Your plan: <strong>${esc(tierNames[ws.tier] || ws.tier)}</strong>
            ${ws.status !== 'active' ? ' · <span style="color:#dc2626;font-weight:700;">paused — update your payment method</span>' : ''}
            · Company code: <code>${esc(ws.slug)}</code>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${ws.temp_password !== null && ws.temp_password !== undefined ? `<button class="btn btn-sm btn-outline" onclick="revealMonarchCreds()">🔑 Show my login</button>` : ''}
          <a class="btn btn-sm btn-green" href="${esc(status.app_url)}" target="_blank" rel="noopener" style="text-decoration:none;">Open Sales Suite →</a>
          ${ws.tier !== 'pro' && status.checkout_ready ? `<button class="btn btn-sm" style="background:var(--accent);color:#fff;" onclick="upgradeMonarch('${ws.tier === 'free' ? 'starter' : 'pro'}')">⬆ Upgrade</button>` : ''}
        </div>
      </div>`;
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
    <div style="font-weight:800;font-size:16px;margin-bottom:2px;">🚀 Sales Suite <span style="font-weight:500;font-size:12px;color:var(--text-muted);">powered by Monarch</span></div>
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">Run your whole distribution business: your own CRM, AI calls &amp; texts, inventory, routes, and more — private to you.</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;">
      ${tierCard('free', 'Free', 'Claim your stores', ['Lock in your stores so no one else can claim them', 'Customer list & order history'],
        `<button class="btn btn-sm btn-green" onclick="startMonarchFree()" style="width:100%;">Start free</button>`)}
      ${tierCard('starter', 'Starter', 'Run the day-to-day', ['Inventory tracking', 'AI-written emails & texts', 'Visit check-ins & tasks', `${p.starter?.included?.texts ?? 250} texts / ${p.starter?.included?.ai_drafts ?? 200} AI drafts included monthly`],
        status.checkout_ready ? `<button class="btn btn-sm" style="width:100%;background:var(--accent);color:#fff;" onclick="upgradeMonarch('starter')">Subscribe</button>` : `<button class="btn btn-sm btn-outline" style="width:100%;" disabled>Coming soon</button>`)}
      ${tierCard('pro', 'Pro', 'Everything, automated', ['AI voice calls to prospects', 'Route optimization', 'Automated reorder outreach', 'Bulk email & flyer scanning'],
        status.checkout_ready ? `<button class="btn btn-sm" style="width:100%;background:var(--accent);color:#fff;" onclick="upgradeMonarch('pro')">Subscribe</button>` : `<button class="btn btn-sm btn-outline" style="width:100%;" disabled>Coming soon</button>`)}
    </div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-top:10px;">Paid plans include monthly usage; going over pauses the feature until you enable pay-per-use overage inside the Suite. Cancel anytime — you drop back to Free and keep your store claims.</div>`;
}

async function startMonarchFree() {
  showToast('Setting up your workspace…', 'info');
  const r = await apiFetch('/api/monarch/start-free', { method: 'POST' });
  if (r && r.success) {
    showToast('Sales Suite created ✓', 'success');
    document.getElementById('monarch-suite-card')?.remove();
    await loadMonarchSuite();
    revealMonarchCreds();
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

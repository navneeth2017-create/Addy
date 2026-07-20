/**
 * Frontend patches, loaded AFTER app.js (injected by server_patches.js into
 * dashboard-admin.html). Later function declarations replace the globals from
 * app.js, so these overrides take effect everywhere without editing app.js.
 *
 * Fixes the "NaN stats + stores gone" failure: any server error used to come
 * back from apiFetch as a truthy {error} object, so refreshAdminTable rendered
 * undefined stats (NaN) and crashed before drawing the table — which looked
 * exactly like all data had been deleted. It never was.
 */

/* eslint-disable no-unused-vars */

// ── 1. apiFetch: errors return null so every `if (!data) return` guard works ──
async function apiFetch(url, options = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(API + url, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...options.headers },
    });
  } catch (e) {
    showToast('Network error — check your connection and try again', 'error');
    return null;
  }
  if (res.status === 401) { logout(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || `Server error (${res.status}) — your data is safe, try refreshing`, 'error');
    return null;
  }
  return data;
}

// ── 2. NaN-proof formatters ──────────────────────────────────────────────────
function formatCurrency(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '$0';
  return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

// ── 3. refreshAdminTable: honest failure state instead of NaN + dead table ───
async function refreshAdminTable() {
  const { sort, order, page, search, category, state, status } = adminState;
  const params = new URLSearchParams({ sort, order, page, limit: 25, search, category, state, status });
  const data = await apiFetch(`/api/stores?${params}`);
  if (!data || !Array.isArray(data.stores)) {
    const tbody = document.getElementById('stores-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:28px;">
      ⚠️ Couldn't load stores — the server returned an error. Your data is NOT deleted.<br>
      <button class="btn btn-sm btn-outline" style="margin-top:10px;" onclick="refreshAdminTable()">↻ Try again</button>
    </td></tr>`;
    ['stat-total', 'stat-revenue', 'stat-avg', 'stat-active'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '—';
    });
    return;
  }

  animateValue(document.getElementById('stat-total'), Number(data.total) || 0);
  animateCurrency(document.getElementById('stat-revenue'), Number(data.total_revenue) || 0);
  animateCurrency(document.getElementById('stat-avg'), Number(data.avg_revenue) || 0);

  const statusCounts = {};
  (data.by_status || []).forEach(s => statusCounts[s.status] = s.count);
  const activeEl = document.getElementById('stat-active');
  if (activeEl) activeEl.textContent = `${statusCounts.active || 0} active / ${statusCounts.pending || 0} pending / ${statusCounts.inactive || 0} inactive`;

  renderProductRevenueChart('chart-category', data.by_product || []);
  renderOrdersOverTimeChart('chart-top', data.orders_over_time || []);

  selectedStores.clear();
  updateBulkBar();

  const tbody = document.getElementById('stores-tbody');
  if (data.stores.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="loading">No stores found</td></tr>';
  } else {
    tbody.innerHTML = data.stores.map(s => `
      <tr>
        <td class="check-col"><input type="checkbox" value="${s.id}" onchange="toggleStoreSelect(${s.id}, this.checked)"></td>
        <td data-label="Store"><span style="cursor:pointer" onclick="showStoreDetail(${s.id})"><span class="status-dot ${s.status}"></span>${esc(s.name)}</span>${(() => { const m = storeMissingInfo(s); return m.length ? ` <span title="Missing: ${m.join(', ')}" style="cursor:help;">⚠️</span><button onclick="event.stopPropagation();pingStoreOwner(${s.id}, '${esc(s.name)}')" title="Ping the rep to fix this" style="margin-left:2px;background:none;border:none;cursor:pointer;font-size:13px;padding:0;vertical-align:middle;">📨</button>` : ''; })()}</td>
        <td data-label="Owner">${esc(s.owner_name)}</td>
        <td data-label="Claimed By">${s.claimed_by ? esc(s.claimed_by) : '<span style="color:var(--text-muted);">—</span>'}</td>
        <td data-label="Email">${esc(s.email)}</td>
        <td data-label="City">${esc(s.city)}</td>
        <td data-label="State">${esc(s.state)}</td>
        <td data-label="Category">${esc(s.category)}</td>
        <td data-label="Status"><span class="status-badge ${s.status}">${s.status}</span></td>
        <td data-label="Revenue/mo" class="revenue-cell">${formatCurrency(s.monthly_revenue)}</td>
        <td data-label="Wholesale">${formatCurrency(s.wholesale_price)}</td>
        <td data-label="Retail">${formatCurrency(s.retail_price)}</td>
        <td data-label="Dist. Cost">${formatCurrency(s.distribution_cost)}</td>
      </tr>
    `).join('');
  }

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.remove('sorted', 'desc');
    if (th.dataset.sort === sort) {
      th.classList.add('sorted');
      if (order === 'desc') th.classList.add('desc');
    }
  });

  renderPagination(data, 'admin');
}

// ── 4. deleteAllStores: sends the server-side confirmation ───────────────────
async function deleteAllStores() {
  const total = document.getElementById('stat-total')?.textContent || 'all';
  const typed = prompt(`⚠️ This permanently deletes ALL ${total} stores.\n\nA full snapshot is uploaded to backup storage first, so it CAN be restored from Settings → View/Restore Backups.\n\nType DELETE to confirm:`);
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'DELETE') { showToast('Cancelled — you did not type DELETE', 'info'); return; }
  showToast('Snapshotting to backup storage, then deleting…', 'info');
  const result = await apiFetch('/api/stores/delete-all', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) });
  if (result && result.success) {
    showToast(`All ${result.deleted} stores deleted ✓ (snapshot saved — restorable from Settings)`, 'success');
    selectedStores.clear();
    refreshAdminTable();
    loadActivityFeed();
  }
}

// ── 5. Backup restore UI (injected into the Settings backup card) ────────────
function _injectRestoreButton() {
  const backupBtn = document.querySelector('button[onclick="triggerBackup()"]');
  if (!backupBtn || document.getElementById('backups-restore-btn')) return;
  const viewBtn = document.createElement('button');
  viewBtn.id = 'backups-restore-btn';
  viewBtn.className = 'btn btn-outline btn-sm';
  viewBtn.style.cssText = 'font-size:13px;margin-left:8px;';
  viewBtn.textContent = '📥 View / Restore Backups';
  viewBtn.onclick = loadBackupsList;
  backupBtn.after(viewBtn);
  const listDiv = document.createElement('div');
  listDiv.id = 'backups-list';
  listDiv.style.marginTop = '14px';
  backupBtn.parentElement.appendChild(listDiv);
}
document.addEventListener('DOMContentLoaded', _injectRestoreButton);
if (document.readyState !== 'loading') _injectRestoreButton();

async function loadBackupsList() {
  const el = document.getElementById('backups-list');
  if (!el) return;
  el.innerHTML = '<div class="loading">Loading backups…</div>';
  const data = await apiFetch('/api/admin/backups');
  if (!data || !Array.isArray(data.backups)) { el.innerHTML = '<p style="font-size:13px;color:#dc2626;">Couldn\'t list backups — are the B2 env vars set in Railway?</p>'; return; }
  if (data.backups.length === 0) { el.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">No backups in the bucket yet. Run one now, then it appears here.</p>'; return; }
  el.innerHTML = `
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <thead><tr style="text-align:left;color:var(--text-muted);"><th style="padding:4px;">Backup</th><th>Type</th><th>Size</th><th></th></tr></thead>
      <tbody>${data.backups.map(b => `
        <tr style="border-top:1px solid var(--border);">
          <td style="padding:6px 4px;">${esc(b.fileName.split('/').pop())}<br><span style="color:var(--text-muted);">${new Date(b.uploaded_at).toLocaleString()}</span></td>
          <td>${esc(b.kind)}</td>
          <td>${(b.size / 1024 / 1024).toFixed(2)} MB</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-sm btn-outline" onclick="previewBackup('${esc(b.fileId)}')">👁 Preview</button>
            <button class="btn btn-sm btn-green" onclick="restoreBackup('${esc(b.fileId)}', '${esc(b.fileName.split('/').pop())}')">↩ Restore</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div id="backup-preview" style="margin-top:10px;"></div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:10px;">Restore is a <strong>merge</strong>: it puts back rows that are missing and never overwrites or deletes anything that exists now. A snapshot of the current data is taken automatically before every restore.</p>`;
}

async function previewBackup(fileId) {
  const el = document.getElementById('backup-preview');
  if (el) el.innerHTML = '<div class="loading">Downloading backup…</div>';
  const data = await apiFetch('/api/admin/backups/preview', { method: 'POST', body: JSON.stringify({ fileId }) });
  if (!data || !data.tables) { if (el) el.innerHTML = ''; return; }
  const rows = Object.entries(data.tables).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  if (el) el.innerHTML = `<div style="background:var(--bg-secondary,#f3f4f6);border-radius:8px;padding:10px 14px;font-size:13px;">
    <strong>Contents (taken ${new Date(data.timestamp).toLocaleString()}):</strong><br>
    ${rows.map(([t, c]) => `${esc(t)}: <strong>${c}</strong>`).join(' · ') || 'empty backup'}
  </div>`;
}

async function restoreBackup(fileId, name) {
  const typed = prompt(`Restore "${name}" into the live database?\n\nThis is a MERGE — nothing that exists now is deleted or overwritten; missing rows are put back.\n\nType RESTORE to confirm:`);
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'RESTORE') { showToast('Cancelled — you did not type RESTORE', 'info'); return; }
  showToast('Restoring — this can take a minute…', 'info');
  const result = await apiFetch('/api/admin/backups/restore', { method: 'POST', body: JSON.stringify({ fileId, confirm: 'RESTORE' }) });
  if (result && result.success) {
    const back = Object.entries(result.report || {}).filter(([, r]) => r.inserted > 0).map(([t, r]) => `${t}: ${r.inserted}`).join(', ');
    showToast(`Restore complete ✓ ${back ? 'Recovered — ' + back : 'Nothing was missing.'}`, 'success');
    refreshAdminTable();
    loadActivityFeed();
  }
}

console.log('🩹 frontend patches active (error-safe loading, NaN-proof stats, backup restore UI)');

// ── Sales Suite (Monarch) — admin overview card in Settings ──────────────────
// Shows partner workspaces + monthly overage to bill. When the integration
// isn't configured (or not deployed), it says exactly what's missing — so the
// admin always sees SOMETHING about Monarch, never silence.
async function loadMonarchAdminCard() {
  const settingsTab = document.getElementById('tab-settings');
  if (!settingsTab || document.getElementById('monarch-admin-card')) return;
  const card = document.createElement('div');
  card.id = 'monarch-admin-card';
  card.className = 'table-card';
  card.style.cssText = 'max-width:640px;margin-bottom:24px;';
  card.innerHTML = `
    <div class="table-toolbar"><div><h2 style="margin:0 0 4px;display:flex;align-items:center;gap:8px;"><svg width="22" height="22" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style="flex:none;vertical-align:middle;"><g transform="rotate(-6 32 32)"><path d="M31 21.5 C29 16.5 26.5 13.5 23.5 12.5" fill="none" stroke="#5b3a1e" stroke-width="2" stroke-linecap="round"/><path d="M33 21.5 C35 16.5 37.5 13.5 40.5 12.5" fill="none" stroke="#5b3a1e" stroke-width="2" stroke-linecap="round"/><path d="M30.5 30 C26 13 9 4 5 11 C1 18 11 30 29 34.5 Z" fill="#E8873B"/><path d="M29.5 35 C16 34 5 43 8.5 51 C12 58.5 26 52 30.5 38 Z" fill="#B96A2C"/><path d="M33.5 30 C38 13 55 4 59 11 C63 18 53 30 35 34.5 Z" fill="#E8873B"/><path d="M34.5 35 C48 34 59 43 55.5 51 C52 58.5 38 52 33.5 38 Z" fill="#B96A2C"/><ellipse cx="32" cy="36.5" rx="2.6" ry="10.5" fill="#5b3a1e"/><circle cx="32" cy="24" r="2.9" fill="#5b3a1e"/></g></svg>Sales Suite <span style="font-weight:500;font-size:13px;color:var(--text-secondary);">powered by Monarch</span></h2>
      <p style="font-size:13px;color:var(--text-secondary);margin:0;">Partner workspaces &amp; monthly overage to bill</p></div>
      <button class="btn btn-outline btn-sm" onclick="diagnoseMonarch(this)" title="Live-test the partner API connection to Monarch">🔧 Test connection</button></div>
    <div id="monarch-diagnose-result" style="margin:0 24px;"></div>
    <div id="monarch-admin-body" style="padding:0 24px 20px;"><div class="loading">Loading…</div></div>`;
  // Insert at the TOP of Settings (after the page header) so it's the first thing seen.
  const header = settingsTab.querySelector('.page-header');
  if (header && header.nextSibling) settingsTab.insertBefore(card, header.nextSibling);
  else settingsTab.insertBefore(card, settingsTab.firstChild);
  const body = card.querySelector('#monarch-admin-body');

  const data = await apiFetch('/api/admin/monarch/usage');
  if (!data) {
    body.innerHTML = '<p style="font-size:13px;color:#dc2626;">Couldn\'t reach the integration — is the new code (boot.js + monarch_integration.js + package.json) deployed?</p>';
    return;
  }
  if (data.configured && data.monarch_reachable === false) {
    body.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 14px;font-size:13px;color:#991b1b;">
      ⚠️ Configured, but can't reach Monarch:<br><span style="color:#7f1d1d;">${esc(data.monarch_error || 'connection failed')}</span>
      <div style="margin-top:8px;font-size:12px;">Verify Monarch is deployed and <code>MONARCH_API_URL</code> is correct, with <code>PARTNER_API_KEY</code> set on Monarch.</div></div>`;
    return;
  }
  if (!data.configured) {
    body.innerHTML = `
      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px;">Deployed ✓ but not configured. Add these in Railway → Variables, then redeploy:</p>
      <pre style="font-size:12px;background:var(--bg-secondary,#f3f4f6);padding:10px 12px;border-radius:8px;overflow-x:auto;">MONARCH_API_URL=https://your-monarch-url
MONARCH_APP_URL=https://your-monarch-url
MONARCH_PARTNER_KEY=some-long-random-secret</pre>
      <p style="font-size:12px;color:var(--text-muted);margin:8px 0 0;">Also set <code>PARTNER_API_KEY</code> = the same secret on the Monarch deployment. Partners then get the Sales Suite card on <strong>their</strong> dashboard (it never shows on this admin page).</p>`;
    return;
  }
  const c = data.counts || { total: (data.workspaces||[]).length, synced: 0, pending_sync: 0, paid: 0 };
  const countsBar = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin:0 0 14px;font-size:13px;">
      <div><strong style="font-size:20px;">${c.total}</strong><br><span style="color:var(--text-muted);">Sales Suite users</span></div>
      <div><strong style="font-size:20px;color:#059669;">${c.synced}</strong><br><span style="color:var(--text-muted);">live in Monarch</span></div>
      <div><strong style="font-size:20px;">${c.paid}</strong><br><span style="color:var(--text-muted);">on paid plans</span></div>
      ${c.pending_sync ? `<div><strong style="font-size:20px;color:#e8873b;">${c.pending_sync}</strong><br><span style="color:var(--text-muted);">pending sync</span></div>` : ''}
    </div>
    ${c.pending_sync ? `<button class="btn btn-sm btn-outline" onclick="syncMonarchUsers(this)" style="margin-bottom:12px;">↻ Sync ${c.pending_sync} to Monarch now</button>` : ''}`;
  if (!data.workspaces || data.workspaces.length === 0) {
    body.innerHTML = countsBar + '<p style="font-size:13px;color:var(--text-secondary);">No Sales Suite users yet. When a partner clicks “Start free” or subscribes, they appear here.</p>';
    return;
  }
  body.innerHTML = countsBar + `
    <table style="width:100%;font-size:13px;border-collapse:collapse;">
      <thead><tr style="text-align:left;color:var(--text-muted);"><th style="padding:4px;">Partner</th><th>Plan</th><th>In Monarch</th><th>Overage this month</th></tr></thead>
      <tbody>${data.workspaces.map(w => `
        <tr style="border-top:1px solid var(--border);">
          <td style="padding:6px 4px;">${esc(w.name || w.email)}<br><span style="color:var(--text-muted);">${esc(w.slug)}</span></td>
          <td>${esc(w.tier)}</td>
          <td>${w.monarch_provisioned ? '✓' : '<span style="color:#e8873b;">pending</span>'}</td>
          <td style="font-weight:700;">${w.tier === 'free' ? '—' : '$' + Number(w.usage?.overage_total_usd || 0).toFixed(2)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p style="font-size:12px;color:var(--text-muted);margin-top:10px;">Free users are counted for the Monarch user base; only paid plans accrue overage. Add each paid partner's overage to their invoice at month end.</p>`;
}

async function diagnoseMonarch(btn) {
  const out = document.getElementById('monarch-diagnose-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  if (out) out.innerHTML = '<div class="loading" style="padding:10px 0;">Contacting Monarch…</div>';
  const d = await apiFetch('/api/admin/monarch/diagnose');
  if (btn) { btn.disabled = false; btn.textContent = '🔧 Test connection'; }
  if (!out) return;
  if (!d) { out.innerHTML = '<p style="font-size:13px;color:#dc2626;padding:10px 0;">Couldn\'t reach the Addy integration itself — is the new code deployed?</p>'; return; }
  const good = d.ok === true;
  const whitespace = d.key_set && d.key_len !== d.key_trimmed_len;
  out.innerHTML = `
    <div style="background:${good ? '#f0fdf4' : '#fef2f2'};border:1px solid ${good ? '#bbf7d0' : '#fecaca'};border-radius:8px;padding:12px 14px;margin:4px 0 14px;font-size:13px;color:${good ? '#166534' : '#991b1b'};">
      <div style="font-weight:700;margin-bottom:6px;">${esc(d.verdict || (good ? 'Connected' : 'Failed'))}</div>
      <div style="font-family:monospace;font-size:12px;line-height:1.7;color:${good ? '#15803d' : '#7f1d1d'};">
        api_url: ${esc(String(d.api_url))}<br>
        probe: ${esc(String(d.probe_url || '—'))}<br>
        key_set: ${d.key_set ? 'yes' : 'NO'} · key_len: ${d.key_len}${whitespace ? ` <span style="color:#b45309;font-weight:700;">⚠ trimmed=${d.key_trimmed_len} — the key has leading/trailing whitespace!</span>` : ''}<br>
        ${d.status !== undefined ? `http_status: ${d.status}<br>` : ''}
        ${d.fetch_error ? `fetch_error: ${esc(String(d.fetch_error))}<br>` : ''}
        ${d.body ? `body: ${esc(String(d.body))}` : ''}
      </div>
    </div>`;
}

async function syncMonarchUsers(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  const r = await apiFetch('/api/admin/monarch/sync', { method: 'POST' });
  if (r) showToast(`Synced ${r.synced}/${r.attempted} to Monarch${r.failed ? ' — ' + r.failed + ' still failing (is Monarch reachable?)' : ''}`, r.failed ? 'error' : 'success');
  document.getElementById('monarch-admin-card')?.remove();
  loadMonarchAdminCard();
}
document.addEventListener('DOMContentLoaded', loadMonarchAdminCard);
if (document.readyState !== 'loading') loadMonarchAdminCard();
// The Settings tab may render after first load; re-run on any admin-tab click
// (loadMonarchAdminCard is idempotent — it no-ops if the card already exists).
document.addEventListener('click', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('admin-tab')) {
    setTimeout(loadMonarchAdminCard, 30);
  }
});

const API = '';

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
let _vapidPublicKey = null;

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const config = await apiFetch('/api/config');
    _vapidPublicKey = config?.vapidPublicKey;
    const reg = await navigator.serviceWorker.register('/sw.js');
    const existing = await reg.pushManager.getSubscription();
    updatePushBellUI(!!existing);
  } catch(e) { console.log('Push init failed:', e.message); }
}

function updatePushBellUI(isSubscribed) {
  const btn = document.getElementById('push-bell-btn');
  if (!btn) return;
  if (isSubscribed) {
    btn.style.background = 'var(--accent-bg)';
    btn.style.borderColor = 'var(--accent)';
    btn.title = 'Order notifications ON — click to disable';
    btn.textContent = '🔔';
  } else {
    btn.style.background = 'none';
    btn.style.borderColor = 'var(--border)';
    btn.title = 'Click to enable order notifications';
    btn.textContent = '🔕';
  }
}

async function togglePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Push notifications not supported in this browser', 'error');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
      await apiFetch('/api/push/unsubscribe', { method: 'DELETE' });
      updatePushBellUI(false);
      showToast('Order notifications disabled', 'success');
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        showToast('Please allow notifications in your browser settings', 'error');
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(_vapidPublicKey)
      });
      await apiFetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
      updatePushBellUI(true);
      showToast('✓ Order notifications enabled! You\'ll be notified of new orders.', 'success');
    }
  } catch(e) {
    console.error('Push toggle error:', e);
    showToast('Could not update notification settings', 'error');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function getToken() { return localStorage.getItem('addy_token'); }
function getRole() { return localStorage.getItem('addy_role'); }

function logout() {
  localStorage.removeItem('addy_token');
  localStorage.removeItem('addy_role');

  // Cover the dashboard IMMEDIATELY — no opacity transition on the overlay itself
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    background:#0f172a;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:'DM Sans',sans-serif;
    text-align:center;padding:24px;
  `;

  overlay.innerHTML = `
    <div id="farewell-inner" style="opacity:0;transform:translateY(16px);transition:opacity 0.6s ease 0.15s,transform 0.6s ease 0.15s;">
      <div style="margin:0 auto 28px;text-align:center;">
        <img src="/images/addy-logo.svg" alt="ADDY" style="height:64px;width:auto;object-fit:contain;">
      </div>
      <p style="font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#3b82f6;margin-bottom:18px;">ADDY Distribution</p>
      <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:clamp(36px,6vw,64px);font-weight:800;color:#ffffff;line-height:1.1;letter-spacing:-1px;margin-bottom:20px;">
        Until next time.
      </h1>
      <p style="font-size:17px;color:#64748b;max-width:400px;line-height:1.65;margin:0 auto;">
        Your session has ended. Your products and pricing will be here when you return.
      </p>
      <div style="margin-top:48px;display:flex;align-items:center;gap:10px;justify-content:center;opacity:0.4;" id="farewell-loader">
        <div style="width:5px;height:5px;background:#3b82f6;border-radius:50%;animation:farewell-dot 1.2s ease-in-out infinite 0s;"></div>
        <div style="width:5px;height:5px;background:#3b82f6;border-radius:50%;animation:farewell-dot 1.2s ease-in-out infinite 0.2s;"></div>
        <div style="width:5px;height:5px;background:#3b82f6;border-radius:50%;animation:farewell-dot 1.2s ease-in-out infinite 0.4s;"></div>
      </div>
    </div>
    <style>
      @keyframes farewell-dot {
        0%,80%,100% { transform:scale(0.6);opacity:0.3; }
        40% { transform:scale(1);opacity:1; }
      }
    </style>
  `;

  document.body.appendChild(overlay);

  // Animate inner content in after overlay is already covering the screen
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const inner = document.getElementById('farewell-inner');
      if (inner) { inner.style.opacity = '1'; inner.style.transform = 'translateY(0)'; }
    });
  });

  setTimeout(() => { window.location.replace('/index.html'); }, 2600);
}

function requireAuth(allowedRoles) {
  const token = getToken();
  const role = getRole();
  if (!token || !role) { window.location.href = '/login.html'; return false; }
  if (allowedRoles && !allowedRoles.includes(role)) { window.location.href = '/login.html'; return false; }
  return true;
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const res = await fetch(API + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...options.headers }
  });
  if (res.status === 401) { logout(); return null; }
  const data = await res.json();
  if (!res.ok && data.error) { showToast(data.error, 'error'); }
  return data;
}

function openInvoice(orderId) {
  const token = getToken();
  const a = document.createElement('a');
  a.href = '/api/invoices/' + orderId + '/print?token=' + token;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function formatCurrency(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

// --- Logo ---
function renderLogo(container) {
  if (!container) return;
  try {
    const token = localStorage.getItem('addy_token');
    const role = token ? JSON.parse(atob(token.split('.')[1])).role : null;
    const href = role === 'admin' ? '/dashboard-admin.html' : '/dashboard-dsd.html';
    container.innerHTML = `<a href="${href}" style="display:flex;align-items:center;text-decoration:none;cursor:pointer;">
      <img src="/images/addy-logo.svg" alt="ADDY" style="height:52px;width:auto;object-fit:contain;" onerror="this.style.display='none';this.parentElement.textContent='ADDY'">
    </a>`;
  } catch(e) {
    container.innerHTML = '<a href="/dashboard-dsd.html" style="text-decoration:none;font-weight:900;font-size:22px;color:var(--text);">ADDY</a>';
  }
}


// --- Dark Mode ---
function initTheme() {
  const saved = localStorage.getItem('addy_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeButton(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('addy_theme', next);
  updateThemeButton(next);
}

function updateThemeButton(theme) {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
}

// --- Toast Notifications ---
function showToast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '\u2713', error: '\u2717', info: '\u24D8' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// --- Animated Counter ---
function animateValue(el, end) {
  if (!el) return;
  el.classList.add('stat-pop');
  const duration = 800;
  const startTime = performance.now();
  const endNum = Number(end);
  function update(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatNumber(Math.round(endNum * eased));
    if (progress < 1) requestAnimationFrame(update);
    else el.textContent = formatNumber(endNum);
  }
  requestAnimationFrame(update);
}

function animateCurrency(el, end) {
  if (!el) return;
  el.classList.add('stat-pop');
  const duration = 800;
  const startTime = performance.now();
  const endNum = Number(end);
  function update(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatCurrency(Math.round(endNum * eased));
    if (progress < 1) requestAnimationFrame(update);
    else el.textContent = formatCurrency(endNum);
  }
  requestAnimationFrame(update);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// --- Skeleton Loaders ---
function renderSkeletonRows(tbody, cols, rows = 5) {
  tbody.innerHTML = Array(rows).fill('').map(() =>
    `<tr>${Array(cols).fill('').map((_, i) =>
      `<td><div class="skeleton-cell" style="width:${60 + Math.random() * 40}%; height:16px;"></div></td>`
    ).join('')}</tr>`
  ).join('');
}

function renderSkeletonStats(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="skeleton-stat"></div>';
  });
}

// --- Session Timeout ---
function initSessionTimeout() {
  const token = getToken();
  if (!token) return;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const expiry = payload.exp * 1000;
    const warnAt = expiry - 5 * 60 * 1000;

    const checkInterval = setInterval(() => {
      const now = Date.now();
      if (now >= expiry) {
        clearInterval(checkInterval);
        logout();
      } else if (now >= warnAt) {
        let warning = document.getElementById('session-warning');
        if (!warning) {
          warning = document.createElement('div');
          warning.id = 'session-warning';
          warning.className = 'session-warning active';
          warning.textContent = 'Your session is expiring soon. Click here to sign in again.';
          warning.onclick = logout;
          document.body.prepend(warning);
        }
      }
    }, 30000);
  } catch {}
}

// --- Profile ---
function showProfile() {
  document.getElementById('profile-modal').classList.add('active');
}

async function handleChangePassword(e) {
  e.preventDefault();
  const form = e.target;
  const current_password = form.current_password.value;
  const new_password = form.new_password.value;
  const confirm_password = form.confirm_password.value;

  if (new_password !== confirm_password) {
    showToast('Passwords do not match', 'error');
    return;
  }

  const result = await apiFetch('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ current_password, new_password })
  });

  if (result && result.success) {
    showToast('Password updated successfully', 'success');
    closeModal();
    form.reset();
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

// ==========================================
// LOGIN
// ==========================================

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error-msg');
  errorEl.style.display = 'none';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.style.display = 'block';
      return;
    }
    localStorage.setItem('addy_token', data.token);
    localStorage.setItem('addy_role', data.role);
    const t = data.token;
    switch (data.role) {
      case 'admin':       window.location.href = `/dashboard-admin.html?t=${t}`; break;
      case 'investor':    window.location.href = `/dashboard-dsd.html?t=${t}`; break;
      case 'dsd': window.location.href = `/dashboard-dsd.html?t=${t}`; break;
      case 'dsd': window.location.href = `/dashboard-dsd.html?t=${t}`; break;
      case 'rep':         window.location.href = `/dashboard-dsd.html?t=${t}`; break;
      default:            window.location.href = `/dashboard-admin.html?t=${t}`;
    }
  } catch {
    errorEl.textContent = 'Connection error';
    errorEl.style.display = 'block';
  }
}

// ==========================================
// ADDY DSD TIER & COMMISSION FUNCTIONS
// ==========================================

async function setUserTier(userId, tier) {
  const result = await apiFetch('/api/users/' + userId + '/tier', { method: 'PATCH', body: JSON.stringify({ tier: parseInt(tier) }) });
  if (result && result.success) { showToast('Tier updated to Tier ' + tier + ' ✓', 'success'); loadUsersTab(); }
}

async function loadCommissionsTab() {
  await loadPayoutRequests();
  await loadCommissionsTable();
}

async function loadPayoutRequests() {
  const el = document.getElementById('payout-requests-list');
  if (!el) return;
  const requests = await apiFetch('/api/payouts');
  const pending = (requests || []).filter(r => r.status === 'pending');
  const badge = document.getElementById('payouts-badge');
  if (badge) { badge.textContent = pending.length; badge.style.display = pending.length ? 'inline' : 'none'; }
  if (!pending.length) {
    el.innerHTML = `<div style="padding:32px;text-align:center;">
      <div style="font-size:28px;margin-bottom:10px;">✅</div>
      <div style="font-weight:600;color:var(--text);margin-bottom:4px;">All caught up</div>
      <div style="font-size:13px;color:var(--text-muted);">No pending payout requests right now.</div>
    </div>`;
    return;
  }
  el.innerHTML = pending.map(r => `
    <div style="display:flex;align-items:center;gap:16px;padding:16px;border:1px solid var(--border);border-radius:12px;margin-bottom:10px;background:var(--bg-card);">
      <div style="flex:1;">
        <div style="font-weight:700;color:var(--text);">${esc(r.name || r.email)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(r.email)} · Requested ${new Date(r.created_at).toLocaleDateString()}</div>
        ${r.stripe_connect_id ? '<div style="font-size:11px;color:var(--green);">✓ Stripe Connected</div>' : '<div style="font-size:11px;color:var(--yellow);">⚠ No Stripe account — mark paid manually</div>'}
      </div>
      <div style="font-size:22px;font-weight:800;color:var(--green);">$${parseFloat(r.amount).toFixed(2)}</div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm btn-green" onclick="approvePayoutRequest(${r.id})">✓ Approve & Pay</button>
        <button class="btn btn-sm btn-danger" onclick="rejectPayoutRequest(${r.id})">Reject</button>
      </div>
    </div>`).join('');
}

async function approvePayoutRequest(id) {
  if (!confirm('Approve and pay this payout request?')) return;
  const result = await apiFetch('/api/payouts/' + id + '/approve', { method: 'PATCH' });
  if (result && result.success) { showToast(result.stripe_transfer_id ? 'Payout sent via Stripe ✓' : 'Payout approved ✓ (mark as manually paid)', 'success'); loadPayoutRequests(); }
}

async function rejectPayoutRequest(id) {
  const note = prompt('Reason for rejection (optional):') || '';
  const result = await apiFetch('/api/payouts/' + id + '/reject', { method: 'PATCH', body: JSON.stringify({ note }) });
  if (result && result.success) { showToast('Payout rejected', 'info'); loadPayoutRequests(); }
}

async function loadCommissionsTable() {
  const tbody = document.getElementById('commissions-tbody');
  if (!tbody) return;
  const rows = await apiFetch('/api/commissions');
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;">
      <div style="font-size:28px;margin-bottom:10px;">💸</div>
      <div style="font-weight:600;color:var(--text);margin-bottom:4px;">No commissions yet</div>
      <div style="font-size:13px;color:var(--text-muted);">Commissions are earned when a Tier 2 or Tier 3 DSD places an order.<br>They'll show up here automatically.</div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${esc(r.earner_name || r.earner_email || '—')}</td>
    <td>${esc(r.buyer_name || '—')}</td>
    <td><span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:var(--accent-bg);color:var(--accent);">Level ${r.level}</span></td>
    <td>${(parseFloat(r.rate)*100).toFixed(0)}%</td>
    <td style="font-weight:700;color:var(--green);">$${parseFloat(r.amount).toFixed(2)}</td>
    <td><span class="status-badge ${r.status}">${r.status}</span></td>
    <td style="font-size:12px;color:var(--text-muted);">${new Date(r.created_at).toLocaleDateString()}</td>
  </tr>`).join('');
}

async function loadStoreClaimsTab() {
  const el = document.getElementById('store-claims-list');
  if (!el) return;
  const claims = await apiFetch('/api/stores/pending-claims');
  const badge = document.getElementById('claims-badge');
  if (badge) { badge.textContent = (claims||[]).length; badge.style.display = (claims||[]).length ? 'inline' : 'none'; }
  if (!claims || !claims.length) { el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No pending store claims</div>'; return; }
  el.innerHTML = claims.map(s => `
    <div style="display:flex;align-items:center;gap:16px;padding:16px;border:1px solid var(--border);border-radius:12px;margin-bottom:10px;background:var(--bg-card);">
      <div style="flex:1;">
        <div style="font-weight:700;font-size:15px;color:var(--text);">${esc(s.name)}</div>
        <div style="font-size:13px;color:var(--text-secondary);">${esc([s.address,s.city,s.state,s.zip].filter(Boolean).join(', '))}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Claimed by: <strong>${esc(s.rep_name||s.rep_email)}</strong></div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm btn-green" onclick="approveStoreClaim(${s.id})">✓ Approve</button>
        <button class="btn btn-sm btn-danger" onclick="rejectStoreClaim(${s.id})">Reject</button>
      </div>
    </div>`).join('');
}

async function approveStoreClaim(storeId) {
  const result = await apiFetch('/api/stores/' + storeId + '/approve-claim', { method: 'PATCH', body: JSON.stringify({ approved: true }) });
  if (result && result.success) { showToast('Store claim approved ✓', 'success'); loadStoreClaimsTab(); }
}

async function rejectStoreClaim(storeId) {
  const result = await apiFetch('/api/stores/' + storeId + '/approve-claim', { method: 'PATCH', body: JSON.stringify({ approved: false }) });
  if (result && result.success) { showToast('Store claim rejected', 'info'); loadStoreClaimsTab(); }
}

async function loadOwnershipRequestsTab() {
  const el = document.getElementById('ownership-requests-list');
  if (!el) return;
  const requests = await apiFetch('/api/ownership-requests');
  if (!requests || !requests.length) {
    el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted);">No pending ownership requests</div>';
    return;
  }
  el.innerHTML = requests.map(r => `
    <div style="display:flex;align-items:center;gap:16px;padding:16px;border:1px solid var(--border);border-radius:12px;margin-bottom:10px;background:var(--bg-card);">
      <div style="flex:1;">
        <div style="font-weight:700;font-size:15px;color:var(--text);">${esc(r.store_name)}</div>
        <div style="font-size:13px;color:var(--text-secondary);">${esc([r.city, r.state].filter(Boolean).join(', '))}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
          Requested by: <strong>${esc(r.requester_name||r.requester_email)}</strong>
          ${r.current_owner_name ? ` — currently owned by <strong>${esc(r.current_owner_name)}</strong>` : ''}
        </div>
        ${r.message ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;font-style:italic;">"${esc(r.message)}"</div>` : ''}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-sm btn-green" onclick="handleOwnershipRequest(${r.id}, true)">✓ Approve Transfer</button>
        <button class="btn btn-sm btn-danger" onclick="handleOwnershipRequest(${r.id}, false)">Reject</button>
      </div>
    </div>`).join('');
}

async function handleOwnershipRequest(requestId, approved) {
  const result = await apiFetch('/api/ownership-requests/' + requestId, { method: 'PATCH', body: JSON.stringify({ approved }) });
  if (result && result.success) {
    showToast(approved ? 'Ownership transferred ✓' : 'Request rejected', approved ? 'success' : 'info');
    loadOwnershipRequestsTab();
  }
}

// ==========================================
// ADMIN DASHBOARD
// ==========================================

let adminState = { sort: 'name', order: 'asc', page: 1, search: '', category: '', state: '', status: '' };
let selectedStores = new Set();

async function loadAdminDashboard() {
  if (!requireAuth(['admin'])) return;
  window._userRole = 'admin';
  initTheme();
  initSessionTimeout();
  initPushNotifications();
  document.getElementById('user-role').textContent = 'Admin';
  document.getElementById('user-role').className = 'role-badge admin';
  renderLogo(document.getElementById('logo-container'));

  renderSkeletonStats(['stat-total', 'stat-revenue', 'stat-avg', 'stat-active']);

  const filters = await apiFetch('/api/filters');
  if (filters) {
    const catSelect = document.getElementById('filter-category');
    const stateSelect = document.getElementById('filter-state');
    if (catSelect) catSelect.innerHTML = '<option value="">All Categories</option>' + filters.categories.map(c => `<option value="${c}">${c}</option>`).join('');
    if (stateSelect) stateSelect.innerHTML = '<option value="">All States</option>' + filters.states.map(s => `<option value="${s}">${s}</option>`).join('');
  }

  await refreshAdminTable();
  await loadActivityFeed();
  await loadPendingBadge();
  await checkLowStockBadge();
  await checkNewOrdersBadge();
}

// --- Admin Activity Feed ---
async function loadActivityFeed() {
  const entries = await apiFetch('/api/activity?limit=10');
  const container = document.getElementById('activity-list');
  if (!container || !entries) return;

  if (entries.length === 0) {
    container.innerHTML = '<li class="activity-item" style="color:var(--text-muted)">No recent activity</li>';
    return;
  }

  container.innerHTML = entries.map(e => {
    const actionLabels = { created: 'Added', updated: 'Updated', deleted: 'Deleted', status_changed: 'Changed status of' };
    return `
      <li class="activity-item">
        <span class="activity-dot ${e.action}"></span>
        <span class="activity-text">${actionLabels[e.action] || e.action} <strong>${esc(e.target_name)}</strong></span>
        <span class="activity-time">${timeAgo(e.created_at)}</span>
      </li>
    `;
  }).join('');
}

// --- Store Detail Modal with Notes ---
async function showStoreDetail(id) {
  const [store, notes] = await Promise.all([
    apiFetch(`/api/stores/${id}`),
    apiFetch(`/api/stores/${id}/notes`)
  ]);
  if (!store) return;

  const notesHtml = (notes || []).map(n => `
    <div class="note-item">
      <div class="note-text">${esc(n.note)}</div>
      <div class="note-time">${timeAgo(n.created_at)}</div>
    </div>
  `).join('') || '<div style="color:var(--text-muted);font-size:13px;">No notes yet</div>';

  document.getElementById('modal-content').innerHTML = `
    <div class="detail-row"><span class="detail-label">Store Name</span><span class="detail-value">${esc(store.name)}</span></div>
    <div class="detail-row"><span class="detail-label">Owner</span><span class="detail-value">${esc(store.owner_name)}</span></div>
    <div class="detail-row"><span class="detail-label">Email</span><span class="detail-value">${esc(store.email)}</span></div>
    <div class="detail-row"><span class="detail-label">Address</span><span class="detail-value">${esc(store.address)}, ${esc(store.city)}, ${esc(store.state)} ${esc(store.zip)}</span></div>
    <div class="detail-row"><span class="detail-label">Category</span><span class="detail-value">${esc(store.category)}</span></div>
    <div class="detail-row"><span class="detail-label">Revenue</span><span class="detail-value revenue">${formatCurrency(store.monthly_revenue)}/mo</span></div>
    <div class="detail-row">
      <span class="detail-label">Status</span>
      <span class="detail-value">
        <select class="filter-select" style="min-width:auto;padding:6px 10px;" onchange="changeStoreStatus(${store.id}, this.value)">
          <option value="active" ${store.status==='active'?'selected':''}>Active</option>
          <option value="pending" ${store.status==='pending'?'selected':''}>Pending</option>
          <option value="inactive" ${store.status==='inactive'?'selected':''}>Inactive</option>
        </select>
      </span>
    </div>
    <div style="margin-top: 16px; display: flex; gap: 12px;">
      <button class="btn btn-sm btn-danger" onclick="deleteStore(${store.id})">Delete Store</button>
    </div>
    <div class="notes-section">
      <h3>Notes</h3>
      ${notesHtml}
      <div class="note-input-row">
        <input type="text" id="note-input-${store.id}" placeholder="Add a note..." onkeydown="if(event.key==='Enter')addNote(${store.id})">
        <button class="btn btn-sm" onclick="addNote(${store.id})">Add</button>
      </div>
    </div>
  `;

  document.getElementById('store-modal').classList.add('active');
}

async function addNote(storeId) {
  const input = document.getElementById(`note-input-${storeId}`);
  if (!input || !input.value.trim()) return;
  await apiFetch(`/api/stores/${storeId}/notes`, { method: 'POST', body: JSON.stringify({ note: input.value.trim() }) });
  showToast('Note added', 'success');
  showStoreDetail(storeId);
}

async function changeStoreStatus(id, status) {
  await apiFetch(`/api/stores/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  showToast(`Status changed to ${status}`, 'info');
  refreshAdminTable();
  loadActivityFeed();
}

function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
}

function sortAdmin(field) {
  if (adminState.sort === field) adminState.order = adminState.order === 'asc' ? 'desc' : 'asc';
  else { adminState.sort = field; adminState.order = 'asc'; }
  adminState.page = 1;
  refreshAdminTable();
}

const adminSearchDebounced = debounce(val => {
  adminState.search = val;
  adminState.page = 1;
  refreshAdminTable();
}, 300);

function adminFilter(type, val) {
  adminState[type] = val;
  adminState.page = 1;
  refreshAdminTable();
}

function adminPage(p) {
  adminState.page = p;
  refreshAdminTable();
}

function exportCSV() {
  const token = getToken();
  const { search, category, state, status } = adminState;
  const params = new URLSearchParams({ token, search, category, state, status });
  window.open(`/api/export/csv?${params}`, '_blank');
  showToast('CSV export started', 'info');
}

// --- Bulk Actions ---
function toggleStoreSelect(id, checked) {
  if (checked) selectedStores.add(id);
  else selectedStores.delete(id);
  updateBulkBar();
}

function toggleSelectAll(checked) {
  const checkboxes = document.querySelectorAll('#stores-tbody input[type="checkbox"]');
  checkboxes.forEach(cb => { cb.checked = checked; toggleStoreSelect(parseInt(cb.value), checked); });
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  if (selectedStores.size > 0) {
    bar.classList.add('active');
    document.getElementById('bulk-count').textContent = `${selectedStores.size} selected`;
  } else {
    bar.classList.remove('active');
  }
}

async function bulkDelete() {
  if (!confirm(`Delete ${selectedStores.size} stores? This cannot be undone.`)) return;
  const ids = Array.from(selectedStores);
  // Send in batches of 50 to avoid query size limits
  const batchSize = 50;
  let deleted = 0, failed = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const result = await apiFetch('/api/stores/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: batch }) });
    if (result && result.success) deleted += result.deleted;
    else failed += batch.length;
  }
  if (deleted > 0) showToast(`${deleted} store${deleted > 1 ? 's' : ''} deleted`, 'success');
  if (failed > 0) showToast(`${failed} store${failed > 1 ? 's' : ''} could not be deleted`, 'error');
  selectedStores.clear();
  refreshAdminTable();
  loadActivityFeed();
}

async function deleteAllStores() {
  const total = document.getElementById('stat-total')?.textContent || 'all';
  if (!confirm(`⚠️ Delete ALL ${total} stores? This will permanently remove every store in the system. This cannot be undone.`)) return;
  showToast('Deleting all stores...', 'info');
  const result = await apiFetch('/api/stores/delete-all', { method: 'POST' });
  if (result && result.success) {
    showToast(`All ${result.deleted} stores deleted ✓`, 'success');
    selectedStores.clear();
    refreshAdminTable();
    loadActivityFeed();
  }
}

function bulkExport() {
  const token = getToken();
  const ids = Array.from(selectedStores).join(',');
  window.open(`/api/export/csv?token=${token}&ids=${ids}`, '_blank');
  showToast(`Exporting ${selectedStores.size} stores`, 'info');
}

// --- Admin Add Store ---
function showAddStore() {
  document.getElementById('add-store-modal').classList.add('active');
}

async function handleAddStore(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value, owner_name: form.owner_name.value, email: form.email.value,
    address: form.address.value, city: form.city.value, state: form.state.value,
    zip: form.zip.value, category: form.category.value,
    monthly_revenue: parseFloat(form.monthly_revenue.value) || 0, status: form.status.value || 'active'
  };
  const result = await apiFetch('/api/stores', { method: 'POST', body: JSON.stringify(body) });
  if (result && result.id) {
    showToast(`${result.name} added`, 'success');
    closeModal();
    form.reset();
    refreshAdminTable();
    loadActivityFeed();
  }
}

async function deleteStore(id) {
  if (!confirm('Delete this store?')) return;
  await apiFetch(`/api/stores/${id}`, { method: 'DELETE' });
  showToast('Store deleted', 'success');
  closeModal();
  refreshAdminTable();
  loadActivityFeed();
}

function printDSDort() { window.print(); }

// ==========================================
// INVESTOR DASHBOARD
// ==========================================

let investorState = { sort: 'name', order: 'asc', page: 1, search: '' };

async function loadInvestorDashboard() {
  if (!requireAuth(['investor'])) return;
  initTheme();
  initSessionTimeout();
  document.getElementById('user-role').textContent = 'Investor';
  document.getElementById('user-role').className = 'role-badge investor';
  renderLogo(document.getElementById('logo-container'));
  renderSkeletonStats(['stat-total', 'stat-revenue', 'stat-avg']);
  await refreshInvestorTable();
}

async function refreshInvestorTable() {
  const { sort, order, page, search } = investorState;
  const params = new URLSearchParams({ sort, order, page, limit: 25, search });
  const data = await apiFetch(`/api/stores?${params}`);
  if (!data) return;

  animateValue(document.getElementById('stat-total'), data.total);
  animateCurrency(document.getElementById('stat-revenue'), data.total_revenue);
  animateCurrency(document.getElementById('stat-avg'), data.avg_revenue);

  renderProductRevenueChart('chart-category', data.by_product);
  renderOrdersOverTimeChart('chart-top', data.orders_over_time);
  renderDistributionChart('chart-distribution', data.distribution);
  renderPerformers('top-performers', data.top10, false);
  renderPerformers('bottom-performers', data.bottom10, true);

  const tbody = document.getElementById('stores-tbody');
  if (data.stores.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="loading">No stores found</td></tr>';
  } else {
    tbody.innerHTML = data.stores.map(s => `
      <tr>
        <td><span class="status-dot ${s.status}"></span>${esc(s.name)}</td>
        <td><span class="status-badge ${s.status}">${s.status}</span></td>
        <td class="revenue-cell">${formatCurrency(s.monthly_revenue)}</td>
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

  renderPagination(data, 'investor');
}

function renderPerformers(containerId, stores, isBottom) {
  const el = document.getElementById(containerId);
  if (!el || !stores) return;
  el.innerHTML = stores.map((s, i) => `
    <li>
      <span><span class="performer-rank">${i + 1}</span><span class="performer-name">${esc(s.name)}</span></span>
      <span class="performer-revenue">${formatCurrency(s.monthly_revenue)}</span>
    </li>
  `).join('');
}

function sortInvestor(field) {
  if (investorState.sort === field) investorState.order = investorState.order === 'asc' ? 'desc' : 'asc';
  else { investorState.sort = field; investorState.order = 'asc'; }
  investorState.page = 1;
  refreshInvestorTable();
}

const investorSearchDebounced = debounce(val => {
  investorState.search = val;
  investorState.page = 1;
  refreshInvestorTable();
}, 300);

function investorPage(p) {
  investorState.page = p;
  refreshInvestorTable();
}

// ==========================================
// DSD COMMISSION & STORE FUNCTIONS
// ==========================================

async function loadMyCommissions() {
  const tbody = document.getElementById('my-commissions-tbody');
  const reqEl = document.getElementById('my-payout-requests');
  if (!tbody) return;
  if (reqEl) {
    const requests = await apiFetch('/api/payouts');
    if (requests && requests.length) {
      reqEl.innerHTML = requests.map(r => `
        <div style="padding:12px 16px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;background:var(--bg-card);">
          <div><span style="font-weight:600;">Payout Request</span><span style="font-size:12px;color:var(--text-muted);margin-left:10px;">${new Date(r.created_at).toLocaleDateString()}</span></div>
          <div style="display:flex;align-items:center;gap:12px;"><span style="font-size:18px;font-weight:700;color:var(--green);">$${parseFloat(r.amount).toFixed(2)}</span><span class="status-badge ${r.status}">${r.status}</span></div>
        </div>`).join('');
    }
  }
  const rows = await apiFetch('/api/commissions');
  if (!rows || !rows.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px;">No commissions yet — recruit reps to earn!</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${esc(r.buyer_name||'Unknown')}</td>
    <td><span style="padding:2px 8px;border-radius:10px;font-size:11px;background:var(--accent-bg);color:var(--accent);">Level ${r.level}</span></td>
    <td>${(parseFloat(r.rate)*100).toFixed(0)}%</td>
    <td style="font-weight:700;color:var(--green);">$${parseFloat(r.amount).toFixed(2)}</td>
    <td><span class="status-badge ${r.status}">${r.status}</span></td>
    <td style="font-size:12px;color:var(--text-muted);">${new Date(r.created_at).toLocaleDateString()}</td>
  </tr>`).join('');
}

async function requestPayout() {
  const result = await apiFetch('/api/payouts/request', { method: 'POST', body: JSON.stringify({}) });
  if (result && result.success) {
    showToast('Payout request of $' + parseFloat(result.amount).toFixed(2) + ' submitted ✓', 'success');
    const banner = document.getElementById('payout-banner');
    if (banner) banner.style.display = 'none';
    loadMyCommissions();
  }
}

async function loadMyStores() {
  const el = document.getElementById('my-stores-list');
  if (!el) return;
  const stores = await apiFetch('/api/my-stores');
  if (!stores || !stores.length) { el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);"><div style="font-size:32px;margin-bottom:12px;">🏪</div><div>No stores claimed yet.</div><div style="margin-top:8px;font-size:13px;">Click Claim a Store to get started.</div></div>'; return; }
  el.innerHTML = `<div class="table-card">` + stores.map(s => `
    <div style="display:flex;align-items:center;gap:16px;padding:16px;border-bottom:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:var(--bg-card);">
      <div style="flex:1;"><div style="font-weight:700;color:var(--text);">${esc(s.name)}</div><div style="font-size:13px;color:var(--text-secondary);">${esc([s.address,s.city,s.state].filter(Boolean).join(', '))}</div></div>
      <span class="status-badge ${s.store_approval_status==='approved'?'active':s.store_approval_status==='rejected'?'inactive':'pending'}">${s.store_approval_status==='approved'?'✓ Exclusive':s.store_approval_status==='rejected'?'Rejected':'⏳ Pending'}</span>
    </div>`).join('');
  const statEl = document.getElementById('stat-my-stores');
  if (statEl) statEl.textContent = stores.filter(s => s.store_approval_status==='approved').length;
}

function showClaimStoreModal() {
  // Reset fields each time it opens
  ['cs-search','cs-name','cs-address','cs-city','cs-state','cs-zip','cs-phone','cs-email','cs-store-id'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.readOnly = false; }
  });
  const results = document.getElementById('wc-store-results');
  if (results) results.style.display = 'none';
  // Reset submit button back to default claim mode
  const btn = document.getElementById('cs-submit-btn');
  if (btn) {
    btn.textContent = 'Submit for Approval';
    btn.onclick = submitStoreClaim;
    btn.classList.add('btn-green');
    btn.classList.remove('btn-outline');
  }
  document.getElementById('claim-store-modal')?.classList.add('active');
}

let _wcSearchTimeout = null;
async function searchWowCowStores(query) {
  clearTimeout(_wcSearchTimeout);
  const el = document.getElementById('wc-store-results');
  if (!query || query.trim().length < 2) {
    if (el) el.style.display = 'none';
    return;
  }
  _wcSearchTimeout = setTimeout(async () => {
    const results = await apiFetch('/api/wowcow-stores/search?q=' + encodeURIComponent(query.trim()));
    if (!el) return;
    if (!results || !results.length) {
      el.innerHTML = '<div style="padding:10px 12px;color:var(--text-muted);font-size:13px;">No matching stores — fill in details below to create new</div>';
      el.style.display = 'block';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = results.map(s => `
      <div onclick='selectWowCowStore(${JSON.stringify(s).replace(/'/g,"&apos;")})'
        style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:13px;"
        onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div>
            <div style="font-weight:600;color:var(--text);">${esc(s.name)}</div>
            <div style="color:var(--text-muted);">${esc([s.address,s.city,s.state].filter(Boolean).join(', '))}</div>
          </div>
          ${s.already_claimed ? '<span style="font-size:10px;font-weight:700;color:var(--red);background:rgba(220,38,38,0.1);padding:2px 8px;border-radius:10px;white-space:nowrap;">Already Claimed</span>' : ''}
        </div>
      </div>`).join('');
  }, 350); // debounce
}

function selectWowCowStore(store) {
  document.getElementById('cs-name').value = store.name || '';
  document.getElementById('cs-address').value = store.address || '';
  document.getElementById('cs-city').value = store.city || '';
  document.getElementById('cs-state').value = store.state || '';
  document.getElementById('cs-zip').value = store.zip || '';
  document.getElementById('cs-store-id').value = store.already_claimed ? store.id : (store.source === 'addy' ? store.id : '');
  const results = document.getElementById('wc-store-results');
  if (results) results.style.display = 'none';
  document.getElementById('cs-name').readOnly = true;
  document.getElementById('cs-address').readOnly = true;

  const btn = document.getElementById('cs-submit-btn');
  if (store.already_claimed) {
    btn.textContent = 'Request Ownership Transfer';
    btn.onclick = () => requestOwnership(store.id);
    btn.classList.remove('btn-green');
    btn.classList.add('btn-outline');
  } else {
    btn.textContent = 'Submit for Approval';
    btn.onclick = submitStoreClaim;
    btn.classList.add('btn-green');
    btn.classList.remove('btn-outline');
  }
}

async function requestOwnership(storeId) {
  const result = await apiFetch('/api/stores/' + storeId + '/request-ownership', { method: 'POST', body: JSON.stringify({}) });
  if (result && result.success) {
    showToast('Ownership request submitted ✓ — admin will review', 'success');
    document.getElementById('claim-store-modal')?.classList.remove('active');
    ['cs-name','cs-address','cs-city','cs-state','cs-zip','cs-phone','cs-email','cs-store-id'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

async function submitStoreClaim() {
  const name = document.getElementById('cs-name')?.value?.trim();
  if (!name) { showToast('Store name is required', 'error'); return; }
  const storeId = document.getElementById('cs-store-id')?.value;
  const result = await apiFetch('/api/stores/claim', { method: 'POST', body: JSON.stringify({
    name, address: document.getElementById('cs-address')?.value?.trim(),
    city: document.getElementById('cs-city')?.value?.trim(), state: document.getElementById('cs-state')?.value?.trim(),
    zip: document.getElementById('cs-zip')?.value?.trim(), phone: document.getElementById('cs-phone')?.value?.trim(),
    email: document.getElementById('cs-email')?.value?.trim(),
    store_id: storeId ? parseInt(storeId) : null,
  })});
  if (result && result.success) {
    showToast('Store submitted for approval ✓', 'success');
    document.getElementById('claim-store-modal')?.classList.remove('active');
    ['cs-name','cs-address','cs-city','cs-state','cs-zip','cs-phone','cs-email','cs-store-id'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    loadMyStores();
  } else if (result && result.alreadyClaimed) {
    showToast(result.error, 'error');
    // Switch to ownership request mode
    const btn = document.getElementById('cs-submit-btn');
    btn.textContent = 'Request Ownership Transfer';
    btn.onclick = () => requestOwnership(result.storeId);
    btn.classList.remove('btn-green');
    btn.classList.add('btn-outline');
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

// ==========================================
// STORE OWNER DASHBOARD
// ==========================================

async function loadOwnerDashboard() {
  if (!requireAuth(['dsd'])) return;
  initTheme();
  initSessionTimeout();
  document.getElementById('user-role').textContent = 'DSD';
  document.getElementById('user-role').className = 'role-badge dsd';
  renderLogo(document.getElementById('logo-container'));

  const data = await apiFetch('/api/stores');
  if (!data || !data.stores.length) return;

  window._ownerStores = data.stores;

  // If multiple stores, show the store picker
  if (data.stores.length > 1) {
    const picker = document.getElementById('store-picker');
    const tabs = document.getElementById('store-picker-tabs');
    if (picker && tabs) {
      picker.style.display = 'block';
      tabs.innerHTML = data.stores.map((s, i) => `
        <button class="cart-tab ${i===0?'active':''}" onclick="ownerSelectStore(${s.id}, this)">
          <span class="status-dot ${s.status}" style="margin-right:5px;"></span>${esc(s.name)}
        </button>
      `).join('');
    }
  }

  // Load first store by default
  ownerLoadStore(data.stores[0], data.network_avg || 0);
}

function ownerSelectStore(storeId, btn) {
  const store = (window._ownerStores || []).find(s => s.id === storeId);
  if (!store) return;
  document.querySelectorAll('#store-picker-tabs .cart-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const data_network_avg = window._ownerNetworkAvg || 0;
  ownerLoadStore(store, data_network_avg);
}

function ownerLoadStore(store, networkAvg) {
  window._ownerNetworkAvg = networkAvg;
  const pctOfAvg = networkAvg > 0 ? ((store.monthly_revenue / networkAvg) * 100).toFixed(0) : 0;
  const aboveAvg = store.monthly_revenue >= networkAvg;

  const titleEl = document.getElementById('store-page-title');
  const subEl = document.getElementById('store-page-subtitle');
  if (titleEl) titleEl.textContent = store.name;
  if (subEl) subEl.textContent = `${store.city}, ${store.state} · ${store.category}`;

  const storeNameEl = document.getElementById('store-name');
  if (storeNameEl) storeNameEl.textContent = store.name;
  
  const revenueEl = document.getElementById('store-revenue');
  if (revenueEl) animateCurrency(revenueEl, store.monthly_revenue);
  
  const ownerNameEl = document.getElementById('store-owner-name');
  if (ownerNameEl) ownerNameEl.textContent = store.owner_name;
  
  const emailEl = document.getElementById('store-email');
  if (emailEl) emailEl.textContent = store.email;
  
  const addressEl = document.getElementById('store-address');
  if (addressEl) addressEl.textContent = `${store.address}, ${store.city}, ${store.state} ${store.zip}`;
  
  const categoryEl = document.getElementById('store-category');
  if (categoryEl) categoryEl.textContent = store.category;
  
  const statusEl = document.getElementById('store-status');
  if (statusEl) statusEl.innerHTML = `<span class="status-badge ${store.status}">${store.status}</span>`;
  
  const wholesaleEl = document.getElementById('store-wholesale');
  if (wholesaleEl) wholesaleEl.textContent = formatCurrency(store.wholesale_price || 0);
  
  const retailEl = document.getElementById('store-retail');
  if (retailEl) retailEl.textContent = formatCurrency(store.retail_price || 0);
  
  const distEl = document.getElementById('store-dist-cost');
  if (distEl) distEl.textContent = formatCurrency(store.distribution_cost || 0);

  const avgEl = document.getElementById('stat-avg');
  if (avgEl) animateCurrency(avgEl, networkAvg);
  
  const compSub = document.getElementById('stat-comparison');
  if (compSub) {
    compSub.textContent = `${pctOfAvg}% of network average`;
    compSub.className = 'stat-sub ' + (aboveAvg ? 'positive' : 'negative');
  }

  const barFill = document.getElementById('comparison-bar-fill');
  if (barFill) {
    setTimeout(() => { barFill.style.width = Math.min(100, pctOfAvg) + '%'; }, 100);
    barFill.className = 'bar-fill ' + (aboveAvg ? 'above' : 'below');
  }
  
  const barYou = document.getElementById('bar-you');
  if (barYou) barYou.textContent = formatCurrency(store.monthly_revenue);
  
  const barAvg = document.getElementById('bar-avg');
  if (barAvg) barAvg.textContent = formatCurrency(networkAvg) + ' avg';

  window._currentStore = store;
  renderOwnerRevenueChart(store.monthly_revenue);
}

function renderOwnerRevenueChart(baseRevenue) {
  const ctx = document.getElementById('chart-revenue');
  if (!ctx) return;
  
  // Destroy existing chart instance if present
  const existing = Chart.getChart(ctx);
  if (existing) existing.destroy();
  
  const months = ['Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'];
  const data = months.map((_, i) => Math.round(baseRevenue * (0.85 + (i * 0.025) + (Math.random() - 0.4) * 0.15)));

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [{
        label: 'Monthly Revenue', data,
        borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)',
        fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#2563eb'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }, grid: { color: 'rgba(0,0,0,0.05)' } },
        x: { grid: { display: false } }
      }
    }
  });
}

function showEditStore() {
  const s = window._currentStore || (window._ownerStores && window._ownerStores[0]);
  if (!s) { showToast('Store data not loaded yet. Please wait.', 'error'); return; }
  const form = document.getElementById('edit-store-form');
  if (!form) return;
  form.name.value = s.name || '';
  form.owner_name.value = s.owner_name || '';
  form.email.value = s.email || '';
  form.address.value = s.address || '';
  form.city.value = s.city || '';
  form.state.value = s.state || '';
  form.zip.value = s.zip || '';
  form.category.value = s.category || '';
  window._currentStore = s;
  document.getElementById('edit-store-modal').classList.add('active');
}

async function handleEditStore(e) {
  e.preventDefault();
  const form = e.target;
  const s = window._currentStore;
  const body = {
    name: form.name.value, owner_name: form.owner_name.value, email: form.email.value,
    address: form.address.value, city: form.city.value, state: form.state.value,
    zip: form.zip.value, category: form.category.value
  };
  const result = await apiFetch(`/api/stores/${s.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  if (result && result.id) {
    showToast('Store info updated', 'success');
    closeModal();
    loadOwnerDashboard();
  }
}

// ==========================================
// SHARED: Charts
// ==========================================

function renderProductRevenueChart(canvasId, byProduct) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (ctx._chart) ctx._chart.destroy();
  if (!byProduct || byProduct.length === 0) {
    ctx._chart = null;
    const parent = ctx.parentElement;
    parent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">No order data yet</div>';
    return;
  }
  const colors = ['#2563eb','#059669','#d97706','#dc2626','#7c3aed','#0891b2','#be185d','#65a30d','#ea580c','#4f46e5'];
  ctx._chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: byProduct.map(p => p.name),
      datasets: [{ data: byProduct.map(p => parseFloat(p.revenue)||0), backgroundColor: colors.slice(0, byProduct.length), borderWidth: 2, borderColor: getComputedStyle(document.body).getPropertyValue('--bg-card') }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.label}: $${parseFloat(c.raw).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` } }
      }
    }
  });
}

function renderOrdersOverTimeChart(canvasId, ordersOverTime) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (ctx._chart) ctx._chart.destroy();
  if (!ordersOverTime || ordersOverTime.length === 0) {
    const parent = ctx.parentElement;
    parent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">No orders in last 30 days</div>';
    return;
  }
  ctx._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ordersOverTime.map(d => new Date(d.date).toLocaleDateString('en-US',{month:'short',day:'numeric'})),
      datasets: [
        { label: 'Revenue', data: ordersOverTime.map(d => parseFloat(d.revenue)||0), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', fill: true, tension: 0.4, pointRadius: 3, yAxisID: 'y' },
        { label: 'Orders', data: ordersOverTime.map(d => parseInt(d.orders)||0), borderColor: '#059669', backgroundColor: 'transparent', tension: 0.4, pointRadius: 3, borderDash: [4,3], yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        y: { position: 'left', grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { callback: v => '$'+v.toLocaleString() } },
        y1: { position: 'right', grid: { display: false }, ticks: { stepSize: 1 } },
        x: { grid: { display: false }, ticks: { font: { size: 10 } } }
      }
    }
  });
}

function renderDistributionChart(canvasId, distribution) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !distribution) return;
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: distribution.map(d => d.label),
      datasets: [{ label: 'Stores', data: distribution.map(d => d.count), backgroundColor: '#059669', borderRadius: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { stepSize: 5 } }, x: { grid: { display: false }, ticks: { font: { size: 10 } } } }
    }
  });
}

// ==========================================
// SHARED: Pagination
// ==========================================

function renderPagination(data, dashboardType) {
  const footer = document.getElementById('table-footer');
  if (!footer) return;
  const { page, total_pages, total_filtered, page_size } = data;
  const start = ((page - 1) * page_size) + 1;
  const end = Math.min(page * page_size, total_filtered);
  const pageFn = dashboardType === 'admin' ? 'adminPage' : 'investorPage';

  let pageButtons = '';
  const maxButtons = 5;
  let startPage = Math.max(1, page - 2);
  let endPage = Math.min(total_pages, startPage + maxButtons - 1);
  if (endPage - startPage < maxButtons - 1) startPage = Math.max(1, endPage - maxButtons + 1);

  pageButtons += `<button class="page-btn" onclick="${pageFn}(1)" ${page === 1 ? 'disabled' : ''}>&laquo;</button>`;
  pageButtons += `<button class="page-btn" onclick="${pageFn}(${page - 1})" ${page === 1 ? 'disabled' : ''}>&lsaquo;</button>`;
  for (let i = startPage; i <= endPage; i++) pageButtons += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="${pageFn}(${i})">${i}</button>`;
  pageButtons += `<button class="page-btn" onclick="${pageFn}(${page + 1})" ${page === total_pages ? 'disabled' : ''}>&rsaquo;</button>`;
  pageButtons += `<button class="page-btn" onclick="${pageFn}(${total_pages})" ${page === total_pages ? 'disabled' : ''}>&raquo;</button>`;

  footer.innerHTML = `
    <span class="page-info">Showing ${start}${end > start ? '-' + end : ''} of ${formatNumber(total_filtered)} stores</span>
    <div class="pagination">${pageButtons}</div>
  `;
}

// ==========================================
// SIGN-UP
// ==========================================
async function handleSignup(e) {
  e.preventDefault();
  const form = e.target;
  const errorEl = document.getElementById('error-msg');
  const successEl = document.getElementById('success-msg');
  errorEl.style.display = 'none';
  successEl.style.display = 'none';

  const body = {
    role: form.role.value,
    name: form.name.value.trim(),
    phone: form.phone.value.trim(),
    email: form.email.value.trim(),
    password: form.password.value,
    store_name: form.store_name ? form.store_name.value.trim() : '',
    city: form.city ? form.city.value.trim() : '',
    state: form.state ? form.state.value.trim() : '',
    zip: form.zip ? form.zip.value.trim() : '',
    category: form.category ? form.category.value.trim() : ''
  };

  if (!body.role) {
    errorEl.textContent = 'Please select your role';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Sign-up failed';
      errorEl.style.display = 'block';
      return;
    }
    successEl.textContent = 'Request submitted! An admin will review and approve your account.';
    successEl.style.display = 'block';
    form.reset();
    setTimeout(() => {
      if (typeof showLogin === 'function') showLogin();
    }, 3000);
  } catch {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
  }
}

// ==========================================
// ADMIN: TABS
// ==========================================
function switchTab(tab, btn) {
  ['stores', 'pending', 'reps', 'users', 'products', 'orders', 'inventory', 'commissions', 'store-claims', 'settings'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (!el) return;
    if (t === tab) {
      el.style.display = 'block';
      el.classList.remove('tab-pane');
      void el.offsetWidth; // force reflow to restart animation
      el.classList.add('tab-pane');
    } else {
      el.style.display = 'none';
    }
  });
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // Clear preorder count polling when leaving the products tab
  if (tab !== 'products' && typeof _preorderRefreshInterval !== 'undefined') {
    clearInterval(_preorderRefreshInterval);
  }

  if (tab === 'pending') loadPendingApprovals();
  if (tab === 'reps') loadAdminDSDs();
  if (tab === 'users') loadUsersTab();
  if (tab === 'commissions') loadCommissionsTab();
  if (tab === 'store-claims') { loadStoreClaimsTab(); loadOwnershipRequestsTab(); }
  if (tab === 'products') loadProductsTab();
  if (tab === 'orders') { loadAdminOrders(); markOrdersSeen(); }
  if (tab === 'inventory') loadInventory();
  if (tab === 'settings') loadNotifEmails();
}

// ==========================================
// ADMIN: PENDING APPROVALS
// ==========================================
async function loadPendingApprovals() {
  const users = await apiFetch('/api/pending-users');
  const tbody = document.getElementById('pending-tbody');
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">No sign-up requests yet</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${esc(u.name || '')}</td>
      <td>${esc(u.email)}</td>
      <td>${esc(u.phone || '')}</td>
      <td><span class="role-badge ${u.role}" style="font-size:11px;">${u.role === 'dsd' ? 'DSD' : u.role.charAt(0).toUpperCase() + u.role.slice(1)}</span></td>
      <td>${esc(u.store_name || '—')}</td>
      <td>${esc(u.city || '—')}</td>
      <td>${esc(u.state || '—')}</td>
      <td><span class="status-badge ${u.status}">${u.status}</span></td>
      <td style="display:flex;gap:8px;">
        ${u.status === 'pending' ? `
          <button class="btn btn-sm btn-green" onclick="showApprovePricingModal(${u.id}, '${esc(u.name || u.email)}', '${u.role}')">Approve</button>
          <button class="btn btn-sm btn-danger" onclick="rejectUser(${u.id}, this)">Reject</button>
        ` : `<span style="font-size:12px;color:var(--text-muted);">${u.status === 'active' ? 'Approved' : 'Rejected'}</span>`}
      </td>
    </tr>
  `).join('');
}

// ADDY DSD pricing tiers
const PRICING_TIERS = [
  { value: '3', label: 'Tier 3 — 25% margin (starter)' },
  { value: '2', label: 'Tier 2 — 30% margin' },
  { value: '1', label: 'Tier 1 — 35% margin (best)' },
  { value: 'custom', label: 'Custom % (set manually below)' },
];

let _approveTargetUserId = null;
let _approveProducts = [];

async function showApprovePricingModal(userId, userName, userRole) {
  _approveTargetUserId = userId;

  // Load products to show custom price inputs if needed
  const products = await apiFetch('/api/products/all');
  _approveProducts = products || [];

  const modal = document.getElementById('approve-pricing-modal');
  document.getElementById('approve-user-name').textContent = userName;

  // Build tier options
  const tierSelect = document.getElementById('approve-tier-select');
  tierSelect.innerHTML = PRICING_TIERS.map(t =>
    `<option value="${t.value}">${t.label}</option>`
  ).join('');

  // Default to Tier 3 for new DSDs
  tierSelect.value = '3';
  renderTierPreview('3');

  modal.classList.add('active');
}

async function renderTierPreview(tier) {
  const previewWrap = document.getElementById('approve-price-preview');
  if (!_approveProducts.length) { previewWrap.innerHTML = ''; return; }

  if (tier === 'custom') {
    previewWrap.innerHTML = `
      <p style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:10px;">Set custom price per product:</p>
      ${_approveProducts.map(p => {
        const roleDefault = (p.role_prices || []).find(rp => rp.role === 'dsd');
        return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <span style="flex:1;font-size:13px;color:var(--text);">${esc(p.name)}</span>
          <input type="number" step="0.01" min="0" placeholder="0.00"
            id="custom-price-${p.id}"
            style="width:90px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;"
            value="${roleDefault ? roleDefault.price : ''}">
        </div>`;
      }).join('')}
    `;
  } else if (tier === 'custom') {
    // show custom % input
    previewWrap.innerHTML = `
      <div class="form-group" style="margin-bottom:10px;">
        <label style="font-size:12px;font-weight:600;color:var(--text);">Custom margin % <span style="font-weight:400;color:var(--text-muted);">(e.g. 28 = they pay 72% of retail)</span></label>
        <input type="number" step="1" min="1" max="60" id="custom-margin-pct" placeholder="e.g. 28"
          oninput="updateCustomMarginPreview()"
          style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:14px;box-sizing:border-box;margin-top:6px;">
      </div>
      <div id="custom-margin-preview"></div>
    `;
  } else {
    // Show calculated tier prices from retail_price
    const multipliers = { '1': 0.65, '2': 0.70, '3': 0.75 };
    const mult = multipliers[tier] || 0.75;
    const marginPct = Math.round((1 - mult) * 100);
    const rows = _approveProducts.map(p => {
      const retail = parseFloat(p.retail_price || 0);
      const price = retail > 0
        ? `<span style="font-weight:700;color:var(--green);">$${(retail * mult).toFixed(2)}</span>`
        : '<span style="color:var(--text-muted);font-size:12px;">Set retail price first</span>';
      return `<div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid var(--border);">
        <span style="color:var(--text);">${esc(p.name)}</span>${price}</div>`;
    }).join('');
    previewWrap.innerHTML = `
      <p style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:8px;">They pay (${marginPct}% margin — keeps ${marginPct}% when selling at retail):</p>
      ${rows || '<p style="color:var(--text-muted);font-size:13px;">No products yet</p>'}
    `;
  }
}

function updateCustomMarginPreview() {
  const pct = parseFloat(document.getElementById('custom-margin-pct')?.value || 0);
  const el = document.getElementById('custom-margin-preview');
  if (!el || !pct) return;
  const mult = 1 - (pct / 100);
  el.innerHTML = _approveProducts.map(p => {
    const retail = parseFloat(p.retail_price || 0);
    const price = retail > 0 ? `<span style="color:var(--green);font-weight:700;">$${(retail * mult).toFixed(2)}</span>` : '<span style="color:var(--text-muted);">—</span>';
    return `<div style="display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px solid var(--border);"><span>${esc(p.name)}</span>${price}</div>`;
  }).join('');
}

async function showChangeTierModal(userId, userName) {
  _approveTargetUserId = userId;

  const products = await apiFetch('/api/products/all');
  _approveProducts = products || [];

  const modal = document.getElementById('approve-pricing-modal');
  document.getElementById('approve-user-name').textContent = userName;

  // Update button text for this context
  document.getElementById('approve-confirm-btn').textContent = 'Save Pricing';

  const tierSelect = document.getElementById('approve-tier-select');
  tierSelect.innerHTML = PRICING_TIERS.map(t =>
    `<option value="${t.value}">${t.label}</option>`
  ).join('');

  const userRow = _approveProducts.length ? null : null; // tier loaded from user
  tierSelect.value = '3';
  renderTierPreview('3');
  modal.classList.add('active');
}

async function confirmApproveWithPricing() {
  const tier = document.getElementById('approve-tier-select').value;
  const btn = document.getElementById('approve-confirm-btn');
  const isApproveFlow = btn.textContent.includes('Approve');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const customPct = tier === 'custom' ? parseFloat(document.getElementById('custom-margin-pct')?.value || 0) : null;
  let pricingPayload = { tier: tier === 'custom' ? 3 : parseInt(tier), custom_margin_pct: customPct };

  if (tier === 'custom') {
    const customPrices = {};
    for (const p of _approveProducts) {
      const val = document.getElementById(`custom-price-${p.id}`)?.value;
      if (val !== '' && val !== undefined && val !== null) {
        customPrices[p.id] = parseFloat(val);
      }
    }
    pricingPayload.custom_prices = customPrices;
  }

  // If approving a pending user, hit the approve endpoint (which also sets pricing)
  // If changing tier on an active user, hit the dedicated pricing endpoint
  const endpoint = isApproveFlow
    ? `/api/users/${_approveTargetUserId}/approve`
    : `/api/users/${_approveTargetUserId}/pricing`;

  const result = await apiFetch(endpoint, {
    method: 'PATCH',
    body: JSON.stringify(pricingPayload)
  });

  btn.disabled = false;
  btn.textContent = isApproveFlow ? 'Approve & Activate' : 'Save Pricing';

  if (result && result.success) {
    document.getElementById('approve-pricing-modal').classList.remove('active');
    showToast(isApproveFlow ? 'User approved and pricing set' : 'Pricing updated', 'success');
    if (isApproveFlow) {
      loadPendingApprovals();
      loadPendingBadge();
    } else {
      loadUsersTab();
    }
  }
}

async function approveUser(id, btn) {
  btn.disabled = true;
  const result = await apiFetch(`/api/users/${id}/approve`, { method: 'PATCH' });
  if (result && result.success) {
    showToast('User approved and activated', 'success');
    loadPendingApprovals();
    loadPendingBadge();
  }
}

async function rejectUser(id, btn) {
  btn.disabled = true;
  const result = await apiFetch(`/api/users/${id}/reject`, { method: 'PATCH' });
  if (result && result.success) {
    showToast('User rejected', 'info');
    loadPendingApprovals();
    loadPendingBadge();
  }
}

async function loadPendingBadge() {
  const users = await apiFetch('/api/pending-users');
  const badge = document.getElementById('pending-badge');
  if (!badge) return;
  const tabBtn = badge.closest('.admin-tab');
  const pending = (users || []).filter(u => u.status === 'pending').length;
  if (pending > 0) {
    badge.textContent = pending;
    badge.style.display = 'inline';
    if (tabBtn) tabBtn.classList.add('tab-pending');
  } else {
    badge.style.display = 'none';
    if (tabBtn) tabBtn.classList.remove('tab-pending');
  }
}

async function checkNewOrdersBadge() {
  const orders = await apiFetch('/api/orders');
  if (!orders) return;
  const badge = document.getElementById('orders-badge');
  if (!badge) return;
  const tabBtn = badge.closest('.admin-tab');

  // Track the highest order ID we've seen in localStorage
  const lastSeen = parseInt(localStorage.getItem('wc_last_seen_order') || '0');
  const newOrders = orders.filter(o => o.id > lastSeen);

  if (newOrders.length > 0) {
    badge.textContent = newOrders.length;
    badge.style.display = 'inline';
    if (tabBtn) tabBtn.classList.add('tab-new-orders');
  } else {
    badge.style.display = 'none';
    if (tabBtn) tabBtn.classList.remove('tab-new-orders');
  }
}

function markOrdersSeen() {
  const badge = document.getElementById('orders-badge');
  const tabBtn = badge ? badge.closest('.admin-tab') : null;
  // Find highest order ID from loaded orders and save it
  apiFetch('/api/orders').then(orders => {
    if (!orders || !orders.length) return;
    const maxId = Math.max(...orders.map(o => o.id));
    localStorage.setItem('wc_last_seen_order', maxId.toString());
    if (badge) badge.style.display = 'none';
    if (tabBtn) tabBtn.classList.remove('tab-new-orders');
  });
}

async function checkLowStockBadge() {
  const products = await apiFetch('/api/products/all');
  if (!products) return;
  const redProducts    = products.filter(p => p.active && p.stock <= 50);
  const yellowProducts = products.filter(p => p.active && p.stock >= 51 && p.stock <= 99);
  const badge = document.getElementById('low-stock-badge');
  const tabBtn = badge ? badge.closest('.admin-tab') : null;
  if (!badge || !tabBtn) return;

  tabBtn.classList.remove('tab-low-stock', 'tab-medium-stock');

  if (redProducts.length > 0) {
    badge.textContent = redProducts.length;
    badge.style.display = 'inline';
    badge.style.background = 'var(--red)';
    tabBtn.classList.add('tab-low-stock');
  } else if (yellowProducts.length > 0) {
    badge.textContent = yellowProducts.length;
    badge.style.display = 'inline';
    badge.style.background = 'var(--yellow)';
    tabBtn.classList.add('tab-medium-stock');
  } else {
    badge.style.display = 'none';
  }
}

// ==========================================
// ADMIN: REPS
// ==========================================
async function loadAdminDSDs() {
  const dsds = await apiFetch('/api/reps');
  const tbody = document.getElementById('reps-tbody');
  if (!dsds || dsds.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted);">No DSDs yet</td></tr>';
    return;
  }
  const tierLabel = t => t === 1 ? 'Tier 1' : t === 2 ? 'Tier 2' : t === 3 ? 'Tier 3' : '—';
  tbody.innerHTML = dsds.map(r => `
    <tr>
      <td>${esc(r.name)}</td>
      <td>${esc(r.email)}</td>
      <td><span style="font-size:12px;font-weight:600;color:var(--accent);">${tierLabel(r.tier)}</span></td>
      <td>${r.sponsor_name ? esc(r.sponsor_name) : '<span style="color:var(--text-muted)">None</span>'}</td>
      <td>${r.store_count}</td>
      <td class="revenue-cell">${formatCurrency(r.commission_balance || 0)}</td>
      <td><span class="status-badge ${r.status}">${r.status}</span></td>
    </tr>
  `).join('');
}

function showAddDSDModal() {
  document.getElementById('add-rep-modal').classList.add('active');
}

async function handleAdminAddDSD(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value.trim(),
    email: form.email.value.trim(),
    phone: form.phone.value.trim(),
    password: form.password.value,
    sponsor_rep_id: form.sponsor_rep_id.value ? parseInt(form.sponsor_rep_id.value) : null
  };
  const result = await apiFetch('/api/reps', { method: 'POST', body: JSON.stringify(body) });
  if (result && result.success) {
    showToast('DSD added successfully', 'success');
    closeModal();
    form.reset();
    loadAdminDSDs();
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

// Update admin table to show new columns
async function refreshAdminTable() {
  const { sort, order, page, search, category, state, status } = adminState;
  const params = new URLSearchParams({ sort, order, page, limit: 25, search, category, state, status });
  const data = await apiFetch(`/api/stores?${params}`);
  if (!data) return;

  animateValue(document.getElementById('stat-total'), data.total);
  animateCurrency(document.getElementById('stat-revenue'), data.total_revenue);
  animateCurrency(document.getElementById('stat-avg'), data.avg_revenue);

  const statusCounts = {};
  (data.by_status || []).forEach(s => statusCounts[s.status] = s.count);
  const activeEl = document.getElementById('stat-active');
  if (activeEl) activeEl.textContent = `${statusCounts.active || 0} active / ${statusCounts.pending || 0} pending / ${statusCounts.inactive || 0} inactive`;

  renderProductRevenueChart('chart-category', data.by_product);
  renderOrdersOverTimeChart('chart-top', data.orders_over_time);

  selectedStores.clear();
  updateBulkBar();

  const tbody = document.getElementById('stores-tbody');
  if (data.stores.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="loading">No stores found</td></tr>';
  } else {
    tbody.innerHTML = data.stores.map(s => `
      <tr>
        <td class="check-col"><input type="checkbox" value="${s.id}" onchange="toggleStoreSelect(${s.id}, this.checked)"></td>
        <td style="cursor:pointer" onclick="showStoreDetail(${s.id})"><span class="status-dot ${s.status}"></span>${esc(s.name)}</td>
        <td>${esc(s.owner_name)}</td>
        <td>${esc(s.email)}</td>
        <td>${esc(s.city)}</td>
        <td>${esc(s.state)}</td>
        <td>${esc(s.category)}</td>
        <td><span class="status-badge ${s.status}">${s.status}</span></td>
        <td class="revenue-cell">${formatCurrency(s.monthly_revenue)}</td>
        <td>${formatCurrency(s.wholesale_price)}</td>
        <td>${formatCurrency(s.retail_price)}</td>
        <td>${formatCurrency(s.distribution_cost)}</td>
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
// ==========================================
// DISTRIBUTOR DASHBOARD
// ==========================================
let _allDistStores = [];

async function loadDSDDashboard() {
  if (!requireAuth(['dsd'])) return;
  // Load user profile to show tier and commission balance
  const profile = await apiFetch('/api/profile');
  if (profile) {
    const tierNames = {1:'Tier 1 — 35% margin', 2:'Tier 2 — 30% margin', 3:'Tier 3 — 25% margin'};
    const tierEl = document.getElementById('stat-tier');
    if (tierEl) tierEl.textContent = tierNames[profile.tier||1] || 'Tier 1';
    const commEl = document.getElementById('stat-commission');
    if (commEl) commEl.textContent = '$' + parseFloat(profile.commission_balance||0).toFixed(2);
    // Show payout banner if balance > 0
    const balance = parseFloat(profile.commission_balance||0);
    const banner = document.getElementById('payout-banner');
    const balText = document.getElementById('payout-balance-text');
    if (banner && balance > 0) {
      if (balText) balText.textContent = '$' + balance.toFixed(2) + ' available to request';
      banner.style.display = 'flex';
    }
  }
  initTheme();
  initSessionTimeout();
  document.getElementById('user-role').className = 'role-badge dsd';
  renderLogo(document.getElementById('logo-container'));

  const stores = await apiFetch('/api/stores');
  if (!stores) return;
  _allDistStores = stores.stores || [];

  renderDSDTable(_allDistStores);

  const totalDistCost = _allDistStores.reduce((a, s) => a + (parseFloat(s.distribution_cost) || 0), 0);
  const avgWholesale = _allDistStores.length ? _allDistStores.reduce((a, s) => a + (parseFloat(s.wholesale_price) || 0), 0) / _allDistStores.length : 0;
  const avgRetail = _allDistStores.length ? _allDistStores.reduce((a, s) => a + (parseFloat(s.retail_price) || 0), 0) / _allDistStores.length : 0;

  animateValue(document.getElementById('stat-total'), _allDistStores.length);
  animateCurrency(document.getElementById('stat-dist-cost'), totalDistCost);
  document.getElementById('stat-avg-wholesale').textContent = formatCurrency(avgWholesale);
  document.getElementById('stat-avg-retail').textContent = formatCurrency(avgRetail);
}

function renderDSDTable(stores) {
  const tbody = document.getElementById('stores-tbody');
  if (!stores.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">No stores assigned</td></tr>';
    return;
  }
  tbody.innerHTML = stores.map(s => `
    <tr>
      <td><span class="status-dot ${s.status}"></span>${esc(s.name)}</td>
      <td>${esc(s.owner_name)}</td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.state)}</td>
      <td>${esc(s.category)}</td>
      <td>${formatCurrency(s.wholesale_price)}</td>
      <td>${formatCurrency(s.retail_price)}</td>
      <td class="revenue-cell">${formatCurrency(s.distribution_cost)}</td>
      <td><span class="status-badge ${s.status}">${s.status}</span></td>
      <td><a href="/shop.html?store_id=${s.id}" style="display:inline-block;padding:5px 12px;background:#2563eb;color:#fff;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;">🛒 Buy</a></td>
    </tr>
  `).join('');
}

function filterStores(val) {
  const q = val.toLowerCase();
  const filtered = _allDistStores.filter(s =>
    s.name.toLowerCase().includes(q) || s.city.toLowerCase().includes(q) || s.owner_name.toLowerCase().includes(q)
  );
  renderDSDTable(filtered);
}

// (Removed: showEnrollModal/handleEnrollDSD — dead code, never wired to any UI button,
// and called a since-removed endpoint that used the broken 'rep' role system.)

// ==========================================
// ADMIN: USERS TAB
// ==========================================
async function loadUsersTab() {
  const users = await apiFetch('/api/users');
  const tbody = document.getElementById('users-tbody');
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted);">No users yet</td></tr>';
    return;
  }
  const roleLabels = { admin: 'Admin', dsd: 'DSD' };
  const tierLabels = {
    dsd: 'Master Dist.',
    dsd: 'DSD',
    rep: 'DSD',
    dsd: 'Wholesale',
    custom: 'Custom'
  };
  const tierableRoles = ['dsd', 'dsd', 'rep'];
  // Store users for detail modal
  window._adminUsers = users;
  tbody.innerHTML = users.map(u => `
    <tr style="cursor:pointer;" onclick="showUserDetail(${u.id})">
      <td>${esc(u.name || '—')}</td>
      <td>${esc(u.email)}</td>
      <td><span class="role-badge ${u.role}" style="font-size:11px;">${roleLabels[u.role] || u.role}</span></td>
      <td>${esc(u.phone || '—')}</td>
      <td><span class="status-badge ${u.status}">${u.status}</span></td>
      <td>
        ${u.pricing_tier
          ? `<span style="display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;background:var(--accent-bg);color:var(--accent);">${tierLabels[u.pricing_tier] || u.pricing_tier}</span>`
          : `<span style="font-size:12px;color:var(--text-muted);">—</span>`
        }
      </td>
      <td onclick="event.stopPropagation()">
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${u.status === 'active'
            ? `<button class="btn btn-sm btn-danger" onclick="toggleUserStatus(${u.id}, 'inactive', this)">Deactivate</button>`
            : `<button class="btn btn-sm btn-green" onclick="toggleUserStatus(${u.id}, 'active', this)">Activate</button>`
          }
          ${tierableRoles.includes(u.role)
            ? `<button class="btn btn-sm btn-outline" onclick="showChangeTierModal(${u.id}, '${esc(u.name || u.email)}')">Change Tier</button>`
            : ''
          }
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${esc(u.name || u.email)}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function showCreateUserModal(role) {
  const titles = { admin: 'Add Admin Account', investor: 'Add Investor Account' };
  const subtitles = { admin: 'This account will have full admin access immediately.', investor: 'This account will have read-only investor access immediately.' };
  document.getElementById('create-user-title').textContent = titles[role];
  document.getElementById('create-user-subtitle').textContent = subtitles[role];
  document.getElementById('create-user-role').value = role;
  document.getElementById('create-user-modal').classList.add('active');
}

async function handleCreateUser(e) {
  e.preventDefault();
  const form = e.target;
  const body = {
    role: form.role.value,
    name: form.name.value.trim(),
    email: form.email.value.trim(),
    phone: form.phone.value.trim(),
    password: form.password.value
  };
  const result = await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(body) });
  if (result && result.success) {
    showToast(`${body.role === 'admin' ? 'Admin' : 'Investor'} account created`, 'success');
    closeModal();
    form.reset();
    loadUsersTab();
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

async function toggleUserStatus(id, status, btn) {
  btn.disabled = true;
  const result = await apiFetch(`/api/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  if (result && result.success) {
    showToast(`User ${status === 'active' ? 'activated' : 'deactivated'}`, 'success');
    loadUsersTab();
  }
}

function showUserDetail(userId) {
  const u = (window._adminUsers || []).find(x => x.id === userId);
  if (!u) return;
  const roleLabels = { admin: 'Admin', dsd: 'DSD' };
  const modal = document.getElementById('user-detail-modal');
  const content = document.getElementById('user-detail-content');
  content.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:20px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div><div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Name</div><div style="font-size:15px;font-weight:600;color:var(--text);">${esc(u.name || '—')}</div></div>
        <div><div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Role</div><span class="role-badge ${u.role}">${roleLabels[u.role] || u.role}</span></div>
        <div><div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Email</div><div style="font-size:14px;color:var(--text);">${esc(u.email)}</div></div>
        <div><div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Phone</div><div style="font-size:14px;color:var(--text);">${esc(u.phone || '—')}</div></div>
        <div><div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Status</div><span class="status-badge ${u.status}">${u.status}</span></div>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">DSD Tier</div>
          ${u.role === 'dsd' ? `
          <select onchange="setUserTier(${u.id}, this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;cursor:pointer;">
            <option value="1" ${(u.tier||1)==1?'selected':''}>Tier 1 — 35% margin</option>
            <option value="2" ${(u.tier||1)==2?'selected':''}>Tier 2 — 30% margin</option>
            <option value="3" ${(u.tier||1)==3?'selected':''}>Tier 3 — 25% margin</option>
          </select>` : '<div style="font-size:14px;color:var(--text);">Admin</div>'}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Commission Balance</div>
          <div style="font-size:18px;font-weight:700;color:var(--green);">$${parseFloat(u.commission_balance||0).toFixed(2)}</div>
        </div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:16px;">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:10px;">🔑 Reset Password</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="password" id="admin-new-password-${u.id}" placeholder="New password (min 6 chars)" minlength="6"
            style="flex:1;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;font-size:13px;">
          <button class="btn btn-sm btn-outline" type="button" onclick="togglePasswordVisibility('admin-new-password-${u.id}', this)">👁 Show</button>
          <button class="btn btn-sm btn-green" type="button" onclick="adminResetPassword(${u.id})">Set Password</button>
        </div>
      </div>

      ${u.role === 'dsd' ? `
      <div style="border-top:1px solid var(--border);padding-top:16px;">
        <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">💲 Custom DSD Pricing</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Override the default product price for this DSD partner specifically.</div>
        <div id="user-pricing-${u.id}">
          <div style="color:var(--text-muted);font-size:12px;">Loading products...</div>
        </div>
      </div>` : ''}

      <div style="border-top:1px solid var(--border);padding-top:16px;display:flex;gap:10px;justify-content:space-between;align-items:center;">
        <button class="btn btn-danger" type="button" onclick="deleteUser(${u.id}, '${esc(u.name || u.email)}', true)">🗑 Delete Account</button>
        <button class="btn btn-outline" type="button" onclick="document.getElementById('user-detail-modal').classList.remove('active')">Close</button>
      </div>
    </div>
  `;
  modal.classList.add('active');
}

async function loadUserPricing(userId) {
  const el = document.getElementById('user-pricing-' + userId);
  if (!el) return;
  const products = await apiFetch('/api/products/all');
  const prices = await apiFetch('/api/users/' + userId + '/pricing');
  if (!products || !products.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">No products yet</div>'; return; }
  const priceMap = {};
  (prices || []).forEach(p => priceMap[p.product_id] = p.price);
  el.innerHTML = products.map(p => `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="flex:1;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</span>
      <span style="font-size:11px;color:var(--text-muted);">Default: $${parseFloat(p.default_price||0).toFixed(2)}</span>
      <input type="number" step="0.01" min="0" value="${priceMap[p.id] !== undefined ? priceMap[p.id] : ''}"
        placeholder="Custom $"
        style="width:90px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;"
        onchange="setUserProductPrice(${userId}, ${p.id}, this.value)">
    </div>
  `).join('');
}

async function setUserProductPrice(userId, productId, price) {
  const result = await apiFetch('/api/users/' + userId + '/pricing', {
    method: 'PATCH',
    body: JSON.stringify({ product_id: productId, price: price === '' ? null : parseFloat(price) })
  });
  if (result && result.success) showToast('Price updated ✓', 'success');
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈 Hide';
  } else {
    input.type = 'password';
    btn.textContent = '👁 Show';
  }
}

async function adminResetPassword(userId) {
  const input = document.getElementById(`admin-new-password-${userId}`);
  if (!input || !input.value || input.value.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  const result = await apiFetch(`/api/users/${userId}/reset-password`, {
    method: 'PATCH',
    body: JSON.stringify({ new_password: input.value })
  });
  if (result && result.success) {
    showToast('Password updated ✓', 'success');
    input.value = '';
    input.type = 'password';
  }
}

async function deleteUser(userId, userName, fromModal = false) {
  if (!confirm(`Delete account for "${userName}"? This cannot be undone.`)) return;
  const result = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
  if (result && result.success) {
    showToast(`${userName} deleted`, 'success');
    if (fromModal) document.getElementById('user-detail-modal').classList.remove('active');
    loadUsersTab();
  }
}

// ==========================================
// ADMIN: ORDERS
// ==========================================
async function loadAdminOrders() {
  const orders = await apiFetch('/api/orders');
  const tbody = document.getElementById('orders-tbody');
  if (!orders || !orders.length) {
    tbody.innerHTML = `
      <tr><td colspan="9">
        <div style="text-align:center;padding:60px 20px;">
          <div style="font-size:48px;margin-bottom:16px;">📋</div>
          <p style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px;">No orders yet</p>
          <p style="font-size:13px;color:var(--text-muted);">Orders placed by your clients will appear here.</p>
        </div>
      </td></tr>`;
    return;
  }
  const statusColors = { pending:'pending', processing:'pending', shipped:'active', delivered:'active', cancelled:'inactive' };
  tbody.innerHTML = orders.map(o => {
    const inv = o.invoice;
    const invStatus = inv?.invoice_status || 'unpaid';
    // Auto-flag overdue: unpaid and past due date
    const isOverdue = invStatus === 'unpaid' && inv?.due_date && new Date(inv.due_date) < new Date();
    const displayStatus = isOverdue ? 'overdue' : invStatus;
    const invBadgeClass = displayStatus === 'paid' ? 'active' : displayStatus === 'overdue' ? 'inactive' : 'pending';
    return `
    <tr style="cursor:pointer;" onclick="showOrderDetail(${o.id})">
      <td style="font-weight:600">#${o.id}</td>
      <td style="font-size:12px">${new Date(o.created_at).toLocaleDateString()}</td>
      <td>${esc(o.user_name || o.user_email || '—')}</td>
      <td>${esc(o.store_name || '—')}</td>
      <td style="font-size:12px">${o.items ? o.items.length + ' item(s)' : '—'}</td>
      <td class="revenue-cell">$${parseFloat(o.total).toFixed(2)}</td>
      <td>
        ${inv ? `<span style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;">${esc(inv.invoice_number)}</span>` : ''}
        <span class="status-badge ${invBadgeClass}" style="font-size:11px;">${displayStatus}</span>
      </td>
      <td><span class="status-badge ${statusColors[o.status] || 'pending'}">${o.status}</span></td>
      <td onclick="event.stopPropagation()">
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <select onchange="updateOrderStatus(${o.id}, this.value)" style="font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);">
            ${['pending','processing','shipped','delivered','cancelled'].map(s => `<option value="${s}" ${o.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
          </select>
          ${inv ? `<button class="btn btn-sm btn-outline" style="font-size:11px;padding:4px 8px;" onclick="openInvoice(${o.id})">📄 Invoice</button>` : ''}
          ${inv && displayStatus !== 'paid' ? `<button class="btn btn-sm btn-green" style="font-size:11px;padding:4px 8px;" onclick="markInvoicePaid(${o.id}, this)">Mark Paid</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');

  // store orders globally for detail lookup
  window._adminOrders = orders;
}

function showOrderDetail(orderId) {
  const o = (window._adminOrders || []).find(x => x.id === orderId);
  if (!o) return;
  renderOrderDetailModal(o, true);
}

function renderOrderDetailModal(o, isAdmin) {
  const modalId = isAdmin ? 'order-detail-modal' : 'my-order-detail-modal';
  const modal = document.getElementById(modalId);
  if (!modal) return;
  const statusColors = { pending:'pending', processing:'pending', shipped:'active', delivered:'active', cancelled:'inactive' };
  modal.querySelector('.order-detail-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Order</p>
        <p style="font-size:18px;font-weight:700;color:var(--text);">#${o.id}</p>
      </div>
      <div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Date</p>
        <p style="font-size:14px;color:var(--text);">${new Date(o.created_at).toLocaleString()}</p>
      </div>
      ${isAdmin ? `<div><p style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Placed By</p><p style="font-size:14px;color:var(--text);">${esc(o.user_name||o.user_email||'—')}</p></div>` : ''}
      ${o.store_name ? `<div><p style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">For Store</p><p style="font-size:14px;color:var(--text);">${esc(o.store_name)}</p></div>` : ''}
      <div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Status</p>
        <span class="status-badge ${statusColors[o.status]||'pending'}">${o.status}</span>
      </div>
      <div>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Payment</p>
        <span class="status-badge ${o.payment_method==='invoice'?'pending':'active'}">${o.payment_method==='invoice'?'Invoice / Net-30':'Credit Card'}</span>
        <span class="status-badge ${o.payment_status==='paid'?'active':'pending'}" style="margin-left:4px;">${o.payment_status}</span>
      </div>
    </div>

    <div style="background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:16px;">
      <p style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:12px;">Items Ordered (${o.items?o.items.length:0})</p>
      ${o.items && o.items.length ? o.items.map(item => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          <div>
            <p style="font-size:13px;font-weight:500;color:var(--text);">${esc(item.name)}</p>
            <p style="font-size:12px;color:var(--text-muted);">$${parseFloat(item.unit_price).toFixed(2)} × ${item.quantity}</p>
          </div>
          <p style="font-size:14px;font-weight:600;color:var(--accent);">$${parseFloat(item.total_price).toFixed(2)}</p>
        </div>
      `).join('') : '<p style="color:var(--text-muted);font-size:13px;">No items</p>'}
      <div style="display:flex;justify-content:space-between;padding:10px 0 4px;">
        <span style="font-size:13px;color:var(--text-secondary);">Subtotal</span>
        <span style="font-size:13px;color:var(--text);">$${parseFloat(o.subtotal).toFixed(2)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;">
        <span style="font-size:13px;color:var(--text-secondary);">Shipping</span>
        <span style="font-size:13px;color:var(--text);">${parseFloat(o.shipping_cost)===0?'FREE':'$'+parseFloat(o.shipping_cost).toFixed(2)}</span>
      </div>
      ${parseFloat(o.processing_fee||0) > 0 ? `
      <div style="display:flex;justify-content:space-between;padding:4px 0;">
        <span style="font-size:13px;color:var(--text-secondary);">Processing Fee (2.9% + $0.30)</span>
        <span style="font-size:13px;color:var(--text);">$${parseFloat(o.processing_fee).toFixed(2)}</span>
      </div>` : ''}
      <div style="display:flex;justify-content:space-between;padding:10px 0 0;border-top:1px solid var(--border);margin-top:6px;">
        <span style="font-size:15px;font-weight:700;color:var(--text);">Total</span>
        <span style="font-size:15px;font-weight:700;color:var(--accent);">$${parseFloat(o.total).toFixed(2)}</span>
      </div>
    </div>

    <div style="background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:16px;">
      <p style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;">Shipping Address</p>
      <p style="font-size:13px;color:var(--text-secondary);">${esc(o.shipping_name||'')}</p>
      <p style="font-size:13px;color:var(--text-secondary);">${esc(o.shipping_address||'')}</p>
      <p style="font-size:13px;color:var(--text-secondary);">${esc(o.shipping_city||'')}${o.shipping_city?', ':''}${esc(o.shipping_state||'')} ${esc(o.shipping_zip||'')}</p>
    </div>

    ${o.notes ? `
    <div style="background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:16px;">
      <p style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px;">Order Notes</p>
      <p style="font-size:13px;color:var(--text-secondary);">${esc(o.notes)}</p>
    </div>` : ''}

    ${o.invoice ? (() => {
      const inv = o.invoice;
      const isOverdue = inv.invoice_status === 'unpaid' && inv.due_date && new Date(inv.due_date) < new Date();
      const status = isOverdue ? 'overdue' : inv.invoice_status;
      const statusColor = status === 'paid' ? '#16a34a' : status === 'overdue' ? '#dc2626' : '#d97706';
      const statusBg = status === 'paid' ? '#f0fdf4' : status === 'overdue' ? '#fef2f2' : '#fffbeb';
      return `
    <div style="background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <p style="font-size:13px;font-weight:600;color:var(--text);">Invoice</p>
        <span style="background:${statusBg};color:${statusColor};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;text-transform:capitalize;">${status}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;color:var(--text-secondary);margin-bottom:14px;">
        <div><span style="color:var(--text-muted);">Invoice #</span><br><strong style="color:var(--text);">${esc(inv.invoice_number)}</strong></div>
        <div><span style="color:var(--text-muted);">Due Date</span><br><strong style="color:var(--text);">${new Date(inv.due_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</strong></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-sm btn-outline" onclick="openInvoice(${o.id})" style="font-size:12px;">📄 View / Download Invoice</button>
        ${isAdmin && status !== 'paid' ? `<button class="btn btn-sm btn-green" onclick="markInvoicePaid(${o.id}, this);closeModal();" style="font-size:12px;">✓ Mark as Paid</button>` : ''}
      </div>
    </div>`;
    })() : ''}
  `;
  modal.classList.add('active');
}

async function markInvoicePaid(orderId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  const result = await apiFetch(`/api/invoices/${orderId}/pay`, { method: 'PATCH' });
  if (result?.success) {
    showToast('Invoice marked as paid ✓', 'success');
    loadAdminOrders();
  } else {
    if (btn) { btn.disabled = false; btn.textContent = 'Mark Paid'; }
    showToast('Failed to update invoice', 'error');
  }
}

async function updateOrderStatus(id, status) {
  const result = await apiFetch(`/api/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
  if (result && result.success) showToast('Order status updated', 'success');
}

// ==========================================
// MY ORDERS (for rep, dsd, dsd)
// ==========================================
async function loadMyOrders(tbodyId) {
  const orders = await apiFetch('/api/orders');
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  window._myOrders = orders || [];

  if (!orders || !orders.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div style="text-align:center;padding:60px 20px;">
            <div style="font-size:48px;margin-bottom:16px;">📦</div>
            <p style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px;">No orders yet</p>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">When you place an order from the shop, it will appear here.</p>
            <a href="/shop.html" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">🛒 Go to Shop</a>
          </div>
        </td>
      </tr>`;
    return;
  }

  const statusColors = { pending:'pending', processing:'pending', shipped:'active', delivered:'active', cancelled:'inactive' };
  tbody.innerHTML = orders.map(o => {
    const inv = o.invoice;
    const invStatus = inv?.invoice_status || 'unpaid';
    const isOverdue = invStatus === 'unpaid' && inv?.due_date && new Date(inv.due_date) < new Date();
    const displayStatus = isOverdue ? 'overdue' : invStatus;
    const invBadgeClass = displayStatus === 'paid' ? 'active' : displayStatus === 'overdue' ? 'inactive' : 'pending';
    return `
    <tr style="cursor:pointer;" onclick="showMyOrderDetail(${o.id})">
      <td style="font-weight:600">#${o.id}</td>
      <td style="font-size:12px">${new Date(o.created_at).toLocaleDateString()}</td>
      <td>${esc(o.store_name || 'Personal')}</td>
      <td style="font-size:12px">${o.items ? o.items.length + ' item(s)' : '—'}</td>
      <td class="revenue-cell">$${parseFloat(o.total).toFixed(2)}</td>
      <td>
        ${inv ? `<span style="font-size:11px;color:var(--text-muted);display:block;">${esc(inv.invoice_number)}</span>` : ''}
        <span class="status-badge ${invBadgeClass}" style="font-size:11px;">${displayStatus}</span>
      </td>
      <td><span class="status-badge ${statusColors[o.status]||'pending'}">${o.status}</span></td>
      <td onclick="event.stopPropagation()">
        ${inv ? `<button class="btn btn-sm btn-outline" style="font-size:11px;" onclick="openInvoice(${o.id})">📄 Invoice</button>` : '—'}
      </td>
    </tr>`;
  }).join('');
}

function showMyOrderDetail(orderId) {
  const o = (window._myOrders || []).find(x => x.id === orderId);
  if (!o) return;
  renderOrderDetailModal(o, false);
}

// ==========================================
// TAB SWITCHER FOR NON-ADMIN DASHBOARDS
// ==========================================
function switchMyTab(tab, btn) {
  ['main','orders','inventory','stores','commissions'].forEach(t => {
    const el = document.getElementById('my-tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (tab === 'orders') loadMyOrders('my-orders-tbody');
  if (tab === 'inventory') loadInventory();
  if (tab === 'stores') loadMyStores();
  if (tab === 'commissions') loadMyCommissions();
}

// ==========================================
// INVENTORY (full featured)
// ==========================================
let _inventoryData = [];
let _inventorySearch = '';
let _inventorySort = 'low'; // 'low' | 'name' | 'stock-asc' | 'stock-desc'
let _inventoryShowLowOnly = false;

function reorderLowStock(storeId) {
  const store = _inventoryData.find ? null : null; // _inventoryData is flat rows
  const storeRows = _inventoryData.filter(r => r.store_id === storeId);
  const lowItems = storeRows.filter(r => r.is_low);
  const storeName = storeRows[0]?.store_name || 'this store';

  if (lowItems.length === 0) {
    // No low items — just go to shop normally
    window.location.href = `/shop.html?store_id=${storeId}`;
    return;
  }

  // Store low items in sessionStorage for shop to pick up
  const reorderData = {
    store_id: storeId,
    store_name: storeName,
    items: lowItems.map(r => ({
      product_id: r.product_id,
      product_name: r.product_name,
      current_qty: r.quantity,
      threshold: r.low_stock_threshold,
      // Suggest restocking to 2× threshold, minimum 1
      suggested_qty: Math.max(1, (r.low_stock_threshold * 2) - r.quantity)
    }))
  };
  sessionStorage.setItem('wc_reorder', JSON.stringify(reorderData));
  window.location.href = `/shop.html?store_id=${storeId}`;
}

async function loadInventory() {
  const el = document.getElementById('inventory-content');
  if (!el) return;
  el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">Loading inventory...</div>';

  const rows = await apiFetch('/api/inventory');
  if (!rows || !rows.length) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No inventory data available yet.</div>';
    return;
  }
  _inventoryData = rows;
  _inventorySearch = '';
  _inventorySort = 'low';
  _inventoryShowLowOnly = false;

  // Render controls once — these never re-render so search keeps focus
  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;">
      <input type="text" id="inventory-search-input" placeholder="🔍 Search stores by name, city, state..."
        oninput="inventorySearch(this.value)"
        style="flex:1;min-width:200px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:14px;font-family:inherit;">
      <select id="inventory-sort-select" onchange="inventorySort(this.value)"
        style="padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;font-family:inherit;">
        <option value="low">Sort: Most Low Stock</option>
        <option value="name">Sort: Store Name A–Z</option>
        <option value="stock-asc">Sort: Least Stocked First</option>
        <option value="stock-desc">Sort: Most Stocked First</option>
      </select>
    </div>
    <div id="inventory-banner"></div>
    <div id="inventory-stores"></div>
  `;

  renderInventoryStores();
}

function renderInventory() {
  renderInventoryStores();
}

function renderInventoryStores() {
  const bannerEl = document.getElementById('inventory-banner');
  const storesEl = document.getElementById('inventory-stores');
  if (!storesEl) return;

  // Group by store
  const byStore = {};
  for (const r of _inventoryData) {
    if (!byStore[r.store_id]) byStore[r.store_id] = { id: r.store_id, name: r.store_name, city: r.city, state: r.state, items: [] };
    if (r.product_id) byStore[r.store_id].items.push(r);
  }

  let stores = Object.values(byStore);

  // Filter by search
  if (_inventorySearch) {
    const q = _inventorySearch.toLowerCase();
    stores = stores.filter(s => s.name.toLowerCase().includes(q) || (s.city||'').toLowerCase().includes(q) || (s.state||'').toLowerCase().includes(q));
  }

  // Filter low only
  if (_inventoryShowLowOnly) {
    stores = stores.filter(s => s.items.some(i => i.is_low));
  }

  // Sort stores
  if (_inventorySort === 'low') {
    stores.sort((a, b) => b.items.filter(i=>i.is_low).length - a.items.filter(i=>i.is_low).length);
  } else if (_inventorySort === 'name') {
    stores.sort((a, b) => a.name.localeCompare(b.name));
  } else if (_inventorySort === 'stock-asc') {
    stores.sort((a, b) => {
      const aMin = Math.min(...a.items.map(i=>i.quantity), 999);
      const bMin = Math.min(...b.items.map(i=>i.quantity), 999);
      return aMin - bMin;
    });
  } else if (_inventorySort === 'stock-desc') {
    stores.sort((a, b) => {
      const aMax = Math.max(...a.items.map(i=>i.quantity), 0);
      const bMax = Math.max(...b.items.map(i=>i.quantity), 0);
      return bMax - aMax;
    });
  }

  const totalLow = _inventoryData.filter(r => r.is_low).length;

  // Update banner
  if (bannerEl) {
    bannerEl.innerHTML = totalLow > 0 ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">⚠️</span>
          <span style="font-size:14px;font-weight:600;color:#dc2626;">${totalLow} product${totalLow>1?'s':''} are low on stock</span>
        </div>
        <button onclick="inventoryToggleLow()" style="padding:7px 14px;border-radius:7px;border:1px solid #fca5a5;background:${_inventoryShowLowOnly?'#dc2626':'#fff'};color:${_inventoryShowLowOnly?'#fff':'#dc2626'};font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">
          ${_inventoryShowLowOnly ? '\u2715 Show All Stores' : '\u26a0 Show Low Inventory Stores'}
        </button>
      </div>` : `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:20px;">\u2705</span>
        <span style="font-size:14px;font-weight:600;color:#16a34a;">All stores are well stocked</span>
      </div>`;
  }

  // Update stores
  const isAdmin = window._userRole === 'admin';
  storesEl.innerHTML = stores.length === 0 ? '<div style="text-align:center;padding:40px;color:var(--text-muted);">No stores match your search.</div>' : stores.map(store => {
      const lowItems = store.items.filter(i => i.is_low);
      const sortedItems = [...store.items].sort((a,b) => b.is_low - a.is_low || a.quantity - b.quantity);
      return `
      <div class="table-card" style="margin-bottom:16px;">
        <div class="table-toolbar">
          <div>
            <h2 style="margin:0 0 2px;"><span id="inv-dot-${store.id}" class="status-dot ${store.items.every(i=>!i.is_low)?'active':'inactive'}"></span>${esc(store.name)}</h2>
            <p style="font-size:12px;color:var(--text-muted);margin:0;">${esc(store.city||'')}${store.city?', ':''}${esc(store.state||'')}</p>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span id="inv-low-indicator-${store.id}">${lowItems.length > 0
              ? `<span style="font-size:12px;font-weight:600;color:#dc2626;">⚠ ${lowItems.length} low</span>`
              : `<span style="font-size:12px;color:#16a34a;">✓ All stocked</span>`}</span>
            <a onclick="reorderLowStock(${store.id})" href="#" style="padding:6px 14px;background:#2563eb;color:#fff;border-radius:7px;font-size:12px;font-weight:600;text-decoration:none;">🛒 Order</a>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Product</th><th>SKU</th><th>In Stock</th><th>Low Stock Threshold</th><th>Status</th>${isAdmin ? '<th>Save</th>' : ''}</tr></thead>
            <tbody>
              ${sortedItems.length ? sortedItems.map(item => `
                <tr id="inv-row-${store.id}-${item.product_id}" style="${item.is_low ? 'background:rgba(239,68,68,0.04);' : ''}">
                  <td style="font-weight:500">${esc(item.product_name)}</td>
                  <td style="font-size:12px;color:var(--text-muted)">${esc(item.sku||'—')}</td>
                  <td style="font-weight:600;">
                    ${isAdmin
                      ? `<input type="number" min="0" value="${item.quantity}"
                           id="inv-qty-${store.id}-${item.product_id}"
                           style="width:80px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;text-align:center;"
                           onchange="markInventoryDirty(${store.id},${item.product_id})">`
                      : `<span style="color:${item.quantity===0?'#dc2626':item.is_low?'#f59e0b':'var(--text)'}">${item.quantity}</span>`
                    }
                  </td>
                  <td style="font-size:12px;">
                    ${isAdmin
                      ? `<input type="number" min="0" value="${item.low_stock_threshold}"
                           id="inv-thr-${store.id}-${item.product_id}"
                           style="width:80px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;text-align:center;"
                           onchange="markInventoryDirty(${store.id},${item.product_id})">`
                      : `<span style="color:var(--text-muted)">${item.low_stock_threshold}</span>`
                    }
                  </td>
                  <td id="inv-status-${store.id}-${item.product_id}">${item.quantity === 0
                    ? '<span class="status-badge inactive"><span style="filter:hue-rotate(315deg) saturate(4) brightness(0.85);">⚠</span> Out of Stock</span>'
                    : item.is_low
                      ? '<span class="status-badge pending">⚠ Low Stock</span>'
                      : '<span class="status-badge active">✓ In Stock</span>'
                  }</td>
                  ${isAdmin ? `<td><button id="inv-save-${store.id}-${item.product_id}"
                      onclick="saveInventoryRow(${store.id},${item.product_id})"
                      style="padding:5px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;font-size:12px;font-weight:600;color:var(--text-secondary);cursor:pointer;font-family:inherit;transition:all 0.15s;"
                      disabled>Saved</button></td>` : ''}
                </tr>
              `).join('') : `<tr><td colspan="${isAdmin?6:5}" style="text-align:center;color:var(--text-muted);padding:20px;">No inventory data</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

function inventorySearch(val) {
  _inventorySearch = val;
  renderInventoryStores();
}

function inventorySort(val) {
  _inventorySort = val;
  renderInventoryStores();
}

function inventoryToggleLow() {
  _inventoryShowLowOnly = !_inventoryShowLowOnly;
  renderInventoryStores();
}

function markInventoryDirty(storeId, productId) {
  const btn = document.getElementById(`inv-save-${storeId}-${productId}`);
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = 'Save';
  btn.style.background = 'var(--accent)';
  btn.style.color = '#fff';
  btn.style.borderColor = 'var(--accent)';
}

async function saveInventoryRow(storeId, productId) {
  const btn = document.getElementById(`inv-save-${storeId}-${productId}`);
  const qtyEl = document.getElementById(`inv-qty-${storeId}-${productId}`);
  const thrEl = document.getElementById(`inv-thr-${storeId}-${productId}`);
  if (!btn || !qtyEl) return;

  const quantity = parseInt(qtyEl.value);
  const low_stock_threshold = thrEl ? parseInt(thrEl.value) : 10;

  if (isNaN(quantity) || quantity < 0) { showToast('Quantity must be 0 or more', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  const result = await apiFetch(`/api/inventory/${storeId}/${productId}`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity, low_stock_threshold })
  });

  if (result && result.success) {
    btn.textContent = 'Saved';
    btn.style.background = 'var(--green-bg)';
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';

    // Update the status badge live without re-rendering the whole table
    const statusEl = document.getElementById(`inv-status-${storeId}-${productId}`);
    if (statusEl) {
      const isLow = quantity <= low_stock_threshold;
      statusEl.innerHTML = quantity === 0
        ? '<span class="status-badge inactive"><span style="filter:hue-rotate(315deg) saturate(4) brightness(0.85);">⚠</span> Out of Stock</span>'
        : isLow
          ? '<span class="status-badge pending">⚠ Low Stock</span>'
          : '<span class="status-badge active">✓ In Stock</span>';
    }

    // Clear/set row background immediately
    const rowEl = document.getElementById(`inv-row-${storeId}-${productId}`);
    if (rowEl) {
      const isLow = quantity <= low_stock_threshold;
      rowEl.style.background = (isLow || quantity === 0) ? 'rgba(239,68,68,0.04)' : '';
    }

    // Update local data so re-sorts work correctly
    for (const row of _inventoryData) {
      if (row.store_id === storeId && row.product_id === productId) {
        row.quantity = quantity;
        row.low_stock_threshold = low_stock_threshold;
        row.is_low = quantity <= low_stock_threshold ? 1 : 0;
      }
    }

    // Update store-level dot and low indicator based on updated data
    const storeItems = _inventoryData.filter(r => r.store_id === storeId);
    const lowCount = storeItems.filter(r => r.is_low).length;
    const dotEl = document.getElementById(`inv-dot-${storeId}`);
    if (dotEl) {
      dotEl.className = `status-dot ${lowCount === 0 ? 'active' : 'inactive'}`;
    }
    const indicatorEl = document.getElementById(`inv-low-indicator-${storeId}`);
    if (indicatorEl) {
      indicatorEl.innerHTML = lowCount > 0
        ? `<span style="font-size:12px;font-weight:600;color:#dc2626;">⚠ ${lowCount} low</span>`
        : `<span style="font-size:12px;color:#16a34a;">✓ All stocked</span>`;
    }
    showToast('Inventory updated', 'success');
  } else {
    btn.disabled = false;
    btn.textContent = 'Save';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#fff';
    showToast('Failed to save', 'error');
  }
}

// ==========================================
// SETTINGS: NOTIFICATION EMAILS
// ==========================================
async function loadNotifEmails() {
  const emails = await apiFetch('/api/notification-emails');
  const list = document.getElementById('notif-emails-list');
  if (!list) return;

  if (!emails || !emails.length) {
    list.innerHTML = '<p style="font-size:13px;color:var(--text-muted);padding:4px;">No notification emails added yet.</p>';
    return;
  }

  list.innerHTML = emails.map(e => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
      <div style="width:36px;height:36px;background:var(--accent-bg);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">📧</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:600;color:var(--text);">${esc(e.email)}</div>
        ${e.label ? `<div style="font-size:12px;color:var(--text-muted);">${esc(e.label)}</div>` : ''}
      </div>
      <button onclick="removeNotifEmail(${e.id})"
        style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.15s;"
        onmouseover="this.style.background='var(--red-bg)';this.style.borderColor='var(--red)'"
        onmouseout="this.style.background='transparent';this.style.borderColor='var(--border)'">
        Remove
      </button>
    </div>
  `).join('');
}

async function addNotifEmail() {
  const emailEl = document.getElementById('notif-email-input');
  const labelEl = document.getElementById('notif-label-input');
  const email = emailEl.value.trim();
  const label = labelEl ? labelEl.value.trim() : '';
  if (!email || !email.includes('@')) { showToast('Enter a valid email address', 'error'); return; }

  const result = await apiFetch('/api/notification-emails', {
    method: 'POST',
    body: JSON.stringify({ email, label })
  });

  if (result && result.id) {
    emailEl.value = '';
    if (labelEl) labelEl.value = '';
    showToast(`${email} added`, 'success');
    loadNotifEmails();
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

async function removeNotifEmail(id) {
  const result = await apiFetch(`/api/notification-emails/${id}`, { method: 'DELETE' });
  if (result && result.success) {
    showToast('Email removed', 'info');
    loadNotifEmails();
  }
}

// ── STORE MAP VIEW ────────────────────────────────────────────────────────────
let _storeMap = null;

function setStoreView(view) {
  // Target the stores list container - works for both WowCow and ADDY layouts
  const listContainer = document.getElementById('stores-list-container') ||
                        document.querySelector('#tab-stores .table-wrap') ||
                        document.querySelector('#tab-stores .table-card');
  const tableFooter = document.getElementById('table-footer');
  const mapEl = document.getElementById('stores-map-view');
  const listBtn = document.getElementById('btn-list-view');
  const mapBtn = document.getElementById('btn-map-view');
  if (view === 'map') {
    if (listContainer) listContainer.style.display = 'none';
    if (tableFooter) tableFooter.style.display = 'none';
    if (mapEl) mapEl.style.display = 'block';
    if (listBtn) { listBtn.style.background='var(--bg-secondary)'; listBtn.style.color='var(--text)'; }
    if (mapBtn) { mapBtn.style.background='var(--accent)'; mapBtn.style.color='#fff'; }
    loadStoreMap();
  } else {
    if (listContainer) listContainer.style.display = '';
    if (tableFooter) tableFooter.style.display = '';
    if (mapEl) mapEl.style.display = 'none';
    if (listBtn) { listBtn.style.background='var(--accent)'; listBtn.style.color='#fff'; }
    if (mapBtn) { mapBtn.style.background='var(--bg-secondary)'; mapBtn.style.color='var(--text)'; }
  }
}

async function loadStoreMap() {
  const mapEl = document.getElementById('stores-map');
  if (!mapEl) return;
  if (!window.L) {
    await new Promise((res, rej) => {
      const css = document.createElement('link'); css.rel='stylesheet';
      css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload=res; s.onerror=rej; document.head.appendChild(s);
    });
  }
  if (_storeMap) { _storeMap.remove(); _storeMap=null; }
  _storeMap = L.map('stores-map').setView([39.5,-98.35],4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {attribution:'© OpenStreetMap contributors'}).addTo(_storeMap);
  const stores = await apiFetch('/api/stores/map-data');
  if (!stores || !stores.length) {
    const info = L.control({position:'topright'});
    info.onAdd = () => { const d=L.DomUtil.create('div'); d.style.cssText='background:#fff;padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.15);'; d.textContent='No stores yet'; return d; };
    info.addTo(_storeMap); return;
  }
  for (const store of stores) {
    const parts = [store.address,store.city,store.state,'USA'].filter(Boolean);
    if (parts.length < 2) continue;
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?q='+encodeURIComponent(parts.join(', '))+'&format=json&limit=1',{headers:{'User-Agent':'ADDY-DSD/1.0'}});
      const data = await r.json();
      if (data && data[0]) {
        L.marker([parseFloat(data[0].lat),parseFloat(data[0].lon)]).addTo(_storeMap)
          .bindPopup('<strong>'+store.name+'</strong><br>'+[store.address,store.city,store.state].filter(Boolean).join(', '));
      }
      await new Promise(r=>setTimeout(r,1100));
    } catch(e){}
  }
}


async function triggerBackup() {
  const status = document.getElementById('backup-status');
  if (status) status.textContent = 'Starting backup...';
  const result = await apiFetch('/api/admin/backup-now', { method: 'POST' });
  if (result && result.success) {
    if (status) status.textContent = '✓ Backup running — check Railway logs for progress';
    showToast('Backup started ✓', 'success');
  }
}

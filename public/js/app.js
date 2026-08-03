const API = '';

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
let _vapidPublicKey = null;

async function initPushNotifications() {
  // Inside the native app (App Store build) the WebView has no PushManager —
  // the bell runs through the Capacitor bridge instead (js/native-push.js).
  if (window.AddyNativePush) { updatePushBellUI(localStorage.getItem('addy_native_push') === '1'); return; }
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
  // Native app: register with APNs/FCM through the Capacitor bridge.
  if (window.AddyNativePush) {
    const wasOn = localStorage.getItem('addy_native_push') === '1';
    if (wasOn) {
      const ok = await window.AddyNativePush.disable();
      if (ok) { localStorage.removeItem('addy_native_push'); updatePushBellUI(false); showToast('Notifications disabled', 'success'); }
      else showToast('Could not update notification settings', 'error');
    } else if (!window.AddyNativePush.available()) {
      showToast('Update the ADDY app to enable notifications', 'error');
    } else {
      const ok = await window.AddyNativePush.enable();
      if (ok) { localStorage.setItem('addy_native_push', '1'); updatePushBellUI(true); showToast('✓ Notifications enabled!', 'success'); }
      else showToast('Allow notifications for ADDY in your phone Settings', 'error');
    }
    return;
  }
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

// ── VIEW AS (admin preview) — session-isolated to the tab it was opened in ───
(function captureImpersonationToken() {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('t');
  if (!t) return;
  try {
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (payload.impersonating) {
      sessionStorage.setItem('addy_preview_token', t);
      sessionStorage.setItem('addy_preview_role', payload.role);
      sessionStorage.setItem('addy_preview_admin_email', payload.admin_email || '');
      window.history.replaceState({}, '', window.location.pathname);
    }
  } catch(e) { /* not a valid token, ignore */ }
})();

function isImpersonating() { return !!sessionStorage.getItem('addy_preview_token'); }

/** Ends an admin "View as" preview in this tab. */
function clearPreviewSession() {
  sessionStorage.removeItem('addy_preview_token');
  sessionStorage.removeItem('addy_preview_role');
  sessionStorage.removeItem('addy_preview_admin_email');
}

async function viewAsUser(userId) {
  const result = await apiFetch('/api/admin/impersonate/' + userId, { method: 'POST' });
  if (!result || !result.success) return;
  const roleFileMap = { dsd: 'dsd', investor: 'dsd', rep: 'dsd' };
  const file = roleFileMap[result.role] || 'dsd';
  window.open(`/dashboard-${file}.html?t=${result.token}`, '_blank');
}
function getToken() { return sessionStorage.getItem('addy_preview_token') || localStorage.getItem('addy_token'); }
function getRole() { return sessionStorage.getItem('addy_preview_role') || localStorage.getItem('addy_role'); }

function exitPreview() {
  sessionStorage.removeItem('addy_preview_token');
  sessionStorage.removeItem('addy_preview_role');
  sessionStorage.removeItem('addy_preview_admin_email');
  window.close();
  setTimeout(() => { window.location.href = '/login.html'; }, 200);
}

function renderImpersonationBanner() {
  if (!isImpersonating()) return;
  const adminEmail = sessionStorage.getItem('addy_preview_admin_email') || 'admin';
  const banner = document.createElement('div');
  banner.style.cssText = 'position:sticky;top:0;z-index:9999;background:#7c3aed;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:center;gap:16px;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
  banner.innerHTML = `
    <span>👀 Admin Preview — viewing as this account (logged in as ${adminEmail})</span>
    <button onclick="exitPreview()" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:#fff;padding:4px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Exit Preview</button>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
}

function logout() {
  localStorage.removeItem('addy_token');
  localStorage.removeItem('addy_role');
  // Also end any admin "View as" preview. getToken()/getRole() PREFER the
  // preview session, so leaving it behind meant a stale preview outlived the
  // sign-out and then overrode the next real login in that tab — an admin
  // would sign in, be treated as whichever account they last previewed, and
  // get bounced off their own dashboard with no way out but a new tab.
  clearPreviewSession();

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

/**
 * Records WHY we're sending someone back to sign in, so the login page can
 * tell them. Being bounced with no explanation — dashboard flashes, then
 * you're back at login — is impossible to diagnose without a devtools console,
 * which is exactly the situation this exists for. sessionStorage, so it shows
 * once and doesn't linger.
 */
function recordSignout(reason) {
  try { sessionStorage.setItem('addy_signout_reason', reason); } catch (e) {}
  console.warn('[addy] signed out:', reason);
}

function requireAuth(allowedRoles) {
  const token = getToken();
  const role = getRole();
  if (!token || !role) {
    recordSignout(`No saved session on this page (token ${token ? 'present' : 'MISSING'}, role ${role ? '"' + role + '"' : 'MISSING'}).`);
    window.location.href = '/login.html';
    return false;
  }
  if (allowedRoles && !allowedRoles.includes(role)) {
    recordSignout(`This page is for ${allowedRoles.join(' or ')} accounts, but your saved role is "${role}".`);
    window.location.href = '/login.html';
    return false;
  }
  if (role !== 'admin') checkAdminMessages();
  return true;
}

// Notification bell + inbox: shows messages an admin sent this user, with an unread badge.
async function checkAdminMessages() {
  try { renderMessageBell(await apiFetch('/api/my-messages') || []); } catch(e) { /* non-critical */ }
}

function renderMessageBell(msgs) {
  if (!msgs.length) { const b = document.getElementById('msg-bell'); if (b) b.remove(); return; }
  const unread = msgs.filter(m => !m.read_at).length;
  let bell = document.getElementById('msg-bell');
  if (!bell) {
    bell = document.createElement('div');
    bell.id = 'msg-bell';
    bell.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:1000;';
    document.body.appendChild(bell);
  }
  bell.innerHTML = `
    <button onclick="toggleMessagePanel()" title="Messages from admin" style="position:relative;width:52px;height:52px;border-radius:50%;border:none;background:#2563eb;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.25);">🔔
      ${unread ? `<span style="position:absolute;top:-2px;right:-2px;background:#dc2626;color:#fff;border-radius:999px;min-width:20px;height:20px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;">${unread}</span>` : ''}
    </button>
    <div id="msg-panel" style="display:none;position:absolute;bottom:64px;right:0;width:320px;max-height:60vh;overflow-y:auto;background:var(--bg-card,#fff);color:var(--text,#0f172a);border:1px solid var(--border,#e2e8f0);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.2);padding:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <strong style="font-size:14px;">Messages</strong>
        ${unread ? `<button onclick="dismissAdminMessages()" style="font-size:12px;background:none;border:none;color:#2563eb;cursor:pointer;">Mark all read</button>` : ''}
      </div>
      ${msgs.map(m => `
        <div style="padding:10px;border-radius:8px;margin-bottom:8px;background:${m.read_at ? 'transparent' : 'rgba(37,99,235,0.10)'};border:1px solid var(--border,#e2e8f0);">
          <div style="font-size:13px;line-height:1.5;white-space:pre-wrap;">${esc(m.message)}</div>
          <div style="font-size:11px;color:var(--text-muted,#94a3b8);margin-top:4px;">${new Date(m.created_at).toLocaleString()}</div>
        </div>`).join('')}
    </div>`;
  if (unread && !bell._nudged) { bell._nudged = true; const p = document.getElementById('msg-panel'); if (p) p.style.display = 'block'; }
}

function toggleMessagePanel() {
  const p = document.getElementById('msg-panel');
  if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

async function dismissAdminMessages() {
  try { await apiFetch('/api/my-messages/read', { method: 'POST' }); } catch(e) {}
  checkAdminMessages();
}

// Getting-started checklist for new reps — hides itself once all steps are done.
/**
 * Quiet milestone tracker: the first visit after crossing an order or store
 * threshold gets one toast (and butterflies for the big ones). Each fires
 * once, ever; catching up past several at once only announces the highest.
 */
function checkAddyMilestones(ordersCount, storesCount, _retry = 0) {
  try {
    // The checklist fetches race the profile fetch — wait for the real user
    // id so milestone keys are always per-user (never a shared 'me' bucket
    // that could double-fire or leak across accounts on one device).
    if (!window._me?.id) {
      if (_retry < 6) setTimeout(() => checkAddyMilestones(ordersCount, storesCount, _retry + 1), 600);
      return;
    }
    const uid = window._me.id;
    const fire = (kind, thresholds, count, label) => {
      const hit = thresholds.filter(t => count >= t);
      if (!hit.length) return;
      const unseen = hit.filter(t => !localStorage.getItem(`addy_ms_${uid}_${kind}_${t}`));
      if (!unseen.length) { hit.forEach(t => localStorage.setItem(`addy_ms_${uid}_${kind}_${t}`, '1')); return; }
      // One announcement per page load — a suppressed kind stays unmarked so
      // it gets its moment on the next visit instead of piling toasts now.
      if (window._addyToastedThisLoad) return;
      window._addyToastedThisLoad = true;
      hit.forEach(t => localStorage.setItem(`addy_ms_${uid}_${kind}_${t}`, '1'));
      const top = Math.max(...unseen);
      showToast(label(top), 'success');
      if (top >= (kind === 'orders' ? 25 : 10) && typeof monarchCelebrate === 'function') monarchCelebrate();
    };
    fire('orders', [10, 25, 50, 100], ordersCount, t => `🏆 ${t} orders placed — you're building something real.`);
    fire('stores', [5, 10, 25], storesCount, t => `🏪 ${t} stores in your territory — route royalty.`);
  } catch (e) { /* decoration */ }
}

async function renderOnboardingChecklist() {
  const el = document.getElementById('onboarding-checklist');
  if (!el) return;
  if (typeof getRole === 'function' && getRole() !== 'dsd') { el.innerHTML = ''; return; } // reps only, not members
  try {
    const [orders, storesData, photos] = await Promise.all([
      apiFetch('/api/orders').catch(() => []),
      apiFetch('/api/stores').catch(() => ({ stores: [] })),
      apiFetch('/api/my-stores/photos-pending').catch(() => [])
    ]);
    const ordersCount = Array.isArray(orders) ? orders.length : (orders?.orders?.length || 0);
    const storesCount = storesData?.stores?.length || 0;
    checkAddyMilestones(ordersCount, storesCount);
    const photosPending = Array.isArray(photos) ? photos.length : 0;
    const steps = [
      { done: ordersCount > 0, label: 'Place your first order', hint: 'At least 3 master boxes, any mix — its size locks in your rate (3+ boxes → 20%, half pallet → 25%, full pallet → 30%).' },
      { done: storesCount > 0, label: 'Claim your first store', hint: 'Lock in a store as your exclusive territory.' },
      { done: storesCount > 0 && photosPending === 0, label: 'Upload your store photos', hint: 'Required within your photo deadline.' },
    ];
    if (steps.every(s => s.done)) {
      el.innerHTML = '';
      // One-time salute the first time everything's checked off.
      const key = 'addy_onboard_done_' + (window._me?.id || 'me');
      if (!localStorage.getItem(key) && !window._addyToastedThisLoad) {
        window._addyToastedThisLoad = true;
        localStorage.setItem(key, '1');
        if (typeof monarchCelebrate === 'function') monarchCelebrate();
        showToast('🎉 You\'re fully set up — welcome to the ADDY program!', 'success');
      }
      return;
    }
    const completed = steps.filter(s => s.done).length;
    el.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:20px;">
        <strong style="font-size:15px;display:block;margin-bottom:12px;">🚀 Getting started (${completed}/${steps.length})</strong>
        ${steps.map(s => `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;">
            <div style="width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:${s.done?'#22c55e':'var(--bg-secondary,#eef2f7)'};color:${s.done?'#fff':'var(--text-muted,#94a3b8)'};border:2px solid ${s.done?'#22c55e':'var(--border,#e2e8f0)'};">${s.done?'✓':''}</div>
            <div><div style="font-size:13px;font-weight:600;color:var(--text);${s.done?'text-decoration:line-through;opacity:0.6;':''}">${s.label}</div><div style="font-size:12px;color:var(--text-muted);">${s.hint}</div></div>
          </div>`).join('')}
      </div>`;
  } catch(e) { /* non-critical */ }
}

// Pricing explainer: % off MSRP is set by the size of EACH order (by the box
// 20% · half pallet 25% · full pallet 30%), not by purchase history.
function renderMarginProgress(profile) {
  const el = document.getElementById('margin-progress');
  if (!el) return;
  const pct = profile.discount_pct != null ? profile.discount_pct : 20;
  if (profile.locked_discount_pct != null) {
    el.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:20px;font-size:13px;">Your margin is <strong>locked at ${pct}%</strong> on every order — pallet or not.${profile.house_partner ? ' <span title="the luck of the house" style="cursor:default;">\u2618</span>' : ''}</div>`;
    return;
  }
  el.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;">How your margin works — set by order size</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center;">
        <div style="background:var(--bg-secondary,#f3f6fb);border-radius:10px;padding:12px 8px;">
          <div style="font-size:20px;font-weight:800;">20%</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">By the box</div>
        </div>
        <div style="background:var(--bg-secondary,#f3f6fb);border-radius:10px;padding:12px 8px;">
          <div style="font-size:20px;font-weight:800;color:#2563eb;">25%</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Half pallet · 15+ boxes</div>
        </div>
        <div style="background:var(--bg-secondary,#f3f6fb);border-radius:10px;padding:12px 8px;">
          <div style="font-size:20px;font-weight:800;color:#2563eb;">30%</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Full pallet · 27+ boxes</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:10px;">Applies automatically to each order in the <a href="/shop.html" style="color:var(--accent);">shop</a> — any mix of products counts.</div>
    </div>`;
}

// Copy this rep's invite link (prefills their email as the referral code at signup).
function copyReferralLink() {
  const email = window._myEmail;
  if (!email) { showToast('Still loading — try again in a moment', 'info'); return; }
  const link = `${location.origin}/?ref=${encodeURIComponent(email)}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(
      () => { showToast('Invite link copied! Share it — you earn 5% on their orders.', 'success'); addyPaperPlane(); },
      () => prompt('Copy your invite link:', link)
    );
  } else {
    prompt('Copy your invite link:', link);
  }
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const res = await fetch(API + url, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...options.headers }
  });
  if (res.status === 401) {
    recordSignout(`The server rejected your session on ${(options.method || 'GET')} ${url} (401).`);
    logout();
    return null;
  }
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

// Whole dollars for round figures (revenue, averages — cents are noise there),
// but exact cents when there ARE cents. This used to round unconditionally,
// so a $175.60 commission balance displayed as "$176" — money owed, shown
// wrong. NaN/undefined renders as $0 rather than "$NaN".
function formatCurrency(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '$0';
  const hasCents = Math.round(num * 100) % 100 !== 0;
  return '$' + num.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
}

function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

// HTML-escape for text nodes and quoted attribute values.
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : str;
  return d.innerHTML.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// Escape for a value we drop inside a quoted JS string that itself lives in an
// onclick="" attribute — e.g. onclick="deleteUser(3, '<HERE>')".
//
// esc() is NOT safe there: the HTML parser decodes entities BEFORE the JS
// parser runs, so &#39; turns back into ' and closes the string early. A name
// like "Sean O'Brien" or a store like "Joe's Deli" threw a SyntaxError and the
// button silently did nothing. So backslash-escape for JS first, then
// entity-escape for HTML; the backslashes survive decoding and reach JS intact.
function escAttr(str) {
  const js = String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return js
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  const credit = '<div id="monarch-brand-credit" style="font-size:10.5px;color:var(--text-muted);letter-spacing:0.2px;padding-left:2px;">powered by <strong style="color:#E8873B;cursor:pointer;" title="🦋">Monarch</strong></div>';
  try {
    const token = localStorage.getItem('addy_token');
    const role = token ? JSON.parse(atob(token.split('.')[1])).role : null;
    const href = role === 'admin' ? '/dashboard-admin.html' : '/dashboard-dsd.html';
    container.innerHTML = `<a href="${href}" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-decoration:none;cursor:pointer;">
      <img src="/images/addy-logo.svg" alt="ADDY" style="height:52px;width:auto;object-fit:contain;" onerror="this.style.display='none';this.parentElement.textContent='ADDY'">
      ${credit}
    </a>`;
  } catch(e) {
    container.innerHTML = '<a href="/dashboard-dsd.html" style="text-decoration:none;font-weight:900;font-size:22px;color:var(--text);">ADDY' + credit + '</a>';
  }
}


// --- Dark Mode ---
function initTheme() {
  const saved = localStorage.getItem('addy_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeButton(saved);
}

function toggleTheme() {
  const btn = document.getElementById('theme-toggle');
  if (btn) { btn.classList.remove('theme-spin'); void btn.offsetWidth; btn.classList.add('theme-spin'); }
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
/**
 * `action` is optional: { label, onClick }. A toast that reports something you
 * might want to act on ("3 stores added") is a dead end without it — the next
 * step belongs on the message, not in a menu the reader has to go find.
 * With an action it also lingers, since three seconds isn't long enough to
 * read a sentence and decide to click.
 */
function showToast(message, type = 'success', action = null) {
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
  if (action && action.label) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.style.cssText = 'margin-left:10px;padding:4px 10px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;';
    btn.onclick = () => { toast.remove(); action.onClick?.(); };
    toast.appendChild(btn);
  }
  container.appendChild(toast);
  setTimeout(() => toast.remove(), action ? 8000 : 3000);
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
        recordSignout('Your session reached its 24-hour limit.');
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
  // Ticked by default: a 30-day session instead of a workday one. Reps use
  // this on a phone between stops and were being signed out constantly.
  const remember = document.getElementById('stay-signed-in')?.checked !== false;
  const errorEl = document.getElementById('error-msg');
  errorEl.style.display = 'none';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember })
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.style.display = 'block';
      return;
    }
    const t = data.token;
    // An UNRECOGNISED role used to fall through to the admin dashboard, which
    // requires role 'admin' — so the dashboard flashed for a moment and
    // requireAuth threw you straight back to this page. Forever, with nothing
    // on screen explaining it. A missing or unexpected role is now a clear
    // message instead of an invisible loop.
    const DASHBOARDS = {
      admin: 'dashboard-admin',
      dsd: 'dashboard-dsd',
      member: 'dashboard-dsd',
      investor: 'dashboard-dsd',
      rep: 'dashboard-dsd',
    };
    const dest = DASHBOARDS[data.role];
    if (!dest) {
      localStorage.removeItem('addy_token');
      localStorage.removeItem('addy_role');
      errorEl.textContent = data.role
        ? `Signed in, but your account role ("${data.role}") isn't one this site recognises, so there's no dashboard to open. An admin needs to fix the role on your account.`
        : `Signed in, but your account has no role set, so there's no dashboard to open. An admin needs to set the role on your account.`;
      errorEl.style.display = 'block';
      return;
    }
    // A fresh sign-in always wins. getToken()/getRole() prefer the preview
    // session, so without this a leftover "View as" preview in this tab
    // silently hijacked the new login — you'd sign in as yourself and be
    // treated as whoever you last previewed.
    clearPreviewSession();
    localStorage.setItem('addy_token', data.token);
    localStorage.setItem('addy_role', data.role);
    // Remember the ADDRESS only — never the password. The browser's own
    // password manager handles that, which is what the autocomplete
    // attributes on the form are there to enable.
    try {
      if (remember) localStorage.setItem('addy_last_email', email);
      else localStorage.removeItem('addy_last_email');
    } catch (e) { /* storage blocked */ }
    window.location.href = `/${dest}.html?t=${t}`;
  } catch {
    errorEl.textContent = 'Connection error';
    errorEl.style.display = 'block';
  }
}

// ==========================================
// ADDY DSD TIER & COMMISSION FUNCTIONS
// ==========================================

async function setUserDiscount(userId, discount) {
  // '' → clear the lock so the rep uses the automatic earn-up rate.
  const body = { discount: discount === '' ? null : parseFloat(discount) };
  const result = await apiFetch('/api/users/' + userId + '/tier', { method: 'PATCH', body: JSON.stringify(body) });
  if (result && result.success) {
    showToast(discount === '' ? 'Set to automatic earn-up ✓' : `Margin locked at ${discount}% ✓`, 'success');
    loadUsersTab();
  }
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
      <div style="font-size:13px;color:var(--text-muted);">You earn 5% when a rep you personally recruited places an order.<br>They'll show up here automatically.</div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${esc(r.earner_name || r.earner_email || '—')}</td>
    <td>${esc(r.buyer_name || '—')}</td>
    <td><span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:var(--accent-bg);color:var(--accent);">${r.level === 2 ? 'House' : 'Referral'}</span></td>
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
  renderImpersonationBanner();
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
  checkMailBadge();
}

/** Unread-mail count on the Mail tab, refreshed on dashboard load. */
async function checkMailBadge() {
  if (!document.getElementById('mail-badge')) return;
  const data = await apiFetch('/api/admin/mail?box=inbox&limit=1');
  if (data) updateMailBadge(data.unread);
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
// ── Getting there: hand off to the phone's own maps app ──────────────────────
/**
 * A rep looking at a store had no way to get directions to it or ring it —
 * they were retyping addresses into Maps by hand, in a truck.
 *
 * We hand off to the maps app rather than embedding a map: once Google Maps is
 * driving, the turn-by-turn appears on CarPlay or Android Auto. That's the only
 * route to a car screen from a web app — CarPlay itself runs native apps only.
 *
 * Google Maps on every device, including iPhone. Apple Maps was tried as the
 * iOS default and taken back out: its URL scheme has no waypoint parameter, so
 * a multi-stop route can't be expressed for it, and Monarch's driver routes
 * need multi-stop. Sending a rep to two different apps depending on which
 * screen they tapped is worse than picking one and staying there.
 */
function mapsUrlFor(store) {
  const q = [store.name, store.address, store.city, store.state, store.zip]
    .filter(Boolean).join(' ');
  const encoded = encodeURIComponent(q);
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encoded}`;
}

/** Tel: link, digits only — spaces and brackets break dialling on some phones. */
const telHref = (phone) => `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;

/**
 * Turn-by-turn is part of the paid Sales Suite (Monarch gates its own routes
 * behind requireFeature('routes'), a Pro-tier feature) — so the in-car
 * handoff here is Pro-only too, and the site owner always has it.
 *
 * Fails CLOSED: if we don't yet know the workspace, nothing is shown.
 *
 * Note this is presentation gating, not a data control. The store's address is
 * already on screen either way — this decides whether we do the convenient
 * thing with it, not whether it's visible. Anything that actually needs
 * enforcing lives behind Monarch's server-side plan checks.
 */
function hasProSuite() {
  if (getRole() === 'admin') return true;
  const ws = window._monarchWorkspace;
  if (!ws) return false;
  const paidTier = ws.tier === 'pro' || ws.tier === 'enterprise';
  const live = ws.status === 'active' || ws.comped;
  return !!(paidTier && live);
}

/**
 * Navigate + Call buttons for a store. `compact` is the inline pair used in a
 * list row; the default is the full-width pair for a detail panel.
 */
/**
 * Dial on a phone; show the number on a desktop.
 *
 * A bare tel: link is silent on desktop browsers that have no handler for it —
 * the button looked dead. Rather than hide Call there (a rep at a laptop still
 * needs the number), fall back to putting it on screen.
 */
const canDial = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

window.handleCallClick = function(event, phone, storeName) {
  if (canDial()) return true;              // let the tel: link do its job
  event.preventDefault();
  showPhoneNumber(phone, storeName);
  return false;
};

function showPhoneNumber(phone, storeName) {
  document.getElementById('phone-popover')?.remove();
  const el = document.createElement('div');
  el.id = 'phone-popover';
  el.style.cssText = `
    position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10050;
    background:var(--bg-card,#fff);border:1px solid var(--border,#ddd);border-radius:14px;
    padding:22px 26px;box-shadow:0 16px 40px rgba(0,0,0,0.3);text-align:center;min-width:260px;`;
  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${esc(storeName)}</div>
    <div style="font-size:26px;font-weight:800;letter-spacing:1px;margin-bottom:14px;">${esc(phone)}</div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-green" style="flex:1;" onclick="copyPhoneNumber('${escAttr(phone)}', this)">Copy</button>
      <button class="btn btn-outline" onclick="document.getElementById('phone-popover').remove()">Close</button>
    </div>`;
  document.body.appendChild(el);
}

window.copyPhoneNumber = function(phone, btn) {
  navigator.clipboard?.writeText(phone).then(() => {
    btn.textContent = 'Copied ✓';
    setTimeout(() => document.getElementById('phone-popover')?.remove(), 700);
  }).catch(() => { btn.textContent = 'Copy failed'; });
};

function storeActionsHtml(store, compact = false) {
  if (!hasProSuite()) return '';
  const hasAddress = !!(store.address || store.city);
  const hasPhone = !!store.phone;
  if (!hasAddress && !hasPhone) return '';
  const pad = compact ? '8px 12px' : '12px';
  const base = `display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:${pad};border-radius:10px;font-size:${compact ? '13px' : '14px'};font-weight:700;text-decoration:none;border:1px solid var(--border);${compact ? '' : 'flex:1;'}`;
  const nav = hasAddress
    ? `<a href="${escAttr(mapsUrlFor(store))}" target="_blank" rel="noopener"
         style="${base}background:var(--accent);color:#fff;border-color:transparent;"
         onclick="event.stopPropagation();">🧭 Navigate</a>`
    : '';
  // On a phone, tel: dials. On a desktop browser with no handler registered it
  // does nothing at all, which reads as a broken button — so there we show the
  // number instead, ready to read out or copy.
  const call = hasPhone
    ? `<a href="${escAttr(telHref(store.phone))}"
         style="${base}color:var(--text);"
         onclick="event.stopPropagation(); return handleCallClick(event, '${escAttr(store.phone)}', '${escAttr(store.name || 'this store')}');">📞 Call</a>`
    : '';
  return `<div style="display:flex;gap:8px;${compact ? '' : 'margin-top:14px;'}">${nav}${call}</div>`;
}

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
    ${storeActionsHtml(store)}
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
  const typed = prompt(`⚠️ This permanently deletes ALL ${total} stores and cannot be undone.\n\nType DELETE to confirm:`);
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'DELETE') { showToast('Cancelled — you did not type DELETE', 'info'); return; }
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
  loadMyReps(); // fire-and-forget — renders its own card
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
    <td><span style="padding:2px 8px;border-radius:10px;font-size:11px;background:var(--accent-bg);color:var(--accent);">${r.level === 2 ? 'House' : 'Referral'}</span></td>
    <td>${(parseFloat(r.rate)*100).toFixed(0)}%</td>
    <td style="font-weight:700;color:var(--green);">$${parseFloat(r.amount).toFixed(2)}</td>
    <td><span class="status-badge ${r.status}">${r.status}</span></td>
    <td style="font-size:12px;color:var(--text-muted);">${new Date(r.created_at).toLocaleDateString()}</td>
  </tr>`).join('');
}

// The earnings roster: every rep earning the caller commission, with tenure
// and dollars. Sortable by column, click a row for the per-order breakdown.
// Renders ONLY on the earner's own Commissions tab — reps never see it.
let _myRepsData = null, _myRepsSort = { key: 'earned_total', dir: -1 };

async function loadMyReps() {
  const el = document.getElementById('my-reps');
  if (!el) return;
  let data = null;
  try {
    const res = await fetch('/api/my-reps', { headers: { 'Authorization': `Bearer ${getToken()}` } });
    if (res.ok) data = await res.json();
  } catch (e) { /* silent */ }
  if (!data || !data.reps) { el.innerHTML = ''; return; }
  if (data.load_error) {
    el.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 18px;font-size:13px;color:var(--text-muted);">Couldn't load your reps right now — refresh to retry.</div>`;
    return;
  }
  if (!data.reps.length) {
    el.innerHTML = data.flat_rate_others
      ? `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;font-size:13px;color:var(--text-muted);">Your network roster is empty right now — new sign-ups appear here automatically.</div>`
      : `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;font-size:13px;color:var(--text-muted);">No reps yet — share your invite link (🔗 Invite, top right) and earn <strong>5%</strong> on everything they order.</div>`;
    return;
  }
  _myRepsData = data;
  renderMyReps();
}

function repTenure(createdAt) {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
  if (days < 1) return 'joined today';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  return `${years} yr ${months % 12} mo`;
}

function sortMyReps(key) {
  if (_myRepsSort.key === key) _myRepsSort.dir *= -1;
  else _myRepsSort = { key, dir: -1 };
  renderMyReps();
}

function renderMyReps() {
  const el = document.getElementById('my-reps');
  if (!el || !_myRepsData) return;
  const { reps, flat_rate_others } = _myRepsData;
  const { key, dir } = _myRepsSort;
  const sorted = [...reps].sort((a, b) => {
    const va = key === 'created_at' ? new Date(a[key]).getTime() : key === 'name' ? String(a.name || a.email).toLowerCase() : (a[key] || 0);
    const vb = key === 'created_at' ? new Date(b[key]).getTime() : key === 'name' ? String(b.name || b.email).toLowerCase() : (b[key] || 0);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
  const totalAll = reps.reduce((s, r) => s + (r.earned_total || 0), 0);
  const totalMonth = reps.reduce((s, r) => s + (r.earned_month || 0), 0);
  const arrow = (k) => _myRepsSort.key === k ? (_myRepsSort.dir === -1 ? ' ↓' : ' ↑') : '';
  const th = (label, k) => `<th style="cursor:pointer;user-select:none;white-space:nowrap;" onclick="sortMyReps('${k}')">${label}${arrow(k)}</th>`;
  el.innerHTML = `
    <div class="table-card">
      <div class="table-toolbar">
        <h2>My Reps <span style="font-size:12px;font-weight:600;color:var(--text-muted);">— click a rep for their order-by-order breakdown</span></h2>
        <div style="display:flex;gap:16px;font-size:13px;">
          <span>All-time: <strong style="color:var(--green);">$${totalAll.toFixed(2)}</strong></span>
          <span>This month: <strong style="color:var(--green);">$${totalMonth.toFixed(2)}</strong></span>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            ${th('Name', 'name')}${th('Joined', 'created_at')}<th>Status</th><th>Source</th>
            ${th('Orders', 'earning_orders')}${th('This month', 'earned_month')}${th('Earned you', 'earned_total')}
          </tr></thead>
          <tbody>
            ${sorted.map(r => `<tr style="cursor:pointer;" onclick="openRepDetail(${r.id})">
              <td style="font-weight:600;">${esc(r.name || '—')}<div style="font-size:11px;color:var(--text-muted);font-weight:400;">${esc(r.email)}</div></td>
              <td style="font-size:12px;">${new Date(r.created_at).toLocaleDateString()}<div style="font-size:11px;color:var(--text-muted);">${repTenure(r.created_at)}</div></td>
              <td><span class="status-badge ${r.status === 'active' ? 'active' : 'pending'}">${esc(r.status)}</span></td>
              <td style="font-size:12px;color:var(--text-muted);">${esc(r.source)}</td>
              <td>${r.earning_orders || 0}</td>
              <td style="color:var(--green);">$${(r.earned_month || 0).toFixed(2)}</td>
              <td style="font-weight:700;color:var(--green);">$${(r.earned_total || 0).toFixed(2)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${flat_rate_others ? `<div style="padding:12px 16px;border-top:1px solid var(--border);font-size:13px;color:var(--text-secondary);">＋ You also earn a flat <strong>${flat_rate_others}%</strong> on every other ADDY sale (never stacked with the 5%).</div>` : ''}
    </div>`;
}

async function openRepDetail(repId) {
  let modal = document.getElementById('rep-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'rep-detail-modal';
    modal.className = 'modal-overlay';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="modal" style="max-width:560px;"><div class="loading" style="padding:40px;">Loading…</div></div>`;
  modal.classList.add('active');
  const data = await apiFetch(`/api/my-reps/${repId}`);
  if (!data || !data.rep) { modal.classList.remove('active'); return; }
  const total = data.orders.reduce((s, o) => s + o.amount, 0);
  modal.innerHTML = `
    <div class="modal" style="max-width:560px;">
      <button class="close-btn" onclick="document.getElementById('rep-detail-modal').classList.remove('active')">&times;</button>
      <h2>${esc(data.rep.name || data.rep.email)}</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">
        Member for ${repTenure(data.rep.created_at)} (since ${new Date(data.rep.created_at).toLocaleDateString()})
        · has earned you <strong style="color:var(--green);">$${total.toFixed(2)}</strong> across ${data.orders.length} order${data.orders.length === 1 ? '' : 's'}</p>
      ${data.orders.length ? `
      <div class="table-wrap" style="max-height:340px;overflow-y:auto;">
        <table>
          <thead><tr><th>Date</th><th>Order</th><th>Order total</th><th>Rate</th><th>Your cut</th><th>Status</th></tr></thead>
          <tbody>${data.orders.map(o => `<tr>
            <td style="font-size:12px;">${new Date(o.created_at).toLocaleDateString()}</td>
            <td style="font-size:12px;">#${o.order_id}</td>
            <td>${o.order_total != null ? '$' + o.order_total.toFixed(2) : '—'}</td>
            <td>${(parseFloat(o.rate) * 100).toFixed(0)}%</td>
            <td style="font-weight:700;color:var(--green);">$${o.amount.toFixed(2)}</td>
            <td><span class="status-badge ${o.status}">${esc(o.status)}</span></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : `<p style="color:var(--text-muted);font-size:13px;padding:16px 0;">No orders yet — when they order, your commission shows up here.</p>`}
    </div>`;
}

async function requestPayout() {
  const result = await apiFetch('/api/payouts/request', { method: 'POST', body: JSON.stringify({}) });
  if (result && result.success) {
    showToast('Payout request of $' + parseFloat(result.amount).toFixed(2) + ' submitted ✓', 'success');
    addyCashFlight();
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
  // Navigate/Call sit on the row itself: this list IS the working screen for a
  // rep out on a route, and making them open a detail panel first to get
  // directions is the difference between using it and not.
  el.innerHTML = `<div class="table-card">` + stores.map(s => `
    <div onclick="editMyStore(${s.id})" title="Edit this store"
         style="display:flex;align-items:center;gap:16px;padding:16px;border-bottom:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:var(--bg-card);flex-wrap:wrap;cursor:pointer;">
      <div style="flex:1;min-width:190px;">
        <div style="font-weight:700;color:var(--text);">${esc(s.name)}</div>
        <div style="font-size:13px;color:var(--text-secondary);">${esc([s.address,s.city,s.state].filter(Boolean).join(', ')) || 'No address on file'}</div>
        ${(s.missing_fields || []).length ? `<div style="font-size:12px;color:#b45309;margin-top:3px;">⚠ Missing ${esc(s.missing_fields.join(', '))}</div>` : ''}
      </div>
      <button type="button" onclick="event.stopPropagation();editMyStore(${s.id});"
        style="display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:10px;font-size:13px;font-weight:700;border:1px solid var(--border);background:transparent;color:var(--text);cursor:pointer;">✎ Edit</button>
      <span class="status-badge ${s.store_approval_status==='approved'?'active':s.store_approval_status==='rejected'?'inactive':'pending'}">${s.store_approval_status==='approved'?'✓ Exclusive':s.store_approval_status==='rejected'?'Rejected':'⏳ Pending'}</span>
      ${storeActionsHtml(s, true)}
    </div>`).join('');
  const statEl = document.getElementById('stat-my-stores');
  if (statEl) statEl.textContent = stores.filter(s => s.store_approval_status==='approved').length;
  updateSuiteSyncButton();
  renderIncompleteStores(stores);
}

// The Suite status arrives after this list first renders, so redraw once it
// lands — otherwise a Pro subscriber sees their stores without the Navigate
// and Call buttons they pay for until they leave the tab and come back.
window.addEventListener('monarch:workspace', () => {
  if (document.getElementById('my-stores-list')) loadMyStores();
}, { once: true });

/**
 * Open a rep's own store for editing.
 *
 * The rows weren't clickable and there was nothing to click through TO: the
 * store detail endpoint was admin-only, so a rep who tapped their own store
 * got a 403. Details a rep collects on the road — a corrected address, the
 * phone, the resale certificate — had no way in at all.
 */
const EDIT_STORE_FIELDS = [
  ['name', 'Store name *'], ['owner_name', 'Owner / contact'], ['address', 'Address'],
  ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'],
  ['phone', 'Phone'], ['email', 'Email'], ['category', 'Category'],
  ['resale_number', 'Tax resale / reseller number'],
];

/** The same dialog the page ships with, created on demand when it isn't there. */
function buildEditStoreModal() {
  if (document.getElementById('edit-store-modal')) return document.getElementById('edit-store-modal');
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.id = 'edit-store-modal';
  wrap.onclick = (e) => { if (e.target === wrap) wrap.classList.remove('active'); };
  const input = (id, label) => `
    <div><label style="font-size:11px;font-weight:600;color:var(--text-muted);">${label}</label>
      <input type="text" id="es-${id}" style="width:100%;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:14px;box-sizing:border-box;"></div>`;
  wrap.innerHTML = `
    <div class="modal" style="max-width:520px;">
      <button class="close-btn" onclick="document.getElementById('edit-store-modal').classList.remove('active')">&times;</button>
      <h2>Edit <span id="es-title"></span></h2>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px;">
        ${EDIT_STORE_FIELDS.map(([id, label]) => input(id, label)).join('')}
        <div id="es-error" style="display:none;color:var(--red);font-size:13px;"></div>
        <button class="btn btn-green" id="es-save" onclick="saveMyStore()" style="padding:12px;font-size:15px;">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  return wrap;
}

window.editMyStore = async function(id) {
  const store = await apiFetch(`/api/stores/${id}`);
  // apiFetch hands back the error body, which is truthy — checking only for
  // falsy would open a blank form on a refusal instead of saying why.
  if (!store || store.error || !store.id) {
    showToast((store && store.error) || "Couldn't open that store.", 'error');
    return;
  }
  // Build the dialog if the page didn't ship with it. A cached or older copy of
  // dashboard-dsd.html has no #edit-store-modal, and the old code returned here
  // without a word — the button looked dead for reasons nothing on screen could
  // explain. Owning the markup in JS means the button works whatever HTML the
  // browser is holding.
  const modal = document.getElementById('edit-store-modal') || buildEditStoreModal();
  if (!modal) { showToast("Couldn't open the editor on this page — try reloading.", 'error'); return; }
  modal.dataset.storeId = id;
  const set = (f, v) => { const el = document.getElementById('es-' + f); if (el) el.value = v ?? ''; };
  EDIT_STORE_FIELDS.forEach(([f]) => set(f, store[f]));
  document.getElementById('es-title').textContent = store.name || 'Store';
  document.getElementById('es-error').style.display = 'none';
  modal.classList.add('active');
};

window.saveMyStore = async function() {
  const modal = document.getElementById('edit-store-modal');
  const id = modal.dataset.storeId;
  const btn = document.getElementById('es-save');
  const err = document.getElementById('es-error');
  const val = (f) => document.getElementById('es-' + f).value.trim();
  if (!val('name')) { err.textContent = 'The store needs a name.'; err.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  const body = {};
  EDIT_STORE_FIELDS.forEach(([f]) => { body[f] = val(f); });
  const r = await apiFetch(`/api/stores/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  btn.disabled = false; btn.textContent = 'Save changes';
  if (r && r.id) {
    showToast('Store updated ✓', 'success');
    modal.classList.remove('active');
    loadMyStores();
  } else {
    err.textContent = (r && r.error) || 'Could not save that.';
    err.style.display = 'block';
  }
};

/**
 * Send a butterfly across the screen while the stores travel.
 *
 * The sync takes a few seconds against a live Monarch and there is nothing to
 * look at meanwhile. One butterfly per store makes the wait legible — you can
 * see how many are going — and it is Monarch's own mark, so it reads as "these
 * are heading over there" rather than as decoration.
 *
 * Honours prefers-reduced-motion: some people get motion sick, and a flurry of
 * moving objects is exactly the trigger. They still get the result.
 */
function flyButterflies(count = 1, fromEl) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  if (!document.getElementById('butterfly-keyframes')) {
    const st = document.createElement('style');
    st.id = 'butterfly-keyframes';
    st.textContent = `
      @keyframes addy-flutter { 0%,100% { transform: rotate(-12deg) scale(1); } 50% { transform: rotate(12deg) scale(1.12); } }
      .addy-butterfly { position: fixed; z-index: 10060; pointer-events: none; will-change: transform, opacity; }
      .addy-butterfly > span { display: block; animation: addy-flutter .22s ease-in-out infinite; }`;
    document.head.appendChild(st);
  }
  const start = fromEl?.getBoundingClientRect();
  const x0 = start ? start.left + start.width / 2 : window.innerWidth / 2;
  const y0 = start ? start.top + start.height / 2 : window.innerHeight / 2;

  for (let i = 0; i < Math.min(count, 12); i++) {
    const b = document.createElement('div');
    b.className = 'addy-butterfly';
    b.innerHTML = '<span>🦋</span>';
    b.style.left = `${x0}px`;
    b.style.top = `${y0}px`;
    b.style.fontSize = `${18 + Math.round(Math.random() * 12)}px`;
    document.body.appendChild(b);
    // Up and to the right, with enough spread that they read as a flight
    // rather than one sprite drawn several times.
    const dx = 120 + Math.random() * (window.innerWidth * 0.5);
    const dy = -(140 + Math.random() * 260);
    const drift = (Math.random() - 0.5) * 120;
    b.animate([
      { transform: 'translate(-50%,-50%) translate(0,0)', opacity: 0 },
      { transform: `translate(-50%,-50%) translate(${dx * 0.35 + drift}px, ${dy * 0.5}px)`, opacity: 1, offset: 0.25 },
      { transform: `translate(-50%,-50%) translate(${dx * 0.7 - drift}px, ${dy * 0.8}px)`, opacity: 1, offset: 0.7 },
      { transform: `translate(-50%,-50%) translate(${dx}px, ${dy}px)`, opacity: 0 },
    ], {
      duration: 1500 + Math.random() * 900,
      delay: i * 90,
      easing: 'cubic-bezier(.35,.1,.25,1)',
    }).onfinish = () => b.remove();
  }
}

/** Push existing stores into the Suite — the mirror only ever ran on new ones. */
window.syncStoresToSuite = async function(btn) {
  const count = document.querySelectorAll('#my-stores-list > div > div').length || 1;
  flyButterflies(count, btn);
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '🦋 Flying…'; }
  const r = await apiFetch('/api/monarch/sync-stores', { method: 'POST', body: JSON.stringify({}) });
  if (btn) { btn.disabled = false; btn.textContent = label || '🦋 Send my stores to the Suite'; }
  if (r && r.success) {
    // A second flight on arrival, so a slow round trip still ends with the
    // butterflies landing rather than a bare toast some seconds later.
    flyButterflies(Math.min(r.created || count, 8), btn);
    showToast(`🦋 ${r.message}`, 'success', r.created ? {
      label: 'Open the Suite', onClick: () => { window.location.href = '/suite.html'; },
    } : undefined);
  } else {
    showToast((r && r.error) || 'Could not reach your Sales Suite.', 'error');
  }
};

/**
 * Only offer the send when there is somewhere to send to. A rep without a live
 * Suite pressing it just gets an error, which is a worse answer than the button
 * not being there. Any paid tier counts — the sync is not Pro-only, unlike the
 * in-car buttons.
 */
function updateSuiteSyncButton() {
  const btn = document.getElementById('suite-sync-btn');
  if (!btn) return;
  // The status payload carries slug/tier/status/comped — there is no
  // "provisioned" field on it, so don't pretend to check one. Whether the
  // workspace is actually provisioned is the server's call, and it says so.
  const ws = window._monarchWorkspace;
  const live = !!ws && (ws.status === 'active' || ws.comped);
  btn.style.display = live ? 'inline-block' : 'none';
  const count = document.querySelectorAll('#my-stores-list > div > div').length;
  btn.textContent = count
    ? `🦋 Send ${count} store${count === 1 ? '' : 's'} to the Suite`
    : '🦋 Send my stores to the Suite';
}
window.addEventListener('monarch:workspace', updateSuiteSyncButton);

/**
 * The stores that came in short of detail, gathered at the top of the list.
 *
 * A spreadsheet import fills in what it has and leaves the rest blank. Those
 * gaps used to be mentioned once in the import dialog and then never again, so
 * they sat there — no phone to ring, no address to navigate to, no certificate
 * to invoice against — until someone happened to open the store.
 */
function renderIncompleteStores(stores) {
  const host = document.getElementById('incomplete-stores');
  if (!host) return;
  const gaps = (stores || []).filter(s => (s.missing_fields || []).length);
  if (!gaps.length) { host.innerHTML = ''; return; }

  // Which gap is the most common tells the rep what their spreadsheet is
  // missing as a whole, rather than making them infer it store by store.
  const tally = {};
  gaps.forEach(s => s.missing_fields.forEach(f => { tally[f] = (tally[f] || 0) + 1; }));
  const worst = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];

  host.innerHTML = `
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:16px 18px;margin-bottom:16px;">
      <div style="font-weight:700;color:#92400e;margin-bottom:4px;">
        ⚠ ${gaps.length} store${gaps.length === 1 ? '' : 's'} ${gaps.length === 1 ? 'is' : 'are'} missing details
      </div>
      <div style="font-size:13px;color:#92400e;opacity:0.9;margin-bottom:10px;">
        ${worst ? `Most often the ${esc(worst[0])} — ${worst[1]} of them.` : ''}
        You can still sell to these; filling the gaps is what makes Navigate, Call and tax-free invoicing work.
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${gaps.slice(0, 12).map(s => `
          <button onclick="editMyStore(${s.id})"
            style="padding:7px 12px;border-radius:9px;border:1px solid #fcd34d;background:#fff;color:#92400e;font-size:12px;font-weight:700;cursor:pointer;"
            title="Missing ${escAttr(s.missing_fields.join(', '))}">
            ${esc(s.name)} <span style="font-weight:500;opacity:0.75;">— ${esc(s.missing_fields.join(', '))}</span>
          </button>`).join('')}
        ${gaps.length > 12 ? `<span style="align-self:center;font-size:12px;color:#92400e;">+ ${gaps.length - 12} more below</span>` : ''}
      </div>
    </div>`;
}

function showClaimStoreModal() {
  // Reset fields each time it opens
  ['cs-search','cs-name','cs-address','cs-city','cs-state','cs-zip','cs-phone','cs-email','cs-resale','cs-store-id'].forEach(id => {
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
    ['cs-name','cs-address','cs-city','cs-state','cs-zip','cs-phone','cs-email','cs-resale','cs-store-id'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
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
    resale_number: document.getElementById('cs-resale')?.value?.trim(),
    store_id: storeId ? parseInt(storeId) : null,
  })});
  if (result && result.success) {
    // Claims are auto-approved; a conflict comes back flagged for admin review instead.
    showToast(result.message || (result.flagged ? 'Flagged for admin review' : 'Store claimed ✓'), result.flagged ? 'info' : 'success');
    document.getElementById('claim-store-modal')?.classList.remove('active');
    ['cs-name','cs-address','cs-city','cs-state','cs-zip','cs-phone','cs-email','cs-resale','cs-store-id'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    loadMyStores();
    // Prompt for store photos only when the claim actually went through (required within 24 hours)
    if (result.needsPhotos && !result.flagged) {
      setTimeout(() => openPhotoModal(result.id, false, name), 400);
    }
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
  if (typeof Chart === 'undefined') return; // chart.js CDN unavailable — skip the chart, keep the view
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
  if (typeof Chart === 'undefined') return;
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
  if (typeof Chart === 'undefined') return;
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
  if (typeof Chart === 'undefined') return;
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
  ['stores', 'pending', 'reps', 'users', 'products', 'orders', 'inventory', 'commissions', 'store-claims', 'mail', 'activity', 'settings'].forEach(t => {
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
  if (tab === 'settings') { loadStripeStatus(); loadNotifEmails(); loadFeedbackList(); loadDbSize(); loadProgramDocs('admin-docs-gallery', true); }
  if (tab === 'mail') loadMailTab(window._mailBox || 'inbox');
  if (tab === 'activity') loadActivityLog();
}

// ==========================================
// ADMIN: PAYMENTS STATUS (Settings card)
// ==========================================
/** Answers "which Stripe account is this, and is it actually able to charge"
 *  from the dashboard — identity only, never keys. */
async function loadStripeStatus() {
  const wrap = document.getElementById('stripe-status-card');
  if (!wrap) return;
  const s = await apiFetch('/api/admin/stripe-status');
  if (!s) return;
  if (!s.configured) {
    wrap.innerHTML = `<div class="card" style="margin:0 0 18px;padding:16px 18px;">
      <div style="font-weight:700;margin-bottom:4px;">💳 Card payments</div>
      <div style="color:var(--text-muted);font-size:14px;">Off — the shop runs invoice-only. To turn cards on, add <code>STRIPE_SECRET_KEY</code> and <code>STRIPE_PUBLISHABLE_KEY</code> in Railway.</div>
    </div>`;
    return;
  }
  const live = s.mode === 'live';
  const rows = [];
  if (s.account) {
    rows.push(`<div>Stripe account: <b>${esc(s.account.email || 'email hidden by Stripe')}</b>${s.account.business_name ? ` (${esc(s.account.business_name)})` : ''}</div>`);
    rows.push(`<div style="margin-top:4px;">${s.account.charges_enabled ? '✅ Can take payments' : '❌ Charges disabled — finish Stripe onboarding'}${s.account.payouts_enabled ? ' · ✅ Payouts to bank enabled' : ' · ⚠️ Bank payouts not enabled yet'}</div>`);
  } else if (s.account_error) {
    rows.push(`<div style="color:var(--red);">${esc(s.account_error)}</div>`);
  }
  if (!s.publishable_key_set) rows.push(`<div style="color:var(--red);margin-top:4px;">⚠️ STRIPE_PUBLISHABLE_KEY is missing — the card form cannot load.</div>`);
  if (s.key_mismatch) rows.push(`<div style="color:var(--red);margin-top:4px;">⚠️ Your secret key is ${esc(s.mode)} but the publishable key is not — checkout will never succeed. Use both keys from the same mode.</div>`);
  wrap.innerHTML = `<div class="card" style="margin:0 0 18px;padding:16px 18px;">
    <div style="font-weight:700;margin-bottom:6px;">💳 Card payments
      <span style="font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;background:${live ? 'var(--green)' : '#f59e0b'};color:#fff;">${live ? 'LIVE' : 'TEST MODE'}</span>
    </div>
    <div style="font-size:14px;color:var(--text-muted);line-height:1.6;">${rows.join('')}</div>
  </div>`;
}

// ==========================================
// ADMIN: MAIL (inbox + sent)
// ==========================================
/**
 * The portal's own mailbox. Outbound is logged at the send facade so it is
 * complete by construction; inbound arrives from Resend's webhook. Bodies are
 * rendered inside a sandboxed iframe — inbox mail is stranger-controlled HTML,
 * and the sandbox (no scripts, no forms, no top-navigation) is what makes
 * reading it safe.
 */
async function loadMailTab(box) {
  window._mailBox = box;
  document.getElementById('mail-box-inbox').classList.toggle('active', box === 'inbox');
  document.getElementById('mail-box-sent').classList.toggle('active', box === 'sent');
  const list = document.getElementById('mail-list');
  list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted);">Loading…</div>';
  const data = await apiFetch(`/api/admin/mail?box=${box}`);
  if (!data) { list.innerHTML = '<div class="empty-note">Could not load mail.</div>'; return; }
  updateMailBadge(data.unread);

  const note = document.getElementById('mail-setup-note');
  if (box === 'inbox' && data.messages.length === 0) {
    note.style.display = 'block';
    note.innerHTML = 'No mail yet. Receiving needs two things in Resend: <b>Enable Receiving</b> on the addydsd.com domain (it gives you an MX record to add in GoDaddy), and a webhook for <b>email.received</b> pointing at <code>https://www.addydsd.com/api/webhooks/resend-inbound</code>.';
  } else note.style.display = 'none';

  if (data.messages.length === 0) {
    list.innerHTML = `<div style="padding:48px;text-align:center;color:var(--text-muted);">${box === 'inbox' ? '📭 Inbox is empty' : 'Nothing sent yet'}</div>`;
    return;
  }
  list.innerHTML = `<table class="data-table"><thead><tr>
      <th>${box === 'inbox' ? 'From' : 'To'}</th><th>Subject</th><th>Status</th><th>When</th>
    </tr></thead><tbody>` + data.messages.map(m => {
      const who = box === 'inbox' ? (m.from_addr || '—') : (m.to_addr || '—');
      const unread = box === 'inbox' && !m.read_at;
      const status = m.status === 'failed'
        ? `<span class="status-badge rejected" title="${escAttr(m.error || '')}">failed</span>`
        : `<span class="status-badge active">${esc(m.status)}</span>`;
      return `<tr onclick="openMailMessage(${m.id})" style="cursor:pointer;${unread ? 'font-weight:700;' : ''}">
        <td>${unread ? '● ' : ''}${esc(who)}</td>
        <td>${esc(m.subject || '(no subject)')}</td>
        <td>${status}</td>
        <td style="white-space:nowrap;">${new Date(m.created_at).toLocaleString()}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

function updateMailBadge(unread) {
  const badge = document.getElementById('mail-badge');
  if (!badge) return;
  badge.style.display = unread > 0 ? '' : 'none';
  badge.textContent = unread > 0 ? unread : '';
}

function ensureMailModal() {
  if (document.getElementById('mail-modal')) return;
  const div = document.createElement('div');
  div.innerHTML = `<div class="modal-overlay" id="mail-modal" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="max-width:720px;width:94vw;">
      <button class="close-btn" onclick="closeModal()">&times;</button>
      <div id="mail-modal-content"></div>
    </div></div>`;
  document.body.appendChild(div.firstChild);
}

async function openMailMessage(id) {
  const m = await apiFetch(`/api/admin/mail/${id}`);
  if (!m || m.error) { showToast(m && m.error ? m.error : 'Could not open message', 'error'); return; }
  ensureMailModal();
  const inbound = m.direction === 'inbound';
  // Refresh the list so the unread dot clears without a manual reload.
  if (inbound && !m.read_at) setTimeout(() => loadMailTab('inbox'), 300);

  const replyTo = inbound ? (m.from_addr || '').match(/<([^>]+)>/)?.[1] || m.from_addr || '' : '';
  let bodyHtml;
  if (m.body_html) {
    // srcdoc + sandbox with no permissions: HTML renders, scripts/forms/links-to-top do not.
    // Plain HTML-attribute escaping, NOT escAttr — escAttr JS-escapes first
    // (\" and \n), which mangles a real email body. Inside a quoted
    // attribute only & and " need encoding; the browser decodes them back
    // before parsing the iframe's document.
    const doc = String(m.body_html).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    bodyHtml = `<iframe sandbox="" srcdoc="${doc}" style="width:100%;min-height:340px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:#fff;"></iframe>`;
  } else if (m.body_text) {
    bodyHtml = `<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;background:var(--bg-2,#f8fafc);padding:14px;border-radius:8px;">${esc(m.body_text)}</pre>`;
  } else {
    bodyHtml = `<div class="empty-note">No body was stored for this message${m.error ? ` (${esc(m.error)})` : ''}.</div>`;
  }
  document.getElementById('mail-modal-content').innerHTML = `
    <h2 style="margin-right:28px;">${esc(m.subject || '(no subject)')}</h2>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px;">${inbound ? 'From' : 'To'}: <b>${esc(inbound ? (m.from_addr || '—') : (m.to_addr || '—'))}</b></div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">${new Date(m.created_at).toLocaleString()} · ${esc(m.status)}${m.error && m.status === 'failed' ? ` — ${esc(m.error)}` : ''}</div>
    ${bodyHtml}
    <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end;">
      ${inbound && replyTo ? `<button class="btn btn-green" onclick='openMailCompose(${JSON.stringify(replyTo)}, ${JSON.stringify('Re: ' + (m.subject || ''))})'>↩︎ Reply</button>` : ''}
      <button class="btn" onclick="closeModal()">Close</button>
    </div>`;
  document.getElementById('mail-modal').classList.add('active');
}

function openMailCompose(to, subject) {
  ensureMailModal();
  document.getElementById('mail-modal-content').innerHTML = `
    <h2>${to ? 'Reply' : 'New email'}</h2>
    <div class="form-group"><label>To</label><input type="email" id="mail-to" value="${escAttr(to || '')}" placeholder="who@example.com"></div>
    <div class="form-group"><label>Subject</label><input type="text" id="mail-subject" value="${escAttr(subject || '')}" maxlength="300"></div>
    <div class="form-group"><label>Message</label><textarea id="mail-body" rows="8" style="width:100%;"></textarea></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-green" id="mail-send-btn" onclick="sendMailCompose(this)">Send</button>
    </div>`;
  document.getElementById('mail-modal').classList.add('active');
  document.getElementById(to ? 'mail-body' : 'mail-to').focus();
}

async function sendMailCompose(btn) {
  btn.disabled = true;
  const r = await apiFetch('/api/admin/mail/send', {
    method: 'POST',
    body: JSON.stringify({
      to: document.getElementById('mail-to').value.trim(),
      subject: document.getElementById('mail-subject').value.trim(),
      body: document.getElementById('mail-body').value,
    }),
  });
  btn.disabled = false;
  if (r && r.success) {
    closeModal();
    showToast('Email sent ✓');
    loadMailTab('sent');
  } else {
    showToast((r && r.error) || 'Send failed', 'error');
  }
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
          <button class="btn btn-sm btn-green" onclick="showApprovePricingModal(${u.id}, '${escAttr(u.name || u.email)}', '${u.role}')">Approve</button>
          <button class="btn btn-sm btn-danger" onclick="rejectUser(${u.id}, this)">Reject</button>
        ` : `<span style="font-size:12px;color:var(--text-muted);">${u.status === 'active' ? 'Approved' : 'Rejected'}</span>`}
      </td>
    </tr>
  `).join('');
}

// ADDY rep discount options (new model). "Auto" = the automatic earn-up rate.
const PRICING_TIERS = [
  { value: 'auto',   label: 'Auto — earn-up (20% → 25% → 30% margin)' },
  { value: '20',     label: 'Lock 20% margin' },
  { value: '25',     label: 'Lock 25% margin' },
  { value: '30',     label: 'Lock 30% margin' },
  { value: '35',     label: 'Lock 35% margin' },
  { value: 'custom', label: 'Custom % (set manually below)' },
];

let _approveTargetUserId = null;
let _approveProducts = [];

async function showApprovePricingModal(userId, userName, userRole) {
  const invoiceCheckbox0 = document.getElementById('approve-can-pay-invoice');
  if (invoiceCheckbox0) invoiceCheckbox0.checked = false; // new approvals default to card-only
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

  // New DSDs start on the automatic earn-up rate
  tierSelect.value = 'auto';
  renderTierPreview('auto');

  modal.classList.add('active');
}

async function renderTierPreview(tier) {
  const previewWrap = document.getElementById('approve-price-preview');
  if (!previewWrap) return;
  if (!_approveProducts.length) { previewWrap.innerHTML = ''; return; }

  if (tier === 'custom') {
    previewWrap.innerHTML = `
      <div class="form-group" style="margin-bottom:10px;">
        <label style="font-size:12px;font-weight:600;color:var(--text);">Custom margin % <span style="font-weight:400;color:var(--text-muted);">(e.g. 28 = they buy at 72% of MSRP)</span></label>
        <input type="number" step="1" min="0" max="90" id="custom-margin-pct" placeholder="e.g. 28"
          oninput="updateCustomMarginPreview()"
          style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:14px;box-sizing:border-box;margin-top:6px;">
      </div>
      <div id="custom-margin-preview"></div>`;
    return;
  }

  const discount = tier === 'auto' ? 20 : (parseFloat(tier) || 20);
  const mult = 1 - discount / 100;
  const rows = _approveProducts.map(p => {
    const retail = parseFloat(p.retail_price || 0);
    const price = retail > 0
      ? `<span style="font-weight:700;color:var(--green);">$${(retail * mult).toFixed(2)}</span>`
      : '<span style="color:var(--text-muted);font-size:12px;">Set retail price first</span>';
    return `<div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="color:var(--text);">${esc(p.name)}</span>${price}</div>`;
  }).join('');
  const header = tier === 'auto'
    ? 'Starts at 20% margin, earns up (25% at 15 boxes, 30% at 27):'
    : `They buy at ${100 - discount}% of MSRP (${discount}% margin):`;
  previewWrap.innerHTML = `
    <p style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:8px;">${header}</p>
    ${rows || '<p style="color:var(--text-muted);font-size:13px;">No products yet</p>'}`;
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

  // Pre-fill invoice permission checkbox from this user's current setting
  const existingUser = (window._adminUsers || []).find(u => u.id === userId);
  const invoiceCheckbox = document.getElementById('approve-can-pay-invoice');
  if (invoiceCheckbox) invoiceCheckbox.checked = !!existingUser?.can_pay_invoice;

  const tierSelect = document.getElementById('approve-tier-select');
  tierSelect.innerHTML = PRICING_TIERS.map(t =>
    `<option value="${t.value}">${t.label}</option>`
  ).join('');

  // Preselect the user's current locked discount (or Auto if they're on earn-up)
  const cur = (window._adminUsers || []).find(u => u.id === userId);
  const lp = cur && cur.locked_discount_pct != null ? String(parseFloat(cur.locked_discount_pct)) : 'auto';
  const preset = ['20','25','30','35','auto'].includes(lp) ? lp : 'custom';
  tierSelect.value = preset;
  renderTierPreview(preset);
  modal.classList.add('active');
}

async function confirmApproveWithPricing() {
  const sel = document.getElementById('approve-tier-select').value;
  const btn = document.getElementById('approve-confirm-btn');
  const isApproveFlow = btn.textContent.includes('Approve');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  // Locked discount %: null = automatic earn-up. custom_margin_pct carries the lock to both endpoints.
  let lockPct = null;
  if (sel === 'custom') lockPct = parseFloat(document.getElementById('custom-margin-pct')?.value || '') || null;
  else if (sel !== 'auto') lockPct = parseFloat(sel);
  const canPayInvoice = document.getElementById('approve-can-pay-invoice')?.checked || false;
  const pricingPayload = { tier: sel, custom_margin_pct: lockPct, can_pay_invoice: canPayInvoice };

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
    tbody.innerHTML = '<tr><td colspan="13" class="loading">No stores found</td></tr>';
  } else {
    tbody.innerHTML = data.stores.map(s => `
      <tr>
        <td class="check-col"><input type="checkbox" value="${s.id}" onchange="toggleStoreSelect(${s.id}, this.checked)"></td>
        <td data-label="Store"><span style="cursor:pointer" onclick="showStoreDetail(${s.id})"><span class="status-dot ${s.status}"></span>${esc(s.name)}</span>${(() => { const m = storeMissingInfo(s); return m.length ? ` <span title="Missing: ${m.join(', ')}" style="cursor:help;">⚠️</span><button onclick="event.stopPropagation();pingStoreOwner(${s.id}, '${escAttr(s.name)}')" title="Ping the rep to fix this" style="margin-left:2px;background:none;border:none;cursor:pointer;font-size:13px;padding:0;vertical-align:middle;">📨</button>` : ''; })()}</td>
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
// ==========================================
// DISTRIBUTOR DASHBOARD
// ==========================================
let _allDistStores = [];

async function loadDSDDashboard() {
  if (!requireAuth(['dsd','member'])) return;
  renderImpersonationBanner();
  // Check for stores with pending photos and show reminder banner
  checkPhotoPendingBanner();
  checkNewProgramDocs();
  // Load user profile to show tier and commission balance
  renderOnboardingChecklist();
  const profile = await apiFetch('/api/profile');
  if (profile) {
    window._myEmail = profile.email;
    window._me = profile;
    // A human hello: "Good morning, Mark ☀️" above the overview header.
    try {
      const h1 = [...document.querySelectorAll('h1')].find(h => h.textContent.includes('My Assigned Stores'));
      if (h1 && !document.getElementById('addy-greeting')) {
        const hr = new Date().getHours();
        const [word, emoji] = hr < 5 ? ['Burning the midnight oil', '🌙'] : hr < 12 ? ['Good morning', '☀️'] : hr < 17 ? ['Good afternoon', '👋'] : ['Good evening', '🌆'];
        const first = (profile.name || '').trim().split(/\s+/)[0];
        const g = document.createElement('div');
        g.id = 'addy-greeting';
        g.style.cssText = 'font-size:14px;font-weight:600;color:var(--text-secondary);margin-bottom:2px;';
        g.textContent = `${word}${first ? ', ' + first : ''} ${emoji}`;
        h1.before(g);
      }
    } catch (e) { /* decoration */ }
    if (profile.house_partner) {
      console.log('%c\u2618 S\u00e1inte doesn\u2019t pay the bills \u2014 but 35% locked does. F\u00e1ilte, Danny.'.replace('S\u00e1inte','Sl\u00e1inte'), 'color:#169B62;font-size:13px;font-weight:700;');
    }
    renderMarginProgress(profile);
    const tierEl = document.getElementById('stat-tier');
    if (tierEl) {
      const pct = profile.discount_pct != null ? profile.discount_pct : 20;
      let label = pct + '% margin';
      if (profile.locked_discount_pct != null) label += ' (locked)';
      else label += ' · higher on pallets';
      tierEl.textContent = label;
    }
    const commEl = document.getElementById('stat-commission');
    if (commEl) {
      // Count the balance up from $0 — cents-accurate (animateCurrency rounds).
      const balNow = parseFloat(profile.commission_balance || 0);
      if (balNow > 0 && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        const t0 = performance.now(), dur = 750;
        (function tick(t) {
          const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
          commEl.textContent = '$' + (balNow * e).toFixed(2);
          if (p < 1) requestAnimationFrame(tick);
        })(t0);
      } else {
        commEl.textContent = '$' + balNow.toFixed(2);
      }
      // Sparkle when the balance grew since their last visit.
      try {
        const k = 'addy_last_bal_' + profile.id;
        const prev = parseFloat(localStorage.getItem(k));
        const now = parseFloat(profile.commission_balance || 0);
        if (Number.isFinite(prev) && now > prev + 0.004) {
          const up = document.createElement('div');
          up.textContent = `+$${(now - prev).toFixed(2)} since your last visit`;
          up.style.cssText = 'font-size:11px;font-weight:700;color:#059669;margin-top:3px;animation:addyRise 0.6s ease-out;';
          if (!document.getElementById('addy-rise-kf')) {
            const st = document.createElement('style'); st.id = 'addy-rise-kf';
            st.textContent = '@keyframes addyRise { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform:none; } }';
            document.head.appendChild(st);
          }
          commEl.after(up);
        }
        localStorage.setItem(k, String(now));
      } catch (e) { /* decoration only */ }
    }
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
  initPushNotifications();
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
  const _statW = document.getElementById('stat-avg-wholesale');
  if (_statW) _statW.textContent = formatCurrency(avgWholesale);
  const _statR = document.getElementById('stat-avg-retail');
  if (_statR) _statR.textContent = formatCurrency(avgRetail);
}

function renderDSDTable(stores) {
  const tbody = document.getElementById('stores-tbody');
  if (!stores.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">No stores assigned</td></tr>';
    return;
  }
  tbody.innerHTML = stores.map(s => `
    <tr>
      <td data-label="Store"><span class="status-dot ${s.status}"></span>${esc(s.name)}</td>
      <td data-label="Owner">${esc(s.owner_name)}</td>
      <td data-label="City">${esc(s.city)}</td>
      <td data-label="State">${esc(s.state)}</td>
      <td data-label="Category">${esc(s.category)}</td>
      <td data-label="Wholesale">${formatCurrency(s.wholesale_price)}</td>
      <td data-label="Retail">${formatCurrency(s.retail_price)}</td>
      <td class="revenue-cell" data-label="Dist. cost">${formatCurrency(s.distribution_cost)}</td>
      <td data-label="Status"><span class="status-badge ${s.status}">${s.status}</span></td>
      <td data-label=""><a href="/shop.html?store_id=${s.id}" style="display:inline-block;padding:5px 12px;background:#2563eb;color:#fff;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;">🛒 Buy</a></td>
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
  // Tier badges read pricing_tier, whose values come from PRICING_TIERS
  // ('auto', '20', '25', '30', '35', 'custom'). This map used to list role
  // names instead — with `dsd` repeated three times, so JS kept only the last
  // and every tier that DID match rendered as "Wholesale", while the real
  // values fell through to the raw string ("20", "auto"). Derive it from
  // PRICING_TIERS so the two can't drift apart again.
  const tierLabels = Object.fromEntries(PRICING_TIERS.map(t => [
    t.value,
    t.value === 'auto' ? 'Auto (earn-up)' : t.value === 'custom' ? 'Custom' : `${t.value}% locked`,
  ]));
  const tierableRoles = ['dsd', 'rep'];
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
        ${u.can_pay_invoice ? `<span style="display:inline-block;margin-left:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;background:rgba(217,119,6,0.12);color:#d97706;" title="Can pay by Invoice/Net-30">📄 Invoice</span>` : ''}
        ${u.house_partner ? `<span style="display:inline-block;margin-left:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;background:rgba(37,99,235,0.12);color:var(--accent);" title="House partner — locked 35%, earns on the network">⭐ House</span>` : ''}
        ${u.role !== 'admin' && !u.house_partner
          ? `<span style="display:inline-block;margin-left:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;background:${u.house_5pct ? 'rgba(22,163,74,0.12);color:var(--green)' : 'rgba(100,116,139,0.12);color:var(--text-muted)'};" title="What the house partner earns on this rep's orders">${u.house_5pct ? '5% grandfathered' : '2%'}</span>`
          : ''}
      </td>
      <td onclick="event.stopPropagation()">
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${u.role !== 'admin' && u.status === 'active'
            ? `<button class="btn btn-sm btn-outline" onclick="viewAsUser(${u.id})" title="Preview their dashboard">👀 View As</button>`
            : ''
          }
          ${u.role === 'dsd' && u.status === 'active'
            ? `<button class="btn btn-sm btn-outline" onclick="showAddMemberModal(${u.id}, '${escAttr(u.name || u.email)}')" title="Add member employee">+ Member</button>`
            : ''
          }
          ${u.status === 'active'
            ? `<button class="btn btn-sm btn-danger" onclick="toggleUserStatus(${u.id}, 'inactive', this)">Deactivate</button>`
            : `<button class="btn btn-sm btn-green" onclick="toggleUserStatus(${u.id}, 'active', this)">Activate</button>`
          }
          ${tierableRoles.includes(u.role)
            ? `<button class="btn btn-sm btn-outline" onclick="showChangeTierModal(${u.id}, '${escAttr(u.name || u.email)}')">Change Tier</button>`
            : ''
          }
          ${u.role !== 'admin'
            ? `<button class="btn btn-sm btn-outline" onclick="pingUser(${u.id}, '${escAttr(u.name || u.email)}')" title="Send this user a message">📨 Ping</button>`
            : ''
          }
          ${u.role === 'dsd' && !u.house_partner
            ? `<button class="btn btn-sm btn-outline" onclick="makeHousePartner(${u.id}, '${escAttr(u.name || u.email)}')" title="Lock at 35% and grandfather everyone else at 5% for them">⭐ House</button>`
            : ''
          }
          ${u.role !== 'admin' && !u.house_partner
            ? `<button class="btn btn-sm btn-outline" onclick="setHouseRate(${u.id}, '${escAttr(u.name || u.email)}', ${!u.house_5pct})" title="What the house partner earns on this rep's orders">${u.house_5pct ? '↓ Set 2%' : '↑ Grandfather 5%'}</button>`
            : ''
          }
          ${u.role === 'dsd'
            ? `<button class="btn btn-sm btn-outline" onclick="grantSuitePro(${u.id}, '${escAttr(u.name || u.email)}')" title="Comp the full Sales Suite (Pro) — no payment, no upgrade prompts">🦋 Suite Pro</button>`
            : ''
          }
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${escAttr(u.name || u.email)}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// Crown the house partner: 35% lock + grandfathers everyone else at 5% for
// them. Only visible here in the admin — the reps themselves see nothing.
async function makeHousePartner(id, name) {
  if (!confirm(`Make ${name} the house partner?\n\n• Locks their margin at 35% on every order\n• They earn 5% on every existing user's orders and their invites\n• Plus a flat 2% on all other future sales\n\nThe reps themselves are never shown any of this.`)) return;
  const r = await apiFetch(`/api/admin/users/${id}/house-partner`, { method: 'POST', body: JSON.stringify({}) });
  if (r && r.success) { showToast(`⭐ ${name} is the house partner — 35% locked`, 'success'); if (typeof loadUsersTab === 'function') loadUsersTab(); }
}

/**
 * Move a rep between the house partner's two rates.
 *
 * This only ever came from a one-shot boot migration, so anyone who joined
 * afterwards was quietly stuck at 2% with no way to grant the 5% and no way
 * to even see which they were on.
 */
async function setHouseRate(id, name, grandfathered) {
  const msg = grandfathered
    ? `Grandfather ${name} at 5%?\n\nThe house partner will earn 5% of every future order they place, instead of 2%.\n\nOrders already placed keep the rate they were made at — use Recalculate on an order to restate one.`
    : `Move ${name} back to 2%?\n\nThe house partner will earn 2% of their future orders instead of 5%.`;
  if (!confirm(msg)) return;
  const r = await apiFetch(`/api/users/${id}/house-rate`, {
    method: 'PATCH', body: JSON.stringify({ grandfathered }),
  });
  if (r && r.success) {
    showToast(`${name} → house earns ${r.rate}% on their orders`, 'success');
    if (typeof loadUsersTab === 'function') loadUsersTab();
  } else if (r && r.error) showToast(r.error, 'error');
}

// ── RECORD A PAST ORDER ───────────────────────────────────────────────────────
// Commission only ever ran inside checkout, so orders taken before the site was
// live paid nobody. This puts them on the books through the same calculation.
let _boProducts = [], _boUsers = [];

async function showBackdatedOrderModal() {
  const modal = document.getElementById('backdated-order-modal');
  if (!modal) return;
  modal.classList.add('active');
  document.getElementById('bo-error').style.display = 'none';
  document.getElementById('bo-date').valueAsDate = new Date();

  const [users, products, stores] = await Promise.all([
    apiFetch('/api/users').catch(() => []),
    apiFetch('/api/products').catch(() => []),
    apiFetch('/api/stores').catch(() => []),
  ]);
  _boUsers = (users || []).filter(u => u.role !== 'admin');
  _boProducts = (products || []);

  const userSel = document.getElementById('bo-user');
  userSel.innerHTML = _boUsers.map(u =>
    `<option value="${u.id}">${esc(u.name || u.email)} — ${esc(u.role)}</option>`).join('');
  userSel.onchange = showBackdatedRate;
  showBackdatedRate();

  // /api/stores answers { stores, total, ... } for every role, not a bare array.
  const storeList = Array.isArray(stores) ? stores : (stores?.stores || []);
  document.getElementById('bo-store').innerHTML =
    '<option value="">— no store —</option>' +
    storeList.map(st => `<option value="${st.id}">${esc(st.name)}</option>`).join('');

  document.getElementById('bo-items').innerHTML = '';
  addBackdatedLine();
}

// Say up front what this order will pay the house partner, so a wrong rate is
// caught before the order exists rather than after.
function showBackdatedRate() {
  const note = document.getElementById('bo-rate-note');
  const u = _boUsers.find(x => String(x.id) === document.getElementById('bo-user').value);
  if (!note || !u) return;
  note.textContent = u.house_partner
    ? 'This is the house partner — his own orders generate no house commission.'
    : `House partner earns ${u.house_5pct ? '5% (grandfathered)' : '2%'} of this order's total.`;
}

function addBackdatedLine() {
  const wrap = document.getElementById('bo-items');
  if (!wrap) return;
  const row = document.createElement('div');
  row.className = 'bo-line';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 70px 90px 30px;gap:6px;margin-bottom:6px;align-items:center;';
  row.innerHTML = `
    <select class="bo-p" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;">
      ${_boProducts.map(p => `<option value="${p.id}" data-price="${p.retail_price || 0}">${esc(p.name)}</option>`).join('')}
    </select>
    <input class="bo-q" type="number" min="1" step="1" value="1" placeholder="Qty" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;">
    <input class="bo-u" type="number" min="0" step="0.01" placeholder="Unit $" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;">
    <button class="btn btn-sm btn-danger" title="Remove line" style="padding:6px 9px;">×</button>`;
  row.querySelector('button').onclick = () => { row.remove(); renderBackdatedTotal(); };
  row.querySelectorAll('input, select').forEach(el => el.addEventListener('input', renderBackdatedTotal));
  wrap.appendChild(row);
  renderBackdatedTotal();
}

function backdatedLines() {
  return [...document.querySelectorAll('.bo-line')].map(r => ({
    product_id: parseInt(r.querySelector('.bo-p').value),
    quantity: parseInt(r.querySelector('.bo-q').value) || 0,
    unit_price: parseFloat(r.querySelector('.bo-u').value) || 0,
  }));
}

function renderBackdatedTotal() {
  const el = document.getElementById('bo-total');
  if (!el) return;
  const subtotal = backdatedLines().reduce((a, l) => a + l.quantity * l.unit_price, 0);
  const ship = parseFloat(document.getElementById('bo-shipping').value) || 0;
  const fee = parseFloat(document.getElementById('bo-fee').value) || 0;
  const total = subtotal + ship + fee;
  const u = _boUsers.find(x => String(x.id) === document.getElementById('bo-user')?.value);
  // Commission is on the TOTAL, shipping included — same as a live checkout.
  const rate = !u || u.house_partner ? 0 : (u.house_5pct ? 0.05 : 0.02);
  el.innerHTML = `Subtotal ${formatCurrency(subtotal)} · Shipping ${formatCurrency(ship)} · Fee ${formatCurrency(fee)}
    <strong style="float:right;">Total ${formatCurrency(total)}</strong>
    ${rate ? `<div style="margin-top:6px;font-size:12px;color:var(--text-muted);">House commission at ${rate * 100}% of the total: <strong style="color:var(--green);">${formatCurrency(total * rate)}</strong></div>` : ''}`;
}

async function submitBackdatedOrder() {
  const btn = document.getElementById('bo-submit');
  const err = document.getElementById('bo-error');
  const items = backdatedLines().filter(l => l.quantity > 0 && l.unit_price >= 0);
  err.style.display = 'none';
  if (!items.length) { err.textContent = 'Add at least one line with a quantity.'; err.style.display = 'block'; return; }
  const date = document.getElementById('bo-date').value;
  if (!date) { err.textContent = 'Set the date this order happened.'; err.style.display = 'block'; return; }

  btn.disabled = true; btn.textContent = 'Recording…';
  const r = await apiFetch('/api/admin/orders/backdated', {
    method: 'POST',
    body: JSON.stringify({
      user_id: parseInt(document.getElementById('bo-user').value),
      store_id: parseInt(document.getElementById('bo-store').value) || null,
      items,
      shipping_cost: parseFloat(document.getElementById('bo-shipping').value) || 0,
      processing_fee: parseFloat(document.getElementById('bo-fee').value) || 0,
      placed_at: new Date(date + 'T12:00:00').toISOString(),
      payment_status: document.getElementById('bo-payment').value,
      status: document.getElementById('bo-status').value,
      notes: document.getElementById('bo-notes').value.trim(),
    }),
  });
  btn.disabled = false; btn.textContent = 'Record order & pay commission';
  if (r && r.success) {
    const paid = (r.commissions || [])
      .map(c => `${c.earner_name} ${formatCurrency(c.amount)} (${Math.round(c.rate * 100)}%)`).join(', ');
    showToast(`Order #${r.order.id} recorded${paid ? ' — paid ' + paid : ' — no commission due'}`, 'success');
    document.getElementById('backdated-order-modal').classList.remove('active');
    if (typeof loadAdminOrders === 'function') loadAdminOrders();
  } else {
    err.textContent = (r && r.error) || 'Could not record that order.';
    err.style.display = 'block';
  }
}

// Comp the full Sales Suite (Pro tier) for a rep — house partners like Danny.
// Provisions their workspace on Monarch and removes every buy/upgrade prompt.
async function grantSuitePro(id, name) {
  if (!confirm(`Give ${name} the full Sales Suite (Pro) on the house?\n\n• Their workspace is created/upgraded to Pro immediately\n• No payment, and they'll never see plan pricing or upgrade prompts\n• They open it right from their dashboard — it stays inside ADDY`)) return;
  const r = await apiFetch('/api/admin/monarch/grant', { method: 'POST', body: JSON.stringify({ user_id: id, tier: 'pro' }) });
  if (r && r.success) showToast(`🦋 ${name} now has the full Sales Suite (Pro, on the house)`, 'success');
}

async function pingUser(id, name) {
  const message = prompt(`Send a message to ${name}:`, '');
  if (message === null) return;              // cancelled
  if (!message.trim()) { showToast('Message is empty', 'error'); return; }
  const r = await apiFetch(`/api/users/${id}/ping`, { method: 'POST', body: JSON.stringify({ message: message.trim() }) });
  if (r && r.success) showToast(`Message sent to ${name} ✓`, 'success');
  else if (r && r.error) showToast(r.error, 'error');
}

// Which key fields a store is missing (used to flag incomplete records in the admin table).
function storeMissingInfo(s) {
  const na = v => !v || String(v).trim() === '' || String(v).trim().toUpperCase() === 'N/A';
  const labels = [];
  if (na(s.address)) labels.push('address');
  if (na(s.city)) labels.push('city');
  if (na(s.state)) labels.push('state');
  if (na(s.zip)) labels.push('zip');
  if (na(s.email)) labels.push('email');
  if (na(s.phone)) labels.push('phone');
  return labels;
}

async function pingStoreOwner(id, name) {
  const message = prompt(`Message the rep who claimed "${name}":`, `Hi — the store "${name}" is missing some info. Please log in and update it. Thanks!`);
  if (message === null) return;
  if (!message.trim()) { showToast('Message is empty', 'error'); return; }
  const r = await apiFetch(`/api/stores/${id}/ping-owner`, { method: 'POST', body: JSON.stringify({ message: message.trim() }) });
  if (r && r.success) showToast(`Pinged the rep for "${name}" ✓`, 'success');
  else if (r && r.error) showToast(r.error, 'error');
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
          <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Margin</div>
          ${(u.role === 'dsd' || u.role === 'member') ? `
          <select onchange="setUserDiscount(${u.id}, this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;cursor:pointer;">
            <option value="" ${u.locked_discount_pct==null?'selected':''}>Auto (earn-up)</option>
            <option value="20" ${parseFloat(u.locked_discount_pct)===20?'selected':''}>20% margin (locked)</option>
            <option value="25" ${parseFloat(u.locked_discount_pct)===25?'selected':''}>25% margin (locked)</option>
            <option value="30" ${parseFloat(u.locked_discount_pct)===30?'selected':''}>30% margin (locked)</option>
            <option value="35" ${parseFloat(u.locked_discount_pct)===35?'selected':''}>35% margin (locked)</option>
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
        <button class="btn btn-danger" type="button" onclick="deleteUser(${u.id}, '${escAttr(u.name || u.email)}', true)">🗑 Delete Account</button>
        <button class="btn btn-outline" type="button" onclick="document.getElementById('user-detail-modal').classList.remove('active')">Close</button>
      </div>
    </div>
  `;
  modal.classList.add('active');
  // loadUserPricing() existed but nothing ever called it, so the Custom DSD
  // Pricing panel sat on "Loading products..." forever and per-partner price
  // overrides were unreachable from the UI.
  if (u.role === 'dsd') loadUserPricing(u.id);
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

// Horizontal progress stepper for an order's status.
function orderStatusTimeline(status) {
  if (status === 'cancelled') {
    return `<div style="background:var(--redBg,#fef2f2);color:var(--red,#dc2626);border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;font-weight:600;">✕ This order was cancelled.</div>`;
  }
  const steps = ['pending','processing','shipped','delivered'];
  const cur = Math.max(0, steps.indexOf(status));
  return `<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;">
    ${steps.map((s, i) => {
      const done = i <= cur;
      const label = s.charAt(0).toUpperCase() + s.slice(1);
      return `<div style="flex:1;text-align:center;position:relative;">
        ${i>0 ? `<div style="position:absolute;top:13px;left:-50%;width:100%;height:3px;background:${i<=cur?'#2563eb':'var(--border,#e2e8f0)'};z-index:0;"></div>` : ''}
        <div style="position:relative;z-index:1;width:28px;height:28px;margin:0 auto 6px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;background:${done?'#2563eb':'var(--bg-secondary,#eef2f7)'};color:${done?'#fff':'var(--text-muted,#94a3b8)'};border:2px solid ${done?'#2563eb':'var(--border,#e2e8f0)'};">${done?'✓':i+1}</div>
        <div style="font-size:11px;font-weight:${i===cur?'700':'500'};color:${done?'var(--text)':'var(--text-muted)'};">${label}</div>
      </div>`;
    }).join('')}
  </div>`;
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

    ${orderStatusTimeline(o.status)}

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
  // The "Total Orders" stat card on the DSD dashboard was never wired to
  // anything and sat at "--" forever. Fill it before the tbody bail-out so it
  // still updates on tabs that don't render the table.
  const ordersStat = document.getElementById('stat-total-orders');
  if (ordersStat) ordersStat.textContent = (orders || []).length;
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
      <td onclick="event.stopPropagation()" style="white-space:nowrap;">
        <button class="btn btn-sm btn-outline" style="font-size:11px;" onclick="reorderMyOrder(${o.id}, this)" title="Add the same items to your cart again">🔁 Reorder</button>
        ${inv ? `<button class="btn btn-sm btn-outline" style="font-size:11px;" onclick="openInvoice(${o.id})">📄 Invoice</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

// One-tap reorder: refill the cart with a past order's items, then jump to the
// shop. Prices are whatever the rep qualifies for TODAY (set server-side at
// add time — pallet pricing included if the quantities still add up to one).
async function reorderMyOrder(orderId, btn) {
  const o = (window._myOrders || []).find(x => x.id === orderId);
  if (!o || !o.items) return;
  const usable = o.items.filter(i => i.product_id);
  if (!usable.length) { showToast('Those products are no longer available', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  let added = 0, failed = 0;
  for (const item of usable) {
    const cart = await apiFetch('/api/cart/add', {
      method: 'POST',
      body: JSON.stringify({ product_id: item.product_id, quantity: item.quantity }),
    });
    if (cart) added++; else failed++;
  }
  if (btn) { btn.disabled = false; btn.textContent = '🔁 Reorder'; }
  if (!added) { showToast('Could not add those items — they may be out of stock', 'error'); return; }
  const skipped = (o.items.length - usable.length) + failed;
  showToast(`✓ ${added} item${added === 1 ? '' : 's'} added to your cart${skipped ? ` (${skipped} unavailable)` : ''}`, 'success');
  setTimeout(() => { window.location.href = '/shop.html'; }, 700);
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
  ['main','orders','inventory','stores','commissions','docs'].forEach(t => {
    const el = document.getElementById('my-tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (tab === 'orders') loadMyOrders('my-orders-tbody');
  if (tab === 'inventory') loadInventory();
  if (tab === 'stores') loadMyStores();
  if (tab === 'commissions') loadMyCommissions();
  if (tab === 'docs') { loadProgramDocs('docs-gallery', false); markProgramDocsSeen(); }
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


// ── FEEDBACK / FEATURE REQUESTS ──────────────────────────────────────────────
function showFeedbackModal() {
  const el = document.getElementById('feedback-message');
  if (el) el.value = '';
  document.getElementById('feedback-modal')?.classList.add('active');
}

async function submitFeedback() {
  const message = document.getElementById('feedback-message')?.value?.trim();
  if (!message) { showToast('Please enter a message', 'error'); return; }
  const result = await apiFetch('/api/feedback', { method: 'POST', body: JSON.stringify({ message }) });
  if (result && result.success) {
    showToast(result.message || 'Feedback submitted ✓', 'success');
    document.getElementById('feedback-modal')?.classList.remove('active');
    document.getElementById('feedback-message').value = '';
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

// Admin: load and manage feedback submissions
async function loadFeedbackList() {
  const el = document.getElementById('feedback-list');
  if (!el) return;
  const items = await apiFetch('/api/feedback');
  if (!items || !items.length) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);">No feedback submitted yet</div>';
    return;
  }
  const statusColors = { new: '#2563eb', reviewed: '#d97706', planned: '#7c3aed', done: '#16a34a', declined: '#64748b' };
  el.innerHTML = items.map(f => `
    <div style="display:flex;gap:16px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--border);">
      <div style="flex:1;">
        <div style="font-size:14px;color:var(--text);line-height:1.5;margin-bottom:6px;">${esc(f.message)}</div>
        <div style="font-size:12px;color:var(--text-muted);">
          ${esc(f.name || f.email || 'Unknown user')} · ${new Date(f.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <select onchange="updateFeedbackStatus(${f.id}, this.value)"
          style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:${statusColors[f.status]||'var(--text)'};font-size:12px;font-weight:600;cursor:pointer;">
          <option value="new" ${f.status==='new'?'selected':''}>New</option>
          <option value="reviewed" ${f.status==='reviewed'?'selected':''}>Reviewed</option>
          <option value="planned" ${f.status==='planned'?'selected':''}>Planned</option>
          <option value="done" ${f.status==='done'?'selected':''}>Done</option>
          <option value="declined" ${f.status==='declined'?'selected':''}>Declined</option>
        </select>
        <button class="btn btn-sm btn-danger" onclick="deleteFeedback(${f.id})" title="Delete">🗑</button>
      </div>
    </div>`).join('');
}

async function updateFeedbackStatus(id, status) {
  const result = await apiFetch('/api/feedback/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
  if (result && result.success) showToast('Status updated ✓', 'success');
}

async function deleteFeedback(id) {
  if (!confirm('Delete this feedback item?')) return;
  const result = await apiFetch('/api/feedback/' + id, { method: 'DELETE' });
  if (result && result.success) { showToast('Deleted', 'info'); loadFeedbackList(); }
}


// ── ACTIVITY LOG ──────────────────────────────────────────────────────────────
async function loadActivityLog() {
  const el = document.getElementById('activity-log-list');
  if (!el) return;
  const logs = await apiFetch('/api/activity-log');
  if (!logs || !logs.length) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">No activity recorded yet</div>';
    return;
  }
  const actionLabels = {
    approved_store_claim: '✅ Approved store claim', rejected_store_claim: '❌ Rejected store claim',
    claimed_store: '🏪 Store claimed', requested_ownership: '🔄 Ownership requested',
    approved_ownership_transfer: '✅ Ownership transferred', rejected_ownership_transfer: '❌ Ownership request rejected',
    created_dsd: '➕ DSD added by admin', refunded_order: '💳 Refunded order',
    submitted_feedback: '💡 Feedback submitted', imported_products: '⬇ Imported products',
    pricing_updated: '💲 Pricing updated',
  };
  el.innerHTML = `<div style="max-height:600px;overflow-y:auto;">` + logs.map(log => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 24px;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-size:14px;color:var(--text);font-weight:600;">${esc(actionLabels[log.action] || log.action)}</div>
        ${log.target_name ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">${esc(log.target_name)}</div>` : ''}
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">by ${esc(log.user_email)}</div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;">${new Date(log.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</div>
    </div>`).join('') + `</div>`;
}

// ── CSV EXPORTS ───────────────────────────────────────────────────────────────
function exportOrdersCSV() {
  const token = localStorage.getItem('addy_token');
  window.open(`/api/export/orders-csv?token=${token}`, '_blank');
}

function exportCommissionsCSV() {
  const token = localStorage.getItem('addy_token');
  window.open(`/api/export/commissions-csv?token=${token}`, '_blank');
}


// ── DATABASE SIZE ─────────────────────────────────────────────────────────────
async function loadDbSize() {
  const el = document.getElementById('db-size-content');
  if (!el) return;
  el.innerHTML = '<div class="loading" style="padding:8px 0;">Loading...</div>';
  const data = await apiFetch('/api/admin/db-size');
  if (!data || !data.total_size) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Could not load database size</div>';
    return;
  }
  const gbUsed = data.total_bytes / (1024*1024*1024);
  const percentOfGb = Math.min((gbUsed / 1).toFixed(1) * 100, 999);
  const barColor = gbUsed < 0.5 ? '#16a34a' : gbUsed < 0.8 ? '#d97706' : '#dc2626';

  el.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:14px;">
      <span style="font-size:28px;font-weight:800;color:var(--text);">${data.total_size}</span>
      <span style="font-size:13px;color:var(--text-muted);">total database size</span>
    </div>
    <div style="height:8px;background:var(--bg-secondary);border-radius:4px;overflow:hidden;margin-bottom:16px;">
      <div style="height:100%;width:${Math.min(percentOfGb,100)}%;background:${barColor};border-radius:4px;"></div>
    </div>
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px;">Largest Tables</div>
    ${(data.top_tables||[]).map(t => `
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;">
        <span style="color:var(--text-secondary);">${esc(t.table_name)}</span>
        <span style="color:var(--text);font-weight:600;">${esc(t.size)}</span>
      </div>`).join('')}
  `;
}


// ── MEMBER (CHILD) ACCOUNTS ───────────────────────────────────────────────────
async function showAddMemberModal(parentId, parentName) {
  const modal = document.getElementById('add-member-modal');
  if (!modal) return;
  document.getElementById('member-parent-id').value = parentId;
  document.getElementById('member-parent-name').textContent = parentName;
  ['member-name','member-email','member-phone','member-password'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  modal.classList.add('active');
}

async function submitAddMember() {
  const name = document.getElementById('member-name')?.value?.trim();
  const email = document.getElementById('member-email')?.value?.trim();
  const password = document.getElementById('member-password')?.value;
  const phone = document.getElementById('member-phone')?.value?.trim();
  const parent_id = parseInt(document.getElementById('member-parent-id')?.value);
  if (!name || !email || !password) { showToast('Name, email and password are required', 'error'); return; }
  const result = await apiFetch('/api/members', {
    method: 'POST',
    body: JSON.stringify({ name, email, password, phone, parent_id })
  });
  if (result && result.success) {
    showToast('Member account created ✓', 'success');
    document.getElementById('add-member-modal')?.classList.remove('active');
    loadUsersTab();
  } else if (result?.error) {
    showToast(result.error, 'error');
  }
}


// ── STORE PHOTO UPLOAD ────────────────────────────────────────────────────────
let _photoStoreId = null;
let _photoIsBulk = false;
let _photoStoreName = '';
let _photoAlreadyDeferred = false;
let _photoPending = { front: null, display: null };
let _photoUploaded = { front: false, display: false };

// Called right after a store is claimed or when a store with pending photos is opened
window.openPhotoModal = function(storeId, isBulk = false, storeName = '', alreadyDeferred = false) {
  _photoStoreId = storeId;
  _photoIsBulk = isBulk;
  _photoPending = { front: null, display: null };
  _photoUploaded = { front: false, display: false };

  const modal = document.getElementById('store-photo-modal');
  if (!modal) return;

  // The arrival nudge has done its job once this is open.
  document.getElementById('photo-arrival-prompt')?.remove();

  _photoStoreName = storeName || 'this store';
  _photoAlreadyDeferred = !!alreadyDeferred;

  const subtitle = document.getElementById('photo-modal-subtitle');
  if (subtitle) {
    subtitle.textContent = isBulk
      ? `You have 60 days to upload photos for ${_photoStoreName}.`
      : `Take both photos while you're at ${_photoStoreName}, or set a deadline below.`;
  }

  // The deferral is offered for every claim, because a rep entering stores from
  // home genuinely cannot take these photos — that used to be a dead end with
  // no way past the modal, so the store never got entered at all. It is only
  // hidden once this store has already used its one deferral.
  const skipWrap = document.getElementById('photo-skip-wrap');
  if (skipWrap) skipWrap.style.display = 'block';
  const deferBtn = document.getElementById('photo-defer-btn');
  if (deferBtn) {
    deferBtn.disabled = false;
    deferBtn.textContent = _photoAlreadyDeferred ? '🚫 Skip — photos still due' : '🚫 Not at the store? Skip for now';
  }

  // Reset previews and statuses
  ['front','display'].forEach(type => {
    const preview = document.getElementById(`preview-${type}`);
    const status = document.getElementById(`${type}-status`);
    const btn = document.getElementById(`btn-${type}`);
    if (preview) { preview.style.display='none'; preview.src=''; }
    if (status) status.textContent = '';
    if (btn) btn.textContent = '📷 Take / Upload Photo';
    const zone = document.getElementById(`photo-${type}-zone`);
    if (zone) zone.style.borderColor = 'var(--border)';
  });

  document.getElementById('photo-modal-error').style.display = 'none';
  document.getElementById('submit-photos-btn').disabled = true;
  modal.style.display = 'block';
};

window.updateDeferButton = function() {
  const agree = document.getElementById('photo-defer-agree');
  const btn = document.getElementById('photo-defer-btn');
  if (btn) btn.disabled = !agree?.checked;
};

/**
 * Take the 30-day deadline instead of the photos.
 *
 * This has to reach the server. The old version only hid the modal, so the
 * store kept whatever deadline it was given at claim time — 24 hours for a
 * manual claim — and a rep who "skipped" was overdue by the next morning.
 */
/**
 * The ✕ / "Skip for now" on the photo modal. One tap, no checkbox ceremony:
 * the rep is never blocked from entering a store, and skipping changes no
 * deadline — photos_due_at has been ticking since the claim. If this store
 * already used its formal deferral, the button simply closes the modal (the
 * old behavior was a modal with NO exit at all, which trapped the rep on
 * their own dashboard).
 */
window.skipStorePhotos = async function() {
  const modal = document.getElementById('store-photo-modal');
  if (!_photoAlreadyDeferred && _photoStoreId) {
    try {
      const result = await apiFetch(`/api/stores/${_photoStoreId}/photos/defer`, {
        method: 'POST',
        body: JSON.stringify({ agreed: true }),
      });
      if (result && result.success) {
        const due = new Date(result.photos_due_at).toLocaleDateString();
        showToast(`Store added ✓ Photos due by ${due} — we'll remind you when you're there.`, 'success');
      }
    } catch (e) { /* skipping must never block — the deadline is server-side either way */ }
  }
  if (modal) modal.style.display = 'none';
  if (typeof loadMyStores === 'function') loadMyStores();
  checkPhotoPendingBanner();
};

window.deferStorePhotos = async function() {
  const btn = document.getElementById('photo-defer-btn');
  const errEl = document.getElementById('photo-modal-error');
  const agree = document.getElementById('photo-defer-agree');
  if (!agree?.checked) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (errEl) errEl.style.display = 'none';
  try {
    const result = await apiFetch(`/api/stores/${_photoStoreId}/photos/defer`, {
      method: 'POST',
      body: JSON.stringify({ agreed: true }),
    });
    if (!result || !result.success) throw new Error(result?.error || 'Could not save that.');
    const modal = document.getElementById('store-photo-modal');
    if (modal) modal.style.display = 'none';
    const due = new Date(result.photos_due_at).toLocaleDateString();
    showToast(`Store added ✓ Photos due by ${due} — we'll remind you when you're there.`, 'success');
    if (typeof loadMyStores === 'function') loadMyStores();
    checkPhotoPendingBanner();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Add store now, photos later'; }
  }
};

window.handlePhotoSelect = function(type, input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById(`${type}-status`);
  if (status) status.textContent = 'Compressing…';

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Compress via Canvas — max 900px wide, JPEG quality 0.72 → ~20-40KB
      const MAX = 900;
      let w = img.width, h = img.height;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);

      _photoPending[type] = dataUrl;

      // Show preview
      const preview = document.getElementById(`preview-${type}`);
      if (preview) { preview.src = dataUrl; preview.style.display = 'block'; }
      const zone = document.getElementById(`photo-${type}-zone`);
      if (zone) zone.style.borderColor = 'var(--green)';
      const btn = document.getElementById(`btn-${type}`);
      if (btn) btn.textContent = '🔄 Replace Photo';
      if (status) status.textContent = `✓ Ready (${Math.round(dataUrl.length / 1024)}KB)`;

      // Enable submit if both photos are ready or already uploaded
      updateSubmitBtn();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
};

function updateSubmitBtn() {
  const btn = document.getElementById('submit-photos-btn');
  if (!btn) return;
  const frontReady = _photoUploaded.front || !!_photoPending.front;
  const displayReady = _photoUploaded.display || !!_photoPending.display;
  btn.disabled = !(frontReady && displayReady);
}

window.submitStorePhotos = async function() {
  const btn = document.getElementById('submit-photos-btn');
  const errEl = document.getElementById('photo-modal-error');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  errEl.style.display = 'none';

  try {
    for (const type of ['front', 'display']) {
      if (!_photoPending[type]) continue; // already uploaded, skip
      const result = await apiFetch(`/api/stores/${_photoStoreId}/photos`, {
        method: 'POST',
        body: JSON.stringify({ photo_type: type, photo_data: _photoPending[type] })
      });
      if (!result || !result.success) throw new Error(result?.error || `Failed to upload ${type} photo`);
      _photoUploaded[type] = true;
      _photoPending[type] = null;
    }

    // Both uploaded
    const modal = document.getElementById('store-photo-modal');
    if (modal) modal.style.display = 'none';
    showToast('✓ Store photos uploaded successfully!', 'success');

    // Refresh stores list to remove reminder
    if (typeof loadDSDStores === 'function') loadDSDStores();
    checkPhotoPendingBanner(); // re-check banner

  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Submit Photos';
  }
};

// ── PHOTO REMINDER BANNER (for bulk/overdue stores) ───────────────────────────
async function checkPhotoPendingBanner() {
  const pending = await apiFetch('/api/my-stores/photos-pending');
  const existing = document.getElementById('photo-reminder-banner');
  if (existing) existing.remove();
  // Nothing owed any more: clear the banner and stop watching location, rather
  // than leaving a stale warning up after the last photo lands.
  if (!pending || pending.length === 0) { _arrivalStores = []; stopArrivalWatch(); return; }

  const overdue = pending.filter(s => s.overdue);
  const upcoming = pending.filter(s => !s.overdue);

  const banner = document.createElement('div');
  banner.id = 'photo-reminder-banner';
  banner.style.cssText = `
    background:#dc2626;color:#fff;padding:12px 20px;
    display:flex;align-items:center;justify-content:space-between;
    gap:16px;font-size:13px;font-weight:600;`;

  let msg = '';
  if (overdue.length > 0) {
    msg = `⚠️ ${overdue.length} store${overdue.length>1?'s':''} ha${overdue.length>1?'ve':'s'} OVERDUE photos — upload now to keep your account in good standing.`;
  } else {
    msg = `📸 ${upcoming.length} store${upcoming.length>1?'s':''} still need${upcoming.length>1?'':'s'} photos — deadline: ${new Date(upcoming[0].photos_due_at).toLocaleDateString()}.`;
  }

  const first = pending[0];
  banner.innerHTML = `
    <span>${msg}</span>
    <div style="display:flex;gap:8px;flex-shrink:0;">
      <button onclick="openPhotoModal(${first.id},${first.claimed_via === 'csv_bulk'},'${escAttr(first.name || '')}',${!!first.photos_deferred_at})"
        style="background:#fff;color:#dc2626;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">
        Upload Now
      </button>
      <button id="photo-geo-optin" onclick="enablePhotoArrivalReminders()"
        style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;display:none;">
        📍 Remind me at the store
      </button>
      <button onclick="this.closest('#photo-reminder-banner').style.display='none'"
        style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;">✕</button>
    </div>`;

  // Insert at top of dashboard (after any existing impersonation banner)
  const mainContent = document.querySelector('.dashboard') || document.body;
  mainContent.insertBefore(banner, mainContent.firstChild);

  startPhotoArrivalWatch(pending);
}

// ── "YOU'RE AT THE STORE" REMINDER ────────────────────────────────────────────
/**
 * A rep who deferred photos is reminded at the one moment they can actually
 * act on it: standing at the store. The banner alone is easy to dismiss from
 * the couch and useless there — this fires where the photo can be taken.
 *
 * Location is never requested unprompted. We only ask after a tap on the
 * opt-in button, and only when photos are actually owed; a rep who is square
 * is never asked for location at all.
 */
const ARRIVAL_RADIUS_M = 200;   // GPS on a phone is good to ~10-50m; 200m covers a parking lot.
// Leaving is a wider ring than arriving on purpose. With a single boundary,
// GPS jitter around 200m would read as leave-arrive-leave and fire the prompt
// over and over while the rep stands still in the parking lot.
const ARRIVAL_EXIT_M = 400;
let _arrivalWatchId = null;
let _arrivalStores = [];
let _arrivalInside = new Set();

function metersBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}


async function startPhotoArrivalWatch(pending) {
  if (!('geolocation' in navigator) || !window.isSecureContext) return;
  _arrivalStores = pending.filter(s => !s.photos_complete);
  if (!_arrivalStores.length) { stopArrivalWatch(); return; }
  // Already watching: the list above is refreshed, just place any new stores.
  if (_arrivalWatchId !== null) { geocodePendingStores(); return; }

  // Only auto-start if location was already granted — otherwise show the opt-in.
  let granted = false;
  try {
    const st = await navigator.permissions?.query({ name: 'geolocation' });
    granted = st?.state === 'granted';
  } catch (e) { /* Safari lacks the Permissions API for geolocation */ }

  if (granted) { beginArrivalWatch(); return; }
  const optIn = document.getElementById('photo-geo-optin');
  if (optIn) optIn.style.display = 'inline-block';
}

window.enablePhotoArrivalReminders = function() {
  const optIn = document.getElementById('photo-geo-optin');
  if (optIn) optIn.textContent = '📍 Locating…';
  beginArrivalWatch(() => {
    if (optIn) optIn.style.display = 'none';
    showToast("Got it — we'll remind you when you're at a store that needs photos.", 'success');
  }, () => {
    if (optIn) optIn.textContent = '📍 Location blocked';
  });
};

function beginArrivalWatch(onOk, onFail) {
  if (_arrivalWatchId !== null) return;
  _arrivalWatchId = navigator.geolocation.watchPosition(
    (pos) => { if (onOk) { onOk(); onOk = null; } onArrivalPosition(pos); },
    (err) => {
      // Only a refusal is permanent. A lost fix — underpass, parking garage,
      // a moment between towers — is routine on a delivery route, and tearing
      // the watch down for one would silently end the reminders for the rest
      // of the day. watchPosition recovers on its own; let it.
      if (err && err.code !== err.PERMISSION_DENIED) return;
      if (onFail) onFail();
      stopArrivalWatch();
    },
    // maximumAge 0: a geofence needs the position now, not one cached from
    // half a minute ago. A stale fix means arriving at a store — or leaving
    // one, which is what re-arms the next visit — goes unnoticed.
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
  geocodePendingStores();
}

function stopArrivalWatch() {
  if (_arrivalWatchId !== null) navigator.geolocation.clearWatch(_arrivalWatchId);
  _arrivalWatchId = null;
  _arrivalInside.clear();
}

/**
 * Fires on arrival, every visit — a rep who drives past the same store three
 * times this week is asked three times, because each visit is a fresh chance
 * to take the photo.
 *
 * "Every visit" is not "every GPS reading": position updates land every few
 * seconds, so the prompt would be unusable if it repeated on each one. A store
 * is remembered as entered until the rep is well clear of it, and only then can
 * it prompt again.
 */
function onArrivalPosition(pos) {
  const { latitude, longitude } = pos.coords;
  let prompted = false;
  for (const s of _arrivalStores) {
    if (s.latitude == null || s.longitude == null) continue;
    const away = metersBetween(latitude, longitude, s.latitude, s.longitude);
    if (away > ARRIVAL_EXIT_M) { _arrivalInside.delete(s.id); continue; }  // left — re-arm
    if (away > ARRIVAL_RADIUS_M) continue;                                 // in the gap, no change
    if (_arrivalInside.has(s.id)) continue;                                // still here from last time
    _arrivalInside.add(s.id);
    if (!prompted) { showArrivalPrompt(s); prompted = true; }              // one prompt at a time
  }
}

function showArrivalPrompt(store) {
  document.getElementById('photo-arrival-prompt')?.remove();
  const el = document.createElement('div');
  el.id = 'photo-arrival-prompt';
  // Below the photo modal (9999), never over it — this prompt's whole job is to
  // open that modal, so it must not then sit on top blocking every control.
  el.style.cssText = `
    position:fixed;left:16px;right:16px;bottom:20px;z-index:9990;max-width:420px;margin:0 auto;
    background:var(--bg-card,#fff);border:2px solid #16a34a;border-radius:14px;padding:18px;
    box-shadow:0 12px 32px rgba(0,0,0,0.28);`;
  el.innerHTML = `
    <div style="font-weight:800;margin-bottom:4px;">📍 You're at ${esc(store.name || 'a store')}</div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;">
      This store still needs its photos. Two minutes now and it's done.
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-green" style="flex:1;"
        onclick="document.getElementById('photo-arrival-prompt').remove();openPhotoModal(${store.id},false,'${escAttr(store.name || '')}',${!!store.photos_deferred_at})">
        📷 Take photos
      </button>
      <button class="btn btn-outline" onclick="document.getElementById('photo-arrival-prompt').remove()">Not now</button>
    </div>`;
  document.body.appendChild(el);
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

/**
 * Fill in coordinates for pending stores that have none, so the check above has
 * something to compare against. Nominatim asks for no more than one request a
 * second; results are cached on the store so this runs at most once per store.
 */
async function geocodePendingStores() {
  for (const s of _arrivalStores) {
    if (s.latitude != null && s.longitude != null) continue;
    const parts = [s.address, s.city, s.state, s.zip, 'USA'].filter(Boolean);
    if (parts.length < 3) continue;   // too vague to place accurately
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
        + encodeURIComponent(parts.join(', ')), { headers: { 'Accept': 'application/json' } });
      const data = await r.json();
      if (data && data[0]) {
        s.latitude = parseFloat(data[0].lat);
        s.longitude = parseFloat(data[0].lon);
        await apiFetch(`/api/stores/${s.id}/geo`, {
          method: 'POST',
          body: JSON.stringify({ latitude: s.latitude, longitude: s.longitude }),
        }).catch(() => {});
      }
      await new Promise(res => setTimeout(res, 1100));
    } catch (e) { /* a store we can't place just never triggers the reminder */ }
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

// ============================================================
// PROGRAM DOCUMENTS — reps view; admins manage
// ============================================================
const DOC_ICONS = {
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.8 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.8-3.8-9S9.5 5.5 12 3Z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
  arrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12l7 7 7-7"/></svg>',
};

async function loadProgramDocs(containerId, manage) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '<div class="loading" style="padding:40px;">Loading…</div>';
  let docs = [];
  try { docs = await apiFetch('/api/program-documents') || []; } catch (e) { docs = []; }

  const uploader = manage ? `
    <div class="doc-upload-card">
      <div style="flex:1;min-width:200px;">
        <input type="text" id="doc-title" placeholder="Document title (e.g. Pricing Sheet)" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:14px;box-sizing:border-box;">
        <div id="doc-upload-status" style="font-size:12px;color:var(--text-muted);margin-top:6px;"></div>
      </div>
      <input type="file" id="doc-file" accept="image/*" style="display:none;" onchange="stageProgramDoc(this)">
      <button class="btn btn-outline btn-sm" onclick="document.getElementById('doc-file').click()" style="white-space:nowrap;">🖼 Choose image</button>
      <button class="btn btn-sm" id="doc-upload-btn" onclick="uploadProgramDoc()" disabled style="white-space:nowrap;">Upload</button>
    </div>` : '';

  if (!docs.length) {
    el.innerHTML = uploader + `<div style="text-align:center;padding:48px 20px;color:var(--text-muted);">
      <div style="font-size:44px;margin-bottom:12px;">📄</div>
      <p style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">No documents yet</p>
      <p style="font-size:13px;">${manage ? 'Upload flyers and pricing sheets above — reps will see them in their Program Docs tab.' : 'Program flyers and pricing sheets will appear here soon.'}</p>
    </div>`;
    return;
  }

  el.innerHTML = uploader + `<div class="docs-grid">${docs.map((d, i) => `
    <div class="doc-card">
      <div class="doc-thumb" onclick="openDocLightbox(${d.id})"><img src="${d.image_data}" alt="${esc(d.title)}" loading="lazy"></div>
      <div class="doc-meta">
        <span class="doc-title" title="${esc(d.title)}">${esc(d.title)}</span>
        ${manage
          ? `<div class="doc-actions">
               <button class="doc-act doc-act-icon" onclick="moveProgramDoc(${d.id}, -1)" title="Move earlier" ${i === 0 ? 'disabled' : ''}>${DOC_ICONS.arrowUp}</button>
               <button class="doc-act doc-act-icon" onclick="moveProgramDoc(${d.id}, 1)" title="Move later" ${i === docs.length - 1 ? 'disabled' : ''}>${DOC_ICONS.arrowDown}</button>
               <button class="doc-act" onclick="renameProgramDoc(${d.id})" title="Rename">${DOC_ICONS.pencil}<span>Rename</span></button>
               <button class="doc-act ${d.is_public ? 'is-public' : ''}" onclick="toggleDocPublic(${d.id}, ${d.is_public ? 'false' : 'true'})" title="${d.is_public ? 'Visible on the public landing page — click to hide' : 'Hidden from the public site — click to show'}">${d.is_public ? DOC_ICONS.globe : DOC_ICONS.lock}<span>${d.is_public ? 'Public' : 'Hidden'}</span></button>
               <button class="doc-act doc-act-icon danger" onclick="deleteProgramDoc(${d.id}, '${escAttr(d.title)}')" title="Delete">${DOC_ICONS.trash}</button>
             </div>`
          : `<div class="doc-actions"><button class="doc-act" onclick="openDocLightbox(${d.id})">${DOC_ICONS.eye}<span>View</span></button></div>`}
      </div>
    </div>`).join('')}</div>`;
  window._programDocs = docs;
}

function openDocLightbox(id) {
  const d = (window._programDocs || []).find(x => x.id === id);
  if (!d) return;
  let lb = document.getElementById('doc-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'doc-lightbox';
    lb.className = 'doc-lightbox';
    lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('doc-lb-close')) lb.classList.remove('active'); });
    document.body.appendChild(lb);
  }
  lb.innerHTML = `
    <div class="doc-lb-bar">
      <span>${esc(d.title)}</span>
      <div style="display:flex;gap:8px;">
        <a class="doc-lb-btn" href="${d.image_data}" download="${esc(d.title).replace(/[^a-z0-9]+/gi,'-')}.jpg">⬇ Download</a>
        <button class="doc-lb-btn doc-lb-close">✕ Close</button>
      </div>
    </div>
    <div class="doc-lb-img-wrap"><img src="${d.image_data}" alt="${esc(d.title)}"></div>`;
  lb.classList.add('active');
}

let _docPending = null;
function stageProgramDoc(input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('doc-upload-status');
  if (status) status.textContent = 'Compressing…';
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Compress: max 1600px on the long edge, JPEG 0.82 — keeps flyers readable, small.
      const MAX = 1600;
      let w = img.width, h = img.height;
      if (Math.max(w, h) > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      _docPending = canvas.toDataURL('image/jpeg', 0.82);
      const kb = Math.round(_docPending.length / 1024);
      if (status) status.textContent = `✓ Ready (${kb}KB)`;
      const btn = document.getElementById('doc-upload-btn');
      if (btn) btn.disabled = false;
      const titleEl = document.getElementById('doc-title');
      if (titleEl && !titleEl.value.trim()) titleEl.value = file.name.replace(/\.[^.]+$/, '');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function uploadProgramDoc() {
  const title = (document.getElementById('doc-title')?.value || '').trim();
  if (!title) { showToast('Give the document a title', 'error'); return; }
  if (!_docPending) { showToast('Choose an image first', 'error'); return; }
  const btn = document.getElementById('doc-upload-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  const r = await apiFetch('/api/program-documents', { method: 'POST', body: JSON.stringify({ title, image_data: _docPending }) });
  if (r && r.id) {
    showToast('Document added ✓', 'success');
    _docPending = null;
    loadProgramDocs('admin-docs-gallery', true);
  } else if (btn) { btn.disabled = false; btn.textContent = 'Upload'; }
}

async function deleteProgramDoc(id, title) {
  if (!confirm(`Delete "${title}"? Reps will no longer see it.`)) return;
  const r = await apiFetch(`/api/program-documents/${id}`, { method: 'DELETE' });
  if (r && r.success) { showToast('Deleted', 'success'); loadProgramDocs('admin-docs-gallery', true); }
}

async function toggleDocPublic(id, makePublic) {
  const r = await apiFetch(`/api/program-documents/${id}`, { method: 'PATCH', body: JSON.stringify({ is_public: makePublic }) });
  if (r && r.success) { showToast(makePublic ? 'Now showing on the landing page' : 'Hidden from the public site', 'success'); loadProgramDocs('admin-docs-gallery', true); }
}

async function renameProgramDoc(id) {
  const doc = (window._programDocs || []).find(x => x.id === id);
  const current = doc ? doc.title : '';
  const next = prompt('Rename this document:', current);
  if (next === null) return;                       // cancelled
  const title = next.trim();
  if (!title) { showToast('Give the document a title', 'error'); return; }
  if (title === current) return;                   // no change
  const r = await apiFetch(`/api/program-documents/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
  if (r && r.success) { showToast('Renamed ✓', 'success'); loadProgramDocs('admin-docs-gallery', true); }
}

// Reorder the flyers: move a doc one slot earlier (-1) or later (+1). Sends the
// whole new id order so sort_order is always clean and consecutive.
async function moveProgramDoc(id, dir) {
  const docs = (window._programDocs || []).slice();
  const i = docs.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= docs.length) return;
  [docs[i], docs[j]] = [docs[j], docs[i]];       // swap
  window._programDocs = docs;                     // optimistic
  const r = await apiFetch('/api/program-documents/reorder', {
    method: 'POST', body: JSON.stringify({ ids: docs.map(d => d.id) }),
  });
  if (r && r.success) loadProgramDocs('admin-docs-gallery', true);
  else loadProgramDocs('admin-docs-gallery', true); // reload either way to reflect truth
}

// "New" badge on the Program Docs tab: count docs added since the rep last
// opened the tab (tracked per-device in localStorage). The meta endpoint is
// image-free so this is cheap to run on every dashboard load.
async function checkNewProgramDocs() {
  const badge = document.getElementById('docs-new-badge');
  if (!badge) return;
  let docs = [];
  try { docs = await apiFetch('/api/program-documents/meta') || []; } catch (e) { return; }
  const seen = Number(localStorage.getItem('addy_docs_seen_ts') || 0);
  const unseen = docs.filter(d => new Date(d.created_at).getTime() > seen).length;
  if (unseen > 0) {
    badge.textContent = unseen > 9 ? '9+' : String(unseen);
    badge.style.display = 'inline';
    window._latestDocTs = Math.max(0, ...docs.map(d => new Date(d.created_at).getTime()));
  } else {
    badge.style.display = 'none';
  }
}

function markProgramDocsSeen() {
  // Stamp "seen" at the newest doc's time (or now) and clear the badge.
  const ts = window._latestDocTs || Date.now();
  localStorage.setItem('addy_docs_seen_ts', String(ts));
  const badge = document.getElementById('docs-new-badge');
  if (badge) badge.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// Monarch butterflies 🦋 — click the "Monarch" name under the logo and a small
// kaleidoscope of monarchs bursts out. One of them lands on the ADDY logo,
// rests with a slow wingbeat, then lifts off and sails off-screen.
// Pure CSS/WAAPI — GPU-composited transforms only, honors reduced-motion.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const WING_L = 'M30.5 30 C26 13 9 4 5 11 C1 18 11 30 29 34.5 Z M29.5 35 C16 34 5 43 8.5 51 C12 58.5 26 52 30.5 38 Z';
  const WING_R = 'M33.5 30 C38 13 55 4 59 11 C63 18 53 30 35 34.5 Z M34.5 35 C48 34 59 43 55.5 51 C52 58.5 38 52 33.5 38 Z';

  function butterflySvg(size, hueShift) {
    const orange = hueShift ? `hsl(${28 + hueShift}, 78%, 57%)` : '#E8873B';
    const dim = hueShift ? `hsl(${28 + hueShift}, 62%, 42%)` : '#B96A2C';
    return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" style="overflow:visible;display:block;">
      <g class="bfly-l" style="transform-origin:31px 33px;"><path d="${WING_L}" fill="${orange}" stroke="${dim}" stroke-width="1"/></g>
      <g class="bfly-r" style="transform-origin:33px 33px;"><path d="${WING_R}" fill="${orange}" stroke="${dim}" stroke-width="1"/></g>
      <ellipse cx="32" cy="36.5" rx="2.4" ry="10.5" fill="#4a301c"/>
      <circle cx="32" cy="24" r="2.7" fill="#4a301c"/>
    </svg>`;
  }

  function injectButterflyStyles() {
    if (document.getElementById('bfly-styles')) return;
    const st = document.createElement('style');
    st.id = 'bfly-styles';
    st.textContent = `
      .bfly { position: fixed; z-index: 9999; pointer-events: none; will-change: transform; left: 0; top: 0; }
      .bfly .bfly-l { animation: bflyFlapL 0.16s ease-in-out infinite alternate; }
      .bfly .bfly-r { animation: bflyFlapR 0.16s ease-in-out infinite alternate; }
      .bfly.bfly-rest .bfly-l { animation: bflyFlapL 1.4s ease-in-out infinite alternate; }
      .bfly.bfly-rest .bfly-r { animation: bflyFlapR 1.4s ease-in-out infinite alternate; }
      @keyframes bflyFlapL { from { transform: scaleX(1); } to { transform: scaleX(0.25); } }
      @keyframes bflyFlapR { from { transform: scaleX(1); } to { transform: scaleX(0.25); } }
    `;
    document.head.appendChild(st);
  }

  /** A smooth curved flight from (x0,y0) to (x1,y1) with a random arc. */
  function flightKeyframes(x0, y0, x1, y1, wobble) {
    const mx = (x0 + x1) / 2 + (Math.random() - 0.5) * wobble;
    const my = Math.min(y0, y1) - (60 + Math.random() * 140); // arc upward
    const frames = [];
    const STEPS = 24;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      // Quadratic bezier point
      const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1;
      const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * my + t * t * y1;
      // Heading (derivative) for a natural bank into the turn
      const dx = 2 * (1 - t) * (mx - x0) + 2 * t * (x1 - mx);
      const dy = 2 * (1 - t) * (my - y0) + 2 * t * (y1 - my);
      const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90; // svg faces up
      frames.push({ transform: `translate(${x}px, ${y}px) rotate(${Math.max(-40, Math.min(40, angle * 0.35))}deg)` });
    }
    return frames;
  }

  function spawnButterfly(x, y, size, hueShift) {
    const el = document.createElement('div');
    el.className = 'bfly';
    el.innerHTML = butterflySvg(size, hueShift);
    el.style.transform = `translate(${x}px, ${y}px)`;
    document.body.appendChild(el);
    return el;
  }

  /**
   * A touch of season in everyone's flock: green for St. Patrick's Day,
   * red & green in Christmas week, red-white-blue on the 4th of July.
   * The rest of the year, classic monarch orange.
   */
  function seasonalHue(i) {
    const now = new Date(), m = now.getMonth() + 1, d = now.getDate();
    if (m === 3 && d === 17) return 112;                        // ☘ everyone's Irish today
    if (m === 12 && d >= 20 && d <= 26) return i % 2 ? 112 : 332; // 🎄 red & green
    if (m === 7 && d === 4) return [332, 190, 212][i % 3];        // 🎆
    return (Math.random() - 0.5) * 16;
  }

  /**
   * Celebration flight — a small kaleidoscope rises from an element (or the
   * bottom of the screen) and fans out over the top edge. Used for placed
   * orders and finished onboarding; anyone can call window.monarchCelebrate().
   */
  window.monarchCelebrate = function (originEl) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    injectButterflyStyles();
    const W = window.innerWidth, H = window.innerHeight;
    let ox = W / 2, oy = H - 40;
    if (originEl && originEl.getBoundingClientRect) {
      const r = originEl.getBoundingClientRect();
      ox = r.left + r.width / 2; oy = r.top + r.height / 2;
    }
    const irish = !!(window._me && window._me.house_partner);
    for (let i = 0; i < 7; i++) {
      const ex = (W / 8) + (i / 6) * (W * 0.75) + (Math.random() - 0.5) * 80;
      const hue = irish && i === 3 ? 112 : seasonalHue(i);
      const el = spawnButterfly(ox - 14, oy - 14, 20 + Math.random() * 12, hue);
      const anim = el.animate(flightKeyframes(ox - 14, oy - 14, ex, -110, 260), {
        duration: 1700 + Math.random() * 1100,
        delay: i * 110,
        easing: 'cubic-bezier(0.4, 0.05, 0.5, 0.95)',
        fill: 'forwards',
      });
      anim.onfinish = () => el.remove();
    }
  };

  window.monarchButterflies = function (sourceEl) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    injectButterflyStyles();
    const src = sourceEl.getBoundingClientRect();
    const sx = src.left + src.width / 2, sy = src.top + src.height / 2;
    const logoImg = document.querySelector('#logo-container img');
    const logo = logoImg ? logoImg.getBoundingClientRect() : { right: sx + 40, top: sy - 40, width: 100 };
    const W = window.innerWidth, H = window.innerHeight;

    // The flock: scatter off-screen in different directions.
    const exits = [
      [W + 80, -80], [W * 0.7, -100], [-90, H * 0.15], [W + 90, H * 0.35],
    ];
    const irish = !!(window._me && window._me.house_partner);
    exits.forEach(([ex, ey], i) => {
      // The house partner's flock always carries one emerald monarch. \u2618
      const hue = irish && i === 2 ? 112 : seasonalHue(i);
      const el = spawnButterfly(sx - 14, sy - 14, 22 + Math.random() * 10, hue);
      const anim = el.animate(flightKeyframes(sx - 14, sy - 14, ex, ey, 300), {
        duration: 1900 + Math.random() * 900,
        delay: i * 90,
        easing: 'cubic-bezier(0.45, 0.05, 0.55, 0.95)',
        fill: 'forwards',
      });
      anim.onfinish = () => el.remove();
    });

    // The hero: flies up to the logo, lands on its top edge, rests with a
    // slow wingbeat, then lifts off and sails away.
    const landX = logo.right - logo.width * 0.25 - 16, landY = logo.top - 20;
    const hero = spawnButterfly(sx - 16, sy - 16, 30, 0);
    const toLogo = hero.animate(flightKeyframes(sx - 16, sy - 16, landX, landY, 160), {
      duration: 1500, easing: 'cubic-bezier(0.4, 0.1, 0.3, 1)', fill: 'forwards',
    });
    toLogo.onfinish = () => {
      hero.classList.add('bfly-rest'); // slow, contented wingbeat
      setTimeout(() => {
        hero.classList.remove('bfly-rest');
        const off = hero.animate(flightKeyframes(landX, landY, W + 120, -120, 220), {
          duration: 1700, easing: 'cubic-bezier(0.5, 0, 0.7, 0.4)', fill: 'forwards',
        });
        off.onfinish = () => hero.remove();
      }, 1600);
    };
  };

  // The word "Monarch" in the brand credit is the trigger — delegated, since
  // renderLogo() rebuilds that markup on every page boot.
  document.addEventListener('click', (e) => {
    const strong = e.target.closest('#monarch-brand-credit strong');
    if (!strong) return;
    e.preventDefault();
    e.stopPropagation();
    monarchButterflies(strong);
  }, true);
})();

// ── A private bit of Ireland ────────────────────────────────────────────────
// Triple-click the MY MARGIN tile and, if you're the house partner, a handful
// of shamrocks tumble out. Nobody else's account does this.
(function () {
  let clicks = 0, timer = null;
  document.addEventListener('click', (e) => {
    const tile = e.target.closest('#stat-tier');
    if (!tile || !(window._me && window._me.house_partner)) return;
    clicks++;
    clearTimeout(timer);
    timer = setTimeout(() => { clicks = 0; }, 900);
    if (clicks < 3) return;
    clicks = 0;
    const r = tile.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < 14; i++) {
      const sh = document.createElement('div');
      sh.textContent = '\u2618';
      sh.style.cssText = `position:fixed;left:0;top:0;z-index:9999;pointer-events:none;font-size:${14 + Math.random() * 14}px;color:hsl(${135 + Math.random() * 25}, ${55 + Math.random() * 25}%, ${32 + Math.random() * 18}%);will-change:transform;`;
      document.body.appendChild(sh);
      const dx = (Math.random() - 0.5) * 380;
      const rise = 80 + Math.random() * 160, fall = 240 + Math.random() * 200;
      const spin = (Math.random() - 0.5) * 720;
      const anim = sh.animate([
        { transform: `translate(${cx}px, ${cy}px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${cx + dx * 0.6}px, ${cy - rise}px) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${cx + dx}px, ${cy + fall}px) rotate(${spin}deg)`, opacity: 0 },
      ], { duration: 1400 + Math.random() * 700, easing: 'cubic-bezier(0.3, 0.2, 0.6, 1)', fill: 'forwards' });
      anim.onfinish = () => sh.remove();
    }
  }, true);
})();

// ── Small flights (shared style with the butterflies: WAAPI, self-cleaning,
//    reduced-motion aware, wrapped so decoration can never break a flow) ──
function addyPaperPlane() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const btn = document.querySelector('button[onclick="copyReferralLink()"]');
    const r = btn ? btn.getBoundingClientRect() : { left: innerWidth / 2, top: 80, width: 0, height: 0 };
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const plane = document.createElement('div');
    plane.textContent = '✈️';
    plane.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;pointer-events:none;font-size:22px;will-change:transform;';
    document.body.appendChild(plane);
    const x1 = innerWidth + 90, y1 = -70, mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 110;
    const frames = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1;
      const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * my + t * t * y1;
      frames.push({ transform: `translate(${x}px, ${y}px) rotate(${-8 + t * 14}deg)` });
    }
    const anim = plane.animate(frames, { duration: 1300, easing: 'cubic-bezier(0.35, 0.1, 0.45, 1)', fill: 'forwards' });
    anim.onfinish = () => plane.remove();
  } catch (e) { /* decoration */ }
}

function addyCashFlight() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const src = document.getElementById('stat-commission') || document.body;
    const r = src.getBoundingClientRect();
    const cx = r.left + r.width / 2 || innerWidth / 2, cy = r.top || innerHeight / 2;
    for (let i = 0; i < 6; i++) {
      const bill = document.createElement('div');
      bill.textContent = '💸';
      bill.style.cssText = `position:fixed;left:0;top:0;z-index:9999;pointer-events:none;font-size:${17 + Math.random() * 10}px;will-change:transform;`;
      document.body.appendChild(bill);
      const dx = (Math.random() - 0.5) * 260, rise = 140 + Math.random() * 180;
      const anim = bill.animate([
        { transform: `translate(${cx}px, ${cy}px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${cx + dx}px, ${cy - rise}px) rotate(${(Math.random() - 0.5) * 300}deg)`, opacity: 0 },
      ], { duration: 1100 + Math.random() * 600, delay: i * 70, easing: 'cubic-bezier(0.3, 0.2, 0.5, 1)', fill: 'both' });
      anim.onfinish = () => bill.remove();
    }
  } catch (e) { /* decoration */ }
}

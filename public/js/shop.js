// Shop page logic

let _products = [];
let _cart = { items: [], total: 0 };
let _role = '';
let _canPayInvoice = false;
let _userId = null;
let _currentStoreId = null;
let _selectedPayment = 'card';
let _storeAddress = null;
let _minOrderBoxes = 1;   // 3 for first orders and pallet-locked reps
let _myRate = 20;         // % off store cost (locked rate or 20 base)

async function initShop() {
  const token = localStorage.getItem('addy_token');
  if (!token) { window.location.href = '/login.html'; return; }

  const me = await apiFetch('/api/me');
  if (!me) { window.location.href = '/login.html'; return; }
  window._me = me;
  try {
  _role = me.role;
  _userId = me.id;
  _canPayInvoice = !!me.can_pay_invoice;
  _minOrderBoxes = me.min_order_boxes || 1;
  _myRate = me.discount_pct != null ? me.discount_pct : 20;

  // Hide Invoice/Net-30 payment option entirely for accounts not approved for it.
  // Actual default-selection logic happens in initPayment() once Stripe's state is known.
  const invoiceOption = document.getElementById('pay-invoice');
  if (invoiceOption && !_canPayInvoice) {
    invoiceOption.style.display = 'none';
    // Center the remaining Card option since it's now the only choice
    document.getElementById('payment-options-wrap')?.classList.add('single-option');
  }

  // Set dashboard link
  const roleMap = { admin: 'admin', investor: 'investor', dsd: 'owner', dsd: 'dsd', rep: 'rep' };
  const token2 = token;
  document.getElementById('dashboard-link').href = `/dashboard-${roleMap[_role]}.html?t=${token2}`;

  const roleLabels = { dsd: 'DSD', dsd: 'DSD', rep: 'DSD', admin: 'Admin' };
  document.getElementById('user-role').textContent = roleLabels[_role] || _role;
  document.getElementById('user-role').className = `role-badge ${_role}`;

  initTheme();
  renderLogo(document.getElementById('logo-container'));

  if (_role === 'dsd') {
    document.getElementById('shop-subtitle').textContent = 'Your prices are set per your dsd agreement';
    // prefill shipping from store
    const data = await apiFetch('/api/stores');
    if (data && data.stores && data.stores[0]) {
      _storeAddress = data.stores[0];
    }
  }

  // DSDs always order for themselves — store selector removed
  // (reps handle store fulfilment independently after receiving their shipment)

  if (_role === 'dsd') {
    // Auto-select store from URL param
    const urlStoreId = new URLSearchParams(window.location.search).get('store_id');
    if (urlStoreId) {
      _currentStoreId = parseInt(urlStoreId);
      const data = await apiFetch('/api/stores');
      if (data && data.stores) {
        _storeAddress = data.stores.find(s => s.id === _currentStoreId) || null;
      }
    }
  }

  await loadProducts();
  await loadCart();
  updateShoppingForBanner();
  } catch(initErr) {
    console.error('Shop init error:', initErr.message);
    const grid = document.getElementById('products-grid');
    if (grid) grid.innerHTML = '<p style="color:var(--text-muted);font-size:14px;padding:32px;">Something went wrong loading the shop. Please refresh the page.</p>';
  }

function updateShoppingForBanner() {
  const banner = document.getElementById('shopping-for-banner');
  const nameEl = document.getElementById('shopping-for-name');
  const subEl = document.getElementById('shopping-for-sub');
  if (!banner) return;
  if (_currentStoreId && _storeAddress) {
    nameEl.textContent = `Shopping for: ${_storeAddress.name}`;
    subEl.textContent = `${_storeAddress.city || ''} ${_storeAddress.state || ''} · ${_storeAddress.category || ''}`.trim();
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}
}

async function loadProducts() {
  const products = await apiFetch('/api/products');
  _products = products || [];
  renderPalletBar();
  renderProducts();
  await initPayment();
  checkReorderIntent(); // Show low stock reorder modal if coming from inventory
}

// ── PALLET ORDERING ──────────────────────────────────────────────────────────
// Half pallet = 15 master boxes (5 of each type) → automatic 25% off.
// Full pallet = 27 master boxes (9 of each type) → automatic 30% off.
// "Classic mix" adds the even split in one tap; "Build your own" opens a
// mix-and-match builder that must land exactly on the pallet size. The
// discount itself is applied server-side the moment the cart holds enough
// boxes — these are just fast ways to get there.
// Hand-drawn pallet icons (SVG) — the emoji squares looked cheap on the cards.
const PALLET_ICONS = {
  single: `<svg viewBox="0 0 48 48" fill="none"><rect x="12" y="12" width="24" height="24" rx="2" fill="#5B9BF8" stroke="#0D1B38" stroke-width="1.6"/><path d="M12 20h24" stroke="#0D1B38" stroke-width="1.4"/><path d="M22 12v8" stroke="#0D1B38" stroke-width="1.4"/><path d="M26 12v8" stroke="#0D1B38" stroke-width="1.4"/><rect x="19" y="26" width="10" height="5" rx="1" fill="#DCEBFF"/></svg>`,
  starter: `<svg viewBox="0 0 48 48" fill="none"><rect x="8" y="24" width="15" height="14" rx="1.5" fill="#5B9BF8" stroke="#0D1B38" stroke-width="1.5"/><rect x="25" y="24" width="15" height="14" rx="1.5" fill="#3D7BE0" stroke="#0D1B38" stroke-width="1.5"/><rect x="16" y="9" width="15" height="14" rx="1.5" fill="#8FC0FF" stroke="#0D1B38" stroke-width="1.5"/><path d="M23.5 9v5" stroke="#0D1B38" stroke-width="1.3"/><path d="M15.5 24v5" stroke="#0D1B38" stroke-width="1.3"/><path d="M32.5 24v5" stroke="#0D1B38" stroke-width="1.3"/></svg>`,
  half: `<svg viewBox="0 0 48 48" fill="none"><rect x="6" y="38" width="36" height="3" rx="1" fill="#33507E"/><rect x="9" y="34" width="7" height="4" fill="#33507E"/><rect x="20.5" y="34" width="7" height="4" fill="#33507E"/><rect x="32" y="34" width="7" height="4" fill="#33507E"/><rect x="7" y="22" width="11" height="11" rx="1.5" fill="#5B9BF8" stroke="#0D1B38" stroke-width="1.5"/><rect x="19" y="22" width="11" height="11" rx="1.5" fill="#3D7BE0" stroke="#0D1B38" stroke-width="1.5"/><rect x="31" y="22" width="11" height="11" rx="1.5" fill="#5B9BF8" stroke="#0D1B38" stroke-width="1.5"/><rect x="13" y="10" width="11" height="11" rx="1.5" fill="#8FC0FF" stroke="#0D1B38" stroke-width="1.5"/></svg>`,
  full: `<svg viewBox="0 0 48 48" fill="none"><rect x="6" y="38" width="36" height="3" rx="1" fill="#33507E"/><rect x="9" y="34" width="7" height="4" fill="#33507E"/><rect x="20.5" y="34" width="7" height="4" fill="#33507E"/><rect x="32" y="34" width="7" height="4" fill="#33507E"/><rect x="7" y="22" width="11" height="11" rx="1.5" fill="#3D7BE0" stroke="#0D1B38" stroke-width="1.5"/><rect x="19" y="22" width="11" height="11" rx="1.5" fill="#5B9BF8" stroke="#0D1B38" stroke-width="1.5"/><rect x="31" y="22" width="11" height="11" rx="1.5" fill="#3D7BE0" stroke="#0D1B38" stroke-width="1.5"/><rect x="7" y="10" width="11" height="11" rx="1.5" fill="#8FC0FF" stroke="#0D1B38" stroke-width="1.5"/><rect x="19" y="10" width="11" height="11" rx="1.5" fill="#5B9BF8" stroke="#0D1B38" stroke-width="1.5"/><rect x="31" y="10" width="11" height="11" rx="1.5" fill="#8FC0FF" stroke="#0D1B38" stroke-width="1.5"/></svg>`,
};
const PALLETS = {
  starter: { label: '3 Master Boxes', sub: 'Your minimum order', boxes: 3, each: 1, pct: null, icon: 'starter' },
  half: { label: 'Half Pallet', sub: '15 master boxes · FREE shipping', boxes: 15, each: 5, pct: 25, icon: 'half' },
  full: { label: 'Full Pallet', sub: '27 master boxes · FREE shipping', boxes: 27, each: 9, pct: 30, icon: 'full' },
};
const BOX_TYPE_LABELS = { shots: 'Shots', blister_card: 'Capsules', gummies: 'Gummies' };

// ── Shipping (mirrors server.js — the server is the source of truth) ────────
// Free when: half/full pallet (15+ boxes), or the order includes a capsules
// master box (blister cards). Otherwise zone-rated from Arizona by state.
const CAPSULE_BOX_TYPE = 'blister_card';
const SHIPPING_ZONES = [
  { price: 15, states: ['AZ'] },
  { price: 25, states: ['CA', 'NV', 'UT', 'NM', 'CO', 'OR', 'WA', 'ID', 'WY', 'MT', 'TX'] },
  { price: 35, states: ['OK', 'KS', 'NE', 'SD', 'ND', 'MN', 'IA', 'MO', 'AR', 'LA', 'WI', 'IL', 'IN', 'MI', 'OH', 'KY', 'TN', 'MS', 'AL'] },
  { price: 45, states: ['FL', 'GA', 'SC', 'NC', 'VA', 'WV', 'MD', 'DE', 'PA', 'NJ', 'NY', 'CT', 'RI', 'MA', 'VT', 'NH', 'ME', 'DC'] },
  { price: 60, states: ['AK', 'HI'] },
];
function shippingForState(state) {
  const st = String(state || '').trim().toUpperCase();
  for (const z of SHIPPING_ZONES) if (z.states.includes(st)) return z.price;
  return 35;
}
function cartShipsFree() {
  const items = _cart.items || [];
  if (!items.length) return false;
  if (items.every(i => _products.find(p => p.id === i.product_id)?.free_shipping)) return true;
  const boxes = items.filter(i => i.box_type).reduce((a, i) => a + i.quantity, 0);
  if (boxes >= 6) return true; // unadvertised — don't mention this rule in copy
  return items.some(i => i.box_type === CAPSULE_BOX_TYPE);
}
function currentShipping() {
  if (cartShipsFree()) return 0;
  return shippingForState(document.getElementById('ship-state')?.value);
}

function boxProducts() {
  return _products.filter(p => p.box_type && p.active === 1 && p.my_price != null && !isNaN(parseFloat(p.my_price)));
}

function renderPalletBar() {
  const bar = document.getElementById('pallet-bar');
  if (!bar) return;
  if (_role === 'admin' || !boxProducts().length) { bar.innerHTML = ''; return; }
  // The 3-box starter card only shows when it matters: first order, or a
  // pallet-locked rep whose minimum is 3 boxes.
  PALLETS.starter.boxes = Math.max(2, _minOrderBoxes);
  PALLETS.starter.label = `${PALLETS.starter.boxes} Master Boxes`;
  const kinds = Object.entries(PALLETS).filter(([kind]) => kind !== 'starter' || _minOrderBoxes >= 2);
  // Reps at the 20% tier (min order 1) get a "custom master box" card instead
  // of the 3-box starter: one box, packed the way they ask.
  const singleCard = _minOrderBoxes < 2 ? `
        <div class="pallet-card starter">
          <span class="pallet-badge">${_myRate}% margin</span>
          <div class="pallet-head">
            <span class="pallet-icon">${PALLET_ICONS.single}</span>
            <div>
              <div class="pallet-title">1 Master Box</div>
              <div class="pallet-sub">Your minimum order · packed your way</div>
            </div>
          </div>
          <div class="pallet-actions">
            <button class="btn-pallet primary" onclick="openSingleBoxModal()">Pick &amp; customize</button>
            <button class="btn-pallet" onclick="document.getElementById('products-grid').scrollIntoView({behavior:'smooth'})">Browse boxes</button>
          </div>
        </div>` : '';
  bar.innerHTML = `
    <div class="pallet-bar">
      ${singleCard}
      ${kinds.map(([kind, P]) => `
        <div class="pallet-card ${kind}">
          <span class="pallet-badge">${Math.max(_myRate, P.pct || 0)}% margin</span>
          <div class="pallet-head">
            <span class="pallet-icon">${PALLET_ICONS[P.icon] || PALLET_ICONS.starter}</span>
            <div>
              <div class="pallet-title">${P.label}</div>
              <div class="pallet-sub">${P.sub}</div>
            </div>
          </div>
          <div class="pallet-actions">
            ${kind === 'starter' && P.boxes !== 3
              ? `<button class="btn-pallet primary" onclick="openPalletBuilder('${kind}')">Pick your ${P.boxes} boxes</button>
            <button class="btn-pallet" onclick="document.getElementById('products-grid').scrollIntoView({behavior:'smooth'})">Browse boxes</button>`
              : `<button class="btn-pallet primary" onclick="addClassicPallet('${kind}')">Classic mix — ${P.each} of each</button>
            <button class="btn-pallet" onclick="openPalletBuilder('${kind}')">Build your own</button>`}
          </div>
        </div>`).join('')}
    </div>
    <div class="pallet-note">${_myRate >= 30
      ? `Your margin is locked at ${_myRate}% on every order — any mix of products.`
      : `Your margin is set by order size: single boxes ${_myRate}% · ${PALLETS.half.boxes}+ boxes ${Math.max(_myRate, PALLETS.half.pct)}% · ${PALLETS.full.boxes}+ boxes ${Math.max(_myRate, PALLETS.full.pct)}%. Applied automatically, any mix of products.`}${_minOrderBoxes >= 2 ? ` Minimum order: ${_minOrderBoxes} master boxes.` : ' Minimum order: 1 master box — customizable.'} Pallets ship FREE — so does any order with a capsules master box.</div>`;
}

async function addClassicPallet(kind) {
  const P = PALLETS[kind];
  const byType = {};
  for (const p of boxProducts()) {
    if (!byType[p.box_type] && p.stock >= P.each) byType[p.box_type] = p;
  }
  const types = Object.keys(BOX_TYPE_LABELS);
  const missing = types.filter(t => !byType[t]);
  if (missing.length) {
    showToast('Not enough stock for the classic mix — build your own instead', 'error');
    openPalletBuilder(kind);
    return;
  }
  document.querySelectorAll('.btn-pallet').forEach(b => b.disabled = true);
  try {
    let cart = null;
    for (const t of types) {
      const body = { product_id: byType[t].id, quantity: P.each };
      if (_currentStoreId) body.store_id = _currentStoreId;
      cart = await apiFetch('/api/cart/add', { method: 'POST', body: JSON.stringify(body) });
    }
    if (cart) { _cart = cart; renderCart(); }
    showToast(`${P.label} added to cart ✓`, 'success');
  } finally {
    document.querySelectorAll('.btn-pallet').forEach(b => b.disabled = false);
  }
}

// ── CUSTOM SINGLE MASTER BOX (20% tier, min order 1) ────────────────────────
// Pick which box, and optionally tell us how to pack it — the note rides
// along to checkout's order notes so the warehouse packs it custom.
let _customBoxNote = '';

function openSingleBoxModal() {
  let modal = document.getElementById('single-box-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'single-box-modal';
    modal.className = 'modal-overlay';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
    document.body.appendChild(modal);
  }
  const opts = boxProducts().map((p, i) => `
    <label class="pb-row" style="cursor:pointer;">
      <div class="pb-info" style="display:flex;align-items:center;gap:10px;">
        <input type="radio" name="sb-pick" value="${p.id}" ${i === 0 ? 'checked' : ''} style="width:auto;accent-color:#2563eb;">
        <div>
          <div class="pb-name">${esc(p.name)}</div>
          <div class="pb-meta">${BOX_TYPE_LABELS[p.box_type] || esc(p.box_type)} · $${parseFloat(p.my_price).toFixed(2)}/box · ${p.stock} in stock</div>
        </div>
      </div>
    </label>`).join('');
  modal.innerHTML = `
    <div class="modal" style="max-width:520px;">
      <button class="close-btn" onclick="document.getElementById('single-box-modal').classList.remove('active')">&times;</button>
      <h2>📦 Your master box</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Pick a box — and if you want a custom mix inside, tell us how to pack it.</p>
      ${opts || '<p style="color:var(--text-muted);">No boxes available.</p>'}
      <div class="form-group" style="margin-top:14px;">
        <label>Custom mix (optional)</label>
        <textarea id="sb-note" rows="2" placeholder="e.g. half shots, half gummies — we'll pack it your way" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;font-size:14px;resize:vertical;"></textarea>
      </div>
      <button class="checkout-btn" id="sb-add-btn" onclick="addSingleBox()">Add to cart</button>
    </div>`;
  modal.classList.add('active');
}

async function addSingleBox() {
  const pick = document.querySelector('input[name="sb-pick"]:checked');
  if (!pick) { showToast('Pick a box first', 'error'); return; }
  const btn = document.getElementById('sb-add-btn');
  btn.disabled = true; btn.textContent = 'Adding…';
  const note = (document.getElementById('sb-note')?.value || '').trim();
  const body = { product_id: parseInt(pick.value), quantity: 1 };
  if (_currentStoreId) body.store_id = _currentStoreId;
  const cart = await apiFetch('/api/cart/add', { method: 'POST', body: JSON.stringify(body) });
  btn.disabled = false; btn.textContent = 'Add to cart';
  if (!cart) return;
  _cart = cart; renderCart();
  if (note) { _customBoxNote = note; showToast('📦 Box added — custom mix noted for packing', 'success'); }
  else showToast('📦 Box added to cart', 'success');
  document.getElementById('single-box-modal').classList.remove('active');
}

let _builderKind = null, _builderQty = {};

function openPalletBuilder(kind) {
  const P = PALLETS[kind];
  _builderKind = kind;
  _builderQty = {};
  let modal = document.getElementById('pallet-builder-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pallet-builder-modal';
    modal.className = 'modal-overlay';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
    document.body.appendChild(modal);
  }
  const rows = boxProducts().map(p => `
    <div class="pb-row">
      <div class="pb-info">
        <div class="pb-name">${esc(p.name)}</div>
        <div class="pb-meta">${BOX_TYPE_LABELS[p.box_type] || esc(p.box_type)} · $${parseFloat(p.my_price).toFixed(2)}/box · ${p.stock} in stock</div>
      </div>
      <div class="pb-stepper">
        <button onclick="pbStep(${p.id}, -1)">−</button>
        <span id="pb-qty-${p.id}">0</span>
        <button onclick="pbStep(${p.id}, 1)">+</button>
      </div>
    </div>`).join('');
  modal.innerHTML = `
    <div class="modal" style="max-width:520px;">
      <button class="close-btn" onclick="document.getElementById('pallet-builder-modal').classList.remove('active')">&times;</button>
      <h2><span class="modal-pallet-icon">${PALLET_ICONS[P.icon] || PALLET_ICONS.starter}</span>Build your ${P.label.toLowerCase()}</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">
        Pick any mix of master boxes totaling exactly <strong>${P.boxes}</strong>${P.pct ? ` — the ${P.pct}% pallet price applies automatically` : ''}.</p>
      <div class="pb-progress-wrap">
        <div class="pb-progress"><div id="pb-progress-fill" style="width:0%;"></div></div>
        <div class="pb-count"><span id="pb-count">0</span> / ${P.boxes} boxes</div>
      </div>
      ${rows || '<p style="color:var(--text-muted);">No box products available.</p>'}
      <button class="checkout-btn" id="pb-add-btn" disabled onclick="palletBuilderAdd()" style="margin-top:16px;">Select ${P.boxes} boxes</button>
    </div>`;
  modal.classList.add('active');
}

function pbStep(productId, delta) {
  const P = PALLETS[_builderKind];
  const p = _products.find(x => x.id === productId);
  if (!p) return;
  const cur = _builderQty[productId] || 0;
  const totalNow = Object.values(_builderQty).reduce((a, b) => a + b, 0);
  let next = cur + delta;
  if (next < 0) next = 0;
  if (next > p.stock) { showToast(`Only ${p.stock} in stock`, 'error'); next = p.stock; }
  if (delta > 0 && totalNow >= P.boxes) { showToast(`That's the full ${P.boxes} — remove one to swap`, 'error'); return; }
  _builderQty[productId] = next;
  document.getElementById(`pb-qty-${productId}`).textContent = next;
  const total = Object.values(_builderQty).reduce((a, b) => a + b, 0);
  document.getElementById('pb-count').textContent = total;
  document.getElementById('pb-progress-fill').style.width = `${Math.min(100, (total / P.boxes) * 100)}%`;
  const btn = document.getElementById('pb-add-btn');
  btn.disabled = total !== P.boxes;
  btn.textContent = total === P.boxes
    ? `Add ${P.label.toLowerCase()} to cart${P.pct ? ` — ${P.pct}% margin` : ''}`
    : total < P.boxes ? `${P.boxes - total} more box${P.boxes - total === 1 ? '' : 'es'} to go` : `Select ${P.boxes} boxes`;
}

async function palletBuilderAdd() {
  const P = PALLETS[_builderKind];
  const picks = Object.entries(_builderQty).filter(([, q]) => q > 0);
  const btn = document.getElementById('pb-add-btn');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    let cart = null;
    for (const [pid, qty] of picks) {
      const body = { product_id: parseInt(pid), quantity: qty };
      if (_currentStoreId) body.store_id = _currentStoreId;
      cart = await apiFetch('/api/cart/add', { method: 'POST', body: JSON.stringify(body) });
    }
    if (cart) { _cart = cart; renderCart(); }
    document.getElementById('pallet-builder-modal').classList.remove('active');
    showToast(`${P.label} added to cart ✓`, 'success');
  } catch (e) {
    btn.disabled = false; btn.textContent = `Add ${P.label.toLowerCase()} to cart${P.pct ? ` — ${P.pct}% margin` : ''}`;
  }
}

function renderProducts() {
  const grid = document.getElementById('products-grid');
  if (!_products.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);font-size:14px;">No products available.</p>';
    return;
  }
  grid.innerHTML = _products.map((p, i) => {
    try {
    const isComingSoon = p.active === 2;
    const price = p.my_price !== null && p.my_price !== undefined ? `$${parseFloat(p.my_price || 0).toFixed(2)}` : 'No price set';
    const hasPrice = p.my_price !== null && p.my_price !== undefined && !isNaN(parseFloat(p.my_price));
    const stockClass = (p.stock || 0) < 20 ? 'low' : '';
    const safeImgUrl = (p.image_url || '').trim();

    const imgContent = safeImgUrl
      ? `<img class="product-img" src="${safeImgUrl}" alt="${esc(p.name || '')}" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.remove('loaded');this.style.display='none';">`
      : '';
    const fallback = `<div class="product-img-placeholder"><span>📦</span><p>${esc(p.name || 'Product')}</p></div>`;
    const comingSoonOverlay = isComingSoon ? `
      <div class="coming-soon-overlay">
        <span style="font-size:28px;">🔜</span>
        <span class="coming-soon-badge-pill">Coming Soon</span>
        ${p.preorder_count > 0 ? `<span style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:2px;">${p.preorder_count} interested</span>` : ''}
      </div>` : '';

    const imgEl = `<div class="product-img-wrap" style="position:relative;">${imgContent}${fallback}${comingSoonOverlay}</div>`;

    const actionArea = isComingSoon ? `
      <button class="btn-notify ${p.user_preordered ? 'notified' : ''}"
        id="notify-btn-${p.id}"
        onclick="${p.user_preordered ? '' : `notifyMe(${p.id})`}"
        ${p.user_preordered ? 'disabled' : ''}>
        ${p.user_preordered ? "✓ You're on the list" : '🔔 Notify Me When Available'}
      </button>` : `
      <div class="product-price">${price}</div>
      <div class="product-stock ${stockClass}">${p.stock > 0 ? `${p.stock.toLocaleString()} in stock` : '⚠ Out of stock'}</div>
      <div class="qty-row">
        <button class="qty-btn" onclick="changeQty(${p.id}, -1)">−</button>
        <input class="qty-input" type="number" id="qty-${p.id}" value="1" min="1" max="${p.stock}" step="1"
          oninput="validateQtyInput(this, ${p.id})"
          onkeydown="if(['e','E','+','-','.'].includes(event.key)) event.preventDefault()">
        <button class="qty-btn" onclick="changeQty(${p.id}, 1)">+</button>
      </div>
      <button class="add-btn" onclick="addToCart(${p.id})" ${!hasPrice || p.stock === 0 ? 'disabled' : ''}>${!hasPrice ? 'No Price Set' : p.stock === 0 ? 'Out of Stock' : 'Add to Cart'}</button>`;

    return `
      <div class="product-card table-row-anim" style="animation-delay:${i * 40}ms">
        ${imgEl}
        <div class="product-body">
          <div class="product-name">${esc(p.name)}</div>
          ${p.sku ? `<div class="product-sku">SKU: ${esc(p.sku)}</div>` : ''}
          <div class="product-desc">${esc(p.description || '')}</div>
          <div style="margin-top:auto;">${actionArea}</div>
        </div>
      </div>
    `;
    } catch(productErr) {
      console.error('Error rendering product:', p?.id, productErr?.message);
      return `<div class="product-card" style="display:flex;align-items:center;justify-content:center;min-height:200px;color:var(--text-muted);font-size:13px;padding:16px;">Unable to display product</div>`;
    }
  }).join('');
}

async function notifyMe(productId) {
  const btn = document.getElementById(`notify-btn-${productId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  const result = await apiFetch('/api/preorders', { method: 'POST', body: JSON.stringify({ product_id: productId }) });
  if (result && result.success) {
    if (btn) { btn.classList.add('notified'); btn.textContent = "✓ You're on the list"; }
    showToast("You're on the list! We'll email you when it's available.", 'success');
    const p = _products.find(x => x.id === productId);
    if (p) { p.user_preordered = true; p.preorder_count = (p.preorder_count || 0) + 1; }
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Notify Me When Available'; }
    showToast('Something went wrong. Try again.', 'error');
  }
}

// ── LOW STOCK REORDER ─────────────────────────────────────────────────────────
let _pendingReorderItems = [];

function checkReorderIntent() {
  const raw = sessionStorage.getItem('wc_reorder');
  if (!raw) return;
  sessionStorage.removeItem('wc_reorder');
  let reorderData;
  try { reorderData = JSON.parse(raw); } catch { return; }
  if (!reorderData?.items?.length) return;

  _pendingReorderItems = reorderData.items;

  // Render the modal
  const storeLabel = document.getElementById('reorder-store-name');
  if (storeLabel) storeLabel.textContent = `${reorderData.items.length} item${reorderData.items.length > 1 ? 's are' : ' is'} running low at ${esc(reorderData.store_name)}`;

  const list = document.getElementById('reorder-items-list');
  if (list) {
    list.innerHTML = reorderData.items.map((item, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:8px;gap:12px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.product_name)}</div>
          <div style="font-size:11px;color:var(--red);margin-top:2px;">Only ${item.current_qty} left in stock</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <label style="font-size:11px;color:var(--text-muted);">Qty:</label>
          <input type="number" min="1" value="${item.suggested_qty}" id="reorder-qty-${i}"
            style="width:56px;padding:5px 7px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;text-align:center;">
        </div>
      </div>
    `).join('');
  }

  document.getElementById('reorder-modal').classList.add('active');
}

async function confirmReorder() {
  document.getElementById('reorder-modal').classList.remove('active');
  let addedCount = 0;
  for (let i = 0; i < _pendingReorderItems.length; i++) {
    const item = _pendingReorderItems[i];
    const qty = parseInt(document.getElementById(`reorder-qty-${i}`)?.value) || item.suggested_qty;
    const product = _products.find(p => p.id === item.product_id);
    if (!product || product.active !== 1) continue; // skip coming soon or inactive
    const body = { product_id: item.product_id, quantity: qty };
    if (_currentStoreId) body.store_id = _currentStoreId;
    const cart = await apiFetch('/api/cart/add', { method: 'POST', body: JSON.stringify(body) });
    if (cart) { _cart = cart; addedCount++; }
  }
  renderCart();
  if (addedCount > 0) {
    showToast(`Added ${addedCount} low-stock item${addedCount > 1 ? 's' : ''} to your cart ✓`, 'success');
  }
  _pendingReorderItems = [];
}

function changeQty(productId, delta) {
  const input = document.getElementById(`qty-${productId}`);
  const product = _products.find(p => p.id === productId);
  const max = product ? product.stock : 9999;
  let val = parseInt(input.value) || 1;
  val = Math.min(max, Math.max(1, val + delta));
  input.value = val;
}

function validateQtyInput(input, productId) {
  const product = _products.find(p => p.id === productId);
  const max = product ? product.stock : 9999;
  // Strip anything that's not a digit
  let val = input.value.replace(/[^0-9]/g, '');
  let num = parseInt(val) || 1;
  num = Math.min(max, Math.max(1, num));
  input.value = num;
}

async function addToCart(productId) {
  const qty = parseInt(document.getElementById(`qty-${productId}`).value) || 1;
  const body = { product_id: productId, quantity: qty };
  if (_currentStoreId) body.store_id = _currentStoreId;
  const btn = event?.target?.closest?.('.add-btn');
  const cart = await apiFetch('/api/cart/add', { method: 'POST', body: JSON.stringify(body) });
  if (cart) {
    _cart = cart; renderCart();
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Added'; btn.classList.add('added');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('added'); }, 900);
      flyToCart(btn);
    } else showToast('Added to cart', 'success');
  }
}

// A tiny leprechaun — green top hat, gold buckle, orange beard — hugging a
// parcel. Only the house partner ever sees him; everyone else gets the 📦.
const LEPRECHAUN_COURIER = `<svg viewBox="0 0 64 64" width="34" height="34" style="display:block;overflow:visible;">
  <rect x="14" y="19" width="36" height="4" rx="2" fill="#169B62"/>
  <rect x="20" y="5" width="24" height="15" rx="3" fill="#169B62"/>
  <rect x="20" y="14" width="24" height="6" fill="#0E7A4B"/>
  <rect x="29" y="14" width="6" height="6" rx="1" fill="#F5C04A"/>
  <circle cx="32" cy="30" r="9" fill="#F8C99B"/>
  <path d="M23 30 Q32 47 41 30 Q40 41 32 41.5 Q24 41 23 30 Z" fill="#D96B27"/>
  <circle cx="28.5" cy="28" r="1.4" fill="#3B2A1A"/><circle cx="35.5" cy="28" r="1.4" fill="#3B2A1A"/>
  <path d="M24 40 Q32 44 40 40 L42 52 Q32 56 22 52 Z" fill="#169B62"/>
  <rect x="22" y="44" width="20" height="14" rx="2" fill="#C98A4B" stroke="#9A6633" stroke-width="1.5"/>
  <rect x="30.5" y="44" width="3" height="14" fill="#9A6633"/>
  <circle cx="21" cy="49" r="2.8" fill="#F8C99B"/><circle cx="43" cy="49" r="2.8" fill="#F8C99B"/>
</svg>`;

/** A little courier arcs from the Add button into the cart, which gives a
 *  happy bump when it lands. The house partner's parcels are hand-delivered
 *  by a leprechaun; everyone else's box makes the trip solo. Skipped for
 *  reduced-motion users. */
function flyToCart(fromEl) {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const cartHeader = document.querySelector('.cart-sidebar .cart-header') || document.querySelector('.mobile-cart-bar');
    if (!cartHeader) return;
    const irish = !!(window._me && window._me.house_partner);
    const a = fromEl.getBoundingClientRect(), b = cartHeader.getBoundingClientRect();
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
    const x1 = b.left + 24, y1 = b.top + b.height / 2;
    const box = document.createElement('div');
    if (irish) { box.innerHTML = LEPRECHAUN_COURIER; box.className = 'lep-courier'; }
    else box.textContent = '📦';
    box.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;pointer-events:none;font-size:20px;will-change:transform;';
    document.body.appendChild(box);
    const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 90;
    const frames = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1;
      const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * my + t * t * y1;
      // The box tumbles; the wee man just leans into his leap.
      const spin = irish ? Math.sin(t * Math.PI * 3) * 11 : t * 260;
      frames.push({ transform: `translate(${x - 10}px, ${y - 10}px) scale(${1 - t * (irish ? 0.35 : 0.5)}) rotate(${spin}deg)`, opacity: 1 - t * 0.15 });
    }
    const anim = box.animate(frames, { duration: irish ? 760 : 620, easing: 'cubic-bezier(0.3, 0.1, 0.4, 1)', fill: 'forwards' });
    anim.onfinish = () => {
      box.remove();
      cartHeader.animate([
        { transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' },
      ], { duration: 260, easing: 'ease-out' });
    };
  } catch (e) { /* decoration only */ }
}

async function loadCart() {
  const params = _currentStoreId ? `?store_id=${_currentStoreId}` : '';
  const cart = await apiFetch(`/api/cart${params}`);
  if (cart) { _cart = cart; renderCart(); }
}

function renderCart() {
  const wrap = document.getElementById('cart-items-wrap');
  const totalRow = document.getElementById('cart-total-row');
  const shippingNote = document.getElementById('cart-shipping-note');
  const checkoutBtn = document.getElementById('checkout-btn');

  if (!_cart.items || !_cart.items.length) {
    // Empty cart: arm the tier tracker at 0 so a one-tap pallet add (classic
    // mix / builder / reorder) celebrates its 0→25/30 crossing, and so the
    // next cart after a checkout or clear can celebrate again.
    window._lastPalPct = 0;
    // Empty-cart illustration: the house partner gets his leprechaun; everyone
    // else gets a simple cart icon.
    const emptyArt = (window._me && window._me.house_partner)
      ? LEPRECHAUN_COURIER
      : `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="var(--text-muted)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1.4"/><circle cx="18" cy="21" r="1.4"/><path d="M1 1h3.2l2.1 12.4a1.6 1.6 0 0 0 1.6 1.3h8.7a1.6 1.6 0 0 0 1.6-1.3L21 6H5.5"/></svg>`;
    wrap.innerHTML = `<div class="cart-empty"><div class="cart-empty-art">${emptyArt}</div><div>Your cart is empty</div></div>`;
    totalRow.style.display = 'none';
    shippingNote.style.display = 'none';
    checkoutBtn.disabled = true;
    updateMobileCartBar(0);
    return;
  }

  // Pallet status: celebrate an active pallet discount, and nudge toward the
  // next threshold when it's close (that's the whole upsell).
  // Pallet banners only make sense when the pallet rate BEATS the rep's own
  // margin — a 35% Danny never sees "unlock 25%".
  const pal = _cart.pallet;
  // The moment the cart crosses into a better pallet rate, celebrate it —
  // that's the exact second the whole pricing model clicks for a rep.
  // (First render only records, so loading a saved cart stays quiet.)
  const palPctNow = (pal && pal.pct && _myRate < pal.pct) ? pal.pct : 0;
  // High-water semantics: celebrate only a NEW best tier for this cart, so
  // nudging quantities back and forth across a threshold never replays it.
  const prevPal = window._lastPalPct;
  if (prevPal !== undefined && palPctNow > prevPal) {
    if (typeof monarchCelebrate === 'function') monarchCelebrate();
    showToast(`🎉 ${palPctNow}% margin unlocked on this whole order!`, 'success');
  }
  window._lastPalPct = Math.max(prevPal ?? 0, palPctNow);
  // A slim progress bar toward the next tier keeps the goal visible from the
  // very first box, not just when they're 6 away.
  const palBar = (boxes, target, goal) => `
    <div class="pal-progress" title="${boxes} of ${target} boxes toward ${goal}">
      <div class="pal-progress-fill" style="width:${Math.min(100, Math.round(boxes / target * 100))}%"></div>
      <span class="pal-progress-label">${boxes}/${target} boxes → ${goal}</span>
    </div>`;
  let palletBanner = '';
  if (pal && pal.boxes > 0) {
    if (pal.pct === 30 && _myRate < 30) {
      palletBanner = `<div class="cart-pallet-banner on">✨ Full-pallet pricing — <strong>30% margin</strong> on every box</div>`;
    } else if (pal.pct === 25 && _myRate < 25) {
      palletBanner = `<div class="cart-pallet-banner on">✨ Half-pallet pricing — <strong>25% margin</strong> on every box${pal.to_full && _myRate < 30 ? `<span class="nudge">${pal.to_full} more box${pal.to_full === 1 ? '' : 'es'} → 30%</span>` : ''}</div>`;
    } else if (!pal.pct && pal.to_half <= 6 && _myRate < 25) {
      palletBanner = `<div class="cart-pallet-banner">📦 ${pal.to_half} more box${pal.to_half === 1 ? '' : 'es'} unlocks <strong>25% half-pallet pricing</strong></div>`;
    }
    // Progress toward whichever tier is next (and still an upgrade for them).
    if (pal.pct === 25 && _myRate < 30 && pal.to_full) {
      palletBanner += palBar(pal.boxes, pal.boxes + pal.to_full, '30% full pallet');
    } else if (!pal.pct && _myRate < 25 && pal.to_half) {
      palletBanner += palBar(pal.boxes, pal.boxes + pal.to_half, '25% half pallet');
    }
  }

  wrap.innerHTML = palletBanner + _cart.items.map(item => `
    <div class="cart-item">
      ${item.image_url ? `<img class="cart-item-img" src="${item.image_url}" alt="">` : '<div class="cart-item-img" style="background:var(--bg-secondary);border-radius:6px;"></div>'}
      <div class="cart-item-info">
        <div class="cart-item-name">${esc(item.name)}</div>
        <div class="cart-item-price">$${parseFloat(item.price_at_add).toFixed(2)} each</div>
        <div class="cart-item-qty">
          <button class="cart-qty-btn" onclick="updateCartItem(${item.id}, ${item.quantity - 1})">−</button>
          <span class="cart-qty-val">${item.quantity}</span>
          <button class="cart-qty-btn" onclick="updateCartItem(${item.id}, ${item.quantity + 1})">+</button>
        </div>
      </div>
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px;">$${(item.price_at_add * item.quantity).toFixed(2)}</div>
        <button class="cart-item-remove" onclick="removeCartItem(${item.id})">🗑</button>
      </div>
    </div>
  `).join('');

  const total = _cart.items.reduce((a, i) => a + i.price_at_add * i.quantity, 0);
  document.getElementById('cart-total-val').textContent = `$${total.toFixed(2)}`;
  // Bump the cart when something new lands in it.
  const count = _cart.items.reduce((a, i) => a + i.quantity, 0);
  if (count > (window._lastCartCount || 0)) {
    document.querySelectorAll('.cart-header, #mobile-cart-bar').forEach(el => {
      el.classList.remove('cart-bump'); void el.offsetWidth; el.classList.add('cart-bump');
    });
  }
  window._lastCartCount = count;
  totalRow.style.display = 'flex';
  shippingNote.textContent = cartShipsFree()
    ? '✓ This order ships FREE'
    : 'Add a capsules master box for free shipping — otherwise shipping is charged by zone from Arizona';
  shippingNote.style.display = 'block';
  checkoutBtn.disabled = false;
  updateMobileCartBar(total);
}

// Floating cart bar for phones — on mobile the cart sidebar sits below the
// products, so without this you can't tell anything happened when you add.
function updateMobileCartBar(total) {
  let bar = document.getElementById('mobile-cart-bar');
  const count = (_cart.items || []).reduce((a, i) => a + i.quantity, 0);
  if (!count) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'mobile-cart-bar';
    bar.addEventListener('click', () => document.querySelector('.cart-sidebar')?.scrollIntoView({ behavior: 'smooth' }));
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span>🛒 ${count} box${count === 1 ? '' : 'es'}</span><strong>$${(total ?? 0).toFixed(2)}</strong><span class="mcb-go">View cart ↓</span>`;
}

async function updateCartItem(itemId, qty) {
  const cart = await apiFetch(`/api/cart/item/${itemId}`, { method: 'PATCH', body: JSON.stringify({ quantity: qty }) });
  if (cart) { _cart = cart; renderCart(); }
}

async function removeCartItem(itemId) {
  const cart = await apiFetch(`/api/cart/item/${itemId}`, { method: 'DELETE' });
  if (cart) { _cart = cart; renderCart(); }
}

async function clearCart() {
  const params = _currentStoreId ? `?store_id=${_currentStoreId}` : '';
  await apiFetch(`/api/cart${params}`, { method: 'DELETE' });
  _cart = { items: [], total: 0 };
  renderCart();
}

// Checkout
function showCheckout() {
  const items = _cart.items || [];
  if (!items.length) return;

  const subtotal = items.reduce((a, i) => a + i.price_at_add * i.quantity, 0);
  const shipping = currentShipping();
  const isCard = _selectedPayment === 'card';
  const processingFee = isCard ? Math.round(((subtotal + shipping + 0.30) / 0.971 - subtotal - shipping) * 100) / 100 : 0;
  const total = Math.round((subtotal + shipping + processingFee) * 100) / 100;

  const rateEl = document.getElementById('co-rate');
  if (rateEl) rateEl.textContent = `${Math.max(_myRate, (_cart.pallet && _cart.pallet.pct) || 0)}% margin`;
  document.getElementById('co-subtotal').textContent = `$${subtotal.toFixed(2)}`;
  document.getElementById('co-shipping').textContent = shipping === 0 ? 'FREE' : `$${shipping.toFixed(2)}`;
  const feeRow = document.getElementById('co-fee-row');
  if (feeRow) feeRow.style.display = processingFee > 0 ? 'flex' : 'none';
  const feeEl = document.getElementById('co-fee');
  if (feeEl) feeEl.textContent = `$${processingFee.toFixed(2)}`;
  document.getElementById('co-total').textContent = `$${total.toFixed(2)}`;

  document.getElementById('checkout-items').innerHTML = items.map(i => `
    <div class="order-summary-row">
      <span>${esc(i.name)} × ${i.quantity}</span>
      <span>$${(i.price_at_add * i.quantity).toFixed(2)}</span>
    </div>
  `).join('');

  // Prefill address
  if (_storeAddress) {
    document.getElementById('ship-name').value = _storeAddress.owner_name || _storeAddress.name || '';
    document.getElementById('ship-address').value = _storeAddress.address || '';
    document.getElementById('ship-city').value = _storeAddress.city || '';
    document.getElementById('ship-state').value = _storeAddress.state || '';
    document.getElementById('ship-zip').value = _storeAddress.zip || '';
  } else {
    // Clear for reps ordering for themselves
    document.getElementById('ship-name').value = '';
    document.getElementById('ship-address').value = '';
    document.getElementById('ship-city').value = '';
    document.getElementById('ship-state').value = '';
    document.getElementById('ship-zip').value = '';
  }

  // Shipping depends on the destination state — recompute totals as they type.
  const stEl = document.getElementById('ship-state');
  if (stEl && !stEl.dataset.shipHooked) {
    stEl.dataset.shipHooked = '1';
    stEl.addEventListener('input', updateCheckoutTotals);
  }

  // A custom-box packing request rides along in the order notes.
  const notesEl = document.getElementById('order-notes');
  if (notesEl && _customBoxNote && !notesEl.value.includes(_customBoxNote)) {
    notesEl.value = (notesEl.value ? notesEl.value + '\n' : '') + 'Custom box: ' + _customBoxNote;
  }

  document.getElementById('checkout-modal').classList.add('active');
}

// ── PAYMENT / STRIPE ──────────────────────────────────────────────────────────
let _stripe = null;
let _stripeCardElement = null;
let _stripeActive = false;

async function initPayment() {
  try {
    const config = await apiFetch('/api/config');
    if (config?.stripePublishableKey && typeof Stripe !== 'undefined') {
      _stripe = Stripe(config.stripePublishableKey);
      _stripeActive = true;
      const cardSub = document.getElementById('card-option-sub');
      if (cardSub) cardSub.textContent = 'Pay now securely';
      // Card is always available when Stripe is active — make it the explicit default
      selectPayment('card');
    } else {
      // Stripe not configured — disable card option
      const payCard = document.getElementById('pay-card');
      if (payCard) {
        payCard.style.opacity = '0.5';
        payCard.style.cursor = 'not-allowed';
        payCard.onclick = null;
        const cardSub = document.getElementById('card-option-sub');
        if (cardSub) cardSub.textContent = 'Coming soon';
      }
      if (_canPayInvoice) {
        selectPayment('invoice');
      } else {
        const wrap = document.getElementById('payment-options-wrap');
        if (wrap) wrap.insertAdjacentHTML('afterend', '<p style="color:#dc2626;font-size:13px;margin-top:8px;">No payment method is currently available on your account. Please contact support.</p>');
      }
    }
  } catch(e) {
    if (_canPayInvoice) selectPayment('invoice');
  }
}

function updateCheckoutTotals() {
  // The rate this order is getting: the rep's locked/base rate, or the pallet
  // rate when the cart qualifies — whichever is better.
  const rateEl = document.getElementById('co-rate');
  if (rateEl) rateEl.textContent = `${Math.max(_myRate, (_cart.pallet && _cart.pallet.pct) || 0)}% margin`;
  const items = _cart.items || [];
  if (!items.length) return;
  const subtotal = items.reduce((a, i) => a + i.price_at_add * i.quantity, 0);
  const shipping = currentShipping();
  const isCard = _selectedPayment === 'card';
  const processingFee = isCard ? Math.round(((subtotal + shipping + 0.30) / 0.971 - subtotal - shipping) * 100) / 100 : 0;
  const total = Math.round((subtotal + shipping + processingFee) * 100) / 100;
  document.getElementById('co-shipping').textContent = shipping === 0 ? 'FREE' : `$${shipping.toFixed(2)}`;
  const feeRow = document.getElementById('co-fee-row');
  if (feeRow) feeRow.style.display = processingFee > 0 ? 'flex' : 'none';
  const feeEl = document.getElementById('co-fee');
  if (feeEl) feeEl.textContent = `$${processingFee.toFixed(2)}`;
  document.getElementById('co-total').textContent = `$${total.toFixed(2)}`;
}

function selectPayment(method) {
  if (method === 'card' && !_stripeActive) return;
  _selectedPayment = method;
  document.getElementById('pay-card').classList.toggle('selected', method === 'card');
  document.getElementById('pay-invoice').classList.toggle('selected', method === 'invoice');

  const cardWrap = document.getElementById('stripe-card-wrap');
  if (method === 'card' && _stripeActive) {
    cardWrap.style.display = 'block';
    if (!_stripeCardElement) {
      const elements = _stripe.elements();
      _stripeCardElement = elements.create('card', {
        style: { base: { fontSize: '15px', color: '#1e293b', '::placeholder': { color: '#94a3b8' } } }
      });
      _stripeCardElement.mount('#stripe-card-element');
    }
  } else {
    cardWrap.style.display = 'none';
  }
  updateCheckoutTotals();
}

async function placeOrder() {
  const addr = document.getElementById('ship-address').value.trim();
  const city = document.getElementById('ship-city').value.trim();
  const state = document.getElementById('ship-state').value.trim();
  const zip = document.getElementById('ship-zip').value.trim();
  if (!addr || !city || !state || !zip) { showToast('Please fill in the complete shipping address', 'error'); return; }

  const placeBtn = document.querySelector('#checkout-modal .btn-green');
  if (placeBtn) { placeBtn.disabled = true; placeBtn.textContent = 'Processing...'; }

  try {
    // If paying by card with Stripe, create payment intent first
    let stripePaymentIntentId = null;
    if (_selectedPayment === 'card' && _stripeActive && _stripeCardElement) {
      const subtotal = (_cart.items || []).reduce((a, i) => a + i.price_at_add * i.quantity, 0);
      const shipping = subtotal >= 350 ? 0 : 35;
      const processingFee = Math.round(((subtotal + shipping + 0.30) / 0.971 - subtotal - shipping) * 100) / 100;
      const totalCents = Math.round((subtotal + shipping + processingFee) * 100);
      const intentRes = await apiFetch('/api/payment/intent', { method: 'POST', body: JSON.stringify({ amount_cents: totalCents }) });
      if (!intentRes?.clientSecret) { showToast('Card payment error. Please try invoice instead.', 'error'); return; }

      const { error: stripeError, paymentIntent } = await _stripe.confirmCardPayment(intentRes.clientSecret, {
        payment_method: { card: _stripeCardElement }
      });
      if (stripeError) {
        const errEl = document.getElementById('stripe-error');
        if (errEl) { errEl.textContent = stripeError.message; errEl.style.display = 'block'; }
        showToast(stripeError.message, 'error');
        return;
      }
      stripePaymentIntentId = paymentIntent.id;
    }

    const body = {
      store_id: _currentStoreId || null,
      payment_method: _selectedPayment,
      stripe_payment_intent_id: stripePaymentIntentId,
      shipping_name: document.getElementById('ship-name').value.trim(),
      shipping_address: addr, shipping_city: city, shipping_state: state, shipping_zip: zip,
      notes: document.getElementById('order-notes').value.trim()
    };

    const order = await apiFetch('/api/orders', { method: 'POST', body: JSON.stringify(body) });
    if (order && order.id) {
      // If card payment, confirm with server to update invoice
      if (stripePaymentIntentId) {
        await apiFetch('/api/payment/confirm', { method: 'POST', body: JSON.stringify({ payment_intent_id: stripePaymentIntentId, order_id: order.id }) });
      }
      document.getElementById('checkout-modal').classList.remove('active');
      const invoiceNote = order.invoice_number ? ` · Invoice ${order.invoice_number}` : '';
      const msg = _selectedPayment === 'invoice'
        ? `Order #${order.id} placed!${invoiceNote} — Invoice will be due in 30 days. Total: $${parseFloat(order.total).toFixed(2)}`
        : `Order #${order.id} confirmed! Payment of $${parseFloat(order.total).toFixed(2)} processed.`;
      document.getElementById('confirm-msg').textContent = msg;
      document.getElementById('confirm-modal').classList.add('active');
      if (typeof monarchCelebrate === 'function') setTimeout(() => monarchCelebrate(), 250);
      _cart = { items: [], total: 0 };
      _stripeCardElement = null;
      renderCart();
    } else if (order && order.error) {
      showToast(order.error, 'error');
    }
  } finally {
    if (placeBtn) { placeBtn.disabled = false; placeBtn.textContent = 'Place Order'; }
  }
}

initShop();

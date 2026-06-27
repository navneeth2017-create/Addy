// Shop page logic

let _products = [];
let _cart = { items: [], total: 0 };
let _role = '';
let _userId = null;
let _currentStoreId = null;
let _selectedPayment = 'card';
let _storeAddress = null;

async function initShop() {
  const token = localStorage.getItem('addy_token');
  if (!token) { window.location.href = '/login.html'; return; }

  const me = await apiFetch('/api/me');
  if (!me) { window.location.href = '/login.html'; return; }
  _role = me.role;
  _userId = me.id;

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
  renderProducts();
  await initPayment();
  checkReorderIntent(); // Show low stock reorder modal if coming from inventory
}

function renderProducts() {
  const grid = document.getElementById('products-grid');
  if (!_products.length) {
    grid.innerHTML = '<p style="color:var(--text-muted);font-size:14px;">No products available.</p>';
    return;
  }
  grid.innerHTML = _products.map((p, i) => {
    const isComingSoon = p.active === 2;
    const price = p.my_price !== null && p.my_price !== undefined ? `$${parseFloat(p.my_price).toFixed(2)}` : 'No price set';
    const hasPrice = p.my_price !== null && p.my_price !== undefined;
    const stockClass = p.stock < 20 ? 'low' : '';

    const imgContent = p.image_url
      ? `<img class="product-img" src="${p.image_url}" alt="${esc(p.name)}" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('failed')">`
      : '';
    const fallback = `<div class="product-img-placeholder"><span>💊</span><p>${esc(p.name)}</p></div>`;
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
  const cart = await apiFetch('/api/cart/add', { method: 'POST', body: JSON.stringify(body) });
  if (cart) { _cart = cart; renderCart(); showToast('Added to cart', 'success'); }
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
    wrap.innerHTML = '<div class="cart-empty">Your cart is empty</div>';
    totalRow.style.display = 'none';
    shippingNote.style.display = 'none';
    checkoutBtn.disabled = true;
    return;
  }

  wrap.innerHTML = _cart.items.map(item => `
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
  totalRow.style.display = 'flex';
  shippingNote.style.display = 'block';
  checkoutBtn.disabled = false;
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
  const shipping = subtotal >= 350 ? 0 : 35;
  const isCard = _selectedPayment === 'card';
  const processingFee = isCard ? Math.round(((subtotal + shipping + 0.30) / 0.971 - subtotal - shipping) * 100) / 100 : 0;
  const total = Math.round((subtotal + shipping + processingFee) * 100) / 100;

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
      // Auto-select invoice
      selectPayment('invoice');
    }
  } catch(e) {
    selectPayment('invoice');
  }
}

function updateCheckoutTotals() {
  const items = _cart.items || [];
  if (!items.length) return;
  const subtotal = items.reduce((a, i) => a + i.price_at_add * i.quantity, 0);
  const shipping = subtotal >= 350 ? 0 : 35;
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

// Admin product management

let _allProducts = [];

// Internal tier definitions — labels shown to admin only, never to end users
const PRODUCT_TIERS = [
  { key: 'dsd', label: 'DSD' },
  { key: 'dsd',        label: 'DSD' },
  { key: 'rep',                label: 'DSD' },
  { key: 'dsd',        label: 'Wholesale / DSD' },
];

let _preorderRefreshInterval = null;

async function importFromWowCow() {
  if (!confirm('Import all active products from WowCow?\n\nThey will be added as INACTIVE with no pricing set. You can set cost prices and activate them before DSDs can see them.')) return;

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Importing...';

  const result = await apiFetch('/api/products/import-from-wowcow', { method: 'POST' });

  btn.disabled = false;
  btn.textContent = '⬇ Import from WowCow';

  if (result && result.success) {
    showToast(result.message, 'success');
    if (result.imported > 0) loadProductsTab();
  }
}

async function loadProductsTab() {
  const products = await apiFetch('/api/products/all');
  _allProducts = products || [];

  // Auto-refresh preorder counts every 15s while on this tab
  clearInterval(_preorderRefreshInterval);
  _preorderRefreshInterval = setInterval(async () => {
    const fresh = await apiFetch('/api/products/all');
    if (!fresh) return;
    _allProducts = fresh;
    // Only re-render the preorder count cells — don't full-redraw to avoid flicker
    fresh.forEach(p => {
      const el = document.getElementById(`preorder-count-${p.id}`);
      if (el) el.textContent = `👥 ${p.preorder_count || 0} interested`;
    });
  }, 15000);

  // Low stock warning banner
  const redProducts    = _allProducts.filter(p => p.active === 1 && p.stock <= 50);
  const yellowProducts = _allProducts.filter(p => p.active === 1 && p.stock >= 51 && p.stock <= 99);
  const bannerEl = document.getElementById('products-low-stock-banner');
  if (bannerEl) {
    if (redProducts.length > 0 || yellowProducts.length > 0) {
      const outOfStock = redProducts.filter(p => p.stock === 0);
      let html = '';

      if (redProducts.length > 0) {
        html += `
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;flex-shrink:0;filter:hue-rotate(315deg) saturate(4) brightness(0.85);">⚠️</span>
            <div>
              <span style="font-size:14px;font-weight:700;color:#dc2626;">
                ${redProducts.length} product${redProducts.length>1?'s are':' is'} critically low
              </span>
              ${outOfStock.length > 0
                ? `<div style="font-size:12px;color:#ef4444;margin-top:2px;">${outOfStock.length} item${outOfStock.length>1?'s':''} completely out of stock</div>`
                : ''}
              <div style="font-size:12px;color:#f87171;margin-top:6px;line-height:1.8;">
                ${redProducts.map(p => `<span style="display:inline-block;margin-right:14px;">
                  ${esc(p.name)}: <strong>${p.stock === 0 ? 'Out of Stock' : p.stock + ' left'}</strong>
                </span>`).join('')}
              </div>
            </div>
          </div>`;
      }

      if (yellowProducts.length > 0) {
        html += `
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">
            <span style="font-size:20px;flex-shrink:0;">⚠️</span>
            <div>
              <span style="font-size:14px;font-weight:700;color:#d97706;">
                ${yellowProducts.length} product${yellowProducts.length>1?'s are':' is'} getting low
              </span>
              <div style="font-size:12px;color:#f59e0b;margin-top:6px;line-height:1.8;">
                ${yellowProducts.map(p => `<span style="display:inline-block;margin-right:14px;">
                  ${esc(p.name)}: <strong>${p.stock} left</strong>
                </span>`).join('')}
              </div>
            </div>
          </div>`;
      }

      bannerEl.innerHTML = html;
      bannerEl.style.display = 'block';
    } else {
      bannerEl.innerHTML = `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">✅</span>
          <span style="font-size:14px;font-weight:600;color:#16a34a;">All products are well stocked</span>
        </div>`;
      bannerEl.style.display = 'block';
    }
  }

  // Refresh the tab pulse badge
  if (typeof checkLowStockBadge === 'function') checkLowStockBadge();

  renderProductsTable();
}

function renderProductsTable() {
  const tbody = document.getElementById('products-tbody');
  if (!_allProducts.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted);">No products yet. Add your first product.</td></tr>';
    return;
  }
  tbody.innerHTML = _allProducts.map((p, i) => {
    // ADDY uses retail_price to auto-calculate tier prices
    const retail = parseFloat(p.retail_price || 0);
    const prices = retail > 0
      ? [
          `<span style="white-space:nowrap;">Retail: <strong>$${retail.toFixed(2)}</strong></span>`,
          `<span style="white-space:nowrap;color:#16a34a;">T1: <strong>$${(retail*0.65).toFixed(2)}</strong></span>`,
          `<span style="white-space:nowrap;color:#2563eb;">T2: <strong>$${(retail*0.70).toFixed(2)}</strong></span>`,
          `<span style="white-space:nowrap;color:#64748b;">T3: <strong>$${(retail*0.75).toFixed(2)}</strong></span>`,
        ].join('<br>')
      : '<span style="color:var(--red);font-size:12px;">Set retail price</span>';
    const statusBadge = p.active === 2
      ? `<span class="status-badge coming-soon">Coming Soon</span>`
      : p.active === 1
        ? `<span class="status-badge active">Active</span>`
        : `<span class="status-badge inactive">Inactive</span>`;
    const imgEl = p.image_url
      ? `<div style="width:44px;height:44px;border-radius:6px;overflow:hidden;flex-shrink:0;"><img src="${p.image_url}" style="width:44px;height:44px;object-fit:cover;display:block;" onerror="this.parentElement.outerHTML='<div style=\\'width:44px;height:44px;background:var(--bg-secondary);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;\\'>💊</div>'"></div>`
      : `<div style="width:44px;height:44px;background:var(--bg-secondary);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;">💊</div>`;
    const preorderInfo = p.active === 2
      ? `<span id="preorder-count-${p.id}" style="font-size:11px;color:#7c3aed;font-weight:600;display:block;margin-top:4px;">👥 ${parseInt(p.preorder_count) || 0} interested</span>`
      : '';
    return `
      <tr class="table-row-anim" style="animation-delay:${i * 30}ms">
        <td>${imgEl}</td>
        <td style="font-weight:500">${esc(p.name)}${preorderInfo}</td>
        <td style="font-size:12px;color:var(--text-muted)">${esc(p.sku || '—')}</td>
        <td style="font-size:12px;line-height:1.8;">${prices || '<span style="color:var(--text-muted)">No prices set</span>'}</td>
        <td>${p.active === 2 ? '<span style="color:var(--text-muted);font-size:13px;">—</span>' : p.stock}</td>
        <td>${statusBadge}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-outline" onclick="showEditProduct(${p.id})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function showAddProductModal() {
  document.getElementById('product-modal-title').textContent = 'Add Product';
  document.getElementById('product-form').reset();
  document.getElementById('product-id').value = '';
  document.getElementById('product-preview-img').style.display = 'none';
  document.getElementById('product-modal').classList.add('active');
}

function showEditProduct(id) {
  const p = _allProducts.find(x => x.id === id);
  if (!p) return;
  document.getElementById('product-modal-title').textContent = 'Edit Product';
  document.getElementById('product-id').value = p.id;
  document.getElementById('pf-name').value = p.name;
  document.getElementById('pf-sku').value = p.sku || '';
  const cpEl = document.getElementById('pf-cost-price');
  if (cpEl) cpEl.value = p.cost_price || '';
  const rpEl = document.getElementById('pf-retail-price');
  if (rpEl) rpEl.value = p.retail_price || '';
  updateTierPricePreview();
  document.getElementById('pf-description').value = p.description || '';
  document.getElementById('pf-stock').value = p.stock;
  document.getElementById('pf-active').value = String(p.active ?? 1);
  document.getElementById('pf-image-url').value = p.image_url || '';
  updateImagePreview(p.image_url);
  // Fill all tier prices
  for (const t of PRODUCT_TIERS) {
    const rp = (p.role_prices || []).find(x => x.role === t.key);
    const el = document.getElementById(`pf-price-${t.key}`);
    if (el) el.value = rp ? rp.price : '';
  }
  document.getElementById('product-modal').classList.add('active');
}

let _cropperInstance = null;
let _cropSourceDataUrl = null;

function updateImagePreview(url) {
  const img = document.getElementById('product-preview-img');
  const wrap = document.getElementById('product-preview-wrap');
  if (url && url.trim()) {
    img.src = url;
    img.style.display = 'block';
    wrap.style.display = 'block';
    img.onerror = () => { wrap.style.display = 'none'; };
  } else {
    wrap.style.display = 'none';
  }
}

function handleImageUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    _cropSourceDataUrl = e.target.result;
    // Auto-open crop modal on upload
    openCropModal();
  };
  reader.readAsDataURL(file);
}

function openCropModal() {
  const src = _cropSourceDataUrl || document.getElementById('pf-image-url').value;
  if (!src) return;
  const modal = document.getElementById('crop-modal');
  const cropImg = document.getElementById('crop-source');
  modal.style.display = 'flex';

  if (_cropperInstance) { _cropperInstance.destroy(); _cropperInstance = null; }

  cropImg.src = '';
  cropImg.onload = () => {
    _cropperInstance = new Cropper(cropImg, {
      aspectRatio: 1,
      viewMode: 0,           // 0 = no restrictions, lets you zoom out freely
      autoCropArea: 0.75,
      responsive: true,
      background: true,
      zoomOnWheel: true,
      ready() {
        // Zoom out to show the full image on load
        const cd = this.cropper.getCanvasData();
        const cont = this.cropper.getContainerData();
        const fitScale = Math.min(cont.width / cd.naturalWidth, cont.height / cd.naturalHeight) * 0.85;
        this.cropper.zoomTo(fitScale);
        // Reset slider
        const slider = document.getElementById('crop-zoom-slider');
        if (slider) slider.value = 0;
      }
    });
  };
  cropImg.src = src;
}

function closeCropModal() {
  document.getElementById('crop-modal').style.display = 'none';
  if (_cropperInstance) { _cropperInstance.destroy(); _cropperInstance = null; }
  _cropSourceDataUrl = null;
  const fi = document.getElementById('pf-image-file');
  if (fi) fi.value = '';
}

function setCropRatio(ratio) {
  if (_cropperInstance) _cropperInstance.setAspectRatio(ratio);
}

function cropZoomSlider(val) {
  if (!_cropperInstance) return;
  // val is -50 to 50; map to zoom delta from base
  const delta = val / 100;
  const imgData = _cropperInstance.getImageData();
  const base = Math.min(
    _cropperInstance.getContainerData().width / imgData.naturalWidth,
    _cropperInstance.getContainerData().height / imgData.naturalHeight
  ) * 0.85;
  _cropperInstance.zoomTo(base + delta);
}

function resetCropZoom() {
  if (!_cropperInstance) return;
  const imgData = _cropperInstance.getImageData();
  const cont = _cropperInstance.getContainerData();
  const base = Math.min(cont.width / imgData.naturalWidth, cont.height / imgData.naturalHeight) * 0.85;
  _cropperInstance.zoomTo(base);
  const slider = document.getElementById('crop-zoom-slider');
  if (slider) slider.value = 0;
}

function applyCrop() {
  if (!_cropperInstance) { showToast('Cropper not ready, please try again', 'error'); return; }
  try {
    const canvas = _cropperInstance.getCroppedCanvas({
      maxWidth: 800,
      maxHeight: 800,
      fillColor: '#ffffff',       // White bg for transparent PNGs
      imageSmoothingEnabled: true,
    });
    if (!canvas) { showToast('Could not crop image', 'error'); return; }
    // Use PNG if source looks like PNG, else JPEG
    const isPng = (_cropSourceDataUrl || '').startsWith('data:image/png');
    const dataUrl = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.92);
    document.getElementById('pf-image-url').value = dataUrl;
    updateImagePreview(dataUrl);
    closeCropModal();
    showToast('Image cropped ✓', 'success');
  } catch(err) {
    showToast('Crop failed: ' + err.message, 'error');
  }
}

async function handleProductSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('product-id').value;
  const prices = {};
  for (const t of PRODUCT_TIERS) {
    const el = document.getElementById(`pf-price-${t.key}`);
    if (el && el.value !== '') prices[t.key] = el.value;
  }
  const body = {
    name: document.getElementById('pf-name').value.trim(),
    sku: document.getElementById('pf-sku').value.trim(),
    cost_price: parseFloat(document.getElementById('pf-cost-price')?.value || 0),
    retail_price: parseFloat(document.getElementById('pf-retail-price')?.value || 0),
    description: document.getElementById('pf-description').value.trim(),
    stock: parseInt(document.getElementById('pf-stock').value) || 0,
    active: parseInt(document.getElementById('pf-active').value),
    image_url: document.getElementById('pf-image-url').value.trim(),
    prices
  };

  let result;
  if (id) {
    result = await apiFetch(`/api/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  } else {
    result = await apiFetch('/api/products', { method: 'POST', body: JSON.stringify(body) });
  }

  if (result && result.id) {
    showToast(id ? 'Product updated' : 'Product added', 'success');
    closeModal();
    loadProductsTab();
  } else if (result && result.error) {
    showToast(result.error, 'error');
  }
}

function updateTierPricePreview() {
  const retail = parseFloat(document.getElementById('pf-retail-price')?.value || 0);
  const myCost = parseFloat(document.getElementById('pf-cost-price')?.value || 0);

  const els = {
    t1: document.getElementById('preview-tier1'),
    t2: document.getElementById('preview-tier2'),
    t3: document.getElementById('preview-tier3'),
    t1p: document.getElementById('preview-tier1-profit'),
    t2p: document.getElementById('preview-tier2-profit'),
    t3p: document.getElementById('preview-tier3-profit'),
  };

  if (!retail || retail <= 0) {
    Object.values(els).forEach(el => { if (el) el.textContent = '—'; });
    return;
  }

  // DSD pays = retail × (1 - their margin) — they make their % when selling at retail
  const t1pays = retail * 0.65;  // Tier 1: 35% margin
  const t2pays = retail * 0.70;  // Tier 2: 30% margin
  const t3pays = retail * 0.75;  // Tier 3: 25% margin

  if (els.t1) els.t1.textContent = '$' + t1pays.toFixed(2) + ' / unit';
  if (els.t2) els.t2.textContent = '$' + t2pays.toFixed(2) + ' / unit';
  if (els.t3) els.t3.textContent = '$' + t3pays.toFixed(2) + ' / unit';

  // Show admin profit per tier if cost is entered
  if (myCost > 0) {
    const profit = (v) => {
      const p = v - myCost;
      return (p >= 0 ? '+' : '') + '$' + p.toFixed(2) + ' your profit';
    };
    if (els.t1p) els.t1p.textContent = profit(t1pays);
    if (els.t2p) els.t2p.textContent = profit(t2pays);
    if (els.t3p) els.t3p.textContent = profit(t3pays);
  } else {
    [els.t1p, els.t2p, els.t3p].forEach(el => { if (el) el.textContent = ''; });
  }
}

async function deleteProduct(id) {
  const p = _allProducts.find(x => x.id === id);
  if (!confirm(`Delete "${p?.name}"? This cannot be undone.`)) return;
  const result = await apiFetch(`/api/products/${id}`, { method: 'DELETE' });
  if (result && result.success) {
    showToast('Product deleted', 'success');
    loadProductsTab();
  } else if (result && result.error) {
    showToast(result.error, 'error');
  } else if (!result) {
    showToast('Failed to delete product. Please try again.', 'error');
  }
}

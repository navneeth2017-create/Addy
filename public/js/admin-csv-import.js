/**
 * admin-csv-import.js
 * Bulk store import — upload → map columns → preview/warnings → import.
 * Uses smart-csv.js (plain ES module, no bundler needed).
 */
import { parseCsv, autoMap, buildRows, usableRows } from './smart-csv.js';

// ── Field schema (derived from stores table) ──────────────────────────────────
const storeFields = [
  { key: 'name',         required: true,
    synonyms: ['name', 'store name', 'business name', 'store', 'business', 'location', 'customer'] },
  { key: 'owner_name',
    synonyms: ['owner', 'owner name', 'contact', 'contact name', 'manager'] },
  { key: 'email',
    synonyms: ['email', 'e-mail', 'e mail', 'email address', 'contact email'],
    clean: (v, ctx) => {
      const s = String(v).trim();
      if (!s) return undefined;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase();
      ctx.warn(`"${s}" doesn't look like an email — left blank`);
      return undefined;
    } },
  { key: 'phone',
    synonyms: ['phone', 'phone number', 'phone #', 'tel', 'telephone', 'mobile'],
    clean: (v, ctx) => {
      const raw = String(v).trim();
      const digits = raw.replace(/\D/g, '');
      if (digits.length === 10) return '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
      if (digits.length === 11 && digits[0] === '1') return '(' + digits.slice(1,4) + ') ' + digits.slice(4,7) + '-' + digits.slice(7);
      if (raw) return raw; // keep as-is if already formatted
      return undefined;
    } },
  { key: 'address',      required: false, flagIfMissing: true,
    synonyms: ['address', 'street', 'street address', 'addr'] },
  { key: 'city',         required: false, flagIfMissing: true,
    synonyms: ['city', 'town'] },
  { key: 'state',        required: false, flagIfMissing: true,
    synonyms: ['state', 'province', 'st'] },
  { key: 'zip',          required: false, flagIfMissing: true,
    synonyms: ['zip', 'zip code', 'postal', 'postal code'] },
  { key: 'store_number', synonyms: ['store number', 'store #', 'store id', 'store no', 'number', 'location id'] },
  { key: 'category',     default: 'General',
    synonyms: ['category', 'type', 'store type', 'business type', 'industry'] },
];

// ── State ─────────────────────────────────────────────────────────────────────
let _headers = [];
let _records = [];
let _mapping = {};
let _goodRows = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStep(id) {
  ['csv-step-upload','csv-step-mapping','csv-step-preview','csv-step-results']
    .forEach(s => { const el = document.getElementById(s); if (el) el.style.display = s === id ? 'block' : 'none'; });
}

function getToken() { return sessionStorage.getItem('addy_preview_token') || localStorage.getItem('addy_token'); }

// ── Public API (called from HTML onclicks / app.js) ───────────────────────────
window.openCsvImportModal = function() {
  // Reset state
  _headers = []; _records = []; _mapping = {}; _goodRows = [];
  showStep('csv-step-upload');
  document.getElementById('csv-file-input').value = '';
  document.getElementById('csv-import-modal').classList.add('active');
  wireDropZone();
};

window.closeCsvModal = function() {
  document.getElementById('csv-import-modal').classList.remove('active');
};

window.downloadExampleCsv = async function() {
  const token = getToken();
  const a = document.createElement('a');
  a.href = `/api/stores/example-csv?token=${token}`;
  a.download = 'stores-import-example.csv';
  a.click();
};

// Accepts a File from the picker OR from drag-and-drop, in CSV or Excel form.
window.handleCsvFile = async function(event) {
  const file = event.target.files[0];
  if (file) await ingestFile(file);
};

async function ingestFile(file) {
  const name = (file.name || '').toLowerCase();
  let parsed;
  try {
    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) {
      parsed = await parseSpreadsheet(file);   // Excel → CSV → same parser
    } else {
      parsed = parseCsv(await file.text());
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Could not read that file', 'error');
    return;
  }
  _headers = parsed.headers;
  _records = parsed.records;

  if (_records.length === 0) {
    if (typeof showToast === 'function') showToast('That file has no data rows', 'error');
    return;
  }
  if (_records.length > 500) {
    if (typeof showToast === 'function') showToast('Maximum 500 rows — please split the file', 'error');
    return;
  }

  _mapping = autoMap(_headers, storeFields);
  renderMappingGrid();
  showStep('csv-step-mapping');
}

// ── Excel support ─────────────────────────────────────────────────────────────
// SheetJS is only fetched the first time someone actually picks an Excel file,
// so CSV-only users never download it. We convert the first sheet to CSV text and
// reuse the exact same parsing/cleaning path as a real .csv upload.
let _xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { _xlsxLoading = null; reject(new Error('Excel support could not load — check your connection, or save the file as CSV and try again.')); };
    document.head.appendChild(s);
  });
  return _xlsxLoading;
}

async function parseSpreadsheet(file) {
  const XLSX = await loadXlsx();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('That spreadsheet has no readable sheets');
  return parseCsv(XLSX.utils.sheet_to_csv(sheet));
}

// Make the upload box a real drag-and-drop target (the label already says so).
function wireDropZone() {
  const zone = document.querySelector('#csv-step-upload label');
  if (!zone || zone._dropWired) return;
  zone._dropWired = true;
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, e => { stop(e); zone.style.borderColor = 'var(--accent)'; zone.style.opacity = '0.85'; }));
  ['dragleave','dragend','drop'].forEach(ev => zone.addEventListener(ev, e => { stop(e); zone.style.borderColor = ''; zone.style.opacity = ''; }));
  zone.addEventListener('drop', e => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) ingestFile(file);
  });
}

function renderMappingGrid() {
  const grid = document.getElementById('csv-mapping-grid');
  grid.innerHTML = storeFields.map(f => `
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:12px;font-weight:700;color:var(--text-secondary);">${f.key.replace(/_/g,' ').toUpperCase()}${f.required?' *':''}</label>
      <select id="map-${f.key}" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;">
        <option value="">— skip this column —</option>
        ${_headers.map(h => `<option value="${h}" ${_mapping[f.key]===h?'selected':''}>${h}</option>`).join('')}
      </select>
    </div>`).join('');
}

window.runCsvPreview = function() {
  // Read current mapping from selects
  storeFields.forEach(f => {
    _mapping[f.key] = document.getElementById(`map-${f.key}`)?.value || '';
  });

  const { rows, warnings, missingRequired } = buildRows(_records, _mapping, storeFields);
  _goodRows = usableRows(rows, storeFields);

  // Address completeness check
  const missingAddr = _goodRows.filter(r => !r.address || !r.city || !r.state || !r.zip);
  const addrWarning = missingAddr.length > 0
    ? `<span style="color:#d97706;font-weight:600;">· ⚠️ ${missingAddr.length} store${missingAddr.length>1?'s':''} missing address fields</span>`
    : '';

  // Stats bar
  const statsEl = document.getElementById('csv-stats');
  statsEl.innerHTML = `
    <span style="color:var(--green);font-weight:700;">${_goodRows.length} ready to import</span>
    <span style="color:var(--text-muted);">·</span>
    <span style="color:var(--text-muted);">${rows.length - _goodRows.length} skipped (missing required fields)</span>
    <span style="color:var(--text-muted);">·</span>
    <span style="color:var(--text-muted);">${_records.length} total rows</span>
    ${addrWarning}`;

  // Warnings
  const warnWrap = document.getElementById('csv-warnings-wrap');
  const warnList = document.getElementById('csv-warnings-list');
  if (warnings.length > 0) {
    warnList.innerHTML = warnings.map(w => `<div>${w}</div>`).join('');
    warnWrap.style.display = 'block';
  } else {
    warnWrap.style.display = 'none';
  }

  // Preview table (first 5 good rows)
  const previewTable = document.getElementById('csv-preview-table');
  const cols = ['name','owner_name','email','phone','city','state','category'];
  const visibleRows = _goodRows.slice(0, 5);
  previewTable.innerHTML = `
    <thead><tr style="background:var(--bg-secondary);">
      ${cols.map(c => `<th style="padding:8px;text-align:left;font-size:12px;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border);">${c.replace(/_/g,' ')}</th>`).join('')}
    </tr></thead>
    <tbody>
      ${visibleRows.map(r => `<tr style="border-bottom:1px solid var(--border);">
        ${cols.map(c => `<td style="padding:8px;font-size:13px;color:var(--text);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r[c]||'—'}</td>`).join('')}
      </tr>`).join('')}
      ${_goodRows.length > 5 ? `<tr><td colspan="${cols.length}" style="padding:8px;color:var(--text-muted);font-size:12px;font-style:italic;">…and ${_goodRows.length - 5} more rows</td></tr>` : ''}
    </tbody>`;

  // Import button
  document.getElementById('csv-import-count').textContent = _goodRows.length;
  document.getElementById('csv-import-btn').disabled = _goodRows.length === 0;

  showStep('csv-step-preview');
};

window.csvBack = function() { showStep('csv-step-mapping'); };

window.runCsvImport = async function() {
  const btn = document.getElementById('csv-import-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  try {
    const res = await fetch('/api/stores/bulk-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ rows: _goodRows }),
    });
    const data = await res.json();

    // Show results
    const summary = document.getElementById('csv-result-summary');
    const photoNote = data.isBulkBatch
      ? `<div style="background:#fffbeb;border:1px solid #d97706;border-radius:10px;padding:14px;margin-top:12px;font-size:13px;">
           📸 <strong>${data.created} stores imported with a 60-day photo deadline</strong> — DSDs who claim these stores will be reminded to upload a front-of-store and product display photo before the deadline.
         </div>`
      : data.created > 0
        ? `<div style="background:#f0fdf4;border:1px solid #16a34a;border-radius:10px;padding:14px;margin-top:12px;font-size:13px;">
             📸 <strong>24-hour photo window</strong> — when a DSD claims one of these stores, they'll be required to upload photos immediately.
           </div>`
        : '';
    summary.innerHTML = `
      <div style="display:flex;gap:16px;margin-bottom:16px;">
        <div style="text-align:center;padding:16px;background:var(--greenBg,#f0fdf4);border-radius:10px;flex:1;">
          <div style="font-size:28px;font-weight:800;color:var(--green);">${data.created}</div>
          <div style="font-size:13px;color:var(--text-muted);">Created</div>
        </div>
        <div style="text-align:center;padding:16px;background:var(--bg-secondary);border-radius:10px;flex:1;">
          <div style="font-size:28px;font-weight:800;color:var(--text-muted);">${data.skipped}</div>
          <div style="font-size:13px;color:var(--text-muted);">Skipped (duplicates)</div>
        </div>
        <div style="text-align:center;padding:16px;background:var(--redBg,#fef2f2);border-radius:10px;flex:1;">
          <div style="font-size:28px;font-weight:800;color:var(--red);">${data.errors}</div>
          <div style="font-size:13px;color:var(--text-muted);">Errors</div>
        </div>
      </div>
      ${photoNote}`;

    // Show error/skip details if any
    const errWrap = document.getElementById('csv-result-errors');
    const notable = (data.results||[]).filter(r => r.status !== 'created');
    if (notable.length > 0) {
      errWrap.style.display = 'block';
      errWrap.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:8px;">Row details:</div>` +
        notable.map(r => `<div style="font-size:12px;color:var(--text-muted);padding:3px 0;">Row ${r.row}: ${r.status} — ${r.reason||''}</div>`).join('');
    }

    showStep('csv-step-results');

    // Refresh whatever store view is on the current page (admin or DSD dashboard)
    ['loadAdminStores','loadAdminDashboard','loadDSDDashboard']
      .forEach(fn => { if (typeof window[fn] === 'function') { try { window[fn](); } catch(_) {} } });

  } catch(e) {
    if (typeof showToast === 'function') showToast('Import failed: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = `Import ${_goodRows.length} Stores`;
  }
};

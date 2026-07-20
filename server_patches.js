/**
 * Server-side patches, installed by boot.js as EARLY middleware/routes (they
 * run before everything registered in server.js):
 *
 *  1. Delete-all safety: /api/stores/delete-all now requires a server-side
 *     typed confirmation ({ confirm: 'DELETE' }) and automatically snapshots
 *     the whole database to B2 (predelete/ prefix) before the wipe runs.
 *  2. Backup RESTORE — the missing half of the backup system: list the
 *     backups in B2, preview a backup's contents, and MERGE-restore one
 *     (existing rows always win; nothing is ever deleted by a restore).
 *  3. Injects /js/patches.js into dashboard-admin.html (frontend fixes +
 *     the restore UI) without editing the HTML file.
 *
 * Self-contained: uses its own pg pool (same DATABASE_URL) and its own B2
 * client, and reuses runBackup from backup_module for snapshots.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { Pool } = require('pg');
const { authenticate, authorize } = require('./middleware/auth');
const { runBackup } = require('./backup_module');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // mirrors server.js's own pool
  options: '-c search_path=addy,public',
  max: 3,
});

// ── Minimal B2 client (auth, list, download-by-id) ───────────────────────────
function b2Request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.message || `B2 error ${res.statusCode}`));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function b2Authorize() {
  const { B2_KEY_ID, B2_APP_KEY } = process.env;
  if (!B2_KEY_ID || !B2_APP_KEY || !process.env.B2_BUCKET_ID) {
    throw new Error('Backups are not configured (B2_KEY_ID / B2_APP_KEY / B2_BUCKET_ID env vars)');
  }
  const auth = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
  return b2Request({
    hostname: 'api.backblazeb2.com',
    path: '/b2api/v2/b2_authorize_account',
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` },
  });
}

async function listBackups() {
  const auth = await b2Authorize();
  const url = new URL(`${auth.apiUrl}/b2api/v2/b2_list_file_names`);
  const { files } = await b2Request({
    hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
  }, { bucketId: process.env.B2_BUCKET_ID, prefix: '', maxFileCount: 1000 });
  return (files || [])
    .sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)
    .map(f => ({ fileName: f.fileName, fileId: f.fileId, uploadTimestamp: f.uploadTimestamp, size: f.contentLength }));
}

function b2DownloadById(downloadUrl, authToken, fileId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${downloadUrl}/b2api/v2/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`);
    https.get({ hostname: url.hostname, path: url.pathname + url.search, headers: { Authorization: authToken } }, res => {
      if (res.statusCode >= 400) { reject(new Error(`B2 download error ${res.statusCode}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function downloadBackup(fileId) {
  const auth = await b2Authorize();
  const gz = await b2DownloadById(auth.downloadUrl, auth.authorizationToken, fileId);
  const json = await new Promise((res, rej) => zlib.gunzip(gz, (e, b) => e ? rej(e) : res(b)));
  return JSON.parse(json.toString('utf8'));
}

/**
 * MERGE-restore a parsed backup. Never deletes or overwrites: every row is
 * inserted with ON CONFLICT DO NOTHING, so existing rows always win and only
 * missing rows come back. Drift-safe (only columns that still exist are
 * restored), FK-safe (multi-pass retry lets parents restore before children),
 * and sequences are bumped afterwards so new inserts don't collide.
 */
async function restoreParsedBackup(backup) {
  const schema = 'addy';
  const client = await pool.connect();
  const report = {};
  try {
    await client.query(`SET search_path TO ${schema},public`);
    const tableNames = Object.keys(backup.tables || {});
    const colRows = (await client.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`, [schema]
    )).rows;
    const liveCols = {};
    for (const r of colRows) (liveCols[r.table_name] ||= new Set()).add(r.column_name);

    let pending = tableNames
      .filter(t => liveCols[t] && (backup.tables[t] || []).length > 0)
      .map(t => ({ table: t, rows: backup.tables[t] }));
    for (const t of tableNames) {
      report[t] = { in_backup: (backup.tables[t] || []).length, inserted: 0, skipped_existing: 0, failed: 0 };
      if (!liveCols[t]) report[t].note = 'table no longer exists — skipped';
    }

    for (let pass = 0; pass < 5 && pending.length > 0; pass++) {
      const nextPending = [];
      for (const { table, rows } of pending) {
        const cols = [...liveCols[table]].filter(c => rows.some(r => c in r));
        if (cols.length === 0) continue;
        const failedRows = [];
        for (const row of rows) {
          const vals = cols.map(c => row[c] === undefined ? null : row[c]);
          const params = cols.map((_, i) => `$${i + 1}`).join(',');
          try {
            const r = await client.query(
              `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${params}) ON CONFLICT DO NOTHING`,
              vals
            );
            if (r.rowCount > 0) report[table].inserted++;
            else report[table].skipped_existing++;
          } catch (e) {
            failedRows.push(row); // likely FK to a not-yet-restored parent — retry next pass
          }
        }
        if (failedRows.length > 0) nextPending.push({ table, rows: failedRows });
      }
      pending = nextPending;
    }
    for (const { table, rows } of pending) report[table].failed = rows.length;

    for (const t of tableNames) {
      if (!liveCols[t] || !liveCols[t].has('id')) continue;
      try {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('"${t}"','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM "${t}"), 1))`
        );
      } catch (e) { /* non-serial id — fine */ }
    }
    return report;
  } finally {
    client.release();
  }
}

/**
 * SQL hotfixes, applied by wrapping pg's query at the driver level (boot.js
 * calls this before server.js loads). Each entry rewrites one exact, known-bad
 * query string from server.js — deterministic find/replace on the SQL text,
 * nothing dynamic.
 *
 * Hotfix #1 — THE "data gone" bug: the admin /api/stores claims-attach query
 * ends in `JOIN users u ... GROUP BY store_id`. `store_id` is ambiguous there
 * (the subquery has it AND users.store_id exists), so Postgres rejects the
 * query and the whole endpoint 500s — which the dashboard rendered as NaN
 * stats and an empty store list. The data was never gone.
 */
function rewriteSql(text) {
  if (typeof text !== 'string') return text;
  if (text.includes('t JOIN users u ON u.id = t.uid GROUP BY store_id')) {
    return text
      .replace('SELECT store_id, string_agg', 'SELECT t.store_id, string_agg')
      .replace('GROUP BY store_id', 'GROUP BY t.store_id');
  }
  return text;
}

function installPgHotfixes() {
  const pg = require('pg');
  // server.js runs queries via pool.connect() + client.query, so wrap
  // Client.prototype.query (Pool.query also routes through it).
  const origQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function (text, ...rest) {
    if (typeof text === 'string') text = rewriteSql(text);
    else if (text && typeof text.text === 'string') text = { ...text, text: rewriteSql(text.text) };
    return origQuery.call(this, text, ...rest);
  };
  console.log('🩹 pg hotfixes installed (admin stores GROUP BY ambiguity)');
}

// ── Install ──────────────────────────────────────────────────────────────────
function installServerPatches(app) {
  const express = require('express');
  const jsonParser = express.json({ limit: '2mb' }); // body-parser skips if already parsed

  // 1. Delete-all guard: typed server-side confirmation + automatic pre-delete
  //    snapshot. Runs BEFORE the real route; next() lets the wipe proceed.
  app.use('/api/stores/delete-all', (req, res, next) => {
    if (req.method !== 'POST') return next();
    jsonParser(req, res, async (err) => {
      if (err) return res.status(400).json({ error: 'Invalid request body' });
      if (req.body?.confirm !== 'DELETE') {
        return res.status(400).json({ error: "Confirmation required — send { confirm: 'DELETE' }" });
      }
      try {
        await runBackup(pool, 'addy', 'predelete/addy');
        console.log('🛟 pre-delete snapshot uploaded');
      } catch (e) {
        console.error('pre-delete snapshot failed (continuing):', e.message);
      }
      next();
    });
  });

  // 2. Backup restore endpoints (admin only).
  app.get('/api/admin/backups', authenticate, authorize('admin'), async (req, res) => {
    try {
      const files = await listBackups();
      res.json({ backups: files.map(f => ({
        fileName: f.fileName, fileId: f.fileId, size: f.size,
        uploaded_at: new Date(f.uploadTimestamp).toISOString(),
        kind: f.fileName.startsWith('predelete/') ? 'pre-delete snapshot'
            : f.fileName.startsWith('prerestore/') ? 'pre-restore snapshot' : 'nightly',
      })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/backups/preview', authenticate, authorize('admin'), (req, res) => {
    jsonParser(req, res, async () => {
      try {
        const { fileId } = req.body || {};
        if (!fileId) return res.status(400).json({ error: 'fileId required' });
        const backup = await downloadBackup(fileId);
        const counts = {};
        for (const [t, rows] of Object.entries(backup.tables || {})) counts[t] = rows.length;
        res.json({ timestamp: backup.timestamp, tables: counts });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  });

  app.post('/api/admin/backups/restore', authenticate, authorize('admin'), (req, res) => {
    jsonParser(req, res, async () => {
      try {
        const { fileId, confirm } = req.body || {};
        if (confirm !== 'RESTORE') return res.status(400).json({ error: "Confirmation required — send { confirm: 'RESTORE' }" });
        if (!fileId) return res.status(400).json({ error: 'fileId required' });
        // Snapshot current state first so even a restore can be undone.
        try { await runBackup(pool, 'addy', 'prerestore/addy'); } catch (e) { console.error('pre-restore snapshot failed:', e.message); }
        const backup = await downloadBackup(fileId);
        const report = await restoreParsedBackup(backup);
        console.log('↩ restore complete from', backup.timestamp);
        res.json({ success: true, backup_timestamp: backup.timestamp, report });
      } catch (e) { console.error('restore failed:', e); res.status(500).json({ error: e.message }); }
    });
  });

  // 3. Serve dashboard-admin.html with the frontend patch script injected,
  //    so the HTML file itself stays untouched.
  app.get(['/dashboard-admin.html', '/dashboard-admin'], (req, res, next) => {
    const file = path.join(__dirname, 'public', 'dashboard-admin.html');
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      res.type('html').send(html.replace('</body>', '<script src="/js/patches.js"></script></body>'));
    });
  });

  console.log('🩹 server patches installed (delete-all guard, backup restore, frontend patch injection)');
}

module.exports = { installServerPatches, installPgHotfixes };

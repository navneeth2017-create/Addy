// ── BACKBLAZE B2 NIGHTLY BACKUP ──────────────────────────────────────────────
// Uses only Node.js built-ins: https, zlib, crypto — no new packages needed
// Backs up all tables in the schema to Backblaze B2
// Retains: 7 daily + 4 weekly backups, deletes anything older

const https  = require('https');
const zlib   = require('zlib');
const crypto = require('crypto');

// ── B2 API helper ─────────────────────────────────────────────────────────────
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
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Authorize with B2 ─────────────────────────────────────────────────────────
async function b2Authorize(keyId, appKey) {
  const auth = Buffer.from(`${keyId}:${appKey}`).toString('base64');
  return b2Request({
    hostname: 'api.backblazeb2.com',
    path: '/b2api/v2/b2_authorize_account',
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` }
  });
}

// ── Get upload URL ─────────────────────────────────────────────────────────────
async function b2GetUploadUrl(apiUrl, authToken, bucketId) {
  const url = new URL(`${apiUrl}/b2api/v2/b2_get_upload_url`);
  return b2Request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' }
  }, { bucketId });
}

// ── Upload file to B2 ──────────────────────────────────────────────────────────
async function b2Upload(uploadUrl, uploadAuthToken, fileName, data) {
  const url = new URL(uploadUrl);
  const sha1 = crypto.createHash('sha1').update(data).digest('hex');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        Authorization: uploadAuthToken,
        'X-Bz-File-Name': encodeURIComponent(fileName),
        'Content-Type': 'application/gzip',
        'Content-Length': data.length,
        'X-Bz-Content-Sha1': sha1,
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (res.statusCode >= 400) reject(new Error(parsed.message || `Upload error ${res.statusCode}`));
          else resolve(parsed);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── List files in bucket ───────────────────────────────────────────────────────
async function b2ListFiles(apiUrl, authToken, bucketId, prefix) {
  const url = new URL(`${apiUrl}/b2api/v2/b2_list_file_names`);
  return b2Request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' }
  }, { bucketId, prefix, maxFileCount: 1000 });
}

// ── Delete file from B2 ───────────────────────────────────────────────────────
async function b2DeleteFile(apiUrl, authToken, fileId, fileName) {
  const url = new URL(`${apiUrl}/b2api/v2/b2_delete_file_version`);
  return b2Request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' }
  }, { fileId, fileName });
}

// ── Export all tables from a schema ───────────────────────────────────────────
async function exportSchema(pool, schema) {
  const client = await pool.connect();
  try {
    // Get all table names in this schema
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [schema]
    );

    const backup = {
      schema,
      timestamp: new Date().toISOString(),
      tables: {}
    };

    for (const { table_name } of tables) {
      const { rows } = await client.query(`SELECT * FROM "${schema}"."${table_name}"`);
      backup.tables[table_name] = rows;
    }

    return backup;
  } finally {
    client.release();
  }
}

// ── Prune old backups (keep 7 daily + 4 weekly) ───────────────────────────────
async function pruneBackups(apiUrl, authToken, bucketId, prefix) {
  const { files } = await b2ListFiles(apiUrl, authToken, bucketId, prefix);
  if (!files || files.length === 0) return;

  // Sort by upload timestamp desc (newest first)
  files.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp);

  // Keep newest 7 (daily) + every 7th after that up to 4 more (weekly)
  const keep = new Set();
  let weeklySaved = 0;
  files.forEach((f, i) => {
    if (i < 7) { keep.add(f.fileId); return; } // keep last 7
    if (weeklySaved < 4 && (i - 6) % 7 === 0) { keep.add(f.fileId); weeklySaved++; } // keep 1/week for 4 weeks
  });

  let deleted = 0;
  for (const f of files) {
    if (!keep.has(f.fileId)) {
      try {
        await b2DeleteFile(apiUrl, authToken, f.fileId, f.fileName);
        deleted++;
      } catch(e) { console.log('Could not delete old backup:', f.fileName); }
    }
  }
  if (deleted > 0) console.log(`🗑  Pruned ${deleted} old backup(s)`);
}

// ── Main backup function ───────────────────────────────────────────────────────
async function runBackup(pool, schema, siteName) {
  const KEY_ID  = process.env.B2_KEY_ID;
  const APP_KEY = process.env.B2_APP_KEY;
  const BUCKET_ID = process.env.B2_BUCKET_ID;

  if (!KEY_ID || !APP_KEY || !BUCKET_ID) {
    console.log('ℹ️  Backblaze backup skipped — B2_KEY_ID, B2_APP_KEY, B2_BUCKET_ID not set');
    return;
  }

  try {
    console.log(`🔄 Starting ${siteName} database backup...`);

    // 1. Export data
    const data = await exportSchema(pool, schema);
    const json = JSON.stringify(data);

    // 2. Compress
    const compressed = await new Promise((res, rej) =>
      zlib.gzip(Buffer.from(json), (err, buf) => err ? rej(err) : res(buf))
    );

    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const fileName = `${siteName}/backup-${siteName}-${dateStr}.json.gz`;

    // 3. Authorize
    const auth = await b2Authorize(KEY_ID, APP_KEY);

    // 4. Get upload URL
    const uploadData = await b2GetUploadUrl(auth.apiUrl, auth.authorizationToken, BUCKET_ID);

    // 5. Upload
    await b2Upload(uploadData.uploadUrl, uploadData.authorizationToken, fileName, compressed);
    const sizeMB = (compressed.length / 1024 / 1024).toFixed(2);
    console.log(`✅ Backup uploaded: ${fileName} (${sizeMB} MB)`);

    // 6. Prune old backups
    await pruneBackups(auth.apiUrl, auth.authorizationToken, BUCKET_ID, `${siteName}/`);

  } catch(e) {
    console.error(`❌ Backup failed for ${siteName}:`, e.message);
    // Never crash the server — backup failure is non-fatal
  }
}

// ── Scheduler: runs at 3am UTC daily ──────────────────────────────────────────
function startBackupScheduler(pool, schema, siteName) {
  let lastBackupDate = null;

  const check = () => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const today = now.toISOString().split('T')[0];

    if (utcHour === 3 && lastBackupDate !== today) {
      lastBackupDate = today;
      runBackup(pool, schema, siteName);
    }
  };

  // Check every hour
  setInterval(check, 60 * 60 * 1000);

  // Also run once on startup if env vars are set (with 30s delay to let DB connect first)
  if (process.env.B2_KEY_ID) {
    setTimeout(() => {
      const today = new Date().toISOString().split('T')[0];
      lastBackupDate = today; // mark so it doesn't double-run at 3am same day
      runBackup(pool, schema, siteName);
    }, 30000);
  }

  console.log(`📦 Backup scheduler started for ${siteName} (runs 3am UTC daily)`);
}

module.exports = { startBackupScheduler, runBackup };

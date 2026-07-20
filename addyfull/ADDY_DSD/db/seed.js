// ──────────────────────────────────────────────────────────────────────────────
// DEV SEED SCRIPT — LOCAL DEVELOPMENT ONLY
// Run manually: node db/seed.js
// ⚠️  NEVER runs automatically in production. Do NOT call this from server.js.
// ──────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run seed script in production. Exiting.');
  process.exit(1);
}

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding dev database...');
    const hash = pw => bcrypt.hashSync(pw, 10);

    // Dev admin account only — add all real data via the admin dashboard
    await client.query(`
      INSERT INTO users (email, password_hash, role, name, phone, status)
      VALUES ('admin@addy.dev', $1, 'admin', 'Dev Admin', '', 'active')
      ON CONFLICT (email) DO NOTHING
    `, [hash('admin123')]);

    console.log('\n✅ Dev seed complete!');
    console.log('  Admin: admin@addy.dev / admin123');
    console.log('  Add products, stores and users via the admin dashboard.');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => { console.error('❌ Seed failed:', err.message); process.exit(1); });

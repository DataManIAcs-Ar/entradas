// v4 - debug
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

module.exports = async function handler(req, res) {
  try {
    const result = await pool.query('SELECT 1 as ok');
    return res.status(200).json({ db: 'connected', rows: result.rows });
  } catch (err) {
    return res.status(500).json({ db: 'failed', error: err.message });
  }
};

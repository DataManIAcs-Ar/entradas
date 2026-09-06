// lib/db.js — conexión a Postgres (Supabase)
//
// Ojo con serverless: cada invocación puede ser un proceso nuevo. El pool
// se crea a nivel de módulo para que las invocaciones "tibias" lo reusen
// en vez de abrir una conexión por request.
//
// Usar SIEMPRE la URL del POOLER de Supabase (puerto 6543, modo
// transaction), no la conexión directa al 5432. Con 700 personas
// comprando, la conexión directa se queda sin slots enseguida.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,                          // por instancia; Vercel escala instancias
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// Corre una función dentro de una transacción. Si tira, rollback.
// Es lo que hace que el chequeo de cupo y el insert de la orden sean
// atómicos: sin esto, dos compras simultáneas leen el mismo disponible
// y las dos pasan.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, tx, pool };

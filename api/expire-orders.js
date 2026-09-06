// api/expire-orders.js — cron cada minuto
//
// Libera el cupo de las órdenes que nunca se pagaron. Sin esto, cada
// persona que abre el checkout y se arrepiente secuestra un lugar para
// siempre y el evento "se agota" con entradas sin vender.

const { query } = require('../lib/db');

module.exports = async function handler(req, res) {
  // Vercel manda este header en los cron jobs. Sin el chequeo,
  // cualquiera puede llamar el endpoint.
  if (process.env.CRON_SECRET &&
      req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'no autorizado' });
  }

  try {
    const rows = await query(
      `update "order"
          set status = 'expired', updated_at = now()
        where status = 'pending' and hold_expires_at < now()
        returning id`);
    if (rows.length) console.log('[expire] liberadas', rows.length);
    return res.status(200).json({ expired: rows.length });
  } catch (err) {
    console.error('[expire]', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

// v5
const { query } = require('../lib/db.js');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  let pending;
  try {
    pending = await query(`
      SELECT eo.id, eo.order_id, eo.to_email, eo.template,
             o.buyer_first_name, o.buyer_last_name, o.code,
             e.name as event_name, e.starts_at
      FROM email_outbox eo
      JOIN "order" o ON o.id = eo.order_id
      JOIN event e   ON e.id = o.event_id
      WHERE eo.status = 'pending'
        AND eo.attempts < 3
      ORDER BY eo.created_at
      LIMIT 10
    `);
  } catch (err) {
    return res.status(500).json({ error: 'db_error', detail: err.message });
  }

  if (!pending || pending.length === 0) {
    return res.status(200).json({ sent: 0, message: 'nothing pending' });
  }

  const results = [];

  for (const row of pending) {
    try {
      const { data, error } = await resend.emails.send({
        from: 'DataManIAcs <noreply@entradas.datamaniacs.com.ar>',
        to: [row.to_email],
        subject: `Tu entrada para ${row.event_name} ✓`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2>¡Hola ${row.buyer_first_name}!</h2>
            <p>Tu entrada para

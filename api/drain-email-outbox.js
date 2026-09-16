import { Resend } from 'resend';
import { query } from '../lib/db.js';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // Only allow GET (for cron) or POST (for manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Fetch up to 10 pending emails
  const { rows: pending } = await query(`
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

  if (pending.length === 0) {
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
            <p>Tu entrada para <strong>${row.event_name}</strong> está confirmada.</p>
            <p style="font-size:24px;font-weight:bold;letter-spacing:4px">${row.code}</p>
            <p>Guardá este código — te lo van a pedir en la puerta.</p>
            <hr>
            <p style="color:#999;font-size:12px">DataManIAcs · entradas.datamaniacs.com.ar</p>
          </div>
        `,
      });

      if (error) throw new Error(JSON.stringify(error));

      await query(`
        UPDATE email_outbox
        SET status = 'sent', sent_at = now(), attempts = attempts + 1
        WHERE id = $1
      `, [row.id]);

      results.push({ id: row.id, to: row.to_email, ok: true });

    } catch (err) {
      await query(`
        UPDATE email_outbox
        SET attempts = attempts + 1,
            last_error = $2,
            status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END
        WHERE id = $1
      `, [row.id, err.message]);

      results.push({ id: row.id, to: row.to_email, ok: false, error: err.message });
    }
  }

  return res.status(200).json({ sent: results.filter(r => r.ok).length, results });
}

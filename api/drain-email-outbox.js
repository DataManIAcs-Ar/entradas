// api/drain-email-outbox.js — v6
// Triggered by cron (every 30 min) or manually via GET/POST
// Sends confirmation emails for paid orders via Resend

const { query } = require('../lib/db.js');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const LOGO_URL = 'https://raw.githubusercontent.com/DataManIAcs-Ar/entradas/main/assets/logo-datamaniacs-gold.png';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  let pending;
  try {
    pending = await query(`
      SELECT
        eo.id, eo.order_id, eo.to_email, eo.template,
        o.buyer_first_name, o.buyer_last_name, o.code as order_code,
        o.total_cents, o.subtotal_cents, o.service_fee_cents,
        e.name  as event_name,
        e.starts_at,
        v.name  as venue_name,
        v.maps_url,
        t.code  as ticket_code,
        tt.name as tier_name
      FROM email_outbox eo
      JOIN "order"      o  ON o.id  = eo.order_id
      JOIN event        e  ON e.id  = o.event_id
      JOIN venue        v  ON v.id  = o.venue_id
      LEFT JOIN ticket  t  ON t.order_id = o.id AND t.id = (SELECT id FROM ticket WHERE order_id = o.id LIMIT 1)
      LEFT JOIN ticket_type tt ON tt.id = t.ticket_type_id
      WHERE eo.status   = 'pending'
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
      const eventDate = row.starts_at
        ? new Date(row.starts_at).toLocaleDateString('es-AR', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            timeZone: 'America/Argentina/Buenos_Aires'
          })
        : '';
      const eventTime = row.starts_at
        ? new Date(row.starts_at).toLocaleTimeString('es-AR', {
            hour: '2-digit', minute: '2-digit',
            timeZone: 'America/Argentina/Buenos_Aires'
          }) + 'hs'
        : '';

      const ticketCode  = row.ticket_code  || row.order_code;
      const tierName    = row.tier_name    || 'Entrada General';
      const totalARS    = (Number(row.total_cents) / 100).toLocaleString('es-AR');
      const mapsUrl     = row.maps_url     || '#';

      const html = `
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tu entrada · ${row.event_name}</title>
</head>
<body style="margin:0;padding:0;background:#0e0d0b;font-family:'Helvetica Neue',Arial,sans-serif">

  <!-- Wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0e0d0b;padding:32px 0">
  <tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">

    <!-- Header with logo -->
    <tr>
      <td align="center" style="padding:0 0 28px">
        <img src="${LOGO_URL}" alt="DataManIAcs" width="160" height="auto"
             style="display:block;opacity:0.9"
             onerror="this.style.display='none'">
      </td>
    </tr>

    <!-- Gold top bar -->
    <tr>
      <td style="background:linear-gradient(135deg,#c9a84c,#e8c97a);height:3px;border-radius:3px 3px 0 0;font-size:0">&nbsp;</td>
    </tr>

    <!-- Main card -->
    <tr>
      <td style="background:#171510;border:1px solid rgba(201,168,76,0.15);border-top:none;border-radius:0 0 16px 16px;padding:36px 40px">

        <!-- Greeting -->
        <p style="color:#c4b89a;font-size:14px;margin:0 0 6px">¡Hola ${row.buyer_first_name}!</p>
        <h1 style="color:#f2ead8;font-size:22px;font-weight:700;margin:0 0 24px;line-height:1.3">
          Tu entrada está confirmada ✓
        </h1>

        <!-- Event block -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:#1e1b16;border:1px solid rgba(201,168,76,0.12);border-radius:12px;margin-bottom:24px">
          <tr>
            <td style="padding:20px 24px">
              <p style="color:#c9a84c;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin:0 0 8px">Evento</p>
              <h2 style="color:#f2ead8;font-size:20px;font-weight:700;margin:0 0 10px;line-height:1.2">${row.event_name}</h2>
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="color:#6b6150;font-size:12px;padding-right:16px">📅</td>
                  <td style="color:#c4b89a;font-size:13px;text-transform:capitalize">${eventDate}</td>
                </tr>
                <tr><td colspan="2" style="height:6px"></td></tr>
                <tr>
                  <td style="color:#6b6150;font-size:12px;padding-right:16px">🕐</td>
                  <td style="color:#c4b89a;font-size:13px">${eventTime}</td>
                </tr>
                <tr><td colspan="2" style="height:6px"></td></tr>
                <tr>
                  <td style="color:#6b6150;font-size:12px;padding-right:16px">📍</td>
                  <td style="color:#c4b89a;font-size:13px">${row.venue_name}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Ticket code block -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:linear-gradient(135deg,rgba(201,168,76,0.08),rgba(201,168,76,0.04));border:1px solid rgba(201,168,76,0.3);border-radius:12px;margin-bottom:24px">
          <tr>
            <td align="center" style="padding:28px 24px">
              <p style="color:#c9a84c;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin:0 0 12px">${tierName}</p>
              <p style="color:#f2ead8;font-size:36px;font-weight:700;letter-spacing:6px;margin:0 0 8px;font-family:'Courier New',monospace">${ticketCode}</p>
              <p style="color:#6b6150;font-size:12px;margin:0">Mostrá este código en la puerta</p>
            </td>
          </tr>
        </table>

        <!-- Price summary -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="border-top:1px solid rgba(255,255,255,0.06);margin-bottom:24px;padding-top:20px">
          <tr>
            <td style="color:#6b6150;font-size:12px;padding:4px 0">Precio entrada</td>
            <td align="right" style="color:#c4b89a;font-size:12px;font-family:'Courier New',monospace">
              $${(Number(row.subtotal_cents)/100).toLocaleString('es-AR')}
            </td>
          </tr>
          <tr>
            <td style="color:#6b6150;font-size:12px;padding:4px 0">Cargo por servicio</td>
            <td align="right" style="color:#c4b89a;font-size:12px;font-family:'Courier New',monospace">
              $${(Number(row.service_fee_cents)/100).toLocaleString('es-AR')}
            </td>
          </tr>
          <tr>
            <td style="color:#f2ead8;font-size:13px;font-weight:600;padding:8px 0 4px;border-top:1px solid rgba(255,255,255,0.06)">Total pagado</td>
            <td align="right" style="color:#c9a84c;font-size:13px;font-weight:700;font-family:'Courier New',monospace;border-top:1px solid rgba(255,255,255,0.06)">
              $${totalARS}
            </td>
          </tr>
        </table>

        <!-- Maps CTA -->
        ${mapsUrl && mapsUrl !== '#' ? `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
          <tr>
            <td align="center">
              <a href="${mapsUrl}" target="_blank"
                 style="display:inline-block;background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.3);color:#c9a84c;text-decoration:none;font-size:13px;font-weight:600;padding:11px 24px;border-radius:8px">
                📍 Cómo llegar al venue →
              </a>
            </td>
          </tr>
        </table>` : ''}

        <!-- Note -->
        <p style="color:#6b6150;font-size:12px;line-height:1.6;margin:0;text-align:center">
          Este email es tu comprobante de compra.<br>
          Guardá el código — te lo van a pedir en la puerta.
        </p>

      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td align="center" style="padding:24px 0 0">
        <p style="color:#4a4035;font-size:11px;margin:0 0 4px">
          DataManIAcs · San Antonio de Areco
        </p>
        <p style="margin:0">
          <a href="https://entradas.datamaniacs.com.ar"
             style="color:#6b6150;font-size:11px;text-decoration:none">
            entradas.datamaniacs.com.ar
          </a>
        </p>
      </td>
    </tr>

  </table>
  </td></tr>
  </table>

</body>
</html>`;

      const { data, error } = await resend.emails.send({
        from: 'DataManIAcs Entradas <noreply@entradas.datamaniacs.com.ar>',
        to: [row.to_email],
        subject: `✓ Tu entrada para ${row.event_name} — ${ticketCode}`,
        html,
      });

      if (error) throw new Error(JSON.stringify(error));

      await query(`
        UPDATE email_outbox
        SET status = 'sent', sent_at = now(), attempts = attempts + 1
        WHERE id = $1
      `, [row.id]);

      results.push({ id: row.id, to: row.to_email, ok: true, resend_id: data?.id });

    } catch (err) {
      await query(`
        UPDATE email_outbox
        SET attempts = attempts + 1,
            last_error = $2,
            status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END
        WHERE id = $1
      `, [row.id, err.message?.slice(0, 500)]);

      results.push({ id: row.id, to: row.to_email, ok: false, error: err.message });
    }
  }

  return res.status(200).json({ sent: results.filter(r => r.ok).length, results });
};

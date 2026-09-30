// api/mp-webhook.js
const { tx, query } = require('../lib/db');
const { getPayment } = require('../lib/mp');
const crypto = require('crypto');

const SHEET_ID  = '1Tmrr6lxD7n0wp3x87wUdy-vP-tuDGU8DCvMmIh9UciI';
const SHEET_TAB = 'Tickets_Entradas';

function validateSignature({ xSignature, xRequestId, dataId, secret }) {
  if (!xSignature || !secret) return false;
  try {
    const parts = {};
    xSignature.split(',').forEach(p => {
      const [k, v] = p.trim().split('=');
      if (k && v) parts[k.trim()] = v.trim();
    });
    const ts = parts['ts'];
    const v1 = parts['v1'];
    if (!ts || !v1) return false;
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch (_) { return false; }
}

// ── Push one row to Google Sheets via Service Account ──────────
async function pushToSheet(row) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    if (!creds.client_email) {
      console.warn('[webhook] GOOGLE_SERVICE_ACCOUNT_JSON not set — skipping sheet push');
      return;
    }

    // Build JWT for Google OAuth2
    const now   = Math.floor(Date.now() / 1000);
    const claim = {
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    // Sign JWT with private key
    const { SignJWT } = await import('jose');
    const privateKey = await (await import('jose')).importPKCS8(creds.private_key, 'RS256');
    const jwt = await new SignJWT(claim)
      .setProtectedHeader({ alg: 'RS256' })
      .sign(privateKey);

    // Exchange JWT for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    const { access_token } = await tokenRes.json();

    // Append row to sheet
    const range = encodeURIComponent(`${SHEET_TAB}!A:U`);
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const appendRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
    });

    if (!appendRes.ok) {
      const err = await appendRes.text();
      console.error('[webhook] sheet append failed:', err);
    } else {
      console.log('[webhook] sheet row appended ✅');
    }
  } catch (err) {
    // Never let a sheet error break the webhook response
    console.error('[webhook] sheet push error:', err.message);
  }
}

module.exports = async function handler(req, res) {
  try {
    const body   = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const q      = req.query || {};
    const dataId = q['data.id'] || q.id || body?.data?.id;

    // 1. Validate signature
    const ok = validateSignature({
      xSignature: req.headers['x-signature'],
      xRequestId: req.headers['x-request-id'],
      dataId,
      secret: process.env.MP_WEBHOOK_SECRET,
    });
    if (!ok) {
      console.warn('[webhook] firma inválida', { dataId });
      return res.status(401).json({ error: 'firma inválida' });
    }

    const topic = body.type || body.topic || q.topic;
    if (topic !== 'payment') return res.status(200).json({ ignored: topic });
    if (!dataId)             return res.status(200).json({ ignored: 'sin data.id' });

    // 2. Already processed?
    const known = (await query(
      `select o.id, o.status, o.event_id, v.mp_access_token
         from "order" o join venue v on v.id = o.venue_id
        where o.mp_payment_id = $1`, [String(dataId)]))[0];

    if (known && known.status === 'paid') {
      return res.status(200).json({ ok: true, already: true });
    }

    // 3. Fetch payment from MP
    let payment = null;
    const venues = await query(
      `select id, mp_access_token from venue
        where mp_access_token is not null and status = 'active'`);

    for (const v of venues) {
      try {
        const p = await getPayment({ accessToken: v.mp_access_token, paymentId: dataId });
        if (p && p.id) { payment = p; break; }
      } catch (_) {}
    }

    if (!payment && process.env.MP_ACCESS_TOKEN) {
      try {
        const p = await getPayment({ accessToken: process.env.MP_ACCESS_TOKEN, paymentId: dataId });
        if (p && p.id) payment = p;
      } catch (_) {}
    }

    if (!payment) {
      console.warn('[webhook] pago no encontrado', { dataId });
      return res.status(200).json({ ok: true, unknown: true });
    }

    const orderId = payment.external_reference;
    if (!orderId) return res.status(200).json({ ok: true, no_ref: true });

    // 4. Apply payment
    const minted = await tx(async (c) => {
      const ord = (await c.query(
        `select * from "order" where id = $1 for update`, [orderId])).rows[0];
      if (!ord)                  return { skipped: 'orden inexistente' };
      if (ord.status === 'paid') return { skipped: 'ya pagada' };

      if (payment.status !== 'approved') {
        await c.query(
          `update "order" set mp_status = $1, mp_status_detail = $2, updated_at = now()
            where id = $3`,
          [payment.status, payment.status_detail || null, orderId]);
        return { skipped: `estado ${payment.status}` };
      }

      const paidCents = payment.amount_cents;
      if (paidCents !== Number(ord.total_cents)) {
        console.error('[webhook] monto no coincide', { orderId, esperado: ord.total_cents, recibido: paidCents });
        return { skipped: 'monto no coincide' };
      }

      let mpFeeActual = null;
      const mpFee = (payment.fee_details || [])
        .filter(d => d.type === 'mercadopago_fee')
        .reduce((s, d) => s + Number(d.amount || 0), 0);
      if (mpFee > 0) mpFeeActual = Math.round(mpFee * 100);

      await c.query(
        `update "order"
            set status = 'paid', mp_payment_id = $1, mp_status = $2,
                mp_status_detail = $3, mp_fee_actual_cents = $4,
                paid_at = now(), updated_at = now()
          where id = $5`,
        [String(payment.id), payment.status, payment.status_detail || null,
         mpFeeActual, orderId]);

      // Issue tickets
      const secret = process.env.TICKET_SECRET;
      const lines  = (await c.query(
        `select oi.ticket_type_id, oi.quantity
           from order_item oi where oi.order_id = $1`, [orderId])).rows;

      let n = 0;
      let firstTicketCode = null;
      for (const l of lines) {
        for (let i = 0; i < l.quantity; i++) {
          const id  = crypto.randomUUID();
          const seq = (await c.query(`select nextval('ticket_code_seq') as n`)).rows[0].n;
          const code = 'ARC-' + Number(seq).toString(36).toUpperCase().padStart(4, '0');
          if (!firstTicketCode) firstTicketCode = code;
          const sig  = crypto.createHmac('sha256', secret).update(id).digest('hex');
          await c.query(
            `insert into ticket (id, order_id, event_id, ticket_type_id, code, qr_token, status)
             values ($1,$2,$3,$4,$5,$6,'valid')`,
            [id, orderId, ord.event_id, l.ticket_type_id, code, `${id}.${sig}`]);
          n++;
        }
      }

      // Queue confirmation email
      await c.query(
        `insert into email_outbox (order_id, to_email, template)
         values ($1, $2, 'confirmacion')`,
        [orderId, ord.buyer_email]);

      // Fetch event + venue name for sheet
      const evRow = (await c.query(
        `select e.name as event_name, e.starts_at,
                v.name as venue_name
           from event e join venue v on v.id = e.venue_id
          where e.id = $1`, [ord.event_id])).rows[0];

      // Detect device from payment metadata (best effort)
      const device = payment.additional_info?.payer?.authentication_type || 'online';

      // Build sheet row — must match column order in Tickets_Entradas exactly
      const paidAt   = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const eventDate = evRow?.starts_at
        ? new Date(evRow.starts_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
        : '';
      const totalQty = lines.reduce((s, l) => s + l.quantity, 0);

      const sheetRow = [
        paidAt,                                          // Fecha y hora pago
        ord.code,                                        // Código orden
        firstTicketCode || '',                           // Código ticket
        ord.buyer_first_name,                            // Nombre
        ord.buyer_last_name,                             // Apellido
        ord.buyer_email,                                 // Email
        (ord.buyer_phone ? '+549' + ord.buyer_phone : ''),  // Teléfono
        ord.buyer_dni   || '',                           // DNI
        totalQty,                                        // Cantidad
        Number(ord.subtotal_cents)    / 100,             // Subtotal (ARS)
        Number(ord.service_fee_cents) / 100,             // Cargo servicio (ARS)
        Number(ord.total_cents)       / 100,             // Total (ARS)
        Number(ord.venue_net_cents)   / 100,             // Venue recibe (ARS)
        ord.payment_method,                              // Tipo pago
        'Confirmado',                                    // Estado
        evRow?.event_name || ord.event_id,               // Evento
        eventDate,                                       // Fecha del evento
        evRow?.venue_name || '',                         // Venue
        ord.channel || 'online',                         // Canal
        String(payment.id),                              // MP Payment ID
        device,                                          // Dispositivo
        ord.notif_venue  ? 'Yes' : 'No',                 // Notif. Venue
        ord.notif_artist ? 'Yes' : 'No',                 // Notif. Artista
      ];

      return { minted: n, sheetRow, ord };
    });

    // Push to sheet outside the transaction
    if (minted.sheetRow) {
      await pushToSheet(minted.sheetRow);
    }

    console.log('[webhook] ok', { orderId, minted: minted.minted });
    return res.status(200).json({ ok: true, minted: minted.minted });

  } catch (err) {
    console.error('[webhook] error', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

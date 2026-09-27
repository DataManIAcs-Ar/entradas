// api/mp-webhook.js
const { tx, query } = require('../lib/db');
const { getPayment } = require('../lib/mp');
const crypto = require('crypto');

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

module.exports = async function handler(req, res) {
  try {
    const body   = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const q      = req.query || {};
    const dataId = q['data.id'] || q.id || body?.data?.id;

    // 1. FIRMA
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

    // 2. ¿Ya procesamos este pago?
    const known = (await query(
      `select o.id, o.status, o.event_id, v.mp_access_token
         from "order" o join venue v on v.id = o.venue_id
        where o.mp_payment_id = $1`, [String(dataId)]))[0];

    if (known && known.status === 'paid') {
      return res.status(200).json({ ok: true, already: true });
    }

    // 3. Buscar el pago en los venues activos
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

    // Also try with platform token if no venue token worked
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

    // 4. Aplicar el pago
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

      const paidCents = Math.round(Number(payment.transaction_amount) * 100);
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

      // Emitir entradas
      const secret = process.env.TICKET_SECRET;
      const lines  = (await c.query(
        `select ticket_type_id, quantity from order_item where order_id = $1`,
        [orderId])).rows;

      let n = 0;
      for (const l of lines) {
        for (let i = 0; i < l.quantity; i++) {
          const id  = crypto.randomUUID();
          const seq = (await c.query(`select nextval('ticket_code_seq') as n`)).rows[0].n;
          const code = 'ARC-' + Number(seq).toString(36).toUpperCase().padStart(4, '0');
          const sig  = crypto.createHmac('sha256', secret).update(id).digest('hex');
          await c.query(
            `insert into ticket (id, order_id, event_id, ticket_type_id, code, qr_token, status)
             values ($1,$2,$3,$4,$5,$6,'valid')`,
            [id, orderId, ord.event_id, l.ticket_type_id, code, `${id}.${sig}`]);
          n++;
        }
      }

      // Encolar email en la MISMA transacción
      await c.query(
        `insert into email_outbox (order_id, to_email, template)
         values ($1, $2, 'confirmacion')`,
        [orderId, ord.buyer_email]);

      return { minted: n };
    });

    console.log('[webhook] ok', { orderId, ...minted });
    return res.status(200).json({ ok: true, ...minted });

  } catch (err) {
    console.error('[webhook] error', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

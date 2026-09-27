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
    const ts  = parts['ts'];
    const v1  = parts['v1'];
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

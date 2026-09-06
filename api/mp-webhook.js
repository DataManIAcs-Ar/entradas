// api/mp-webhook.js
//
// Punto donde el dinero se convierte en entradas. Todo lo demás es
// formulario; esto es lo que no puede fallar.
//
// REGLAS:
//   1. Validar x-signature ANTES de mirar el body.
//   2. No confiar en el body: MP manda un id, el estado se PREGUNTA.
//   3. Idempotente: MP reintenta. Dos webhooks del mismo pago tienen
//      que producir un solo juego de entradas.
//   4. Responder 200 rápido. Un 500 hace que MP reintente en loop.

const { tx, query } = require('../lib/db');
const { validateSignature, getPayment } = require('../lib/mp');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  try {
    const body   = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const q      = req.query || {};
    const dataId = q['data.id'] || q.id || body?.data?.id;

    // ── 1. FIRMA ───────────────────────────────────────────────────
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

    // Solo nos interesan pagos.
    const topic = body.type || body.topic || q.topic;
    if (topic !== 'payment') return res.status(200).json({ ignored: topic });
    if (!dataId)             return res.status(200).json({ ignored: 'sin data.id' });

    // ── 2. ¿DE QUÉ VENUE ES ESTE PAGO? ─────────────────────────────
    // El pago vive en la cuenta del venue, así que hay que consultarlo
    // con SU token. Primero miramos si ya lo procesamos.
    const known = (await query(
      `select o.id, o.status, o.event_id, v.mp_access_token
         from "order" o join venue v on v.id = o.venue_id
        where o.mp_payment_id = $1`, [String(dataId)]))[0];

    if (known && known.status === 'paid') {
      // Reintento de MP sobre algo ya procesado. Todo bien.
      return res.status(200).json({ ok: true, already: true });
    }

    // Todavía no lo vimos: hay que averiguar el venue por otro lado.
    // Probamos con cada venue que tenga token activo — en la práctica
    // son pocos, y el external_reference confirma cuál es.
    let payment = null;
    const venues = await query(
      `select id, mp_access_token from venue
        where mp_access_token is not null and status = 'active'`);

    for (const v of venues) {
      try {
        const p = await getPayment({ accessToken: v.mp_access_token, paymentId: dataId });
        if (p && p.id) { payment = p; break; }
      } catch (_) { /* no es de este venue, seguimos */ }
    }

    if (!payment) {
      console.warn('[webhook] pago no encontrado en ningún venue', { dataId });
      return res.status(200).json({ ok: true, unknown: true });
    }

    const orderId = payment.external_reference;
    if (!orderId) return res.status(200).json({ ok: true, no_ref: true });

    // ── 3. APLICAR ─────────────────────────────────────────────────
    const minted = await tx(async (c) => {
      // Lock de la orden: si llegan dos webhooks a la vez, el segundo
      // espera y ve la orden ya pagada.
      const ord = (await c.query(
        `select * from "order" where id = $1 for update`, [orderId])).rows[0];
      if (!ord) return { skipped: 'orden inexistente' };
      if (ord.status === 'paid') return { skipped: 'ya pagada' };

      // Estado real, según MP y no según el body.
      if (payment.status !== 'approved') {
        await c.query(
          `update "order" set mp_status = $1, mp_status_detail = $2, updated_at = now()
            where id = $3`,
          [payment.status, payment.status_detail || null, orderId]);
        return { skipped: `estado ${payment.status}` };
      }

      // El monto tiene que coincidir. Si no, algo está mal y no
      // emitimos nada: mejor un reclamo que entradas regaladas.
      const paidCents = Math.round(Number(payment.transaction_amount) * 100);
      if (paidCents !== Number(ord.total_cents)) {
        console.error('[webhook] monto no coincide', {
          orderId, esperado: ord.total_cents, recibido: paidCents });
        return { skipped: 'monto no coincide' };
      }

      // Arancel real de MP, si viene en la respuesta. Es lo que nos
      // deja medir el desvío contra el estimado de la garantía.
      let mpFeeActual = null;
      const details = payment.fee_details || [];
      const mpFee = details.filter(d => d.type === 'mercadopago_fee')
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

      // ── EMITIR ENTRADAS ─────────────────────────────────────────
      // Una fila por persona: cada una se escanea sola y una sola vez.
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

          // <uuid>.<hmac> — el lector de puerta parte, recalcula el
          // HMAC con el secreto compartido y valida SIN consultar la
          // base. Es lo que permite escanear sin señal.
          const sig = crypto.createHmac('sha256', secret).update(id).digest('hex');

          await c.query(
            `insert into ticket (id, order_id, event_id, ticket_type_id,
                                 code, qr_token, status)
             values ($1,$2,$3,$4,$5,$6,'valid')`,
            [id, orderId, ord.event_id, l.ticket_type_id, code, `${id}.${sig}`]);
          n++;
        }
      }
      return { minted: n };
    });

    // TODO: mandar el mail de confirmación acá (Resend u otro).
    // MailApp de Gmail no sirve: 100 por día no sobrevive una noche.

    console.log('[webhook] ok', { orderId, ...minted });
    return res.status(200).json({ ok: true, ...minted });

  } catch (err) {
    // 500 hace que MP reintente. Está bien: preferimos el reintento a
    // perder un pago. Pero hay que mirar los logs.
    console.error('[webhook] error', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

// lib/mp.js — helpers de Mercado Pago
//
// Split de Pagos 1:1: la preference se crea con el ACCESS TOKEN DEL VENUE
// (obtenido por OAuth), no con el nuestro. El marketplace_fee es lo que
// nos queda a nosotros. La plata nunca pasa por nuestra cuenta.

const crypto = require('crypto');

const MP_API = 'https://api.mercadopago.com';

// ── VALIDACIÓN DE FIRMA ────────────────────────────────────────────
// Sin esto, cualquiera que descubra la URL del webhook puede mandar un
// "pago aprobado" falso y fabricar entradas gratis. Es la pieza de
// seguridad más importante de todo el sistema.
//
// Manifest documentado:  id:{data.id};request-id:{x-request-id};ts:{ts};
//
// Dos detalles que rompen la validación en producción aunque funcione
// en test:
//   1. data.id va en MINÚSCULAS en el manifest (los ids numéricos no
//      se notan, los alfanuméricos sí).
//   2. Si falta data.id o x-request-id, hay que OMITIR ese par entero
//      del manifest, no dejarlo vacío.
function validateSignature({ xSignature, xRequestId, dataId, secret }) {
  if (!xSignature || !secret) return false;

  let ts = null, v1 = null;
  for (const part of String(xSignature).split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 'ts') ts = v;
    else if (k === 'v1') v1 = v;
  }
  if (!ts || !v1) return false;

  const parts = [];
  if (dataId)     parts.push(`id:${String(dataId).toLowerCase()};`);
  if (xRequestId) parts.push(`request-id:${xRequestId};`);
  parts.push(`ts:${ts};`);
  const manifest = parts.join('');

  const expected = crypto.createHmac('sha256', secret)
                         .update(manifest)
                         .digest('hex');

  // timingSafeEqual y no ===, para no filtrar información por el
  // tiempo que tarda la comparación.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── PREFERENCE (Checkout Pro) ──────────────────────────────────────
async function createPreference({ accessToken, order, event, venue, items, baseUrl }) {
  const body = {
    items: items.map(it => ({
      title:       `${event.name} · ${it.tier_name}`,
      quantity:    it.quantity,
      unit_price:  it.unit_price_cents / 100,   // MP va en PESOS, no centavos
      currency_id: 'ARS',
    })),

    payer: {
      name:    order.buyer_first_name,
      surname: order.buyer_last_name,
      email:   order.buyer_email,
    },

    // El id de la orden viaja a MP y vuelve en el webhook. Es lo que
    // ata el pago a la compra sin adivinar por monto ni por nombre.
    external_reference: order.id,

    // Nuestra comisión, en pesos. Sale de calc_fees() en la base:
    // una sola fórmula, un solo lugar.
    marketplace_fee: order.platform_fee_cents / 100,

    notification_url: `${baseUrl}/api/mp-webhook`,
    back_urls: {
      success: `${baseUrl}/${venue.slug}/gracias?order=${order.id}`,
      pending: `${baseUrl}/${venue.slug}/gracias?order=${order.id}`,
      failure: `${baseUrl}/${venue.slug}/${event.slug}?error=1`,
    },
    auto_return: 'approved',

    // ── SOLO DINERO EN CUENTA ──────────────────────────────────────
    // purpose 'wallet_purchase' obliga a pagar con cuenta de Mercado
    // Pago. Es la decisión que baja el arancel de ~7,6% (tarjeta) a
    // ~1,2%, y lo que hace sostenible garantizarle 94% al venue.
    purpose: 'wallet_purchase',
    payment_methods: {
      excluded_payment_types: [
        { id: 'credit_card' },
        { id: 'debit_card' },
        { id: 'ticket' },       // Rapipago / Pago Fácil
        { id: 'atm' },
      ],
      installments: 1,
    },

    // La preference vence junto con el hold del cupo. Si no, alguien
    // paga a las tres horas una entrada que ya vendimos.
    expires: true,
    expiration_date_to: new Date(order.hold_expires_at).toISOString(),
  };

  const res = await fetch(`${MP_API}/checkout/preferences`, {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${accessToken}`,
      'Content-Type':    'application/json',
      'X-Idempotency-Key': order.id,      // reintentos no duplican
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`MP preference ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;   // { id, init_point, sandbox_init_point, ... }
}

// ── CONSULTA DE PAGO ───────────────────────────────────────────────
// NUNCA confiar en el body del webhook. MP manda el id; el estado se
// pregunta. El body podría venir de cualquiera.
async function getPayment({ accessToken, paymentId }) {
  const res = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`MP getPayment ${res.status}`);
  }
  return res.json();
}

// ── OAUTH ──────────────────────────────────────────────────────────
// El access_token del venue vence. Refrescarlo ANTES de que expire:
// si vence en plena venta, el venue deja de poder cobrar.
async function refreshToken({ refreshToken }) {
  const res = await fetch(`${MP_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'refresh_token',
      client_id:     process.env.MP_CLIENT_ID,
      client_secret: process.env.MP_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`MP refreshToken ${res.status}`);
  return res.json();
}

module.exports = { validateSignature, createPreference, getPayment, refreshToken, MP_API };

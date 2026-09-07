// lib/mp.j
//
// Todo lo que le hablamos a Mercado Pago vive acá.
//
// SPLIT DE PAGOS 1:1 — cómo funciona en concreto:
// La preference se crea con el ACCESS TOKEN DEL VENUE, no con el
// nuestro. El dinero entra a la cuenta del venue y `marketplace_fee`
// es lo que MP nos deposita a nosotros. Nunca tocamos la plata: por
// eso el token del venue es un secreto de un tercero y no se loguea
// jamás.
//
// LOS MONTOS. La base trabaja en centavos enteros; MP quiere pesos
// con dos decimales. La conversión pasa UNA sola vez, acá abajo, en
// `pesos()`. Nadie más divide por 100.
//
// EL CONTROL DE SUMA. Si los items no suman exactamente `total_cents`,
// MP cobra un número distinto al que la orden dice y la conciliación
// deja de cerrar. Antes de mandar nada, verificamos. Si no da, se
// rompe acá y no en el resumen de fin de mes.

const MP_API = 'https://api.mercadopago.com';

/**
 * Convierte centavos a pesos con dos decimales.
 * 1260000 → 12600.00
 */
function pesos(cents) {
  return Number((Number(cents) / 100).toFixed(2));
}

/**
 * Crea la preference de Checkout Pro para una orden ya guardada.
 *
 * @param {string} accessToken  token OAuth del VENUE (no el nuestro)
 * @param {object} order        fila de "order" recién insertada
 * @param {object} event        { name, slug }
 * @param {object} venue        { slug }
 * @param {array}  items        [{ tier_name, quantity, unit_price_cents }]
 * @param {string} baseUrl      PUBLIC_BASE_URL, sin barra final
 * @returns {{ id: string, init_point: string }}
 */
async function createPreference({ accessToken, order, event, venue, items, baseUrl }) {
  if (!accessToken) throw new Error('mp: falta el access token del venue');
  if (!baseUrl)     throw new Error('mp: falta PUBLIC_BASE_URL');

  const base = String(baseUrl).replace(/\/+$/, '');

  // ── LOS RENGLONES ────────────────────────────────────────────────
  // Un renglón por tier, más el cargo por servicio APARTE. Va separado
  // a propósito: el comprador tiene que ver en el checkout de MP el
  // mismo desglose que vio en nuestra pantalla. Un total que aparece
  // distinto del que aceptó es la forma más rápida de que abandone.
  const mpItems = items.map((l) => ({
    id:          l.ticket_type_id,
    title:       event.name + ' · ' + l.tier_name,
    quantity:    Number(l.quantity),
    unit_price:  pesos(l.unit_price_cents),
    currency_id: 'ARS',
  }));

  if (Number(order.service_fee_cents) > 0) {
    mpItems.push({
      id:          'service_fee',
      title:       'Cargo por servicio',
      quantity:    1,
      unit_price:  pesos(order.service_fee_cents),
      currency_id: 'ARS',
    });
  }

  // ── CONTROL DE SUMA ──────────────────────────────────────────────
  // En centavos, que es donde la aritmética es exacta.
  const sumaCents = items.reduce(
    (a, l) => a + Number(l.unit_price_cents) * Number(l.quantity), 0
  ) + Number(order.service_fee_cents);

  if (sumaCents !== Number(order.total_cents)) {
    throw new Error(
      'mp: los items suman ' + sumaCents +
      ' pero la orden dice ' + order.total_cents + ' centavos'
    );
  }

  const body = {
    items: mpItems,
    external_reference: order.id,          // el webhook busca por acá

    payer: {
      name:    order.buyer_first_name,
      surname: order.buyer_last_name,
      email:   order.buyer_email,
    },

    // Nuestra comisión, como MONTO ABSOLUTO en pesos. Absoluto y no
    // porcentaje a propósito: así no depende de si MP lo calcularía
    // sobre el bruto o sobre el neto.
    marketplace_fee: pesos(order.platform_fee_cents),

    back_urls: {
      success: base + '/gracias?code=' + encodeURIComponent(order.code),
      pending: base + '/gracias?code=' + encodeURIComponent(order.code),
      failure: base + '/' + venue.slug + '/' + event.slug + '?pago=fallido',
    },
    auto_return: 'approved',

    notification_url: base + '/api/mp-webhook',

    // La preference vence CON el hold. Si vencieran distinto, existiría
    // una ventana en la que el cupo ya volvió al pool pero el link de
    // pago sigue vivo: alguien paga una entrada que ya no existe.
    expires: true,
    expiration_date_to: new Date(order.hold_expires_at).toISOString(),

    statement_descriptor: 'ENTRADAS',

    metadata: {
      order_id:   order.id,
      order_code: order.code,
      event_slug: event.slug,
      venue_slug: venue.slug,
    },
  };

  const r = await fetch(MP_API + '/checkout/preferences', {
    method: 'POST',
    headers: {
      'Authorization':   'Bearer ' + accessToken,
      'Content-Type':    'application/json',
      // Si Vercel reintenta la función, MP no crea una preference
      // duplicada: devuelve la misma.
      'X-Idempotency-Key': order.id,
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    // NUNCA loguear el token. El mensaje de MP sí, que es lo que
    // hace falta para entender qué rechazó.
    console.error('[mp] preference rechazada', r.status, data && data.message);
    throw new Error('mp: ' + (data.message || ('HTTP ' + r.status)));
  }

  return { id: data.id, init_point: data.init_point };
}

/**
 * Reconsulta un pago contra la API de MP.
 * El webhook NUNCA confía en el payload que llega: solo toma el id y
 * vuelve a preguntar. Lo que MP responde acá es la verdad.
 */
async function getPayment({ accessToken, paymentId }) {
  const r = await fetch(MP_API + '/v1/payments/' + paymentId, {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('mp: no se pudo leer el pago ' + paymentId);

  // fee_details trae el arancel REAL. Es lo que después se compara
  // contra mp_fee_bps_estimate para detectar que un venue cambió su
  // fecha de liberación.
  const arancelCents = Math.round(
    (data.fee_details || [])
      .filter((f) => f.type === 'mercadopago_fee')
      .reduce((a, f) => a + Number(f.amount || 0), 0) * 100
  );

  return {
    id:                 String(data.id),
    status:             data.status,
    status_detail:      data.status_detail,
    external_reference: data.external_reference,
    amount_cents:       Math.round(Number(data.transaction_amount || 0) * 100),
    mp_fee_cents:       arancelCents,
    raw:                data,
  };
}

module.exports = { createPreference, getPayment, pesos };

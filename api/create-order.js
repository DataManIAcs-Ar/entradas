// api/create-order.js
//
// Crea la orden, reserva el cupo y devuelve cómo pagar.
//
// DOS CAMINOS SEGÚN EL MÉTODO DE PAGO:
//
//   mp_checkout  → eventos grandes. Crea la preference de Mercado Pago
//                  y devuelve el link de pago. Hold de 15 minutos.
//
//   transfer     → eventos chicos. No toca Mercado Pago: devuelve un
//                  CÓDIGO y el alias. El comprador transfiere pegando
//                  el código en el motivo, y después se concilia con
//                  el extracto. Hold de 48 horas, porque una
//                  transferencia manual no se hace en 15 minutos.
//
// ORDEN DE OPERACIONES (para mp_checkout):
//   1. transacción: lock del tier → cupo → insert de la orden
//   2. commit
//   3. recién ahí, llamar a Mercado Pago
//
// Si el paso 3 falla, la orden queda pending y expira sola. El cupo
// vuelve. Nadie pagó de más y nada quedó a medias.

const { tx, query } = require('../lib/db');
const { createPreference } = require('../lib/mp');

const HOLD = { mp_checkout: '15 minutes', transfer: '48 hours' };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { event_id, items, buyer } = body;

    const method = body.payment_method === 'transfer' ? 'transfer' : 'mp_checkout';

    if (!event_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'faltan event_id o items' });
    }
    if (!buyer || !buyer.first_name || !buyer.last_name || !buyer.email) {
      return res.status(400).json({ error: 'faltan datos del comprador' });
    }

    const result = await tx(async (c) => {
      const ev = (await c.query(
        `select e.id, e.slug, e.name, e.status,
                v.id as venue_id, v.slug as venue_slug,
                v.mp_access_token
           from event e join venue v on v.id = e.venue_id
          where e.id = $1`, [event_id])).rows[0];

      if (!ev)                     throw httpErr(404, 'evento inexistente');
      if (ev.status !== 'on_sale') throw httpErr(409, 'evento no está a la venta');
      if (method === 'mp_checkout' && !ev.mp_access_token) {
        throw httpErr(409, 'el venue no vinculó Mercado Pago');
      }

      let subtotal = 0;
      const lines  = [];

      for (const it of items) {
        const qty = parseInt(it.quantity, 10);
        if (!(qty > 0)) throw httpErr(400, 'cantidad inválida');

        // ── EL LOCK ────────────────────────────────────────────────
        // Serializa a todos los que compran ESTE tier: el segundo
        // espera al primero y lee el cupo ya actualizado. Sin esto se
        // vende dos veces el mismo último lugar.
        const tt = (await c.query(
          `select id, name, price_cents, quantity, max_per_order,
                  sales_start_at, sales_end_at, status
             from ticket_type
            where id = $1 and event_id = $2
            for update`, [it.ticket_type_id, event_id])).rows[0];

        if (!tt)                    throw httpErr(404, 'tipo de entrada inexistente');
        if (tt.status !== 'active') throw httpErr(409, tt.name + ' no está disponible');
        if (qty > tt.max_per_order) throw httpErr(400, 'máximo ' + tt.max_per_order + ' por compra');

        const now = new Date();
        if (tt.sales_start_at && now < tt.sales_start_at) throw httpErr(409, tt.name + ' todavía no está a la venta');
        if (tt.sales_end_at   && now > tt.sales_end_at)   throw httpErr(409, tt.name + ' ya cerró');

        // Cupo tomado = pagas + propuestas + pendientes vigentes.
        // Las vencidas no cuentan: su lugar ya volvió al pool.
        if (tt.quantity !== null) {
          const taken = parseInt((await c.query(
            `select coalesce(sum(oi.quantity),0) as n
               from order_item oi
               join "order" o on o.id = oi.order_id
              where oi.ticket_type_id = $1
                and (o.status in ('paid','proposed')
                     or (o.status = 'pending' and o.hold_expires_at > now()))`,
            [tt.id])).rows[0].n, 10);

          if (taken + qty > tt.quantity) {
            throw httpErr(409, 'quedan ' + Math.max(0, tt.quantity - taken) + ' de ' + tt.name);
          }
        }

        subtotal += tt.price_cents * qty;
        lines.push({ ticket_type_id: tt.id, tier_name: tt.name,
                     quantity: qty, unit_price_cents: tt.price_cents });
      }

      // ── COMISIONES ────────────────────────────────────────────────
      // calc_fees recibe el PRECIO DE CARA y devuelve las cuatro patas:
      // cargo al comprador, total, arancel de MP y nuestra comisión.
      // La app no calcula plata: una sola fórmula, en la base.
      const f = (await c.query(
        `select * from calc_fees($1::bigint, $2::uuid)`, [subtotal, event_id])).rows[0];

      if (f.guarantee_met === false) {
        console.warn('[fees] garantía no alcanzada', { event_id: event_id, subtotal: subtotal });
      }

      // El código va SIEMPRE, aunque pague por Mercado Pago: sirve de
      // referencia para el comprador y para soporte.
      const code = (await c.query(
        `select 'ENT-' || short_code(nextval('order_code_seq')) as code`)).rows[0].code;

      const ord = (await c.query(
        `insert into "order" (
           event_id, venue_id, code, payment_method,
           buyer_first_name, buyer_last_name, buyer_email, buyer_phone, buyer_dni,
           subtotal_cents, service_fee_cents, total_cents,
           platform_fee_cents, mp_fee_estimated_cents, venue_net_cents,
           pricing_model, status, hold_expires_at, channel
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   'pending', now() + $17::interval, $18)
         returning *`,
        [event_id, ev.venue_id, code, method,
         buyer.first_name, buyer.last_name, buyer.email,
         buyer.phone || null, buyer.dni || null,
         subtotal, f.service_fee_cents, f.total_cents,
         f.platform_fee_cents, f.mp_fee_estimated_cents, f.venue_net_cents,
         f.pricing_model, HOLD[method],
         body.channel === 'door' ? 'door' : 'online'])).rows[0];

      for (const l of lines) {
        await c.query(
          `insert into order_item (order_id, ticket_type_id, quantity, unit_price_cents)
           values ($1,$2,$3,$4)`,
          [ord.id, l.ticket_type_id, l.quantity, l.unit_price_cents]);
      }

      return { order: ord, event: ev, lines: lines };
    });

    const o = result.order;

    // Desglose para la pantalla. En Argentina el precio final tiene que
    // estar a la vista, y además un cargo que aparece recién al final es
    // la forma más rápida de perder la venta.
    const desglose = {
      entradas: o.subtotal_cents    / 100,
      servicio: o.service_fee_cents / 100,
      total:    o.total_cents       / 100,
    };

    // ── TRANSFERENCIA: no se toca Mercado Pago ────────────────────
    if (method === 'transfer') {
      return res.status(200).json({
        order_id:   o.id,
        code:       o.code,
        payment:    'transfer',
        alias:      process.env.TRANSFER_ALIAS || null,
        desglose:   desglose,
        expires_at: o.hold_expires_at,
        // Esta instrucción es la que hace que la conciliación funcione:
        // sin el código en el motivo, emparejar es adivinar.
        instrucciones: 'Transferí $' + desglose.total.toLocaleString('es-AR') +
                       ' y poné ' + o.code + ' en el motivo de la transferencia.',
      });
    }

    // ── MERCADO PAGO: fuera de la transacción ─────────────────────
    // Llamar a MP con la transacción abierta dejaría el lock del tier
    // tomado durante toda la latencia de red. Con cientos de personas
    // comprando a la vez, eso es una fila de espera.
    const pref = await createPreference({
      accessToken: result.event.mp_access_token,
      order:   o,
      event:   result.event,
      venue:   { slug: result.event.venue_slug },
      items:   result.lines,
      baseUrl: process.env.PUBLIC_BASE_URL,
    });

    await query(`update "order" set mp_preference_id = $1, updated_at = now()
                  where id = $2`, [pref.id, o.id]);

    return res.status(200).json({
      order_id:   o.id,
      code:       o.code,
      payment:    'mp',
      desglose:   desglose,
      expires_at: o.hold_expires_at,
      init_point: pref.init_point,
    });

  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) console.error('[create-order]', err);
    return res.status(code).json({ error: code === 500 ? 'error interno' : err.message });
  }
};

function httpErr(status, msg) {
  const e = new Error(msg);
  e.statusCode = status;
  return e;
}

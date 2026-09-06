// api/create-order.js
//
// Crea la orden (pending), reserva el cupo y devuelve el link de pago.
//
// ORDEN DE OPERACIONES — importa:
//   1. transacción: lock del tier → chequeo de cupo → insert orden
//   2. commit
//   3. recién ahí, crear la preference en MP
//
// Si el paso 3 falla, la orden queda pending y expira sola en 15
// minutos. El cupo vuelve. Nadie pagó de más y nada quedó a medias.

const { tx, query } = require('../lib/db');
const { createPreference } = require('../lib/mp');

const HOLD_MINUTES = 15;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  try {
    const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { event_id, items, buyer } = body;

    if (!event_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'faltan event_id o items' });
    }
    if (!buyer?.first_name || !buyer?.last_name || !buyer?.email) {
      return res.status(400).json({ error: 'faltan datos del comprador' });
    }

    const result = await tx(async (c) => {
      // Evento + venue en un solo query, y verificamos que esté a la venta.
      const ev = (await c.query(
        `select e.id, e.slug, e.name, e.status,
                v.id as venue_id, v.slug as venue_slug,
                v.mp_access_token, v.mp_user_id
           from event e join venue v on v.id = e.venue_id
          where e.id = $1`, [event_id])).rows[0];

      if (!ev)                     throw httpErr(404, 'evento inexistente');
      if (ev.status !== 'on_sale') throw httpErr(409, 'evento no está a la venta');
      if (!ev.mp_access_token)     throw httpErr(409, 'el venue no vinculó Mercado Pago');

      let subtotal = 0;
      const lines  = [];

      for (const it of items) {
        const qty = parseInt(it.quantity, 10);
        if (!(qty > 0)) throw httpErr(400, 'cantidad inválida');

        // ── EL LOCK ────────────────────────────────────────────────
        // FOR UPDATE serializa a todos los que compran ESTE tier. El
        // segundo comprador espera a que el primero termine, así que
        // lee el cupo ya actualizado. Sin esto se vende dos veces el
        // mismo último lugar.
        const tt = (await c.query(
          `select id, name, price_cents, quantity, max_per_order,
                  sales_start_at, sales_end_at, status
             from ticket_type
            where id = $1 and event_id = $2
            for update`, [it.ticket_type_id, event_id])).rows[0];

        if (!tt)                     throw httpErr(404, 'tipo de entrada inexistente');
        if (tt.status !== 'active')  throw httpErr(409, `${tt.name} no está disponible`);
        if (qty > tt.max_per_order)  throw httpErr(400, `máximo ${tt.max_per_order} por compra`);

        const now = new Date();
        if (tt.sales_start_at && now < tt.sales_start_at) throw httpErr(409, `${tt.name} todavía no está a la venta`);
        if (tt.sales_end_at   && now > tt.sales_end_at)   throw httpErr(409, `${tt.name} ya cerró`);

        // Cupo tomado = pagas + pendientes vigentes. Las vencidas no
        // cuentan: su lugar ya volvió al pool.
        if (tt.quantity !== null) {
          const taken = parseInt((await c.query(
            `select coalesce(sum(oi.quantity),0) as n
               from order_item oi
               join "order" o on o.id = oi.order_id
              where oi.ticket_type_id = $1
                and (o.status = 'paid'
                     or (o.status = 'pending' and o.hold_expires_at > now()))`,
            [tt.id])).rows[0].n, 10);

          if (taken + qty > tt.quantity) {
            throw httpErr(409, `quedan ${Math.max(0, tt.quantity - taken)} de ${tt.name}`);
          }
        }

        subtotal += tt.price_cents * qty;
        lines.push({ ticket_type_id: tt.id, tier_name: tt.name,
                     quantity: qty, unit_price_cents: tt.price_cents });
      }

      // Comisiones: una sola fórmula, en la base.
      const fees = (await c.query(
        `select * from calc_fees($1::bigint, $2::uuid)`, [subtotal, event_id])).rows[0];

      // Señal de que el piso se comió la garantía. No frena la venta,
      // pero queda en el log para revisar el acuerdo.
      if (fees.guarantee_met === false) {
        console.warn('[fees] garantía no alcanzada', { event_id, subtotal });
      }

      const ord = (await c.query(
        `insert into "order" (
           event_id, venue_id,
           buyer_first_name, buyer_last_name, buyer_email, buyer_phone, buyer_dni,
           subtotal_cents, platform_fee_cents, total_cents,
           pricing_model, mp_fee_estimated_cents, venue_net_cents,
           status, hold_expires_at, channel
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',
                   now() + ($14 || ' minutes')::interval, $15)
         returning *`,
        [event_id, ev.venue_id,
         buyer.first_name, buyer.last_name, buyer.email,
         buyer.phone || null, buyer.dni || null,
         subtotal, fees.platform_fee_cents, subtotal,
         fees.pricing_model, fees.mp_fee_estimated_cents, fees.venue_net_cents,
         String(HOLD_MINUTES), body.channel === 'door' ? 'door' : 'online'])).rows[0];

      for (const l of lines) {
        await c.query(
          `insert into order_item (order_id, ticket_type_id, quantity, unit_price_cents)
           values ($1,$2,$3,$4)`,
          [ord.id, l.ticket_type_id, l.quantity, l.unit_price_cents]);
      }

      return { order: ord, event: ev, lines };
    });

    // ── FUERA DE LA TRANSACCIÓN ──────────────────────────────────
    // Llamar a MP con la transacción abierta dejaría el lock del tier
    // tomado durante toda la latencia de red. Con 700 personas
    // comprando, eso es una fila de espera.
    const baseUrl = process.env.PUBLIC_BASE_URL;
    const pref = await createPreference({
      accessToken: result.event.mp_access_token,
      order: result.order,
      event: result.event,
      venue: { slug: result.event.venue_slug },
      items: result.lines,
      baseUrl,
    });

    await query(`update "order" set mp_preference_id = $1, updated_at = now()
                  where id = $2`, [pref.id, result.order.id]);

    return res.status(200).json({
      order_id:   result.order.id,
      total:      result.order.total_cents / 100,
      expires_at: result.order.hold_expires_at,
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

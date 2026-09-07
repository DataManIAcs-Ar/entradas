// api/quote.js
//
// El desglose ANTES de reservar nada.
//
//   POST { event_id, items: [{ ticket_type_id, quantity }] }
//   →    { entradas: 12000, servicio: 600, total: 12600, ... }
//
// POR QUÉ UN ENDPOINT Y NO UNA CUENTA EN EL NAVEGADOR:
// El cargo por servicio se calcula con división entera sobre el
// subtotal. Multiplicar el cargo de una entrada por cuatro NO da lo
// mismo que calcularlo sobre las cuatro juntas — la diferencia son
// centavos, y centavos que difieren entre la pantalla y el cobro son
// exactamente el tipo de cosa que después nadie puede explicar.
// calc_fees es la única fuente de verdad, así que la pantalla también
// pregunta ahí.
//
// ESTO NO RESERVA NADA. No hay lock, no hay insert, no hay hold. Es
// una cotización: se puede llamar en cada cambio del selector de
// cantidad sin ensuciar la base ni secuestrar cupo.

const { query } = require('../lib/db');

// lib/db.js devuelve las filas directamente, no el objeto de node-postgres.
// Esta función acepta las dos formas para que un cambio ahí no rompa acá.
function filas(r) {
  if (!r) return [];
  return Array.isArray(r) ? r : (r.rows || []);
}


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { event_id, items } = body;

    if (!event_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'faltan event_id o items' });
    }
    if (items.length > 10) {
      return res.status(400).json({ error: 'demasiados renglones' });
    }

    let subtotal = 0;
    const lines  = [];

    for (const it of items) {
      const qty = parseInt(it.quantity, 10);
      if (!(qty > 0) || qty > 50) {
        return res.status(400).json({ error: 'cantidad inválida' });
      }

      // El tier tiene que ser DE ESTE evento. Sin esta condición se
      // podría cotizar el precio de un evento con el id de otro.
      const tt = filas(await query(
        `select id, name, price_cents, max_per_order
           from ticket_type
          where id = $1::uuid and event_id = $2::uuid and status = 'active'`,
        [it.ticket_type_id, event_id]
      ))[0];

      if (!tt) return res.status(404).json({ error: 'tipo de entrada inexistente' });
      if (qty > tt.max_per_order) {
        return res.status(400).json({ error: 'máximo ' + tt.max_per_order + ' por compra' });
      }

      subtotal += Number(tt.price_cents) * qty;
      lines.push({
        ticket_type_id: tt.id,
        tier_name:      tt.name,
        quantity:       qty,
        unit_price_cents: Number(tt.price_cents),
        subtotal_cents:   Number(tt.price_cents) * qty,
      });
    }

    const f = filas(await query(
      `select * from calc_fees($1::bigint, $2::uuid)`, [subtotal, event_id]
    ))[0];

    if (!f) return res.status(404).json({ error: 'evento inexistente' });

    // Al comprador solo le importan tres números. El resto —arancel de
    // MP, nuestra comisión, el neto del venue— es información interna
    // y no sale de acá.
    return res.status(200).json({
      lineas: lines,
      desglose: {
        entradas: subtotal / 100,
        servicio: Number(f.service_fee_cents) / 100,
        total:    Number(f.total_cents) / 100,
      },
      cents: {
        subtotal_cents:    subtotal,
        service_fee_cents: Number(f.service_fee_cents),
        total_cents:       Number(f.total_cents),
      },
    });

  } catch (err) {
    console.error('[quote]', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

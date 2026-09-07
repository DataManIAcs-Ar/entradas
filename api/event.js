// api/event.js
//
// Una noche, con sus tiers y el cupo de verdad.
//
//   GET /api/event?venue=chamico&event=gato-abuela-031026
//   GET /api/event?venue=chamico&event=gato-abuela-031026&tt=<uuid>
//
// EL PARÁMETRO `tt`:
// Los tiers con visible=false (la Lista de invitados) no salen en la
// respuesta pública. Con `tt=<uuid>` se agrega ESE tier y solo ese.
// El uuid es el link privado — quien lo tiene, entra; quien no, ni se
// entera de que existe. Es el enganche para promotores más adelante.
//
// LO QUE NUNCA SALE DE ACÁ:
// mp_access_token, mp_refresh_token, mp_user_id. La consulta los
// nombra columna por columna justamente para que un `select *` futuro
// no los filtre sin que nadie lo note.

const { query } = require('../lib/db');

// lib/db.js devuelve las filas directamente, no el objeto de node-postgres.
// Esta función acepta las dos formas para que un cambio ahí no rompa acá.
function filas(r) {
  if (!r) return [];
  return Array.isArray(r) ? r : (r.rows || []);
}


module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  try {
    const q          = req.query || {};
    const venueSlug  = q.venue;
    const eventSlug  = q.event;
    const hiddenTier = q.tt || null;

    if (!venueSlug || !eventSlug) {
      return res.status(400).json({ error: 'faltan venue y event' });
    }

    const ev = filas(await query(
      `select
         e.id, e.slug, e.name, e.tagline, e.description,
         e.starts_at, e.doors_at, e.ends_at,
         coalesce(e.image_urls,'{}') as image_urls,
         e.status,

         v.slug as venue_slug, v.name as venue_name, v.city,
         v.logo_url, v.maps_url, v.tagline as venue_tagline,

         coalesce(e.service_fee_bps, v.service_fee_bps) as service_fee_bps,

         -- booleano, NO el token
         (v.mp_access_token is not null)                as mp_conectado

       from event e
       join venue v on v.id = e.venue_id
      where v.slug = $1 and e.slug = $2 and v.status = 'active'`,
      [venueSlug, eventSlug]
    ))[0];

    if (!ev) return res.status(404).json({ error: 'evento inexistente' });

    // `draft`, `closed` y `cancelled` no se muestran. `sold_out` sí:
    // el que llega por un link viejo merece ver que se agotó, no un 404.
    if (ev.status !== 'on_sale' && ev.status !== 'sold_out') {
      return res.status(404).json({ error: 'evento inexistente' });
    }

    const tiers = filas(await query(
      `select
         a.ticket_type_id  as id,
         a.name,
         tt.description,
         a.price_cents,
         a.quantity,
         a.available,
         tt.max_per_order,
         tt.sales_start_at,
         tt.sales_end_at,
         tt.visible
       from ticket_type_availability a
       join ticket_type tt on tt.id = a.ticket_type_id
      where a.event_id = $1
        and tt.status = 'active'
        and (tt.visible or tt.id = $2::uuid)
      order by tt.sort_order, tt.name`,
      [ev.id, hiddenTier]
    ));

    const now = new Date();

    const entradas = tiers.map((t) => {
      const antes   = t.sales_start_at && now < new Date(t.sales_start_at);
      const despues = t.sales_end_at   && now > new Date(t.sales_end_at);
      const sinCupo = t.quantity !== null && Number(t.available) <= 0;

      return {
        id:            t.id,
        name:          t.name,
        description:   t.description,
        price_cents:   Number(t.price_cents),
        max_per_order: t.max_per_order,
        // available null = sin tope propio
        available:     t.quantity === null ? null : Number(t.available),
        sales_end_at:  t.sales_end_at,
        privado:       !t.visible,
        a_la_venta:    !antes && !despues && !sinCupo,
        motivo:        antes   ? 'todavía no está a la venta'
                     : despues ? 'ya cerró'
                     : sinCupo ? 'agotado'
                     : null,
      };
    });

    const hayStock = entradas.some((t) => t.a_la_venta);

    return res.status(200).json({
      evento: {
        id:          ev.id,
        slug:        ev.slug,
        name:        ev.name,
        tagline:     ev.tagline,
        description: ev.description,
        starts_at:   ev.starts_at,
        doors_at:    ev.doors_at,
        ends_at:     ev.ends_at,
        image_urls:  ev.image_urls,
        agotado:     ev.status === 'sold_out' || !hayStock,
      },
      venue: {
        slug:     ev.venue_slug,
        name:     ev.venue_name,
        city:     ev.city,
        tagline:  ev.venue_tagline,
        logo_url: ev.logo_url,
        maps_url: ev.maps_url,
      },
      entradas: entradas,

      // Qué puede ofrecer la pantalla de pago. Si las dos son false no
      // hay forma de cobrar y la página tiene que decirlo, no mandar al
      // comprador a un formulario que va a fallar al final.
      pago: {
        mercadopago: ev.mp_conectado,
        transferencia: Boolean(process.env.TRANSFER_ALIAS),
      },

      // Solo para MOSTRAR el porcentaje ("+5% de cargo por servicio").
      // Los montos salen de /api/quote, que llama a calc_fees. El
      // frontend no multiplica plata.
      service_fee_bps: ev.service_fee_bps,
    });

  } catch (err) {
    console.error('[event]', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

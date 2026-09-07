// api/events.js
//
// La grilla pública: qué hay a la venta, en todos los venues.
//
// POR QUÉ ESTO EXISTE Y NO SE LEE SUPABASE DIRECTO:
// RLS está activo y sin políticas, así que la clave `anon` no lee
// nada — que es exactamente lo que queremos, porque la tabla venue
// tiene los access tokens de Mercado Pago adentro. El frontend habla
// con estos endpoints y nunca con la base.
//
// QUÉ SALE Y QUÉ NO:
// Solo eventos `on_sale`, futuros, de venues `active`. Solo tiers
// `visible` — la lista de invitados no aparece acá, se entra por link
// directo (ver api/event.js).

const { query } = require('../lib/db');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  try {
    const venue = (req.query && req.query.venue) || null;

    const { rows } = await query(
      `select
         v.slug                                as venue_slug,
         v.name                                as venue_name,
         v.city,
         v.logo_url                            as venue_logo,
         v.maps_url,

         e.id,
         e.slug,
         e.name,
         e.tagline,
         e.starts_at,
         e.doors_at,
         coalesce(e.image_urls, '{}')          as image_urls,

         min(a.price_cents)                    as desde_cents,

         -- Un tier sin tope propio hace que el evento no pueda
         -- agotarse por conteo.
         bool_or(tt.quantity is null)          as cupo_ilimitado,
         coalesce(sum(a.available), 0)::int    as disponibles

       from event e
       join venue v  on v.id = e.venue_id
       join ticket_type tt
              on tt.event_id = e.id
             and tt.visible
             and tt.status = 'active'
       join ticket_type_availability a
              on a.ticket_type_id = tt.id

      where e.status = 'on_sale'
        and e.starts_at > now()
        and v.status = 'active'
        and (tt.sales_start_at is null or tt.sales_start_at <= now())
        and (tt.sales_end_at   is null or tt.sales_end_at   >  now())
        and ($1::text is null or v.slug = $1)

      group by v.slug, v.name, v.city, v.logo_url, v.maps_url,
               e.id, e.slug, e.name, e.tagline, e.starts_at, e.doors_at, e.image_urls
      order by e.starts_at`,
      [venue]
    );

    const eventos = rows.map((r) => ({
      id:          r.id,
      slug:        r.slug,
      url:         '/' + r.venue_slug + '/' + r.slug,
      name:        r.name,
      tagline:     r.tagline,
      starts_at:   r.starts_at,
      doors_at:    r.doors_at,
      image_urls:  r.image_urls,
      desde_cents: Number(r.desde_cents),
      // `agotado` solo tiene sentido si TODOS los tiers tienen tope.
      agotado:     r.cupo_ilimitado ? false : r.disponibles <= 0,
      venue: {
        slug:     r.venue_slug,
        name:     r.venue_name,
        city:     r.city,
        logo_url: r.venue_logo,
        maps_url: r.maps_url,
      },
    }));

    // 60 segundos en el CDN. La grilla no cambia por segundo y esto
    // evita que una noche de venta fuerte pegue a la base en cada
    // recarga. El cupo exacto se chequea igual al crear la orden.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ eventos: eventos });

  } catch (err) {
    console.error('[events]', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

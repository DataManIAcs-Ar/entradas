// api/events.js
const { query } = require('../lib/db');

function filas(r) {
  if (!r) return [];
  return Array.isArray(r) ? r : (r.rows || []);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  try {
    const venue = (req.query && req.query.venue) || null;

    const rows = filas(await query(
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

         (array_agg(tt.id order by tt.sort_order, tt.name))[1] as ticket_type_id,
         (array_agg(tt.name order by tt.sort_order, tt.name))[1] as tier_name,
         min(tt.max_per_order)                 as max_per_order,
         min(a.price_cents)                    as desde_cents,

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
    ));

    const eventos = rows.map((r) => ({
      id:             r.id,
      slug:           r.slug,
      url:            '/' + r.venue_slug + '/' + r.slug,
      name:           r.name,
      tagline:        r.tagline,
      starts_at:      r.starts_at,
      doors_at:       r.doors_at,
      image_urls:     r.image_urls,
      ticket_type_id: r.ticket_type_id,
      tier_name:      r.tier_name,
      max_per_order:  Number(r.max_per_order),
      desde_cents:    Number(r.desde_cents),
      price_cents:    Number(r.desde_cents),
      available:      r.cupo_ilimitado ? null : Number(r.disponibles),
      agotado:        r.cupo_ilimitado ? false : r.disponibles <= 0,
      venue: {
        slug:     r.venue_slug,
        name:     r.venue_name,
        city:     r.city,
        logo_url: r.venue_logo,
        maps_url: r.maps_url,
      },
    }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ eventos: eventos });

  } catch (err) {
    console.error('[events]', err);
    return res.status(500).json({ error: 'error interno' });
  }
};

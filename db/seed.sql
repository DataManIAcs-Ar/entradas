-- ═══════════════════════════════════════════════════════════════════
--  entradas.datamaniacs.com.ar · datos de prueba
--
--  Objetivo: demostrar que un show único del Chamico y una noche
--  recurrente de boliche entran en las MISMAS tablas, sin ramas ni
--  casos especiales. La diferencia es cuántas filas de ticket_type
--  cuelgan del evento, nada más.
--
--  Correr DESPUÉS de schema.sql, sobre una base vacía.
-- ═══════════════════════════════════════════════════════════════════

-- ── VENUE 1: Chamico — datos reales ────────────────────────────────
insert into venue (id, slug, name, maps_url, logo_url, capacity,
                   platform_fee_bps, status)
values (
  '11111111-1111-1111-1111-111111111111',
  'chamico',
  'Galpón Chamico',
  'https://maps.app.goo.gl/H5viHN4ZsEAJGFtv9',
  '/assets/venue-chamico.png',
  350,
  600,              -- 6,00%
  'active'
);

-- ── VENUE 2: boliche — placeholder hasta cerrar el acuerdo ─────────
insert into venue (id, slug, name, capacity, platform_fee_bps, status)
values (
  '22222222-2222-2222-2222-222222222222',
  'eldisco',
  'El Disco (nombre a definir)',
  700,
  600,
  'draft'           -- draft = no aparece público todavía
);


-- ═══════════════════════════════════════════════════════════════════
--  CASO A — Chamico: shows únicos, un solo tier
--  Exactamente lo que hoy vive en events.js.
-- ═══════════════════════════════════════════════════════════════════

insert into event (id, venue_id, slug, name, tagline, starts_at, capacity, status)
values
  ('aaaaaaaa-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'gato-abuela-031026',
   'El Gato de la Abuela & José Luis Arriola',
   'Dejá de flamear aura y vení a flamear rock.',
   '2026-10-03 23:00:00-03',      -- offset explícito: -03 Argentina
   350, 'on_sale'),

  ('aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'alambre-mental-311026',
   'Alambre Gonzáles & Mental Delta',
   'No dejes que te coman los gusanos, vení a vivir blues y un poco de fusión.',
   '2026-10-31 20:30:00-03',
   350, 'on_sale');

-- Un tier por evento = el modelo actual, sin cambios de comportamiento.
insert into ticket_type (event_id, name, price_cents, quantity, sort_order)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Preventa', 1500000, 350, 0),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Preventa', 2500000, 350, 0);
--                                                     ↑
--   $15.000 = 1.500.000 centavos. Todo entero, siempre.


-- ═══════════════════════════════════════════════════════════════════
--  CASO B — Boliche: noches recurrentes, cuatro tiers
--  Misma estructura. Lo único que cambia es el volumen de filas.
-- ═══════════════════════════════════════════════════════════════════

insert into event_template (id, venue_id, name, weekday, starts_time, doors_time)
values (
  'bbbbbbbb-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222222',
  'Sábado de Fiesta',
  6,                -- sábado
  '01:00', '23:30'
);

-- Una noche generada desde la plantilla.
insert into event (id, venue_id, template_id, slug, name,
                   starts_at, doors_at, capacity, status)
values (
  'bbbbbbbb-0000-0000-0000-000000000101',
  '22222222-2222-2222-2222-222222222222',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'sabado-071126',
  'Sábado 7 de Noviembre',
  '2026-11-08 01:00:00-03',   -- ojo: la fiesta del sábado empieza el domingo
  '2026-11-07 23:30:00-03',
  700, 'on_sale'
);

-- Los cuatro tiers. Acá se ve para qué sirve el cupo por tipo:
-- el early bird se agota solo y empuja a la gente al precio siguiente,
-- sin que nadie tenga que tocar nada.
insert into ticket_type
  (event_id, name, price_cents, quantity, sales_end_at, visible, sort_order)
values
  ('bbbbbbbb-0000-0000-0000-000000000101', 'Early Bird',
    800000, 150, '2026-11-01 23:59:59-03', true,  0),

  ('bbbbbbbb-0000-0000-0000-000000000101', 'General',
   1200000, 450, null,                     true,  1),

  ('bbbbbbbb-0000-0000-0000-000000000101', 'VIP',
   2500000,  80, null,                     true,  2),

  -- Lista: precio 0 y visible = false. No sale en la página pública,
  -- se entra por link directo. Es el gancho para promotores después.
  ('bbbbbbbb-0000-0000-0000-000000000101', 'Lista',
        0,  20, '2026-11-07 20:00:00-03',  false, 3);


-- ═══════════════════════════════════════════════════════════════════
--  VERIFICACIÓN
-- ═══════════════════════════════════════════════════════════════════

-- Cupo por tier. Debe mostrar todo disponible (todavía no hay órdenes).
-- select * from ticket_type_availability order by event_id, ticket_type_id;

-- La grilla pública de entradas.datamaniacs.com.ar — un solo query sirve para
-- el Chamico y para el boliche:
--
--   select v.slug as venue, e.slug, e.name, e.starts_at,
--          min(tt.price_cents) as desde_cents
--     from event e
--     join venue v       on v.id = e.venue_id
--     join ticket_type tt on tt.event_id = e.id and tt.visible
--    where e.status = 'on_sale' and e.starts_at > now()
--    group by v.slug, e.slug, e.name, e.starts_at
--    order by e.starts_at;

-- ═══════════════════════════════════════════════════════════════════
--  entradas.datamaniacs.com.ar · esquema base (PostgreSQL / Supabase)
--  Plataforma multi-venue de entradas · por DataManIAcs
--
--  Reglas que atraviesan todo el modelo:
--
--  1. PLATA EN ENTEROS. Todos los montos son BIGINT en centavos.
--     Nunca float, nunca numeric con decimales flotantes. Un error de
--     redondeo en 700 tickets es plata real que alguien reclama.
--
--  2. TODO timestamptz. El servidor corre en UTC; la app formatea en
--     America/Argentina/Buenos_Aires. Ya perdimos tiempo una vez con
--     new Date('2026-10-03') corriéndose un día. No otra vez.
--
--  3. NADA SE BORRA. Los estados avanzan, las filas quedan. Si hay
--     una discusión con un venue por plata, el historial es la prueba.
--
--  4. LOS PRECIOS SE CONGELAN EN LA ORDEN. Si mañana sube el early
--     bird, las órdenes viejas no cambian.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";   -- gen_random_uuid(), hmac()

-- Códigos de entrada legibles y únicos por construcción, no por azar.
-- Con 4 caracteres al azar y 700 entradas la probabilidad de colisión
-- ronda el 14%: demasiado para algo que se imprime.
create sequence if not exists ticket_code_seq;


-- ───────────────────────────────────────────────────────────────────
--  VENUE — el tenant. La URL es entradas.datamaniacs.com.ar/<slug>
-- ───────────────────────────────────────────────────────────────────
create table venue (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null,         -- 'chamico', 'eldisco'
  name              text not null,
  city              text not null default 'San Antonio de Areco',
  maps_url          text,
  logo_url          text,
  tagline           text,                         -- la voz del venue (puede ser NULL)
  capacity          int,                          -- tope por defecto de sus eventos

  -- Vínculo Mercado Pago (Split 1:1, obtenido por OAuth)
  -- ⚠️ mp_access_token / mp_refresh_token son SECRETOS de un tercero.
  --    Encriptar en reposo (Supabase Vault o pgcrypto). Jamás loguearlos,
  --    jamás exponerlos al cliente, jamás al repo.
  mp_user_id        text,                         -- id de vendedor en MP
  mp_access_token   text,
  mp_refresh_token  text,
  mp_token_expires_at timestamptz,                -- hay que refrescar ANTES de que venza
  mp_connected_at   timestamptz,

  -- ── MODELO DE PRECIO (default del venue; cada evento puede pisarlo) ──
  --  'guaranteed_net' → el venue se queda SIEMPRE con un % fijo (94%).
  --                     Nuestra comisión flexiona para absorber el
  --                     arancel de MP: si MP sube, ganamos menos, pero
  --                     la promesa al venue se cumple.
  --  'flat_fee'       → comisión fija nuestra (ej. 6%), el arancel de
  --                     MP lo absorbe el venue.
  --  'free'           → sin comisión nuestra. Para clientes que ya
  --                     pagan otros servicios de DataManIAcs.
  --                     OJO: 'free' NO es el 100% para el venue —
  --                     el arancel de Mercado Pago se cobra igual.
  pricing_model        text not null default 'guaranteed_net'
                       check (pricing_model in ('guaranteed_net','flat_fee','free')),

  guaranteed_net_bps   int not null default 9400   -- 94,00% para el venue
                       check (guaranteed_net_bps between 0 and 10000),
  platform_fee_bps     int not null default 600    -- usado si flat_fee
                       check (platform_fee_bps between 0 and 10000),

  -- Piso de nuestra comisión. Sin esto, un aumento de aranceles de MP
  -- nos deja procesando tickets ajenos a pérdida.
  -- Con piso 3% la garantía del 94% se sostiene mientras el arancel
  -- de MP no supere el 3%. Por encima de eso el venue recibe menos y
  -- hay que MOSTRARLE POR QUÉ (ver vista venue_settlement).
  min_platform_fee_bps int not null default 300    -- 3,00%
                       check (min_platform_fee_bps between 0 and 10000),

  -- Arancel estimado de MP para ESTE venue. Va en el venue y no global
  -- porque el arancel depende del domicilio fiscal del vendedor
  -- (Provincia de Buenos Aires paga más por Ingresos Brutos).
  -- Actualizar cuando el ejecutivo comercial confirme el número real.
  mp_fee_bps_estimate  int not null default 121    -- ~1% + IVA, dinero en cuenta
                       check (mp_fee_bps_estimate between 0 and 10000),

  status            text not null default 'draft'
                    check (status in ('draft','active','paused')),
  created_at        timestamptz not null default now()
);

comment on column venue.mp_access_token is
  'SECRETO DE TERCERO. Encriptar en reposo. Si se filtra, alguien puede cobrar en nombre del venue.';


-- ───────────────────────────────────────────────────────────────────
--  EVENT — una noche. Sirve igual para un show único del Chamico que
--  para el sábado del boliche. Un boliche recurrente = muchas filas
--  acá, generadas desde una plantilla (ver event_template abajo).
-- ───────────────────────────────────────────────────────────────────
create table event (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venue(id),
  slug          text not null,                    -- /chamico/gato-abuela-031026
  name          text not null,
  tagline       text,
  description   text,
  image_urls    text[] not null default '{}',

  starts_at     timestamptz not null,
  doors_at      timestamptz,
  ends_at       timestamptz,

  capacity      int,                              -- NULL = usa venue.capacity

  status        text not null default 'draft'
                check (status in ('draft','on_sale','sold_out','closed','cancelled')),

  -- Override por evento. NULL = hereda del venue.
  -- Esto es lo que permite cobrarle a un venue en un evento y no en
  -- otro (ej. un cliente que ya paga encuestas y le hacemos uno free).
  pricing_model        text check (pricing_model in ('guaranteed_net','flat_fee','free')),
  guaranteed_net_bps   int check (guaranteed_net_bps between 0 and 10000),
  platform_fee_bps     int check (platform_fee_bps between 0 and 10000),

  template_id   uuid,                             -- si nació de una plantilla recurrente
  created_at    timestamptz not null default now(),

  unique (venue_id, slug)
);

create index on event (venue_id, starts_at desc);
create index on event (status, starts_at) where status = 'on_sale';


-- Plantilla para noches recurrentes (ej: "todos los sábados").
-- El boliche define esto una vez y un job genera los `event` que vienen.
create table event_template (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venue(id),
  name          text not null,                    -- 'Sábado de Fiesta'
  weekday       int check (weekday between 0 and 6),   -- 0 = domingo
  starts_time   time not null,
  doors_time    time,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

alter table event add constraint event_template_fk
  foreign key (template_id) references event_template(id);


-- ───────────────────────────────────────────────────────────────────
--  TICKET_TYPE — los tiers: Early Bird, General, VIP, Lista.
--  El cupo vive acá, no en el evento: es lo que hace que el early bird
--  se agote sin cerrar la venta general.
-- ───────────────────────────────────────────────────────────────────
create table ticket_type (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references event(id),
  name            text not null,                  -- 'Early Bird', 'VIP', 'Lista'
  description     text,

  price_cents     bigint not null check (price_cents >= 0),   -- 0 = lista/invitación
  quantity        int,                            -- NULL = sin tope propio
  max_per_order   int not null default 10,

  sales_start_at  timestamptz,                    -- NULL = desde ya
  sales_end_at    timestamptz,                    -- así el early bird se corta solo

  -- Lista de invitados: no se muestra en la página pública, se accede
  -- por link directo. Es el gancho para promotores más adelante.
  visible         boolean not null default true,

  sort_order      int not null default 0,
  status          text not null default 'active'
                  check (status in ('active','hidden','closed')),
  created_at      timestamptz not null default now()
);

create index on ticket_type (event_id, sort_order);


-- ───────────────────────────────────────────────────────────────────
--  ORDER — una compra. `id` es el external_reference que va a MP.
--
--  CICLO DE VIDA:
--    pending  → se creó, hay cupo RESERVADO hasta hold_expires_at
--    paid     → llegó el webhook y verificamos contra la API de MP
--    expired  → no pagó a tiempo; el cupo vuelve al pool
--    refunded / cancelled
--
--  El hold es lo que evita sobreventa: entre que el comprador aprieta
--  "pagar" y que MP confirma pasan segundos o minutos, y en ese rato
--  ese lugar NO puede vendérsele a otro.
-- ───────────────────────────────────────────────────────────────────
create table "order" (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references event(id),
  venue_id            uuid not null references venue(id),

  buyer_first_name    text not null,
  buyer_last_name     text not null,
  buyer_email         text not null,
  buyer_phone         text,
  buyer_dni           text,

  -- El comprador paga el precio de cara: total = subtotal.
  -- La comisión sale de adentro, no se suma arriba.
  subtotal_cents      bigint not null,            -- precio de cara × cantidad
  platform_fee_cents  bigint not null,            -- marketplace_fee → nosotros (6%)
  total_cents         bigint not null,            -- lo que paga el comprador (= subtotal)
  -- Snapshot del modelo aplicado: si mañana cambia el acuerdo, esta
  -- orden sigue diciendo bajo qué condiciones se vendió.
  pricing_model          text not null default 'guaranteed_net',
  mp_fee_estimated_cents bigint not null default 0,   -- lo que calculamos al cobrar
  mp_fee_actual_cents    bigint,                      -- lo que MP informó después
  venue_net_cents        bigint not null default 0,   -- lo que debería recibir el venue

  -- mp_fee_actual se completa desde el reporte de ventas de Split.
  -- La diferencia contra el estimado es el desvío de la garantía:
  -- si es sistemático, hay que ajustar venue.mp_fee_bps_estimate.

  status              text not null default 'pending'
                      check (status in ('pending','paid','expired','cancelled','refunded')),
  hold_expires_at     timestamptz not null,

  -- Mercado Pago
  mp_preference_id    text,
  mp_payment_id       text unique,                -- UNIQUE = idempotencia del webhook
  mp_status           text,                       -- approved / rejected / in_process...
  mp_status_detail    text,
  paid_at             timestamptz,

  channel             text not null default 'online'
                      check (channel in ('online','door')),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column "order".mp_payment_id is
  'UNIQUE a propósito: MP reintenta los webhooks. El índice hace la operación idempotente sin lógica extra.';

create index on "order" (event_id, status);
create index on "order" (buyer_email);
create index on "order" (hold_expires_at) where status = 'pending';   -- para el job de expiración


-- Renglones de la orden. El precio se copia acá: si mañana cambia el
-- ticket_type, esta orden sigue diciendo lo que realmente se cobró.
create table order_item (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references "order"(id),
  ticket_type_id    uuid not null references ticket_type(id),
  quantity          int not null check (quantity > 0),
  unit_price_cents  bigint not null               -- snapshot, NO joinear para el precio
);

create index on order_item (order_id);


-- ───────────────────────────────────────────────────────────────────
--  TICKET — una persona que entra. Se emiten SOLO cuando la orden
--  pasa a 'paid'. Si alguien compra 4, son 4 filas: cada una se
--  escanea una vez y sola.
-- ───────────────────────────────────────────────────────────────────
create table ticket (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references "order"(id),
  event_id        uuid not null references event(id),
  ticket_type_id  uuid not null references ticket_type(id),

  code            text unique not null,           -- corto y legible: 'ARC-7K2M'
  qr_token        text unique not null,           -- HMAC firmado, ver nota abajo

  attendee_name   text,                           -- opcional, se carga en puerta
  promoter_id     uuid,                           -- todavía sin uso (ver promoter)

  status          text not null default 'valid'
                  check (status in ('valid','used','void','refunded')),
  checked_in_at   timestamptz,
  checked_in_by   text,                           -- id del dispositivo/portero

  created_at      timestamptz not null default now()
);

comment on column ticket.qr_token is
  'Firmado con HMAC + secreto del servidor para que el escáner valide OFFLINE, sin consultar la base. La firma prueba autenticidad; la lista descargada prueba que no fue anulado ni usado.';

create index on ticket (event_id, status);
create index on ticket (order_id);


-- Log de escaneos. Separado de ticket.checked_in_at a propósito:
-- acá quedan TAMBIÉN los intentos duplicados e inválidos, que es
-- justo lo que se quiere ver cuando alguien discute en la puerta.
create table check_in (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid references ticket(id),         -- NULL si el QR ni siquiera existe
  event_id    uuid not null references event(id),
  scanned_at  timestamptz not null,               -- hora del DISPOSITIVO
  synced_at   timestamptz not null default now(), -- cuándo llegó al server
  device_id   text,
  result      text not null
              check (result in ('ok','duplicate','invalid','wrong_event','void'))
);

create index on check_in (event_id, scanned_at);


-- ───────────────────────────────────────────────────────────────────
--  PROMOTER — todavía no se usa. La tabla existe para que sumarlo
--  después sea un INSERT y no una migración con datos vivos.
-- ───────────────────────────────────────────────────────────────────
create table promoter (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venue(id),
  name            text not null,
  phone           text,
  code            text unique not null,           -- /eldisco?p=CODIGO
  commission_bps  int not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

alter table ticket add constraint ticket_promoter_fk
  foreign key (promoter_id) references promoter(id);


-- ───────────────────────────────────────────────────────────────────
--  DISPONIBILIDAD
--  Vendido = órdenes pagadas + órdenes pendientes todavía vigentes.
--  Las pendientes vencidas no cuentan: su cupo ya volvió al pool.
-- ───────────────────────────────────────────────────────────────────
create view ticket_type_availability as
select
  tt.id                                            as ticket_type_id,
  tt.event_id,
  tt.name,
  tt.price_cents,
  tt.quantity,
  coalesce(sum(oi.quantity), 0)::int               as taken,
  case when tt.quantity is null then null
       else tt.quantity - coalesce(sum(oi.quantity), 0)::int
  end                                              as available
from ticket_type tt
left join order_item oi on oi.ticket_type_id = tt.id
left join "order" o     on o.id = oi.order_id
                       and (o.status = 'paid'
                            or (o.status = 'pending' and o.hold_expires_at > now()))
group by tt.id;


-- ═══════════════════════════════════════════════════════════════════
--  SEGURIDAD — Row Level Security
--
--  ⚠️ CRÍTICO EN SUPABASE. Supabase publica automáticamente todas las
--  tablas por su API REST. Sin RLS, cualquiera con la clave `anon`
--  (que va en el frontend, o sea que es PÚBLICA) puede leer:
--      · venue.mp_access_token  → cobrar en nombre del venue
--      · datos de compradores   → nombre, email, DNI, teléfono
--      · ticket.qr_token        → fabricar entradas válidas
--
--  Activamos RLS y NO creamos políticas: así la clave anon no lee
--  nada. Nuestras funciones serverless se conectan por Postgres
--  directo con el usuario postgres, que ignora RLS y sigue andando.
-- ═══════════════════════════════════════════════════════════════════
alter table venue          enable row level security;
alter table event          enable row level security;
alter table event_template enable row level security;
alter table ticket_type    enable row level security;
alter table "order"        enable row level security;
alter table order_item     enable row level security;
alter table ticket         enable row level security;
alter table check_in       enable row level security;
alter table promoter       enable row level security;


-- ───────────────────────────────────────────────────────────────────
--  CÁLCULO DE COMISIÓN — fuente única de verdad
--
--  Toda la plata se calcula acá. La app NO recalcula por su cuenta:
--  si la fórmula vive en dos lugares, tarde o temprano difieren y la
--  diferencia es plata de otro.
-- ───────────────────────────────────────────────────────────────────
create or replace function calc_fees(
  p_total_cents bigint,
  p_event_id    uuid
)
returns table (
  pricing_model          text,
  platform_fee_cents     bigint,
  mp_fee_estimated_cents bigint,
  venue_net_cents        bigint,
  guarantee_met          boolean
)
language plpgsql stable as $fn$
declare
  m        text;
  net_bps  int;
  flat_bps int;
  min_bps  int;
  mp_bps   int;
  mp_fee   bigint;
  fee      bigint;
  floor_fee bigint;
begin
  -- El evento pisa al venue; si el evento no define, hereda.
  select coalesce(e.pricing_model,      v.pricing_model),
         coalesce(e.guaranteed_net_bps, v.guaranteed_net_bps),
         coalesce(e.platform_fee_bps,   v.platform_fee_bps),
         v.min_platform_fee_bps,
         v.mp_fee_bps_estimate
    into m, net_bps, flat_bps, min_bps, mp_bps
    from event e join venue v on v.id = e.venue_id
   where e.id = p_event_id;

  mp_fee := (p_total_cents * mp_bps) / 10000;

  if m = 'free' then
    fee := 0;
  elsif m = 'flat_fee' then
    fee := (p_total_cents * flat_bps) / 10000;
  else
    -- guaranteed_net: el venue se lleva net_bps SÍ O SÍ.
    -- Nosotros nos quedamos con lo que sobra después de MP.
    fee := p_total_cents - mp_fee - ((p_total_cents * net_bps) / 10000);
  end if;

  -- Piso: nunca por debajo, ni siquiera para sostener la garantía.
  floor_fee := case when m = 'free' then 0
                    else (p_total_cents * min_bps) / 10000 end;
  if fee < floor_fee then
    fee := floor_fee;
  end if;

  return query select
    m,
    fee,
    mp_fee,
    p_total_cents - mp_fee - fee,
    -- ¿se cumplió la promesa? Si tocamos el piso, no.
    (m <> 'guaranteed_net')
      or (p_total_cents - mp_fee - fee) >= ((p_total_cents * net_bps) / 10000);
end;
$fn$;

comment on function calc_fees is
  'Única fuente de verdad para comisiones. guarantee_met=false avisa que el piso comió la garantía: ahí hay que renegociar o subir el precio, no absorberlo callado.';


-- ───────────────────────────────────────────────────────────────────
--  LIQUIDACIÓN POR EVENTO — lo que ve el venue
--
--  Esta vista ES la estrategia comercial. Si el venue puede ver a
--  dónde fue cada peso, cuando el arancel de MP sube no nos putea a
--  nosotros: ve la línea y entiende que el aumento es de Mercado Pago
--  / Ingresos Brutos de Provincia. La transparencia es lo que retiene
--  al cliente cuando el número empeora por algo que no controlamos.
-- ───────────────────────────────────────────────────────────────────
create or replace view venue_settlement as
select
  v.slug                                   as venue,
  e.id                                     as event_id,
  e.name                                   as evento,
  e.starts_at,
  o.pricing_model,

  count(*)                                 as ordenes,
  sum(oi.qty)                              as entradas,

  sum(o.total_cents)                       as bruto_cents,
  -- arancel real si MP ya lo informó; si no, el estimado
  sum(coalesce(o.mp_fee_actual_cents,
               o.mp_fee_estimated_cents))  as arancel_mp_cents,
  sum(o.platform_fee_cents)                as comision_plataforma_cents,
  sum(o.venue_net_cents)                   as neto_venue_cents,

  -- Los porcentajes que el venue va a chequear con la calculadora
  round(100.0 * sum(coalesce(o.mp_fee_actual_cents, o.mp_fee_estimated_cents))
        / nullif(sum(o.total_cents),0), 2) as pct_mercadopago,
  round(100.0 * sum(o.platform_fee_cents)
        / nullif(sum(o.total_cents),0), 2) as pct_plataforma,
  round(100.0 * sum(o.venue_net_cents)
        / nullif(sum(o.total_cents),0), 2) as pct_venue,

  -- true = MP ya informó todo; false = hay estimados sin confirmar
  bool_and(o.mp_fee_actual_cents is not null) as arancel_confirmado

from "order" o
join event e on e.id = o.event_id
join venue v on v.id = o.venue_id
join (select order_id, sum(quantity) as qty from order_item group by order_id) oi
     on oi.order_id = o.id
where o.status = 'paid'
group by v.slug, e.id, e.name, e.starts_at, o.pricing_model;

comment on view venue_settlement is
  'Liquidación que se le muestra al venue. pct_mercadopago separado de pct_plataforma a propósito: cuando MP sube aranceles, el venue ve exactamente qué línea se movió y no nos culpa a nosotros.';


-- ═══════════════════════════════════════════════════════════════════
--  EXPIRACIÓN DE HOLDS — con pg_cron (recomendado)
--
--  Libera el cupo de las órdenes que nunca se pagaron. Sin esto, cada
--  persona que abre el checkout y se arrepiente secuestra un lugar y
--  el evento "se agota" con entradas sin vender.
--
--  Se hace acá y no en un cron de Vercel por dos razones:
--    · el plan Hobby de Vercel solo permite un cron POR DÍA, y un hold
--      de 15 minutos que se libera al otro día no sirve de nada;
--    · es SQL puro — no tiene sentido dar la vuelta por una función
--      serverless para hacer un UPDATE.
--
--  Activar primero: Supabase → Database → Extensions → pg_cron.
--  El endpoint /api/expire-orders queda igual, como disparo manual.
-- ═══════════════════════════════════════════════════════════════════

-- create extension if not exists pg_cron;
--
-- select cron.schedule(
--   'expirar-holds',
--   '* * * * *',                      -- cada minuto
--   $cron$
--     update "order"
--        set status = 'expired', updated_at = now()
--      where status = 'pending'
--        and hold_expires_at < now();
--   $cron$
-- );
--
-- Ver que esté corriendo:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;


-- ═══════════════════════════════════════════════════════════════════
--  NOTAS DE IMPLEMENTACIÓN — lo que el esquema solo no resuelve
-- ═══════════════════════════════════════════════════════════════════
--
--  SOBREVENTA. La vista de arriba es para MOSTRAR, no para decidir.
--  Al crear una orden hay que hacerlo dentro de una transacción con
--  SELECT ... FOR UPDATE sobre el ticket_type, verificar cupo e
--  insertar. Sin eso, dos compras simultáneas leen el mismo número
--  disponible y las dos pasan. Es el mismo problema que resolvimos
--  con LockService en Apps Script, pero acá lo hace la base.
--
--  JOB DE EXPIRACIÓN. Un cron cada minuto:
--      update "order" set status = 'expired'
--       where status = 'pending' and hold_expires_at < now();
--  Sin esto el cupo queda secuestrado por gente que nunca pagó.
--  Sugerido: hold de 15 minutos.
--
--  WEBHOOK. Validar el header x-signature ANTES de leer el body.
--  Después consultar la API de MP por el payment_id — nunca confiar
--  en el payload. Recién con status 'approved' se marca paid y se
--  emiten los tickets. El UNIQUE en mp_payment_id hace que un
--  reintento de MP no duplique nada.
--
--  ORDEN DE OPERACIONES AL COBRAR:
--      1. crear order (pending) + order_items  → id = external_reference
--      2. crear preference en MP con marketplace_fee y ese external_reference
--      3. redirigir al comprador
--      4. webhook → verificar → order.paid → emitir tickets → mandar mail
--
--  SECRETOS. mp_access_token de cada venue va encriptado. Las claves
--  de la plataforma van en variables de entorno de Vercel. El repo
--  de esto va PRIVADO — no es como el de Chamico, acá hay plata de
--  terceros.
--
--  MIGRAR CHAMICO. Un venue, dos events, un ticket_type por evento.
--  Hacerlo DESPUÉS del 3 y el 31 de octubre, con las ventas cerradas.
--
--  PENDIENTE DE DEFINIR (no bloquea empezar):
--    · ¿Las órdenes de puerta (channel='door') las carga un operador
--      logueado, o el comprador desde su celular con el QR del local?
--    · ¿Reembolsos parciales, o solo cancelación total del evento?
--    · ¿El venue necesita login para ver su panel, o alcanza con un
--      link privado por ahora?

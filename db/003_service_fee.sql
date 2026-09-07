-- ═══════════════════════════════════════════════════════════════════
--  entradas.datamaniacs.com.ar · migración 003
--  Cargo por servicio al comprador
--
--  MODELO DEFINITIVO (confirmado con aranceles reales de MP):
--
--      cargo al comprador ......  5%  sobre el precio de cara
--      recibe el local .........  94% del precio de cara
--      liberación ..............  10 días desde el pago
--      margen nuestro ..........  ~5,16% del precio de cara
--
--  Entrada de $12.000:
--      paga el comprador ...... $12.600
--      arancel Mercado Pago ...    $701   (4,60% + IVA sobre el total)
--      recibe el local ........ $11.280
--      nos queda .............. $   619
--
--  POR QUÉ EL CARGO AL COMPRADOR:
--  Mercado Pago confirmó que el arancel es IDÉNTICO para todos los
--  medios de pago — tarjeta, débito, efectivo y dinero en cuenta. Lo
--  único que lo cambia es la fecha de liberación, y los 35 días se
--  cuentan desde el pago, no desde el evento (confirmado por soporte).
--
--  Sin cargo al comprador, el arancel de MP se come toda la comisión:
--  al instante son 7,99% con IVA, más que el 6% que cobrábamos. Con 5%
--  al comprador el modelo cierra desde los 10 días de liberación.
--
--  Correr DESPUÉS de schema.sql y 002_conciliacion.sql.
-- ═══════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────
--  CARGO POR SERVICIO — configurable por venue, pisable por evento
-- ───────────────────────────────────────────────────────────────────
alter table venue
  add column if not exists service_fee_bps int not null default 500
      check (service_fee_bps between 0 and 10000);

alter table event
  add column if not exists service_fee_bps int
      check (service_fee_bps between 0 and 10000);

comment on column venue.service_fee_bps is
  '500 = 5,00% que paga el COMPRADOR encima del precio de cara. Es la mitad de lo que cobra la competencia y es el número que la gente compara en el checkout.';

comment on column event.service_fee_bps is
  'NULL = hereda del venue. Sirve para un evento sin cargo (invitación, beneficio) sin tocar la config del local.';


-- El arancel de MP ahora sale de la tabla real, con liberación a 10
-- días: 4,60% + IVA = 5,566%. Antes tenía 121 bps, que era una
-- estimación equivocada — no existe descuento por dinero en cuenta.
alter table venue
  alter column mp_fee_bps_estimate set default 557;

update venue set mp_fee_bps_estimate = 557 where mp_fee_bps_estimate = 121;

comment on column venue.mp_fee_bps_estimate is
  'Arancel de MP con IVA, según fecha de liberación: al instante 799, 10 días 557, 18 días 430, 35 días 189. Se aplica sobre el TOTAL que paga el comprador, no sobre el precio de cara.';


-- ───────────────────────────────────────────────────────────────────
--  LA ORDEN GUARDA LAS TRES PATAS
-- ───────────────────────────────────────────────────────────────────
alter table "order"
  add column if not exists service_fee_cents bigint not null default 0;

comment on column "order".subtotal_cents is
  'Precio de cara × cantidad. Es la base del 94% del local.';
comment on column "order".service_fee_cents is
  'Cargo por servicio que paga el comprador ENCIMA del precio de cara.';
comment on column "order".total_cents is
  'subtotal + service_fee. Es lo que se cobra por Mercado Pago y sobre lo que MP calcula su arancel.';


-- ───────────────────────────────────────────────────────────────────
--  CÁLCULO — fuente única de verdad
--
--  Ahora recibe el SUBTOTAL (precio de cara), no el total: el cargo
--  por servicio se calcula acá adentro y no en la app. Si la fórmula
--  vive en dos lugares, tarde o temprano difieren.
-- ───────────────────────────────────────────────────────────────────
drop function if exists calc_fees(bigint, uuid);

create or replace function calc_fees(
  p_subtotal_cents bigint,
  p_event_id       uuid
)
returns table (
  pricing_model          text,
  service_fee_cents      bigint,   -- lo paga el comprador
  total_cents            bigint,   -- subtotal + servicio
  mp_fee_estimated_cents bigint,   -- sobre el total
  platform_fee_cents     bigint,   -- marketplace_fee → nosotros
  venue_net_cents        bigint,   -- lo que recibe el local
  guarantee_met          boolean
)
language plpgsql stable as $fn$
declare
  m         text;
  net_bps   int;
  flat_bps  int;
  min_bps   int;
  mp_bps    int;
  svc_bps   int;
  svc       bigint;
  tot       bigint;
  mp_fee    bigint;
  fee       bigint;
  floor_fee bigint;
  venue_net bigint;
begin
  select coalesce(e.pricing_model,      v.pricing_model),
         coalesce(e.guaranteed_net_bps, v.guaranteed_net_bps),
         coalesce(e.platform_fee_bps,   v.platform_fee_bps),
         coalesce(e.service_fee_bps,    v.service_fee_bps),
         v.min_platform_fee_bps,
         v.mp_fee_bps_estimate
    into m, net_bps, flat_bps, svc_bps, min_bps, mp_bps
    from event e join venue v on v.id = e.venue_id
   where e.id = p_event_id;

  -- 1. El comprador paga el precio de cara más el cargo por servicio.
  svc := (p_subtotal_cents * svc_bps) / 10000;
  tot := p_subtotal_cents + svc;

  -- 2. MP cobra sobre el TOTAL, no sobre el precio de cara.
  mp_fee := (tot * mp_bps) / 10000;

  -- 3. Nuestra comisión según el modelo del venue.
  if m = 'free' then
    -- Sin comisión al local: el cargo por servicio es todo el ingreso.
    venue_net := tot - mp_fee - svc;
    fee       := svc;
  elsif m = 'flat_fee' then
    fee       := (p_subtotal_cents * flat_bps) / 10000;
    venue_net := tot - mp_fee - fee;
  else
    -- guaranteed_net: el local se lleva su % del PRECIO DE CARA,
    -- pase lo que pase con el arancel. Nosotros absorbemos la
    -- diferencia — hasta el piso.
    venue_net := (p_subtotal_cents * net_bps) / 10000;
    fee       := tot - mp_fee - venue_net;
  end if;

  -- 4. Piso: nunca por debajo, ni siquiera para sostener la garantía.
  floor_fee := case when m = 'free' then 0
                    else (p_subtotal_cents * min_bps) / 10000 end;
  if fee < floor_fee then
    fee       := floor_fee;
    venue_net := tot - mp_fee - fee;   -- el local recibe menos, y se avisa
  end if;

  return query select
    m, svc, tot, mp_fee, fee, venue_net,
    (m <> 'guaranteed_net')
      or venue_net >= ((p_subtotal_cents * net_bps) / 10000);
end $fn$;

comment on function calc_fees is
  'Recibe el PRECIO DE CARA y devuelve las cuatro patas. guarantee_met=false avisa que el piso se comió la garantía: ahí se renegocia o se sube el precio, no se absorbe callado.';


-- ───────────────────────────────────────────────────────────────────
--  LIQUIDACIÓN — ahora con el cargo por servicio separado
-- ───────────────────────────────────────────────────────────────────
-- La vista vieja tiene la columna `bruto_cents` y la nueva la llama
-- `precio_cara_cents`. CREATE OR REPLACE no permite RENOMBRAR columnas,
-- así que hay que tirarla y volver a crearla.
drop view if exists venue_settlement;

create view venue_settlement as
select
  v.slug                            as venue,
  e.id                              as event_id,
  e.name                            as evento,
  e.starts_at,
  o.pricing_model,

  count(*)                          as ordenes,
  sum(oi.qty)                       as entradas,

  sum(o.subtotal_cents)             as precio_cara_cents,
  sum(o.service_fee_cents)          as cargo_servicio_cents,
  sum(o.total_cents)                as cobrado_cents,
  sum(coalesce(o.mp_fee_actual_cents,
               o.mp_fee_estimated_cents)) as arancel_mp_cents,
  sum(o.platform_fee_cents)         as comision_plataforma_cents,
  sum(o.venue_net_cents)            as neto_venue_cents,

  -- El número que el local va a verificar con la calculadora:
  -- su neto sobre el precio de cara. Tiene que dar 94,00%.
  round(100.0 * sum(o.venue_net_cents)
        / nullif(sum(o.subtotal_cents),0), 2) as pct_sobre_precio_cara,

  bool_and(o.mp_fee_actual_cents is not null) as arancel_confirmado

from "order" o
join event e on e.id = o.event_id
join venue v on v.id = o.venue_id
join (select order_id, sum(quantity) as qty from order_item group by order_id) oi
     on oi.order_id = o.id
where o.status = 'paid'
group by v.slug, e.id, e.name, e.starts_at, o.pricing_model;

comment on view venue_settlement is
  'pct_sobre_precio_cara es el número del acuerdo: 94,00%. El arancel de MP va en su propia columna para que cuando suba, el local vea qué línea se movió y no nos culpe a nosotros.';


-- ═══════════════════════════════════════════════════════════════════
--  VERIFICACIÓN
--
--    select * from calc_fees(1200000, 'bbbbbbbb-0000-0000-0000-000000000101');
--
--  Esperado:
--    service_fee       60.000   ( 5,00% del precio de cara)
--    total          1.260.000   (lo que paga el comprador)
--    mp_fee            70.182   (5,566% sobre el total)
--    platform_fee      61.818   (5,15% del precio de cara)
--    venue_net      1.128.000   (94,00% exacto)
--    guarantee_met       true
--
--  Control: 1.260.000 = 70.182 + 61.818 + 1.128.000 ✓
--
--
--  PENDIENTE CON MERCADO PAGO:
--  Falta confirmar si `marketplace_fee` se calcula sobre el bruto o
--  sobre el neto después del arancel. Acá lo mandamos como MONTO
--  ABSOLUTO (platform_fee_cents), que esquiva la pregunta siempre y
--  cuando MP lo descuente después del suyo. Si resulta que lo calcula
--  distinto, se ajusta una sola línea de esta función.
--
--  PENDIENTE EN EL CÓDIGO:
--  · create-order.js debe usar la firma nueva: pasa el SUBTOTAL y
--    guarda service_fee_cents y total_cents de lo que devuelve.
--  · La preference de MP cobra `total_cents`, no el precio de cara.
--  · La pantalla de compra tiene que MOSTRAR el desglose: precio +
--    cargo por servicio = total. En Argentina el precio final tiene
--    que estar a la vista, y además un cargo escondido en el último
--    paso es la forma más rápida de perder una venta.
-- ═══════════════════════════════════════════════════════════════════

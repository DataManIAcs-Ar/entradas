-- ═══════════════════════════════════════════════════════════════════
--  entradas.datamaniacs.com.ar · carga sintética
--
--  Genera ~700 entradas vendidas para una noche de boliche, para
--  poder probar ANTES de noviembre lo que solo se rompe con volumen:
--  velocidad de escaneo, descarga de la lista al dispositivo,
--  detección de duplicados y comportamiento de la vista de cupo.
--
--  Requiere: schema.sql y seed.sql ya corridos.
--
--  ⚠️ DATOS FALSOS. Todos los compradores usan @loadtest.local.
--     El bloque de limpieza de abajo los borra a todos y se puede
--     correr este archivo cuantas veces haga falta.
--
--  ⚠️ NUNCA correr esto contra la base de producción con ventas
--     reales. Los DNI y teléfonos son inventados.
-- ═══════════════════════════════════════════════════════════════════


-- ── LIMPIEZA ───────────────────────────────────────────────────────
-- Hace el script idempotente: borra solo lo sintético, nunca lo real.
delete from check_in  where ticket_id in (
  select t.id from ticket t join "order" o on o.id = t.order_id
   where o.buyer_email like '%@loadtest.local');
delete from ticket     where order_id in (
  select id from "order" where buyer_email like '%@loadtest.local');
delete from order_item where order_id in (
  select id from "order" where buyer_email like '%@loadtest.local');
delete from "order"    where buyer_email like '%@loadtest.local';


-- ── GENERACIÓN ─────────────────────────────────────────────────────
do $$
declare
  c_event   uuid := 'bbbbbbbb-0000-0000-0000-000000000101';  -- Sábado 7/11
  c_venue   uuid := '22222222-2222-2222-2222-222222222222';

  -- En producción esto vive en variable de entorno, jamás en la base.
  c_secret  text := 'SEED-SECRET-NO-USAR-EN-PRODUCCION';

  nombres   text[] := array['Sofía','Valentina','Mateo','Juan','Martina',
                            'Lucas','Camila','Benjamín','Lucía','Thiago',
                            'Emma','Santiago','Isabella','Nicolás','Julieta',
                            'Facundo','Delfina','Tomás','Catalina','Joaquín'];
  apellidos text[] := array['González','Rodríguez','Gómez','Fernández','López',
                            'Díaz','Martínez','Pérez','Sánchez','Romero',
                            'Sosa','Álvarez','Torres','Ruiz','Ramírez',
                            'Flores','Benítez','Acosta','Medina','Herrera'];

  t          record;
  v_order    uuid;
  v_ticket   uuid;
  v_status   text;
  v_channel  text;
  v_qty      int;
  v_placed   int;
  v_target   int;
  v_sub      bigint;
  f          record;      -- resultado de calc_fees
  v_hold     timestamptz;
  v_paid     timestamptz;
  n_code     int := 0;
  i          int;
  r          numeric;
begin
  for t in
    select id, name, price_cents, quantity
      from ticket_type
     where event_id = c_event
     order by sort_order
  loop
    -- Llenamos al 96% del cupo: queda algo disponible para probar
    -- una compra real encima de la carga.
    v_target := floor(t.quantity * 0.96);
    v_placed := 0;

    while v_placed < v_target loop
      -- 1 a 4 entradas por orden: la gente compra en grupo.
      v_qty := least(1 + floor(random() * 4)::int, v_target - v_placed);

      -- Mezcla realista de estados.
      r := random();
      if    r < 0.90 then v_status := 'paid';
      elsif r < 0.95 then v_status := 'pending';   -- retiene cupo
      elsif r < 0.98 then v_status := 'expired';   -- lo devuelve
      else                v_status := 'refunded';
      end if;

      -- 80% presale online, 20% puerta.
      v_channel := case when random() < 0.8 then 'online' else 'door' end;

      v_sub := t.price_cents * v_qty;

      -- Una sola fórmula, la de la base. Si el load test calculara
      -- por su cuenta, validaría un modelo que no es el real.
      select * into f from calc_fees(v_sub, c_event);

      if v_status = 'pending' then
        v_hold := now() + interval '15 minutes';
        v_paid := null;
      elsif v_status = 'expired' then
        v_hold := now() - interval '2 hours';
        v_paid := null;
      else
        v_hold := now() - interval '1 hour';
        v_paid := now() - (random() * interval '20 days');
      end if;

      insert into "order" (
        event_id, venue_id,
        buyer_first_name, buyer_last_name, buyer_email, buyer_phone, buyer_dni,
        subtotal_cents, service_fee_cents, total_cents,
        platform_fee_cents, mp_fee_estimated_cents, venue_net_cents,
        pricing_model, code, payment_method,
        status, hold_expires_at,
        mp_payment_id, mp_status, paid_at, channel
      ) values (
        c_event, c_venue,
        nombres[1   + floor(random() * array_length(nombres,1))::int],
        apellidos[1 + floor(random() * array_length(apellidos,1))::int],
        'test' || floor(random() * 1000000)::text || '@loadtest.local',
        '11' || lpad(floor(random() * 100000000)::text, 8, '0'),
        (20000000 + floor(random() * 25000000))::text,
        v_sub, f.service_fee_cents, f.total_cents,
        f.platform_fee_cents, f.mp_fee_estimated_cents, f.venue_net_cents,
        f.pricing_model,
        'ENT-' || short_code(nextval('order_code_seq')), 'mp_checkout',
        v_status, v_hold,
        case when v_status in ('paid','refunded')
             then 'LOADTEST-' || gen_random_uuid()::text else null end,
        case when v_status = 'paid' then 'approved' else null end,
        v_paid, v_channel
      ) returning id into v_order;

      insert into order_item (order_id, ticket_type_id, quantity, unit_price_cents)
      values (v_order, t.id, v_qty, t.price_cents);

      -- Las entradas se emiten SOLO si la orden está paga.
      if v_status = 'paid' then
        for i in 1..v_qty loop
          n_code  := n_code + 1;
          v_ticket := gen_random_uuid();

          insert into ticket (
            id, order_id, event_id, ticket_type_id, code, qr_token, status
          ) values (
            v_ticket, v_order, c_event, t.id,
            -- código corto único por construcción, no por suerte
            'ARC-' || lpad(upper(to_hex(n_code)), 4, '0'),
            -- formato real: <id>.<hmac> — el escáner parte, recalcula
            -- el HMAC con el secreto y valida OFFLINE, sin consultar
            -- la base.
            v_ticket::text || '.' ||
              encode(hmac(v_ticket::text, c_secret, 'sha256'), 'hex'),
            'valid'
          );
        end loop;
      end if;

      v_placed := v_placed + v_qty;
    end loop;
  end loop;
end $$;


-- ── 30 entradas ya escaneadas ──────────────────────────────────────
-- Para probar la detección de duplicados: al escanear una de estas,
-- el lector tiene que rechazarla, no dejarla pasar de nuevo.
with ya_entraron as (
  select id from ticket
   where event_id = 'bbbbbbbb-0000-0000-0000-000000000101'
     and status = 'valid'
   order by random()
   limit 30
)
update ticket t
   set status = 'used',
       checked_in_at = '2026-11-08 00:45:00-03' + (random() * interval '90 minutes'),
       checked_in_by = 'puerta-' || (1 + floor(random() * 2))::int
  from ya_entraron y
 where t.id = y.id;

insert into check_in (ticket_id, event_id, scanned_at, device_id, result)
select id, event_id, checked_in_at, checked_in_by, 'ok'
  from ticket
 where event_id = 'bbbbbbbb-0000-0000-0000-000000000101'
   and status = 'used';


-- ═══════════════════════════════════════════════════════════════════
--  VERIFICACIÓN
-- ═══════════════════════════════════════════════════════════════════

-- Resumen por tier
select tt.name,
       tt.quantity                                   as cupo,
       count(distinct o.id) filter (where o.status = 'paid')    as ordenes_pagas,
       count(t.id)                                   as entradas_emitidas,
       count(t.id) filter (where t.status = 'used')  as ya_escaneadas,
       to_char(sum(o.platform_fee_cents) filter (where o.status = 'paid')
               / 100.0, 'FM999G999D00')              as comision_pesos
  from ticket_type tt
  left join order_item oi on oi.ticket_type_id = tt.id
  left join "order" o     on o.id = oi.order_id
  left join ticket t      on t.ticket_type_id = tt.id and t.order_id = o.id
 where tt.event_id = 'bbbbbbbb-0000-0000-0000-000000000101'
 group by tt.id, tt.name, tt.quantity, tt.sort_order
 order by tt.sort_order;

-- Cupo restante. Las 'expired' NO deben descontar; las 'pending' sí.
select * from ticket_type_availability
 where event_id = 'bbbbbbbb-0000-0000-0000-000000000101';

-- Lista para el escáner. ESTE es el query que el dispositivo baja
-- antes de abrir puertas y guarda localmente. Con 700 filas pesa
-- unos pocos cientos de KB — entra en memoria sin problema y no
-- necesita señal durante la noche.
select t.id, t.code, t.qr_token, t.status, tt.name as tier
  from ticket t
  join ticket_type tt on tt.id = t.ticket_type_id
 where t.event_id = 'bbbbbbbb-0000-0000-0000-000000000101'
   and t.status in ('valid','used');


-- ═══════════════════════════════════════════════════════════════════
--  MODELO DE COMISIÓN — DEFINIDO
--
--  El comprador paga el precio de cara MÁS un 5% de cargo por servicio.
--  El local recibe el 94% del precio de cara. Liberación a 10 días.
--
--      Entrada $12.000
--        comprador paga ........ $12.600
--        − arancel MP (5,57%) ..    $702
--        − comisión plataforma .    $618
--        = recibe el local ..... $11.280   (94,00%)
--
--  Los montos salen de calc_fees(), no se calculan acá. Si este
--  script hiciera su propia cuenta, estaría validando un modelo que
--  no es el que corre en producción.
-- ═══════════════════════════════════════════════════════════════════

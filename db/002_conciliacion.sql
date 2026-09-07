-- ═══════════════════════════════════════════════════════════════════
--  entradas.datamaniacs.com.ar · conciliación de transferencias
--  Migración 002 — modelo semi-automatizado para eventos chicos
--
--  PARA QUÉ:
--  Mientras Mercado Pago no esté integrado, los eventos de menos de
--  ~300 personas cobran por transferencia manual a un alias nuestro.
--  Esto automatiza la parte tediosa — emparejar el extracto bancario
--  con las órdenes — y deja para vos solo la confirmación final.
--
--  CÓMO FUNCIONA:
--    1. Cada orden recibe un CÓDIGO corto (ENT-A7K2) al crearse.
--    2. La pantalla de pago le pide al comprador que lo pegue en el
--       motivo de la transferencia.
--    3. Importás el extracto de MP.
--    4. `match_movements()` empareja lo que puede y deja las órdenes
--       en estado `proposed`.
--    5. Revisás la cola y confirmás. Ahí se emiten las entradas y se
--       encola el email.
--
--  El código es lo que hace que esto funcione. Sin él, emparejar es
--  adivinar por monto y nombre — y los nombres no coinciden (la cuenta
--  está a nombre de la madre, cuatro personas pagan lo mismo el mismo
--  día). Con código, emparejar es un lookup.
--
--  Correr DESPUÉS de schema.sql.
-- ═══════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────
--  CÓDIGO CORTO — el que el comprador pega en la transferencia
-- ───────────────────────────────────────────────────────────────────

-- Empieza alto para que todos los códigos tengan 4 caracteres.
create sequence if not exists order_code_seq start 27000;

create or replace function short_code(n bigint)
returns text language plpgsql immutable as $sc$
declare
  -- Sin 0/O, 1/I/L ni U: se dictan por teléfono y se tipean a mano.
  alfabeto text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  base     int  := 30;
  salida   text := '';
begin
  if n <= 0 then return '2222'; end if;
  while n > 0 loop
    salida := substr(alfabeto, (n % base)::int + 1, 1) || salida;
    n := n / base;
  end loop;
  return salida;
end $sc$;

comment on function short_code is
  'Base-30 sin caracteres ambiguos. Único por construcción vía secuencia, no por azar.';


-- ───────────────────────────────────────────────────────────────────
--  CAMBIOS EN `order`
-- ───────────────────────────────────────────────────────────────────

alter table "order"
  add column if not exists code text unique,
  add column if not exists payment_method text not null default 'mp_checkout'
      check (payment_method in ('mp_checkout','transfer','cash'));

-- Estado nuevo: `proposed` = hay un movimiento bancario emparejado,
-- falta que un humano lo confirme. Nunca se emiten entradas acá.
alter table "order" drop constraint if exists order_status_check;
alter table "order" add constraint order_status_check
  check (status in ('pending','proposed','paid','expired','cancelled','refunded'));

create index if not exists order_code_idx on "order" (code);

comment on column "order".code is
  'Referencia que el comprador pega en el motivo de la transferencia. Se genera al crear la orden, antes de pagar — por eso vive acá y no en ticket.';

comment on column "order".payment_method is
  'transfer = alias manual (eventos chicos). mp_checkout = Mercado Pago. El hold cambia según el método: 15 min para MP, 48 h para transferencia.';


-- ───────────────────────────────────────────────────────────────────
--  MOVIMIENTOS BANCARIOS IMPORTADOS
-- ───────────────────────────────────────────────────────────────────
create table if not exists bank_movement (
  id                 uuid primary key default gen_random_uuid(),

  -- Id de la operación en el extracto. UNIQUE = reimportar el mismo
  -- archivo no duplica nada.
  external_id        text unique,

  movement_date      timestamptz not null,
  amount_cents       bigint not null,
  description        text,                    -- acá viene el código
  counterparty_name  text,                    -- casi nunca coincide

  status             text not null default 'unmatched'
                     check (status in ('unmatched','proposed','confirmed','ignored')),

  order_id           uuid references "order"(id),
  match_confidence   text check (match_confidence in ('alta','media','ambigua')),
  match_reason       text,

  raw                jsonb,                   -- fila original del extracto
  imported_at        timestamptz not null default now(),
  reviewed_at        timestamptz,
  reviewed_by        text
);

create index if not exists bank_movement_status_idx on bank_movement (status);
create index if not exists bank_movement_amount_idx on bank_movement (amount_cents);

alter table bank_movement enable row level security;


-- ───────────────────────────────────────────────────────────────────
--  COLA DE EMAILS
--  Postgres no manda mail. Escribimos acá y una función de Vercel
--  levanta los pendientes. Encolar dentro de la misma transacción que
--  confirma el pago evita el caso "se confirmó pero no se avisó".
-- ───────────────────────────────────────────────────────────────────
create table if not exists email_outbox (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references "order"(id),
  to_email    text not null,
  template    text not null default 'confirmacion',
  status      text not null default 'pending'
              check (status in ('pending','sent','failed')),
  attempts    int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create index if not exists email_outbox_pending_idx
  on email_outbox (created_at) where status = 'pending';

alter table email_outbox enable row level security;


-- ───────────────────────────────────────────────────────────────────
--  EMPAREJAMIENTO
--
--  Tres niveles, y solo los dos primeros proponen algo:
--    alta    → el código apareció en la descripción y el monto coincide
--    media   → sin código, pero hay UNA sola orden pendiente con ese monto
--    ambigua → varias candidatas: no se propone, se revisa a mano
-- ───────────────────────────────────────────────────────────────────
create or replace function match_movements()
returns table (
  movimiento uuid,
  confianza  text,
  motivo     text,
  orden      uuid
)
language plpgsql as $mm$
declare
  m          record;
  v_code     text;
  v_order    record;
  v_count    int;
begin
  for m in
    select * from bank_movement
     where status = 'unmatched'
     order by movement_date
  loop
    v_code  := null;
    v_order := null;

    -- ── 1. ¿Hay un código en la descripción? ──────────────────────
    -- Tolerante: acepta ENT-A7K2, ENTA7K2, ent a7k2.
    v_code := (regexp_match(
                 upper(coalesce(m.description,'')),
                 'ENT[ -]?([23456789ABCDEFGHJKMNPQRSTVWXYZ]{4,6})'
               ))[1];

    if v_code is not null then
      select * into v_order
        from "order"
       where code = 'ENT-' || v_code
         and status in ('pending','proposed');

      if v_order.id is not null then
        if v_order.total_cents = m.amount_cents then
          update bank_movement
             set status = 'proposed', order_id = v_order.id,
                 match_confidence = 'alta',
                 match_reason = 'código ' || v_order.code || ' + monto exacto'
           where id = m.id;
          update "order" set status = 'proposed', updated_at = now()
           where id = v_order.id and status = 'pending';

          movimiento := m.id; confianza := 'alta';
          motivo := 'código + monto'; orden := v_order.id;
          return next;
          continue;
        else
          -- Código correcto, monto distinto: casi siempre pagó de más
          -- o de menos. No se propone, se mira.
          update bank_movement
             set match_confidence = 'ambigua',
                 match_reason = 'código ' || v_order.code ||
                                ' pero monto no coincide (esperado ' ||
                                (v_order.total_cents/100)::text || ')'
           where id = m.id;

          movimiento := m.id; confianza := 'ambigua';
          motivo := 'código ok, monto distinto'; orden := v_order.id;
          return next;
          continue;
        end if;
      end if;
    end if;

    -- ── 2. Sin código: ¿una sola orden pendiente con ese monto? ────
    select count(*) into v_count
      from "order"
     where status = 'pending'
       and payment_method = 'transfer'
       and total_cents = m.amount_cents
       and created_at between m.movement_date - interval '30 days'
                          and m.movement_date + interval '2 days';

    if v_count = 1 then
      select * into v_order
        from "order"
       where status = 'pending'
         and payment_method = 'transfer'
         and total_cents = m.amount_cents
         and created_at between m.movement_date - interval '30 days'
                            and m.movement_date + interval '2 days';

      update bank_movement
         set status = 'proposed', order_id = v_order.id,
             match_confidence = 'media',
             match_reason = 'sin código, única orden pendiente por $' ||
                            (m.amount_cents/100)::text
       where id = m.id;
      update "order" set status = 'proposed', updated_at = now()
       where id = v_order.id;

      movimiento := m.id; confianza := 'media';
      motivo := 'monto único'; orden := v_order.id;
      return next;

    elsif v_count > 1 then
      update bank_movement
         set match_confidence = 'ambigua',
             match_reason = v_count::text || ' órdenes pendientes por $' ||
                            (m.amount_cents/100)::text
       where id = m.id;

      movimiento := m.id; confianza := 'ambigua';
      motivo := v_count::text || ' candidatas'; orden := null;
      return next;
    end if;
    -- v_count = 0 → queda unmatched, sin ruido
  end loop;
end $mm$;


-- ───────────────────────────────────────────────────────────────────
--  CONFIRMAR — acá se emiten las entradas y se encola el email
-- ───────────────────────────────────────────────────────────────────
create or replace function confirm_order(p_order_id uuid, p_by text default 'admin')
returns table (ok boolean, mensaje text, entradas int)
language plpgsql as $co$
declare
  o       record;
  l       record;
  i       int;
  n       int := 0;
  v_id    uuid;
  v_seq   bigint;
begin
  select * into o from "order" where id = p_order_id for update;

  if o.id is null then
    return query select false, 'orden inexistente', 0; return;
  end if;
  if o.status = 'paid' then
    return query select false, 'ya estaba confirmada', 0; return;
  end if;
  if o.status not in ('pending','proposed') then
    return query select false, 'estado ' || o.status || ', no se puede confirmar', 0; return;
  end if;

  update "order"
     set status = 'paid', paid_at = now(), updated_at = now()
   where id = p_order_id;

  update bank_movement
     set status = 'confirmed', reviewed_at = now(), reviewed_by = p_by
   where order_id = p_order_id and status = 'proposed';

  -- Una entrada por persona.
  for l in select ticket_type_id, quantity from order_item where order_id = p_order_id
  loop
    for i in 1..l.quantity loop
      v_id  := gen_random_uuid();
      v_seq := nextval('ticket_code_seq');
      insert into ticket (id, order_id, event_id, ticket_type_id, code, qr_token, status)
      values (
        v_id, p_order_id, o.event_id, l.ticket_type_id,
        'ARC-' || lpad(upper(to_hex(v_seq)), 4, '0'),
        -- ⚠️ el secreto real vive en variables de entorno, no acá.
        -- Esta firma es provisoria: para producción, generar el
        -- qr_token en la función de Vercel que tiene TICKET_SECRET.
        v_id::text || '.' || encode(hmac(v_id::text, 'CAMBIAR-EN-PRODUCCION', 'sha256'), 'hex'),
        'valid'
      );
      n := n + 1;
    end loop;
  end loop;

  -- Encolar el mail en la MISMA transacción: si algo falla, se
  -- deshace todo junto y no queda una orden paga sin avisar.
  insert into email_outbox (order_id, to_email) values (p_order_id, o.buyer_email);

  return query select true, 'confirmada, ' || n::text || ' entrada(s)', n;
end $co$;


-- Rechazar un emparejamiento propuesto y devolver todo a su lugar.
create or replace function reject_match(p_movement_id uuid, p_by text default 'admin')
returns text language plpgsql as $rj$
declare v_order uuid;
begin
  select order_id into v_order from bank_movement where id = p_movement_id;

  update bank_movement
     set status = 'unmatched', order_id = null,
         match_confidence = null, match_reason = null,
         reviewed_at = now(), reviewed_by = p_by
   where id = p_movement_id;

  if v_order is not null then
    update "order" set status = 'pending', updated_at = now()
     where id = v_order and status = 'proposed';
  end if;

  return 'desvinculado';
end $rj$;


-- ───────────────────────────────────────────────────────────────────
--  VISTAS DE TRABAJO
-- ───────────────────────────────────────────────────────────────────

-- LA COLA. Esto es lo que mirás cada mañana.
create or replace view cola_revision as
select
  bm.id                          as movimiento_id,
  o.id                           as order_id,
  o.code                         as codigo,
  bm.match_confidence            as confianza,
  bm.match_reason                as motivo,
  o.buyer_first_name || ' ' || o.buyer_last_name as comprador,
  o.buyer_email,
  bm.counterparty_name           as nombre_en_extracto,
  o.total_cents/100              as esperado,
  bm.amount_cents/100            as recibido,
  e.name                         as evento,
  bm.movement_date               as fecha_transferencia,
  o.created_at                   as fecha_orden
from bank_movement bm
join "order" o on o.id = bm.order_id
join event e   on e.id = o.event_id
where bm.status = 'proposed'
order by (bm.match_confidence = 'alta') desc, bm.movement_date;

comment on view cola_revision is
  'Confianza alta = código + monto exacto, se puede confirmar en lote. Media = emparejada solo por monto, mirar antes.';


-- Plata que llegó y no sabemos de quién es.
create or replace view movimientos_sin_match as
select id, movement_date, amount_cents/100 as monto,
       counterparty_name, description, match_confidence, match_reason
  from bank_movement
 where status = 'unmatched' or match_confidence = 'ambigua'
 order by movement_date desc;


-- Gente que reservó y nunca pagó (o pagó y no lo detectamos).
create or replace view ordenes_sin_pago as
select o.code, o.buyer_first_name || ' ' || o.buyer_last_name as comprador,
       o.buyer_email, o.buyer_phone, o.total_cents/100 as monto,
       e.name as evento, o.created_at,
       round(extract(epoch from (now() - o.created_at))/3600) as horas
  from "order" o
  join event e on e.id = o.event_id
 where o.status = 'pending' and o.payment_method = 'transfer'
 order by o.created_at;


-- ═══════════════════════════════════════════════════════════════════
--  USO DIARIO
--
--    select * from match_movements();        -- emparejar lo importado
--    select * from cola_revision;            -- revisar
--    select * from confirm_order('<uuid>');  -- confirmar una
--    select * from movimientos_sin_match;    -- lo que quedó suelto
--    select * from ordenes_sin_pago;         -- reservas sin transferencia
--
--  Confirmar todas las de confianza alta de una:
--    select o.code, (confirm_order(o.order_id)).*
--      from cola_revision o where o.confianza = 'alta';
--
--
--  PENDIENTE ANTES DE USAR EN SERIO:
--
--  · EL IMPORTADOR. Falta el paso que lee el extracto de Mercado Pago
--    y llena bank_movement. No lo escribí porque no sé qué columnas
--    trae el CSV de MP. Bajá un extracto real, mandame el encabezado
--    y lo armo en diez minutos. Lo que importa es mapear el id de
--    operación a external_id — eso es lo que hace que reimportar el
--    mismo archivo sea inofensivo.
--
--  · EL qr_token de confirm_order() usa un secreto de mentira. Antes
--    de emitir entradas reales hay que generarlo en la función de
--    Vercel que tiene TICKET_SECRET, o el lector de puerta no va a
--    validar nada.
--
--  · EL HOLD de las órdenes por transferencia tiene que ser 48 h, no
--    15 min. La app lo setea al crear la orden según payment_method.
-- ═══════════════════════════════════════════════════════════════════

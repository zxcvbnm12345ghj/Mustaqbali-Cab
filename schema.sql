-- =========================================================
-- Mustaqbali Cab — Database Schema (Supabase / Postgres)
-- Safe to re-run on a fresh OR an already-deployed database: every
-- statement is guarded with IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS / DO $$ ... $$ blocks where applicable.
--
-- v1.1 changes (Careem/Uber-quality UI support):
--   - status pipeline extended from 4 to 5 stages:
--       new -> assigned -> en_route -> arrived -> completed  (+ cancelled)
--   - driver profile fields added: photo, car type, plate, rating, ETA
--   - new get_trip_request_status() RPC: lets the CUSTOMER poll their own
--     trip (matched by request_number + phone, not by auth) so the status
--     screen can show real live data instead of freezing at "new" forever.
--     This does NOT weaken security -- it returns a narrow, whitelisted set
--     of columns for exactly one row, never a listing.
-- =========================================================

-- ---------------------------------------------------------
-- 1) trip_requests
-- ---------------------------------------------------------
create table if not exists trip_requests (
  id                uuid primary key default gen_random_uuid(),
  request_number    text unique,
  service_type      text not null check (service_type in ('taxi','private','courier','intercity','cargo','starx')),
  customer_name     text not null check (char_length(customer_name) <= 100),
  phone             text not null check (char_length(phone) <= 20),
  pickup_location   text not null check (char_length(pickup_location) <= 300),
  pickup_lat        numeric,
  pickup_lng        numeric,
  dropoff_location  text check (char_length(dropoff_location) <= 300),
  scheduled_at      timestamptz,
  notes             text check (char_length(notes) <= 500),
  status            text not null default 'new',
  driver_name       text check (char_length(driver_name) <= 100),
  driver_phone      text check (char_length(driver_phone) <= 20),
  driver_photo_url  text check (char_length(driver_photo_url) <= 500),
  driver_car_type   text check (char_length(driver_car_type) <= 100),
  driver_plate      text check (char_length(driver_plate) <= 20),
  driver_rating     numeric check (driver_rating >= 0 and driver_rating <= 5),
  eta_minutes       integer check (eta_minutes >= 0 and eta_minutes <= 999),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_trip_requests_created_at on trip_requests (created_at desc);
create index if not exists idx_trip_requests_status on trip_requests (status);
create index if not exists idx_trip_requests_request_number on trip_requests (request_number);

-- --- Migration: widen the status CHECK constraint to 5 stages -----------
do $$
begin
  alter table trip_requests drop constraint if exists trip_requests_status_check;
  alter table trip_requests add constraint trip_requests_status_check
    check (status in ('new','assigned','en_route','arrived','completed','cancelled'));
exception when others then
  raise notice 'status constraint migration skipped: %', sqlerrm;
end $$;

-- --- Migration: widen service_type to add "cargo" (حمل) and "starx"
--     (ستاركس -- van/kia group passenger transport), for an already-
--     deployed table where the original CREATE TABLE already ran. ---
do $$
begin
  alter table trip_requests drop constraint if exists trip_requests_service_type_check;
  alter table trip_requests add constraint trip_requests_service_type_check
    check (service_type in ('taxi','private','courier','intercity','cargo','starx'));
exception when others then
  raise notice 'service_type constraint migration skipped: %', sqlerrm;
end $$;

-- --- Migration: add driver profile columns if this is an existing table -
alter table trip_requests add column if not exists driver_photo_url text check (char_length(driver_photo_url) <= 500);
alter table trip_requests add column if not exists driver_car_type  text check (char_length(driver_car_type) <= 100);
alter table trip_requests add column if not exists driver_plate     text check (char_length(driver_plate) <= 20);
alter table trip_requests add column if not exists driver_rating    numeric check (driver_rating >= 0 and driver_rating <= 5);
alter table trip_requests add column if not exists eta_minutes      integer check (eta_minutes >= 0 and eta_minutes <= 999);

-- --- Migration: any existing 'in_progress' rows from v1.0 map to 'en_route'
update trip_requests set status = 'en_route' where status = 'in_progress';

-- ---------------------------------------------------------
-- 2) trip_status_history -- one row per status change, via trigger only
-- ---------------------------------------------------------
create table if not exists trip_status_history (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trip_requests(id) on delete cascade,
  status      text not null,
  changed_at  timestamptz not null default now()
);

create index if not exists idx_trip_status_history_trip_id on trip_status_history (trip_id);

-- ---------------------------------------------------------
-- 3) whatsapp_notifications -- queue for the admin-side WhatsApp Edge Function
-- ---------------------------------------------------------
create table if not exists whatsapp_notifications (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trip_requests(id) on delete cascade,
  payload     jsonb not null,
  sent        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists idx_whatsapp_notifications_trip_id on whatsapp_notifications (trip_id);
create index if not exists idx_whatsapp_notifications_sent on whatsapp_notifications (sent) where sent = false;

-- ---------------------------------------------------------
-- 4) admins -- explicit allow-list, NOT just "authenticated"
-- ---------------------------------------------------------
create table if not exists admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------
-- 5) is_admin() -- stable, indexed lookup, used in every admin RLS policy
-- ---------------------------------------------------------
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------
-- 6) request_number generator: MSQ-YYYYMMDD-#### (global sequence,
--    not reset daily -- simpler and still guarantees no collisions
--    under concurrent inserts via nextval()'s atomicity)
-- ---------------------------------------------------------
create sequence if not exists trip_request_seq;

create or replace function set_trip_request_number()
returns trigger
language plpgsql
as $$
begin
  if new.request_number is null then
    new.request_number := 'MSQ-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('trip_request_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_trip_request_number on trip_requests;
create trigger trg_set_trip_request_number
  before insert on trip_requests
  for each row execute function set_trip_request_number();

-- ---------------------------------------------------------
-- 7) updated_at bump
-- ---------------------------------------------------------
create or replace function bump_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_bump_updated_at on trip_requests;
create trigger trg_bump_updated_at
  before update on trip_requests
  for each row execute function bump_updated_at();

-- ---------------------------------------------------------
-- 8) log_trip_status -- writes to trip_status_history on insert/status
--    change. Must be SECURITY DEFINER: trip_status_history intentionally
--    has NO insert policy for any role (see section 12) -- it's meant to
--    be written ONLY by this trigger, never directly. When triggered by
--    submit_trip_request() (itself SECURITY DEFINER) this already ran
--    with elevated rights and worked. But an admin's direct
--    `.update(trip_requests)` from admin.js runs as the authenticated
--    admin's own role (SECURITY INVOKER) -- so without this trigger
--    function ALSO being SECURITY DEFINER, its own insert into
--    trip_status_history was blocked by RLS with "new row violates
--    row-level security policy for table trip_status_history", even
--    though the trip_requests status update itself succeeded.
-- ---------------------------------------------------------
create or replace function log_trip_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') or (new.status is distinct from old.status) then
    insert into trip_status_history (trip_id, status) values (new.id, new.status);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_log_trip_status_insert on trip_requests;
create trigger trg_log_trip_status_insert
  after insert on trip_requests
  for each row execute function log_trip_status();

drop trigger if exists trg_log_trip_status_update on trip_requests;
create trigger trg_log_trip_status_update
  after update on trip_requests
  for each row execute function log_trip_status();

-- ---------------------------------------------------------
-- 9) queue_whatsapp_notification -- writes to whatsapp_notifications on insert
-- ---------------------------------------------------------
create or replace function queue_whatsapp_notification()
returns trigger
language plpgsql
as $$
begin
  insert into whatsapp_notifications (trip_id, payload)
  values (new.id, jsonb_build_object(
    'request_number', new.request_number,
    'service_type', new.service_type,
    'customer_name', new.customer_name,
    'phone', new.phone,
    'pickup_location', new.pickup_location,
    'dropoff_location', new.dropoff_location
  ));
  return new;
end;
$$;

drop trigger if exists trg_queue_whatsapp_notification on trip_requests;
create trigger trg_queue_whatsapp_notification
  after insert on trip_requests
  for each row execute function queue_whatsapp_notification();

-- ---------------------------------------------------------
-- 10) submit_trip_request() -- the ONLY way anon can create a trip request.
--     Accepts a fixed set of fields, always forces status = 'new',
--     returns only id + request_number (never the full row).
-- ---------------------------------------------------------
create or replace function submit_trip_request(
  p_service_type      text,
  p_customer_name     text,
  p_phone             text,
  p_pickup_location   text,
  p_pickup_lat        numeric,
  p_pickup_lng        numeric,
  p_dropoff_location  text,
  p_scheduled_at      timestamptz,
  p_notes             text
)
returns table (id uuid, request_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_request_number text;
begin
  if p_service_type not in ('taxi','private','courier','intercity','cargo','starx') then
    raise exception 'invalid service_type';
  end if;
  if p_customer_name is null or length(trim(p_customer_name)) = 0 then
    raise exception 'customer_name is required';
  end if;
  if p_phone is null or length(trim(p_phone)) = 0 then
    raise exception 'phone is required';
  end if;
  if p_pickup_location is null or length(trim(p_pickup_location)) = 0 then
    raise exception 'pickup_location is required';
  end if;

  insert into trip_requests (
    service_type, customer_name, phone, pickup_location, pickup_lat, pickup_lng,
    dropoff_location, scheduled_at, notes, status
  ) values (
    p_service_type, p_customer_name, p_phone, p_pickup_location, p_pickup_lat, p_pickup_lng,
    p_dropoff_location, p_scheduled_at, p_notes, 'new'
  )
  returning trip_requests.id, trip_requests.request_number into v_id, v_request_number;

  return query select v_id, v_request_number;
end;
$$;

grant execute on function submit_trip_request(text, text, text, text, numeric, numeric, text, timestamptz, text) to anon, authenticated;

-- ---------------------------------------------------------
-- 11) get_trip_request_status() -- the ONLY way a customer can read back
--     their own trip's live status/driver info. Requires BOTH the exact
--     request_number AND the exact phone number used at submission time --
--     this is a possession-proof check (like a tracking-number + surname
--     pattern used by courier companies), not authentication, and it
--     returns a narrow whitelist of columns for exactly one row. It never
--     allows listing, searching, or browsing other customers' trips.
-- ---------------------------------------------------------
create or replace function get_trip_request_status(
  p_request_number text,
  p_phone text
)
returns table (
  status text,
  service_type text,
  pickup_location text,
  dropoff_location text,
  created_at timestamptz,
  driver_name text,
  driver_phone text,
  driver_photo_url text,
  driver_car_type text,
  driver_plate text,
  driver_rating numeric,
  eta_minutes integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.status, t.service_type, t.pickup_location, t.dropoff_location, t.created_at,
    t.driver_name, t.driver_phone, t.driver_photo_url, t.driver_car_type, t.driver_plate,
    t.driver_rating, t.eta_minutes
  from trip_requests t
  where t.request_number = p_request_number
    and t.phone = p_phone
  limit 1;
$$;

grant execute on function get_trip_request_status(text, text) to anon, authenticated;

-- ---------------------------------------------------------
-- 11b) service_prices -- real, DB-driven, admin-editable pricing.
--      base_price + (distance_km * price_per_km) = the price shown to
--      the customer. Public (anon) can only SELECT this — never write
--      to it; only an admin can UPDATE it. Rows are fixed to the six
--      existing services, so no INSERT/DELETE policy is needed.
-- ---------------------------------------------------------
create table if not exists service_prices (
  service_type   text primary key check (service_type in ('taxi','private','courier','intercity','cargo','starx')),
  label          text not null,
  base_price     numeric not null default 0 check (base_price >= 0),
  price_per_km   numeric not null default 0 check (price_per_km >= 0),
  updated_at     timestamptz not null default now()
);

-- --- Migration: widen service_prices' own CHECK the same way, for an
--     already-deployed table. ---
do $$
begin
  alter table service_prices drop constraint if exists service_prices_service_type_check;
  alter table service_prices add constraint service_prices_service_type_check
    check (service_type in ('taxi','private','courier','intercity','cargo','starx'));
exception when others then
  raise notice 'service_prices constraint migration skipped: %', sqlerrm;
end $$;

insert into service_prices (service_type, label, base_price, price_per_km) values
  ('taxi',      'تكسي',            3000, 500),
  ('private',   'خصوصي',           8000, 800),
  ('courier',   'دليفري',          2000, 400),
  ('intercity', 'بين المحافظات',    20000, 350),
  ('cargo',     'حمل',             6000, 700),
  ('starx',     'ستاركس',          4000, 550)
on conflict (service_type) do nothing;

-- --- Migration: "توصيل أغراض" was renamed to "دليفري" -- update the
--     label on an already-deployed row (the INSERT above only affects
--     a brand-new row, never an existing one, because of ON CONFLICT
--     DO NOTHING). Safe to re-run. ---
update service_prices set label = 'دليفري' where service_type = 'courier';

drop trigger if exists trg_service_prices_updated_at on service_prices;
create trigger trg_service_prices_updated_at
  before update on service_prices
  for each row execute function bump_updated_at();

alter table service_prices enable row level security;

drop policy if exists "public read service_prices" on service_prices;
create policy "public read service_prices" on service_prices
  for select using (true);

drop policy if exists "admin update service_prices" on service_prices;
create policy "admin update service_prices" on service_prices
  for update using (is_admin()) with check (is_admin());

grant select on service_prices to anon, authenticated;

-- ---------------------------------------------------------
-- 12) Row Level Security
-- ---------------------------------------------------------
alter table trip_requests enable row level security;
alter table trip_status_history enable row level security;
alter table whatsapp_notifications enable row level security;
alter table admins enable row level security;

drop policy if exists "admin select trip_requests" on trip_requests;
create policy "admin select trip_requests" on trip_requests
  for select using (is_admin());

drop policy if exists "admin update trip_requests" on trip_requests;
create policy "admin update trip_requests" on trip_requests
  for update using (is_admin()) with check (is_admin());

drop policy if exists "admin select trip_status_history" on trip_status_history;
create policy "admin select trip_status_history" on trip_status_history
  for select using (is_admin());

drop policy if exists "admin select whatsapp_notifications" on whatsapp_notifications;
create policy "admin select whatsapp_notifications" on whatsapp_notifications
  for select using (is_admin());

drop policy if exists "self select admins" on admins;
create policy "self select admins" on admins
  for select using (user_id = auth.uid());

-- ---------------------------------------------------------
-- 13) drivers -- simple driver roster with automatic fair-rotation
--     queue per service_type. "Front of the queue" = the active
--     driver with the oldest last_served_at for that service_type;
--     tapping call/WhatsApp on the featured driver bumps their
--     last_served_at to now(), sending them to the back of the line
--     (see select_driver() below). A brand-new driver defaults to
--     last_served_at = now(), so they start at the BACK of the
--     queue automatically -- they never jump ahead of anyone already
--     waiting. This needs no separate "position" column to maintain.
-- ---------------------------------------------------------
create table if not exists drivers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) <= 100),
  phone          text not null check (char_length(phone) <= 20),
  vehicle_type   text check (char_length(vehicle_type) <= 100),
  service_type   text not null check (service_type in ('taxi','private','courier','intercity','cargo','starx')),
  active         boolean not null default true,
  last_served_at timestamptz not null default now(),
  request_count  integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists idx_drivers_service_active on drivers (service_type, active, last_served_at);

-- --- Migration: widen drivers.service_type too, in case this table was
--     already deployed from an earlier version of this file. ---
do $$
begin
  alter table drivers drop constraint if exists drivers_service_type_check;
  alter table drivers add constraint drivers_service_type_check
    check (service_type in ('taxi','private','courier','intercity','cargo','starx'));
exception when others then
  raise notice 'drivers service_type constraint migration skipped: %', sqlerrm;
end $$;

alter table drivers enable row level security;

-- No anon SELECT policy on this table on purpose: customers never query
-- `drivers` directly. They only ever see ONE driver at a time (the front
-- of their service's queue), through the narrow get_front_driver() RPC
-- below -- never the full roster, never other drivers' details.
drop policy if exists "admin select drivers" on drivers;
create policy "admin select drivers" on drivers
  for select using (is_admin());

drop policy if exists "admin insert drivers" on drivers;
create policy "admin insert drivers" on drivers
  for insert with check (is_admin());

drop policy if exists "admin update drivers" on drivers;
create policy "admin update drivers" on drivers
  for update using (is_admin()) with check (is_admin());

drop policy if exists "admin delete drivers" on drivers;
create policy "admin delete drivers" on drivers
  for delete using (is_admin());

-- ---------------------------------------------------------
-- 14) get_front_driver() -- the ONLY way anon (the customer app) can
--     read driver info. Returns just the id + phone number of whichever
--     active driver is currently at the front of that service's queue
--     (zero rows if none active yet) -- deliberately NOT the driver's
--     name or vehicle type: those stay admin-only. The customer app
--     shows the service type (which it already knows, since the
--     customer picked it) instead of a driver identity.
--     v1.2: dropped first because CREATE OR REPLACE cannot change an
--     existing function's return columns.
-- ---------------------------------------------------------
drop function if exists get_front_driver(text);

create or replace function get_front_driver(p_service_type text)
returns table (id uuid, phone text)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.phone
  from drivers d
  where d.service_type = p_service_type and d.active = true
  order by d.last_served_at asc, d.created_at asc
  limit 1;
$$;

grant execute on function get_front_driver(text) to anon, authenticated;

-- ---------------------------------------------------------
-- 15) select_driver() -- rotation + request counting.
--     v1.2: this is now called from the app ONLY at the moment a real
--     trip request is actually submitted (submit_trip_request success),
--     never on a bare call/WhatsApp tap. Tapping call or WhatsApp with
--     no follow-through must NOT move the driver in the queue.
-- ---------------------------------------------------------
create or replace function select_driver(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update drivers
  set last_served_at = now(), request_count = request_count + 1
  where id = p_driver_id and active = true;
end;
$$;

grant execute on function select_driver(uuid) to anon, authenticated;

-- ---------------------------------------------------------
-- 16) get_service_drivers() -- v1.3: returns ALL active drivers for a
--     service, in current queue order (front of the array = front of
--     the queue = who get_front_driver() would have returned). Lets
--     the customer browse and pick any of them, not just the front
--     one. Same privacy rule as get_front_driver(): never the
--     driver's name or vehicle type, only id + phone.
-- ---------------------------------------------------------
create or replace function get_service_drivers(p_service_type text)
returns table (id uuid, phone text)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.phone
  from drivers d
  where d.service_type = p_service_type and d.active = true
  order by d.last_served_at asc, d.created_at asc;
$$;

grant execute on function get_service_drivers(text) to anon, authenticated;

-- =========================================================
-- Post-install manual step (cannot be scripted):
--   insert into admins (user_id) values ('paste-the-auth-user-uid-here');
--
-- If this is an upgrade from v1.0 (not a fresh install), simply re-run
-- this entire file -- every migration block above is idempotent.
-- =========================================================

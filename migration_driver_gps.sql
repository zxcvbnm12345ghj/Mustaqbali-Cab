-- =========================================================
-- Mustaqbali Cab — Migration: driver.html live GPS tracking
-- Separate from schema.sql on purpose (per project rule: schema.sql is
-- only touched when unavoidable). Safe to re-run: every statement is
-- guarded with IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
--
-- What this adds:
--   1) drivers.driver_token — long random secret, one per driver, used
--      as the ONLY credential for driver.html (no password, no
--      Supabase Auth account per driver — see chat decision).
--   2) driver_locations — one row per driver, upserted on every GPS
--      ping. Kept separate from `drivers` so frequent location writes
--      never touch (or lock) the row the booking/queue system reads.
--   3) update_driver_location() — the only way driver.html can write a
--      location, authenticated purely by knowing the driver's own
--      token. SECURITY DEFINER, anon-callable (driver.html has no
--      Supabase session).
--   4) get_service_driver_roster() — re-created with 3 additional
--      output columns (driver_lat, driver_lng, location_updated_at).
--      The underlying ORDER BY and status logic are UNCHANGED —
--      zone/distance sorting happens entirely client-side in app.js,
--      so the existing fair-rotation queue (last_served_at,
--      select_driver()) is not touched by this migration at all.
--
-- Nothing here alters trip_requests, trip_status_history,
-- whatsapp_notifications, or any existing RPC's queue/notification
-- behavior.
-- =========================================================

-- ---------------------------------------------------------
-- 1) drivers.driver_token
-- ---------------------------------------------------------
alter table drivers add column if not exists driver_token text;

-- Backfill existing drivers with a random 64-hex-char token (two
-- concatenated UUIDs with dashes stripped — no pgcrypto extension
-- required, uses only gen_random_uuid() which the project already
-- relies on elsewhere in schema.sql).
update drivers
set driver_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
where driver_token is null;

alter table drivers alter column driver_token set not null;

do $$
begin
  alter table drivers add constraint drivers_driver_token_unique unique (driver_token);
exception when duplicate_table or duplicate_object then
  raise notice 'drivers_driver_token_unique already exists, skipped';
end $$;

-- Auto-generate a token for any driver inserted from now on without one
-- (admin panel keeps inserting drivers exactly as before; this just
-- fills the new column automatically so nothing there has to change).
create or replace function set_driver_token()
returns trigger
language plpgsql
as $$
begin
  if new.driver_token is null then
    new.driver_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_driver_token on drivers;
create trigger trg_set_driver_token
  before insert on drivers
  for each row execute function set_driver_token();

-- No new SELECT policy on `drivers` for driver_token: the existing
-- "admin select drivers" policy (schema.sql §13) already covers it —
-- an admin can already read the whole row, including the new column.
-- driver.html itself never SELECTs `drivers` directly; it only ever
-- sends its token as a parameter to update_driver_location() below.

-- ---------------------------------------------------------
-- 2) driver_locations — one row per driver, upserted on every ping
-- ---------------------------------------------------------
create table if not exists driver_locations (
  driver_id   uuid primary key references drivers(id) on delete cascade,
  lat         numeric not null check (lat between -90 and 90),
  lng         numeric not null check (lng between -180 and 180),
  updated_at  timestamptz not null default now()
);

alter table driver_locations enable row level security;

-- Locked down exactly like `drivers`: no anon policy at all. Both
-- update_driver_location() (write) and get_service_driver_roster()
-- (read, via the LEFT JOIN below) are SECURITY DEFINER, so they bypass
-- RLS entirely — nobody, anon or authenticated, can SELECT this table
-- directly. Only an admin can, for a future admin live-map view.
drop policy if exists "admin select driver_locations" on driver_locations;
create policy "admin select driver_locations" on driver_locations
  for select using (is_admin());

-- ---------------------------------------------------------
-- 3) update_driver_location() — driver.html's only write path.
--    Token IS the authentication: anyone who does not hold a specific
--    driver's token cannot move that driver's marker. If the token
--    does not match any active driver, this is a silent no-op (never
--    reveals whether a token exists via error messages/timing-visible
--    branching).
-- ---------------------------------------------------------
create or replace function update_driver_location(
  p_token text,
  p_lat    numeric,
  p_lng    numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
begin
  if p_lat is null or p_lng is null or p_token is null then
    return;
  end if;
  if p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return;
  end if;

  select id into v_driver_id
  from drivers
  where driver_token = p_token and active = true;

  if v_driver_id is null then
    return;
  end if;

  insert into driver_locations (driver_id, lat, lng, updated_at)
  values (v_driver_id, p_lat, p_lng, now())
  on conflict (driver_id)
  do update set lat = excluded.lat, lng = excluded.lng, updated_at = now();
end;
$$;

grant execute on function update_driver_location(text, numeric, numeric) to anon, authenticated;

-- ---------------------------------------------------------
-- 4) get_service_driver_roster() — re-created with 3 extra columns.
--    Must DROP first: CREATE OR REPLACE cannot change an existing
--    function's return columns (same rule already used for
--    get_front_driver() in schema.sql §14).
--    Everything else — the WITH clause, the status CASE, the ORDER BY —
--    is copied byte-for-byte from the current production definition
--    you provided. Only a LEFT JOIN to driver_locations and 3 new
--    SELECT columns are added.
-- ---------------------------------------------------------
drop function if exists get_service_driver_roster(text);

create or replace function get_service_driver_roster(p_service_type text)
returns table (
  id                    uuid,
  phone                 text,
  vehicle_type          text,
  status                text,
  driver_lat            numeric,
  driver_lng            numeric,
  location_updated_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with open_trip_phones as (
    select distinct t.driver_phone
    from trip_requests t
    where t.status in ('assigned','en_route','arrived')
      and t.driver_phone is not null
  )
  select
    d.id,
    d.phone,
    d.vehicle_type,
    case
      when d.active = false then 'offline'
      when d.phone in (select driver_phone from open_trip_phones) then 'busy'
      else 'active'
    end as status,
    dl.lat as driver_lat,
    dl.lng as driver_lng,
    dl.updated_at as location_updated_at
  from drivers d
  left join driver_locations dl on dl.driver_id = d.id
  where d.service_type = p_service_type
  order by d.active desc, d.last_served_at asc, d.created_at asc;
$$;

grant execute on function get_service_driver_roster(text) to anon, authenticated;

-- =========================================================
-- Post-install manual step (per driver, cannot be scripted):
--   select id, name, driver_token from drivers where service_type = '...';
--   → build each driver's link as:
--     https://<your-domain>/driver.html?token=<driver_token>
--   Send that link to the driver once. It never changes unless you
--   manually re-run: update drivers set driver_token = ... where id = '...';
-- =========================================================

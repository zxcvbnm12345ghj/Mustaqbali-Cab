-- =========================================================
-- Mustaqbali Cab — Migration 3 (FINAL): submit_trip_request
--
-- Supersedes migration_driver_selection_fix.sql's version of this same
-- function (that file's draft never ran — nothing has been executed
-- yet — so this is simply the final, complete definition; no need to
-- run both).
--
-- New behavior, per the agreed design:
--   1) Customer named a specific driver → that driver gets the trip +
--      admin gets notified. (unchanged from migration 2's draft)
--   2) Customer did NOT name a driver → the SAME FIFO queue
--      get_front_driver() already uses (identical ordering: active,
--      last_served_at asc, created_at asc) is claimed automatically,
--      atomically, inside this one function — no separate manual step
--      needed anymore. The driver + admin both get notified exactly
--      like path 1.
--
-- Fairness is NOT changed — only automated. The ordering rule and the
-- two columns that track it (last_served_at, request_count) are
-- identical to what get_front_driver()/select_driver() already use.
-- The only real difference from "call get_front_driver() then
-- select_driver() separately" is `FOR UPDATE SKIP LOCKED`, which closes
-- a genuine race window those two separate calls never protected
-- against: two customers booking in the same instant could previously
-- both see the same "front" driver before either one's bump landed,
-- assigning that one driver to two trips at once. Doing the pick AND
-- the bump in one atomic statement makes that impossible.
--
-- ⚠️ Companion change already made in app.js: the separate
-- `select_driver()` RPC call that used to run after a successful
-- submission has been REMOVED. The bump now happens once, inside this
-- function, for both paths. Do not add that call back — it would
-- double-count request_count/last_served_at for the same booking.
--
-- get_front_driver() and select_driver() themselves are UNTOUCHED and
-- still used elsewhere (e.g. any future "who's next" display) exactly
-- as before.
-- =========================================================

drop function if exists submit_trip_request(text, text, text, text, numeric, numeric, text, timestamptz, text);
drop function if exists submit_trip_request(text, text, text, text, numeric, numeric, text, timestamptz, text, text);

create or replace function submit_trip_request(
  p_service_type            text,
  p_customer_name           text,
  p_phone                   text,
  p_pickup_location         text,
  p_pickup_lat              numeric,
  p_pickup_lng              numeric,
  p_dropoff_location        text,
  p_scheduled_at            timestamptz,
  p_notes                   text,
  p_selected_driver_phone   text default null
)
returns table (id uuid, request_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id                uuid;
  v_request_number    text;
  v_driver_id          uuid;
  v_driver_name        text;
  v_driver_car_type    text;
  v_driver_phone       text;
  v_status             text := 'new';
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

  if p_selected_driver_phone is not null and length(trim(p_selected_driver_phone)) > 0 then
    -- Path 1: customer specified a particular driver. Re-validate
    -- they're still active for this exact service right now (they may
    -- have gone inactive between browsing and confirming).
    select d.id, d.name, d.vehicle_type, d.phone
    into v_driver_id, v_driver_name, v_driver_car_type, v_driver_phone
    from drivers d
    where d.phone = p_selected_driver_phone
      and d.service_type = p_service_type
      and d.active = true
    limit 1;
  else
    -- Path 2: no driver specified — atomically claim the front of the
    -- existing FIFO queue. FOR UPDATE locks the winning row so a
    -- concurrent simultaneous call can't also pick it; SKIP LOCKED
    -- means a concurrent call just moves on to the next-longest-
    -- waiting driver instead of blocking/erroring.
    select d.id, d.name, d.vehicle_type, d.phone
    into v_driver_id, v_driver_name, v_driver_car_type, v_driver_phone
    from drivers d
    where d.service_type = p_service_type and d.active = true
    order by d.last_served_at asc, d.created_at asc
    limit 1
    for update skip locked;
  end if;

  if v_driver_id is not null then
    v_status := 'assigned';
    -- The exact same bump select_driver() has always done — same two
    -- columns, same semantics — just applied atomically here instead
    -- of via a second, separate call.
    update drivers
    set last_served_at = now(), request_count = request_count + 1
    where id = v_driver_id;
  end if;
  -- If no active driver was found or claimable (path 1's phone didn't
  -- match, or path 2 found nobody free), v_status stays 'new' and the
  -- trip is created unassigned — identical to today's existing
  -- fallback behavior. The booking itself never fails over this.

  insert into trip_requests (
    service_type, customer_name, phone, pickup_location, pickup_lat, pickup_lng,
    dropoff_location, scheduled_at, notes, status,
    driver_name, driver_phone, driver_car_type
  ) values (
    p_service_type, p_customer_name, p_phone, p_pickup_location, p_pickup_lat, p_pickup_lng,
    p_dropoff_location, p_scheduled_at, p_notes, v_status,
    v_driver_name, v_driver_phone, v_driver_car_type
  )
  returning trip_requests.id, trip_requests.request_number into v_id, v_request_number;

  return query select v_id, v_request_number;
end;
$$;

grant execute on function submit_trip_request(text, text, text, text, numeric, numeric, text, timestamptz, text, text) to anon, authenticated;

-- ---------------------------------------------------------
-- Push notification triggers: NO CHANGE NEEDED.
-- queue_driver_push_on_assignment() (migration_push_notifications.sql)
-- already fires whenever driver_phone changes to a new non-empty
-- value, regardless of HOW it got set. Since this function sets
-- driver_phone on INSERT for both path 1 and path 2, that existing
-- trigger already correctly notifies the right driver for both —
-- confirmed by re-reading its condition, not re-verified live (no DB
-- access here).
-- queue_admin_push_on_new_order() fires on every INSERT unconditionally
-- — already covers every request from both paths too.
-- =========================================================

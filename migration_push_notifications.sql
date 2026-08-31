-- =========================================================
-- Mustaqbali Cab — Migration: Push Notifications (replaces Telegram)
-- Separate from schema.sql, per project convention.
--
-- Zero impact on existing systems, by construction:
--   - Does NOT touch queue_whatsapp_notification, whatsapp_notifications,
--     drivers, driver_locations, last_served_at, request_count,
--     select_driver(), get_front_driver(), or submit_trip_request().
--   - Every new object below is additive (new tables, new triggers,
--     new functions) — nothing here alters an existing column, row, or
--     function signature.
--
-- Architecture: mirrors the existing whatsapp_notifications
-- producer/consumer queue pattern exactly — a Postgres trigger enqueues
-- a row, a Supabase Edge Function (separate file, not part of this
-- migration) polls the queue and does the actual sending. The VAPID
-- PRIVATE key lives ONLY as an Edge Function environment variable —
-- never in this SQL, never in any client file.
-- =========================================================

-- ---------------------------------------------------------
-- 1) Subscription storage
-- ---------------------------------------------------------
create table if not exists admin_push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  subscription jsonb not null,   -- raw PushSubscription.toJSON() from the browser
  created_at  timestamptz not null default now()
);

create table if not exists driver_push_subscriptions (
  driver_id    uuid primary key references drivers(id) on delete cascade,
  subscription jsonb not null,
  updated_at   timestamptz not null default now()
);

alter table admin_push_subscriptions enable row level security;
alter table driver_push_subscriptions enable row level security;

-- Locked down like drivers/driver_locations: no anon SELECT/INSERT
-- policy at all. Both save_*_push_subscription() (write) and the Edge
-- Function's read (via service_role, which bypasses RLS entirely) don't
-- need a policy. Only admin can browse subscriptions directly (mostly
-- for debugging).
drop policy if exists "admin select admin_push_subscriptions" on admin_push_subscriptions;
create policy "admin select admin_push_subscriptions" on admin_push_subscriptions
  for select using (is_admin());

drop policy if exists "admin select driver_push_subscriptions" on driver_push_subscriptions;
create policy "admin select driver_push_subscriptions" on driver_push_subscriptions
  for select using (is_admin());

-- ---------------------------------------------------------
-- 2) The queue table (mirrors whatsapp_notifications' shape/spirit)
-- ---------------------------------------------------------
create table if not exists push_notifications_queue (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('admin', 'driver')),
  driver_id   uuid references drivers(id) on delete cascade, -- null when target_type = 'admin'
  title       text not null,
  body        text not null,
  url         text not null default '/driver.html', -- where a notification click should open
  sent        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists idx_push_queue_unsent
  on push_notifications_queue (sent) where sent = false;

alter table push_notifications_queue enable row level security;
drop policy if exists "admin select push_notifications_queue" on push_notifications_queue;
create policy "admin select push_notifications_queue" on push_notifications_queue
  for select using (is_admin());

-- ---------------------------------------------------------
-- 3) save_admin_push_subscription() — called once when the admin
--    enables notifications in the browser. Admin-only (relies on the
--    same is_admin() auth context admin.js already uses elsewhere).
-- ---------------------------------------------------------
create or replace function save_admin_push_subscription(p_subscription jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  insert into admin_push_subscriptions (subscription) values (p_subscription);
end;
$$;

grant execute on function save_admin_push_subscription(jsonb) to authenticated;

-- ---------------------------------------------------------
-- 4) save_driver_push_subscription() — token-authenticated exactly
--    like update_driver_location(), called once from driver.html when
--    the driver enables notifications.
-- ---------------------------------------------------------
create or replace function save_driver_push_subscription(p_token text, p_subscription jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
begin
  if p_token is null or p_subscription is null then
    return;
  end if;

  select id into v_driver_id from drivers where driver_token = p_token and active = true;
  if v_driver_id is null then
    return;
  end if;

  insert into driver_push_subscriptions (driver_id, subscription, updated_at)
  values (v_driver_id, p_subscription, now())
  on conflict (driver_id)
  do update set subscription = excluded.subscription, updated_at = now();
end;
$$;

grant execute on function save_driver_push_subscription(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------
-- 5) Trigger: new order → notify admin
--    AFTER INSERT only, exactly like queue_whatsapp_notification —
--    fires exactly once per new trip request, independent of it.
-- ---------------------------------------------------------
create or replace function queue_admin_push_on_new_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into push_notifications_queue (target_type, title, body, url)
  values (
    'admin',
    'طلب جديد',
    'طلب ' || coalesce(new.request_number, '') || ' — ' || coalesce(new.service_type, ''),
    '/admin.html'
  );
  return new;
end;
$$;

drop trigger if exists trg_queue_admin_push_on_new_order on trip_requests;
create trigger trg_queue_admin_push_on_new_order
  after insert on trip_requests
  for each row execute function queue_admin_push_on_new_order();

-- ---------------------------------------------------------
-- 6) Trigger: real driver assignment → notify that driver only
--
--    ⚠️ Revised after reading the real admin.js: status does NOT
--    reliably become 'assigned' on every driver-phone change.
--    admin.js's saveDriver() only auto-advances status to 'assigned'
--    when the request was exactly 'new' at that moment; reassigning a
--    driver on a request that's already 'en_route' (say) leaves status
--    untouched. Keying this trigger on status='assigned' would have
--    silently missed that reassignment notification. The correct,
--    robust signal is simply: driver_phone actually changed to a new,
--    non-empty value — regardless of what status says. This one
--    condition correctly covers all three real paths: automatic
--    assignment at booking (migration 2, status→'assigned' AND
--    driver_phone set together), admin's two-step flow (driver_phone
--    saved first, status button clicked after — or the reverse order),
--    and admin reassigning a different driver mid-trip.
--
--    Exactly-once guard: only fires when driver_phone is DISTINCT from
--    its previous value (so re-saving the same driver's other fields —
--    car type, plate, rating — never re-fires this).
-- ---------------------------------------------------------
create or replace function queue_driver_push_on_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_id uuid;
  v_just_assigned boolean;
begin
  v_just_assigned :=
    new.driver_phone is not null
    and length(trim(new.driver_phone)) > 0
    and new.status <> 'cancelled'
    and (tg_op = 'INSERT' or old.driver_phone is distinct from new.driver_phone);

  if not v_just_assigned then
    return new;
  end if;

  -- Matched by phone, same as admin.js's own driver-stats matching
  -- (drivers.phone = trip_requests.driver_phone) — trip_requests has
  -- no driver_id FK. If the admin typed a phone that doesn't match any
  -- registered driver (a one-off/unregistered driver — admin.js allows
  -- free-text entry here), there is simply no push subscription to
  -- send to; this is a silent, expected no-op, not an error.
  select id into v_driver_id from drivers where phone = new.driver_phone limit 1;
  if v_driver_id is null then
    return new;
  end if;

  insert into push_notifications_queue (target_type, driver_id, title, body, url)
  values (
    'driver',
    v_driver_id,
    'طلب جديد لك',
    'تم تعيينك لطلب ' || coalesce(new.request_number, '') || ' — افتح للتفاصيل',
    '/driver.html'
  );
  return new;
end;
$$;

drop trigger if exists trg_queue_driver_push_on_assignment on trip_requests;
create trigger trg_queue_driver_push_on_assignment
  after insert or update on trip_requests
  for each row execute function queue_driver_push_on_assignment();

-- =========================================================
-- Nothing above modifies queue_whatsapp_notification, log_trip_status,
-- drivers, driver_locations, or any FIFO/queue column. Both new
-- triggers are purely additive listeners on trip_requests.
-- =========================================================

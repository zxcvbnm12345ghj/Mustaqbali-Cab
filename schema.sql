-- =========================================================
-- Mustaqbali Cab — Database Schema (Supabase / Postgres)
-- Safe to re-run: every statement is guarded with IF NOT EXISTS /
-- CREATE OR REPLACE / DROP POLICY IF EXISTS where applicable.
--
-- Implements exactly the security model documented in
-- DEPLOYMENT_CHECKLIST.md sections 2 and 4:
--   - anon has NO insert/select on trip_requests directly
--   - all public submissions go through submit_trip_request() (SECURITY DEFINER)
--   - admin read/write is gated by is_admin(), backed by an explicit
--     allow-list table (admins), not just "authenticated"
-- =========================================================

-- ---------------------------------------------------------
-- 1) trip_requests
-- ---------------------------------------------------------
create table if not exists trip_requests (
  id                uuid primary key default gen_random_uuid(),
  request_number    text unique,
  service_type      text not null check (service_type in ('taxi','private','courier','intercity')),
  customer_name     text not null check (char_length(customer_name) <= 100),
  phone             text not null check (char_length(phone) <= 20),
  pickup_location   text not null check (char_length(pickup_location) <= 300),
  pickup_lat        numeric,
  pickup_lng        numeric,
  dropoff_location  text check (char_length(dropoff_location) <= 300),
  scheduled_at      timestamptz,
  notes             text check (char_length(notes) <= 500),
  status            text not null default 'new' check (status in ('new','assigned','in_progress','completed','cancelled')),
  driver_name       text check (char_length(driver_name) <= 100),
  driver_phone      text check (char_length(driver_phone) <= 20),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_trip_requests_created_at on trip_requests (created_at desc);
create index if not exists idx_trip_requests_status on trip_requests (status);

-- ---------------------------------------------------------
-- 2) trip_status_history — one row per status change, via trigger only
-- ---------------------------------------------------------
create table if not exists trip_status_history (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trip_requests(id) on delete cascade,
  status      text not null,
  changed_at  timestamptz not null default now()
);

create index if not exists idx_trip_status_history_trip_id on trip_status_history (trip_id);

-- ---------------------------------------------------------
-- 3) whatsapp_notifications — queue for the admin-side WhatsApp Edge Function
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
-- 4) admins — explicit allow-list, NOT just "authenticated"
-- ---------------------------------------------------------
create table if not exists admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------
-- 5) is_admin() — stable, indexed lookup, used in every admin RLS policy
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
--    not reset daily — simpler and still guarantees no collisions
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
-- 8) log_trip_status — writes to trip_status_history on insert/status change
-- ---------------------------------------------------------
create or replace function log_trip_status()
returns trigger
language plpgsql
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
-- 9) queue_whatsapp_notification — writes to whatsapp_notifications on insert
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
-- 10) submit_trip_request() — the ONLY way anon can create a trip request.
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
  if p_service_type not in ('taxi','private','courier','intercity') then
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

-- Only anon/authenticated may call the RPC — they still can't touch the table directly.
grant execute on function submit_trip_request(text, text, text, text, numeric, numeric, text, timestamptz, text) to anon, authenticated;

-- ---------------------------------------------------------
-- 11) Row Level Security
-- ---------------------------------------------------------
alter table trip_requests enable row level security;
alter table trip_status_history enable row level security;
alter table whatsapp_notifications enable row level security;
alter table admins enable row level security;

-- trip_requests: admin-only select/update. No insert policy at all —
-- the only insert path is the SECURITY DEFINER RPC above.
drop policy if exists "admin select trip_requests" on trip_requests;
create policy "admin select trip_requests" on trip_requests
  for select using (is_admin());

drop policy if exists "admin update trip_requests" on trip_requests;
create policy "admin update trip_requests" on trip_requests
  for update using (is_admin()) with check (is_admin());

-- trip_status_history: admin-only select. No insert/update policy —
-- rows are written exclusively by the trigger (runs as table owner).
drop policy if exists "admin select trip_status_history" on trip_status_history;
create policy "admin select trip_status_history" on trip_status_history
  for select using (is_admin());

-- whatsapp_notifications: admin-only select. Writes via trigger; the
-- Edge Function uses the service_role key, which bypasses RLS entirely.
drop policy if exists "admin select whatsapp_notifications" on whatsapp_notifications;
create policy "admin select whatsapp_notifications" on whatsapp_notifications
  for select using (is_admin());

-- admins: a user may see their own row only. No insert/update policy —
-- admins are added manually via SQL Editor (which runs as table owner).
drop policy if exists "self select admins" on admins;
create policy "self select admins" on admins
  for select using (user_id = auth.uid());

-- =========================================================
-- Post-install manual step (cannot be scripted):
--   insert into admins (user_id) values ('paste-the-auth-user-uid-here');
-- =========================================================

-- =========================================================
-- Mustaqbali Cab — Migration: Customer Ads system
-- Separate from schema.sql, per project convention (mirrors
-- migration_push_notifications.sql exactly in spirit).
--
-- Zero impact on existing systems, by construction:
--   - Does NOT touch trip_requests, trip_status_history,
--     whatsapp_notifications, drivers, driver_locations,
--     admin_push_subscriptions, driver_push_subscriptions,
--     push_notifications_queue, select_driver(), get_front_driver(),
--     submit_trip_request(), or any GPS/location code.
--   - Every object below is brand-new (new tables, new triggers, new
--     functions, new RPCs) — nothing here alters an existing column,
--     row, constraint, or function signature.
--   - Reuses only the two helper primitives already defined in
--     schema.sql: is_admin() and bump_updated_at(). Neither is
--     modified — both are called as-is.
--
-- Architecture: a brand-new, fully separate push queue/subscription
-- pair (ad_push_queue / customer_push_subscriptions) — deliberately
-- NOT sharing push_notifications_queue/admin_push_subscriptions/
-- driver_push_subscriptions, so the existing admin/driver push path
-- is never touched, even by a widened CHECK constraint. A separate
-- Edge Function (supabase_functions/send-customer-ads-push.ts, not
-- part of this file) polls this new queue on the same cron pattern
-- already used for send-push-notification.ts. It reuses the SAME
-- VAPID keys (env vars) already configured for that function —
-- no new secret is introduced anywhere.
-- =========================================================

-- ---------------------------------------------------------
-- 1) customer_ads — admin-managed ad content.
--    ad_type = 'scheduled' -> shown only while now() falls within
--      [starts_at, ends_at] (either bound may be null = open-ended).
--    ad_type = 'daily' -> shown every day the current time-of-day
--      (Asia/Baghdad) falls within [daily_start_time, daily_end_time]
--      (wraps past midnight if start > end, e.g. 22:00 -> 06:00);
--      starts_at/ends_at may ADDITIONALLY bound the date range the
--      daily recurrence applies within (both optional).
--    display_seconds = how long this ad stays on screen in the
--      customer app's rotation before advancing to the next ad
--      ("مدة العرض").
-- ---------------------------------------------------------
create table if not exists customer_ads (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(title) <= 150),
  body              text check (char_length(body) <= 500),
  image_url         text check (char_length(image_url) <= 500),
  link_url          text check (char_length(link_url) <= 500),
  display_seconds   integer not null default 6 check (display_seconds >= 2 and display_seconds <= 60),
  ad_type           text not null default 'scheduled' check (ad_type in ('scheduled','daily')),
  starts_at         timestamptz,
  ends_at           timestamptz,
  daily_start_time  time,
  daily_end_time    time,
  priority          integer not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_customer_ads_active_priority on customer_ads (active, priority);

drop trigger if exists trg_customer_ads_updated_at on customer_ads;
create trigger trg_customer_ads_updated_at
  before update on customer_ads
  for each row execute function bump_updated_at();

alter table customer_ads enable row level security;

-- Admin-only direct table access (same pattern as drivers/service_prices).
-- Customers NEVER read this table directly — only through the narrow
-- get_active_customer_ads() RPC below, which whitelists columns and
-- filters by schedule, so future/inactive ads and internal fields
-- (priority, timestamps) never leak to anon.
drop policy if exists "admin select customer_ads" on customer_ads;
create policy "admin select customer_ads" on customer_ads
  for select using (is_admin());

drop policy if exists "admin insert customer_ads" on customer_ads;
create policy "admin insert customer_ads" on customer_ads
  for insert with check (is_admin());

drop policy if exists "admin update customer_ads" on customer_ads;
create policy "admin update customer_ads" on customer_ads
  for update using (is_admin()) with check (is_admin());

drop policy if exists "admin delete customer_ads" on customer_ads;
create policy "admin delete customer_ads" on customer_ads
  for delete using (is_admin());

-- ---------------------------------------------------------
-- 2) get_active_customer_ads() — the ONLY way anon (the customer app)
--    can read ads. Returns just the fields the customer UI needs, for
--    ads that are active AND currently within their schedule window.
-- ---------------------------------------------------------
drop function if exists get_active_customer_ads();

create or replace function get_active_customer_ads()
returns table (
  id               uuid,
  title            text,
  body             text,
  image_url        text,
  link_url         text,
  display_seconds  integer
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.title, a.body, a.image_url, a.link_url, a.display_seconds
  from customer_ads a
  where a.active = true
    and (a.starts_at is null or a.starts_at <= now())
    and (a.ends_at is null or a.ends_at >= now())
    and (
      a.ad_type <> 'daily'
      or a.daily_start_time is null
      or a.daily_end_time is null
      or (
        case
          when a.daily_start_time <= a.daily_end_time then
            (now() at time zone 'Asia/Baghdad')::time
              between a.daily_start_time and a.daily_end_time
          else
            -- overnight window, e.g. 22:00 -> 06:00
            (now() at time zone 'Asia/Baghdad')::time >= a.daily_start_time
            or (now() at time zone 'Asia/Baghdad')::time <= a.daily_end_time
        end
      )
    )
  order by a.priority asc, a.created_at desc;
$$;

grant execute on function get_active_customer_ads() to anon, authenticated;

-- ---------------------------------------------------------
-- 3) customer_push_subscriptions — mirrors admin_push_subscriptions'
--    shape exactly, but is a completely separate table so the
--    existing admin push path is never touched.
-- ---------------------------------------------------------
create table if not exists customer_push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  subscription  jsonb not null,
  created_at    timestamptz not null default now()
);

alter table customer_push_subscriptions enable row level security;

-- No anon SELECT/INSERT policy on purpose (same lockdown pattern as
-- admin_push_subscriptions/driver_push_subscriptions) — writes only
-- happen through save_customer_push_subscription() below, reads only
-- through the Edge Function's service_role client (bypasses RLS).
drop policy if exists "admin select customer_push_subscriptions" on customer_push_subscriptions;
create policy "admin select customer_push_subscriptions" on customer_push_subscriptions
  for select using (is_admin());

-- ---------------------------------------------------------
-- 4) save_customer_push_subscription() — called once when a customer
--    enables ad notifications in the browser. No login/token required
--    (the customer app has no auth), exactly like the public opt-in
--    nature of this feature.
-- ---------------------------------------------------------
create or replace function save_customer_push_subscription(p_subscription jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_subscription is null then
    return;
  end if;
  insert into customer_push_subscriptions (subscription) values (p_subscription);
end;
$$;

grant execute on function save_customer_push_subscription(jsonb) to anon, authenticated;

-- ---------------------------------------------------------
-- 5) ad_push_queue — brand-new queue, deliberately separate from
--    push_notifications_queue (admin/driver) so nothing here ever
--    touches that table's rows, constraint, or triggers.
--    Populated only by queue_customer_ads_push() below (admin-only,
--    on-demand — "Push إعلاني للزبائن عند الحاجة"), never
--    automatically on ad create/update.
-- ---------------------------------------------------------
create table if not exists ad_push_queue (
  id          uuid primary key default gen_random_uuid(),
  ad_id       uuid references customer_ads(id) on delete set null,
  title       text not null check (char_length(title) <= 150),
  body        text not null check (char_length(body) <= 500),
  url         text not null default '/index.html',
  sent        boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists idx_ad_push_queue_unsent
  on ad_push_queue (sent) where sent = false;

alter table ad_push_queue enable row level security;

drop policy if exists "admin select ad_push_queue" on ad_push_queue;
create policy "admin select ad_push_queue" on ad_push_queue
  for select using (is_admin());

-- ---------------------------------------------------------
-- 6) queue_customer_ads_push() — the ONLY way to enqueue a customer
--    ad push. Admin-only (is_admin()), called from admin.js when the
--    admin taps "إرسال إشعار" on a given ad.
-- ---------------------------------------------------------
create or replace function queue_customer_ads_push(
  p_ad_id  uuid,
  p_title  text,
  p_body   text,
  p_url    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'title is required';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'body is required';
  end if;

  insert into ad_push_queue (ad_id, title, body, url)
  values (p_ad_id, p_title, p_body, coalesce(nullif(trim(p_url), ''), '/index.html'));
end;
$$;

grant execute on function queue_customer_ads_push(uuid, text, text, text) to authenticated;

-- =========================================================
-- Nothing above modifies trip_requests, drivers, driver_locations,
-- push_notifications_queue, admin_push_subscriptions,
-- driver_push_subscriptions, or any existing trigger/function/policy.
-- Every table, trigger, and function in this file is new.
-- =========================================================

-- =========================================================
-- Yammak — Migration: "خدمات أخرى" (Other Services)
-- Safe to re-run (IF NOT EXISTS / DO $$ guards throughout).
-- Adds one new table only. Does NOT touch trip_requests, drivers,
-- service_prices, customer_ads, restaurants, or markets in any way.
-- =========================================================

-- ---------------------------------------------------------
-- other_services -- flexible, admin-managed list of any extra
-- service (name + active flag), exact same pattern as
-- restaurants/markets (see schema.sql section 17). Customers only
-- ever see active=true rows. Admin can add/rename/toggle/delete
-- any row, including the seeded "مكتب المستقبل" row below.
-- ---------------------------------------------------------
create table if not exists other_services (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) <= 150),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_other_services_active on other_services (active);

alter table other_services enable row level security;

-- Anon (customer app) only ever sees active rows.
drop policy if exists "public read active other_services" on other_services;
create policy "public read active other_services" on other_services
  for select using (active = true);

-- Admin sees everything (including inactive rows) and can add/update/delete.
drop policy if exists "admin select other_services" on other_services;
create policy "admin select other_services" on other_services
  for select using (is_admin());

drop policy if exists "admin insert other_services" on other_services;
create policy "admin insert other_services" on other_services
  for insert with check (is_admin());

drop policy if exists "admin update other_services" on other_services;
create policy "admin update other_services" on other_services
  for update using (is_admin()) with check (is_admin());

drop policy if exists "admin delete other_services" on other_services;
create policy "admin delete other_services" on other_services
  for delete using (is_admin());

grant select on other_services to anon, authenticated;

-- Seed: "مكتب المستقبل للقرطاسية والطباعة" as a core, active-by-default
-- service. Guarded so re-running this file never creates a duplicate.
insert into other_services (name, active)
select 'مكتب المستقبل للقرطاسية والطباعة', true
where not exists (
  select 1 from other_services where name = 'مكتب المستقبل للقرطاسية والطباعة'
);

-- =====================================================================
-- سوق يمّك (Yammak Market) — مسودة Migration  [DRAFT — للمراجعة فقط، لم تُنفَّذ]
-- ---------------------------------------------------------------------
-- مبنية حصراً على الاستدعاءات الفعلية في market.js و app.js (loadListings).
-- تنشئ فقط: market_categories, market_listings, 4 RPCs, RLS, bucket market-images.
-- لا تلمس أي جدول آخر (طلبات / سائقين / مطاعم / أسواق / ...).
-- قابلة لإعادة التشغيل (idempotent): create ... if not exists / or replace.
-- لا تحتوي أي إعلانات تجريبية. الصفوف الوحيدة المُدخلة: 8 تصنيفات (انظر القسم 3).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0) أدوات مساعدة: توحيد رقم الهاتف (آخر 10 أرقام، مع تحويل الأرقام العربية)
--    يستخدمها ربط «إعلاناتي» بالهاتف: 0770xxxxxxx = +964770xxxxxxx = ٠٧٧٠...
-- ---------------------------------------------------------------------
create or replace function public.market_phone_digits(p text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select regexp_replace(
           translate(coalesce(p, ''),
                     '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
                     '01234567890123456789'),
           '\D', '', 'g')
$$;

create or replace function public.market_norm_phone(p text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select right(public.market_phone_digits(p), 10)
$$;

revoke all on function public.market_phone_digits(text) from public, anon, authenticated;
revoke all on function public.market_norm_phone(text)  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) market_categories  (قراءة عامة)
--    الأعمدة التي يقرؤها الكود: key, label, icon, sort_order
-- ---------------------------------------------------------------------
create table if not exists public.market_categories (
  key        text primary key,
  label      text not null,
  icon       text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2) market_listings
--    الأعمدة التي يستخدمها الكود: id, listing_number, title, description, price,
--    condition ('new'|'used'), category_key, location_text, location_lat,
--    location_lng, image_urls (مصفوفة), seller_name, seller_phone,
--    status ('active'|'paused'|'sold'), created_at
-- ---------------------------------------------------------------------
create sequence if not exists public.market_listing_number_seq;

create table if not exists public.market_listings (
  id             uuid primary key default gen_random_uuid(),
  listing_number text not null unique
                   default ('YM-' || lpad(nextval('public.market_listing_number_seq')::text, 6, '0')),
  seller_name    text not null
                   check (char_length(btrim(seller_name)) between 1 and 100),
  seller_phone   text not null
                   check (char_length(seller_phone) between 7 and 20),
  category_key   text not null
                   references public.market_categories (key)
                   on update cascade on delete restrict,
  title          text not null
                   check (char_length(btrim(title)) between 1 and 120),
  description    text
                   check (description is null or char_length(description) <= 600),
  price          numeric(14,2) not null check (price >= 0),
  condition      text not null default 'used'
                   check (condition in ('new', 'used')),
  location_text  text
                   check (location_text is null or char_length(location_text) <= 200),
  location_lat   double precision check (location_lat between -90  and 90),
  location_lng   double precision check (location_lng between -180 and 180),
  image_urls     text[] not null default '{}'
                   check (coalesce(cardinality(image_urls), 0) <= 5),
  status         text not null default 'active'
                   check (status in ('active', 'paused', 'sold')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Indexes (مطابقة لأنماط الاستعلام في الكود)
-- أحدث الإعلانات (الرئيسية + سوق يمّك): where status='active' order by created_at desc
create index if not exists market_listings_active_created_idx
  on public.market_listings (created_at desc) where status = 'active';
-- تصفح حسب التصنيف
create index if not exists market_listings_cat_active_idx
  on public.market_listings (category_key, created_at desc) where status = 'active';
-- «إعلاناتي» حسب الهاتف الموحَّد
create index if not exists market_listings_phone_idx
  on public.market_listings (public.market_norm_phone(seller_phone), created_at desc);

-- ---------------------------------------------------------------------
-- 3) تصنيفات أولية — نفس مفاتيح MARKET_CATEGORIES_FALLBACK في market.js
--    (ضرورية: create_market_listing يتحقق من وجود category_key، والقائمة المنسدلة
--     في التطبيق تستخدم هذه المفاتيح. ليست بيانات تجريبية للإعلانات.)
-- ---------------------------------------------------------------------
insert into public.market_categories (key, label, icon, sort_order) values
  ('electronics', 'إلكترونيات',  '💻', 1),
  ('cars',        'سيارات',       '🚗', 2),
  ('furniture',   'أثاث',         '🛋️', 3),
  ('realestate',  'عقارات',       '🏠', 4),
  ('fashion',     'ملابس',        '👕', 5),
  ('tools',       'أدوات ومعدات', '🛠️', 6),
  ('books',       'كتب وقرطاسية', '📚', 7),
  ('other',       'أخرى',         '🧩', 8)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 4) RLS — قراءة عامة فقط؛ لا INSERT/UPDATE/DELETE مباشر للزبائن إطلاقاً
--    (كل الكتابة عبر RPCs أدناه بصلاحية security definer)
-- ---------------------------------------------------------------------
alter table public.market_categories enable row level security;
alter table public.market_listings   enable row level security;

drop policy if exists "public read market categories" on public.market_categories;
create policy "public read market categories"
  on public.market_categories for select
  to anon, authenticated
  using (true);

drop policy if exists "public read active market listings" on public.market_listings;
create policy "public read active market listings"
  on public.market_listings for select
  to anon, authenticated
  using (status = 'active');

revoke all on public.market_categories from anon, authenticated;
revoke all on public.market_listings   from anon, authenticated;
grant select on public.market_categories to anon, authenticated;
grant select on public.market_listings   to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) RPCs (الأربعة المستخدمة في market.js)
-- ---------------------------------------------------------------------

-- 5.1 create_market_listing — الطريقة الوحيدة لنشر إعلان (market.js:748)
create or replace function public.create_market_listing(
  p_seller_name   text,
  p_seller_phone  text,
  p_category_key  text,
  p_title         text,
  p_description   text,
  p_price         numeric,
  p_condition     text,
  p_location_text text,
  p_location_lat  double precision,
  p_location_lng  double precision,
  p_image_urls    text[]
)
returns public.market_listings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name   text := btrim(coalesce(p_seller_name, ''));
  v_phone  text := btrim(coalesce(p_seller_phone, ''));
  v_title  text := btrim(coalesce(p_title, ''));
  v_desc   text := nullif(btrim(coalesce(p_description, '')), '');
  v_loc    text := nullif(btrim(coalesce(p_location_text, '')), '');
  v_cond   text := coalesce(nullif(btrim(coalesce(p_condition, '')), ''), 'used');
  v_images text[] := coalesce(p_image_urls, '{}');
  v_url    text;
  v_row    public.market_listings;
begin
  if char_length(v_name) not between 1 and 100 then
    raise exception 'invalid_seller_name' using errcode = '22023';
  end if;
  if char_length(v_phone) > 20 or length(public.market_phone_digits(v_phone)) < 7 then
    raise exception 'invalid_seller_phone' using errcode = '22023';
  end if;
  if not exists (select 1 from public.market_categories c where c.key = p_category_key) then
    raise exception 'invalid_category' using errcode = '22023';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  if v_desc is not null and char_length(v_desc) > 600 then
    raise exception 'invalid_description' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 or p_price > 999999999999 then
    raise exception 'invalid_price' using errcode = '22023';
  end if;
  if v_cond not in ('new', 'used') then
    raise exception 'invalid_condition' using errcode = '22023';
  end if;
  if v_loc is not null and char_length(v_loc) > 200 then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  if (p_location_lat is not null and p_location_lat not between -90 and 90)
     or (p_location_lng is not null and p_location_lng not between -180 and 180) then
    raise exception 'invalid_coordinates' using errcode = '22023';
  end if;
  if coalesce(cardinality(v_images), 0) > 5 then
    raise exception 'too_many_images' using errcode = '22023';
  end if;
  foreach v_url in array v_images loop
    if v_url is null or v_url !~ '^https://' or char_length(v_url) > 500 then
      raise exception 'invalid_image_url' using errcode = '22023';
    end if;
  end loop;

  insert into public.market_listings (
    seller_name, seller_phone, category_key, title, description, price,
    condition, location_text, location_lat, location_lng, image_urls
  ) values (
    v_name, v_phone, p_category_key, v_title, v_desc, p_price,
    v_cond, v_loc, p_location_lat, p_location_lng, v_images
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- 5.2 get_my_market_listings — إعلانات صاحب الهاتف بكل الحالات (market.js:462)
create or replace function public.get_my_market_listings(p_phone text)
returns setof public.market_listings
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select l.*
  from public.market_listings l
  where length(public.market_phone_digits(p_phone)) >= 7
    and public.market_norm_phone(l.seller_phone) = public.market_norm_phone(p_phone)
  order by l.created_at desc
  limit 200
$$;

-- 5.3 update_market_listing_status — إيقاف / تنشيط / تم البيع (market.js:539)
create or replace function public.update_market_listing_status(
  p_id     uuid,
  p_phone  text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status is null or p_status not in ('active', 'paused', 'sold') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if length(public.market_phone_digits(p_phone)) < 7 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  update public.market_listings l
     set status = p_status,
         updated_at = now()
   where l.id = p_id
     and public.market_norm_phone(l.seller_phone) = public.market_norm_phone(p_phone);

  -- لا نُظهر «نجاح» كاذب في التطبيق إن لم يُطابق الإعلان/الهاتف
  if not found then
    raise exception 'listing_not_found_or_not_owner' using errcode = 'P0002';
  end if;
end;
$$;

-- 5.4 delete_market_listing — حذف نهائي (market.js:529)
create or replace function public.delete_market_listing(
  p_id    uuid,
  p_phone text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if length(public.market_phone_digits(p_phone)) < 7 then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  delete from public.market_listings l
   where l.id = p_id
     and public.market_norm_phone(l.seller_phone) = public.market_norm_phone(p_phone);

  if not found then
    raise exception 'listing_not_found_or_not_owner' using errcode = 'P0002';
  end if;
end;
$$;

-- صلاحيات التنفيذ: الزبون (anon/authenticated) فقط على الدوال الأربع
revoke all on function public.create_market_listing(text,text,text,text,text,numeric,text,text,double precision,double precision,text[]) from public, anon, authenticated;
revoke all on function public.get_my_market_listings(text)                              from public, anon, authenticated;
revoke all on function public.update_market_listing_status(uuid,text,text)             from public, anon, authenticated;
revoke all on function public.delete_market_listing(uuid,text)                         from public, anon, authenticated;

grant execute on function public.create_market_listing(text,text,text,text,text,numeric,text,text,double precision,double precision,text[]) to anon, authenticated;
grant execute on function public.get_my_market_listings(text)                           to anon, authenticated;
grant execute on function public.update_market_listing_status(uuid,text,text)          to anon, authenticated;
grant execute on function public.delete_market_listing(uuid,text)                      to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6) Storage: bucket عام «market-images» + سماح برفع الصور فقط (INSERT)
--    القراءة عبر الرابط العام للـ bucket (getPublicUrl)؛ لا سياسة select/update/delete
--    فلا يمكن سرد الملفات أو الكتابة فوقها أو حذفها من التطبيق.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'market-images', 'market-images', true,
  10485760,  -- 10 MB لكل صورة
  array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']
)
on conflict (id) do nothing;

drop policy if exists "market images anon upload" on storage.objects;
create policy "market images anon upload"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'market-images');

-- تحديث schema cache الخاص بـ PostgREST (يزول خطأ PGRST205)
notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- فحوصات بعد التنفيذ (قراءة فقط) — لا تُنفَّذ الآن
-- =====================================================================
-- select to_regclass('public.market_listings'), to_regclass('public.market_categories');
-- select key, label, sort_order from public.market_categories order by sort_order;
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc
--   where pronamespace = 'public'::regnamespace and proname like '%market_listing%';
-- select id, public, file_size_limit from storage.buckets where id = 'market-images';
-- select policyname, cmd, roles from pg_policies
--   where tablename in ('market_categories','market_listings') or policyname like 'market images%';

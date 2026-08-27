-- StayMate: створення таблиць rooms / bookings / escalations
-- + тестові дані для "Panorama Apart-Hotel" (property_id = panorama-apart-hotel)
-- Виконати один раз у Supabase → SQL Editor → Run.

-- 1. Номери
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  property_id text not null,
  room_type text not null,
  price_per_night numeric not null,
  capacity int not null,
  description text,
  created_at timestamptz default now()
);

-- 2. Бронювання
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  booking_id text unique not null,
  property_id text not null,
  room_type text not null,
  check_in date not null,
  check_out date not null,
  guest_name text not null,
  guest_contact text not null,
  price_per_night numeric not null,
  status text not null default 'pending_payment',
  payment_link text,
  created_at timestamptz default now()
);

-- 3. Ескалації до людини
create table if not exists escalations (
  id uuid primary key default gen_random_uuid(),
  property_id text not null,
  reason text not null,
  urgency text default 'normal',
  status text default 'open',
  created_at timestamptz default now()
);

-- 4. Тестові номери для Panorama Apart-Hotel
insert into rooms (property_id, room_type, price_per_night, capacity, description) values
  ('panorama-apart-hotel', 'Затишна студія',    1200, 2, 'Компактна студія з ліжком queen-size, кухонний куточок, сніданок не включено.'),
  ('panorama-apart-hotel', 'Стандарт',          1500, 2, 'Окрема спальня + вітальня, вид у двір, сніданок включено.'),
  ('panorama-apart-hotel', 'Комфорт з балконом',1950, 2, 'Більша площа, балкон з видом на місто, сніданок включено.'),
  ('panorama-apart-hotel', 'Люкс',              2800, 3, 'Просторий номер з окремою вітальнею, джакузі, панорамний вид.'),
  ('panorama-apart-hotel', 'Сімейні апартаменти',3400, 5, 'Дві спальні, повна кухня, підходить для родини з дітьми.');

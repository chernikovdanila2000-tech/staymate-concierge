-- StayMate: таблиця properties (готелі-клієнти) для особистого кабінету
-- Виконати один раз у Supabase → SQL Editor → Run.

create table if not exists properties (
  property_id text primary key,
  owner_id uuid references auth.users(id),
  hotel_name text not null,
  address text,
  telegram_bot_token text,
  webhook_connected boolean default false,
  subscription_status text default 'trial', -- trial | active | cancelled
  created_at timestamptz default now()
);

-- Дозволяємо власнику бачити і редагувати тільки свій готель (Row Level Security)
alter table properties enable row level security;

create policy "Owners can view their own property"
  on properties for select
  using (auth.uid() = owner_id);

create policy "Owners can update their own property"
  on properties for update
  using (auth.uid() = owner_id);

create policy "Owners can insert their own property"
  on properties for insert
  with check (auth.uid() = owner_id);

-- Аналогічно захищаємо rooms — власник бачить/редагує тільки номери свого готелю
alter table rooms enable row level security;

create policy "Owners can manage their own rooms"
  on rooms for all
  using (
    property_id in (select property_id from properties where owner_id = auth.uid())
  );

-- bookings і escalations власник теж має бачити (тільки читання, без редагування вручну)
alter table bookings enable row level security;

create policy "Owners can view their own bookings"
  on bookings for select
  using (
    property_id in (select property_id from properties where owner_id = auth.uid())
  );

alter table escalations enable row level security;

create policy "Owners can view their own escalations"
  on escalations for select
  using (
    property_id in (select property_id from properties where owner_id = auth.uid())
  );

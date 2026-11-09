-- StayAI: перехід з "готельний консьєрж" на універсального бізнес-асистента.
-- business_type на properties визначає, яку гілку системного промпту та який
-- набір інструментів отримує ШІ для цього акаунту. Існуючі рядки (усі
-- сьогоднішні клієнти — готелі) отримують 'hospitality' за замовчуванням,
-- тож їхня поведінка не змінюється ні на йоту.
-- Безпечно виконувати повторно. Виконати один раз у Supabase → SQL Editor → Run.

alter table properties
  add column if not exists business_type text not null default 'hospitality';

-- business_facts — той самий патерн, що й hotel_info (Блок 3): єдине джерело
-- правди про заклад, яке підставляється в системний промпт для НЕ-готельних
-- бізнесів. hotel_info лишається окремою, незмінною таблицею саме для
-- business_type = 'hospitality' — нові й старі готелі й далі користуються
-- нею так само, як сьогодні.
create table if not exists business_facts (
  property_id text primary key references properties(property_id) on delete cascade,
  description text,       -- чим займається бізнес, коротко
  hours text,              -- графік роботи
  location text,            -- адреса / як дістатися
  contact_info text,
  services_offered text,     -- що саме пропонує (послуги/товари)
  pricing_info text,          -- орієнтовні ціни на послуги/товари
  policies text,                -- умови, скасування, повернення тощо
  additional_info text,
  updated_at timestamptz default now()
);

alter table business_facts enable row level security;

drop policy if exists "Owners can manage their own business_facts" on business_facts;
create policy "Owners can manage their own business_facts"
  on business_facts for all
  using (property_id in (select property_id from properties where owner_id = auth.uid()))
  with check (property_id in (select property_id from properties where owner_id = auth.uid()));

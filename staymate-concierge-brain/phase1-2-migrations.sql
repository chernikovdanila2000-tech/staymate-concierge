-- StayMate: точкові доповнення схеми для Фаз 1 і 2 плану.
-- Безпечно виконувати повторно (усюди if not exists / add column if not exists).
-- Виконати один раз у Supabase → SQL Editor → Run.

-- Фаза 1.1: кількість фізичних номерів кожного типу (щоб рахувати реальну
-- зайнятість по датах, а не тільки "чи існує такий тип номера").
alter table rooms add column if not exists quantity integer not null default 1;

-- Фаза 2: тріал і статус/тариф підписки готелю.
-- Дефолт на колонці — щоб НОВІ готелі одразу отримували 3-денний тріал
-- від моменту створення профілю, без окремого коду в кабінеті.
alter table properties add column if not exists trial_ends_at timestamptz default (now() + interval '3 days');
alter table properties add column if not exists subscription_plan text;
alter table properties add column if not exists subscription_active_until timestamptz;

-- Проставити 3-денний тріал усім готелям, які вже зареєстровані і ще не мають
-- цього поля заповненим (щоб гейтинг доступу не вимкнув їх одразу після деплою).
update properties set trial_ends_at = created_at + interval '3 days' where trial_ends_at is null;

-- Фаза 2: замовлення на оплату підписки (щоб вебхук WayForPay знав, якому
-- готелю й за який тариф зараховувати оплату — orderReference сам по собі
-- цього не містить).
create table if not exists subscription_orders (
  order_id text primary key,
  property_id text not null references properties(property_id) on delete cascade,
  plan text not null,
  status text not null default 'pending', -- pending | paid
  created_at timestamptz default now()
);

alter table subscription_orders enable row level security;

drop policy if exists "Owners can view their own subscription orders" on subscription_orders;
create policy "Owners can view their own subscription orders"
  on subscription_orders for select
  using (property_id in (select property_id from properties where owner_id = auth.uid()));

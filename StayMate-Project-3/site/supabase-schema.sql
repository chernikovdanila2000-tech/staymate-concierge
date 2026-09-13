-- ============================================================
-- StayMate — схема бази даних Supabase
-- Виконайте цей скрипт один раз у SQL Editor вашого проєкту
-- (Supabase → SQL Editor → New query → вставити → Run)
-- ============================================================

-- Таблиця підписок: одна відповідність на одного користувача
create table if not exists public.subscriptions (
  user_id      uuid references auth.users(id) on delete cascade primary key,
  plan         text not null default 'none',
  price        integer not null default 0,
  active       boolean not null default false,
  trial_ends_at timestamp with time zone,
  updated_at   timestamp with time zone default now()
);

-- Row Level Security: кожен користувач бачить і редагує тільки свій рядок
alter table public.subscriptions enable row level security;

drop policy if exists "select own subscription" on public.subscriptions;
create policy "select own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "insert own subscription" on public.subscriptions;
create policy "insert own subscription"
  on public.subscriptions for insert
  with check (auth.uid() = user_id);

drop policy if exists "update own subscription" on public.subscriptions;
create policy "update own subscription"
  on public.subscriptions for update
  using (auth.uid() = user_id);

-- Якщо у вас вже була створена таблиця subscriptions раніше (до додавання
-- 3-денного пробного періоду), розкоментуйте рядок нижче і виконайте
-- окремо, щоб додати нову колонку без втрати існуючих даних:
-- alter table public.subscriptions add column if not exists trial_ends_at timestamp with time zone;

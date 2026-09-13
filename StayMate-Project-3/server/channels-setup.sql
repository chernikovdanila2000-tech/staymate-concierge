-- StayMate: таблиця channels (усі канали зв'язку готелю в одному місці)
-- Виконати один раз у Supabase → SQL Editor → Run.
-- Цю таблицю можна виконувати незалежно від того, підключено вже Telegram
-- через старе поле properties.telegram_bot_token чи ні — старе поле
-- лишається як резервний варіант (сервер сам перевіряє спершу цю таблицю,
-- а якщо каналу тут нема — falls back на properties.telegram_bot_token).

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  property_id text not null references properties(property_id) on delete cascade,
  channel_type text not null check (channel_type in ('telegram', 'viber', 'whatsapp', 'instagram', 'website')),
  credentials jsonb not null default '{}'::jsonb,
  connected boolean not null default false,
  connected_at timestamptz,
  created_at timestamptz default now(),
  unique (property_id, channel_type)
);

alter table channels enable row level security;

drop policy if exists "Owners can manage their own channels" on channels;
create policy "Owners can manage their own channels"
  on channels for all
  using (property_id in (select property_id from properties where owner_id = auth.uid()))
  with check (property_id in (select property_id from properties where owner_id = auth.uid()));

-- StayMate: таблиця conversations (постійна історія переписки бота з гостями)
-- Замінює in-memory Map у server.js — переписка більше не губиться
-- при перезапуску/редеплої сервера (Фаза 1.3 плану).
-- Виконати один раз у Supabase → SQL Editor → Run.

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  property_id text not null references properties(property_id) on delete cascade,
  channel text not null check (channel in ('telegram', 'viber', 'whatsapp', 'instagram', 'website', 'test')),
  chat_id text not null,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now(),
  unique (property_id, channel, chat_id)
);

create index if not exists conversations_property_idx on conversations (property_id);

alter table conversations enable row level security;

-- Пише і читає тільки сервер (service_role ключ — обходить RLS), але додамо
-- політику на SELECT, щоб власник міг у майбутньому подивитись історію
-- переписки свого готелю прямо з кабінету.
drop policy if exists "Owners can view their own conversations" on conversations;
create policy "Owners can view their own conversations"
  on conversations for select
  using (property_id in (select property_id from properties where owner_id = auth.uid()));

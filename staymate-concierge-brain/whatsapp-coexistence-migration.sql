-- WhatsApp Business App coexistence data: service-role only.
-- No customer-facing anonymous access is granted.
create table if not exists public.whatsapp_coexistence_messages (
 property_id text not null,
 phone_number_id text not null,
 message_id text not null,
 chat_id text not null,
 direction text not null check(direction in ('inbound','outbound')),
 message_type text not null,
 body text,
 source text not null check(source in ('business_app','history')),
 sent_at timestamptz not null,
 received_at timestamptz not null default now(),
 primary key(property_id, phone_number_id, message_id)
);
create index if not exists whatsapp_coexistence_thread_idx
 on public.whatsapp_coexistence_messages(property_id,phone_number_id,chat_id,sent_at);
alter table public.whatsapp_coexistence_messages enable row level security;

create table if not exists public.whatsapp_coexistence_contacts (
 property_id text not null,
 phone_number_id text not null,
 contact_id text not null,
 contact_name text,
 action text,
 updated_at timestamptz not null default now(),
 primary key(property_id,phone_number_id,contact_id)
);
alter table public.whatsapp_coexistence_contacts enable row level security;

create table if not exists public.whatsapp_coexistence_sync (
 property_id text not null,
 phone_number_id text not null,
 sync_type text not null check(sync_type in ('history','smb_app_state_sync')),
 status text not null check(status in ('starting','requested','completed','not_shared','failed')),
 request_id text,
 updated_at timestamptz not null default now(),
 primary key(property_id,phone_number_id,sync_type)
);
alter table public.whatsapp_coexistence_sync enable row level security;

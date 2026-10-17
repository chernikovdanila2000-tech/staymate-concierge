-- Transactional SMS outbox. Apply only to the staging Supabase project first.
create table if not exists public.payment_link_tokens (
  token_hash text primary key,
  property_id text not null references public.properties(property_id) on delete cascade,
  booking_id text not null,
  invoice_url text not null,
  expires_at timestamptz not null,
  opened_at timestamptz,
  open_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique(property_id, booking_id)
);
create table if not exists public.notification_consents (
  id uuid primary key default gen_random_uuid(), property_id text not null references public.properties(property_id) on delete cascade,
  booking_id text not null, call_id text, phone text not null, phone_source text not null,
  method text not null default 'voice_explicit_confirmation', consented_at timestamptz not null default now()
);
create table if not exists public.sms_notifications (
  id uuid primary key default gen_random_uuid(), property_id text not null references public.properties(property_id) on delete cascade,
  booking_id text not null, notification_type text not null, version integer not null default 1,
  phone text not null, text text not null, provider text, provider_message_id text,
  idempotency_key text not null, status text not null default 'QUEUED' check(status in ('QUEUED','PROCESSING','ACCEPTED','SENT','DELIVERED','FAILED','UNKNOWN')),
  segment_count integer, estimated_cost numeric(12,4), sent_at timestamptz, delivered_at timestamptz, last_error text,
  lease_until timestamptz, attempts integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(property_id, booking_id, notification_type, version), unique(idempotency_key), unique(provider, provider_message_id)
);
create table if not exists public.sms_delivery_events (
  provider text not null, event_id text not null, notification_id uuid references public.sms_notifications(id) on delete cascade,
  status text not null, payload jsonb not null, received_at timestamptz not null default now(), primary key(provider,event_id)
);
alter table public.payment_link_tokens enable row level security;
alter table public.notification_consents enable row level security;
alter table public.sms_notifications enable row level security;
alter table public.sms_delivery_events enable row level security;

create or replace function public.sms_prepare_payment_link(p_property_id text,p_booking_id text,p_phone text,p_call_id text,p_language text,p_phone_source text,p_payment_base_url text,p_allowed_hosts text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare b record; t text; h text; url text; message text; n public.sms_notifications%rowtype;
begin
  -- Serialize a logical notification before generating a token: a duplicate
  -- tool call must neither enqueue another SMS nor invalidate the URL already
  -- present in the first SMS.
  perform pg_advisory_xact_lock(hashtext(p_property_id || ':' || p_booking_id || ':payment_link'));
  select * into n from sms_notifications where property_id=p_property_id and booking_id=p_booking_id and notification_type='payment_link' and version=1;
  if found then return jsonb_build_object('ok',true,'notification_id',n.id,'status',n.status,'idempotent',true); end if;
  if p_payment_base_url !~ '^https://[^/]+$' then raise exception 'payment_base_url_invalid'; end if;
  select booking_id,property_id,payment_link,status,created_at into b from bookings where property_id=p_property_id and booking_id=p_booking_id for update;
  if not found then raise exception 'booking_not_found'; end if;
  if b.status <> 'pending_payment' or b.payment_link is null or b.payment_link = '' then raise exception 'valid_online_invoice_required'; end if;
  if lower(split_part(regexp_replace(b.payment_link,'^https?://','','i'), '/', 1)) <> all(p_allowed_hosts) then raise exception 'invoice_host_not_allowed'; end if;
  t := encode(gen_random_bytes(24),'base64'); t := replace(replace(replace(t,'+','-'),'/','_'),'=',''); h := encode(digest(t,'sha256'),'hex');
  insert into payment_link_tokens(token_hash,property_id,booking_id,invoice_url,expires_at) values(h,p_property_id,p_booking_id,b.payment_link,now()+interval '24 hours');
  url := p_payment_base_url || '/p/' || t;
  message := case lower(coalesce(p_language,'uk')) when 'ru' then 'StayAI: Оплата бронирования: ' || url when 'en' then 'StayAI: Booking payment: ' || url else 'StayAI: Оплата бронювання: ' || url end;
  insert into notification_consents(property_id,booking_id,call_id,phone,phone_source) values(p_property_id,p_booking_id,p_call_id,p_phone,p_phone_source);
  insert into sms_notifications(property_id,booking_id,notification_type,phone,text,idempotency_key) values(p_property_id,p_booking_id,'payment_link',p_phone,message,encode(digest(p_property_id||':'||p_booking_id||':payment_link:1','sha256'),'hex'))
  on conflict(property_id,booking_id,notification_type,version) do update set updated_at=now() returning * into n;
  return jsonb_build_object('ok',true,'notification_id',n.id,'status',n.status);
end $$;

create or replace function public.sms_claim_outbox() returns jsonb language plpgsql security definer set search_path=public as $$
declare n public.sms_notifications%rowtype;
begin
 select * into n from sms_notifications where (status='QUEUED' or (status='PROCESSING' and lease_until<now())) and attempts<3 order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 update sms_notifications set status='PROCESSING',lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now() where id=n.id returning * into n;
 return jsonb_build_object('id',n.id,'phone',n.phone,'text',n.text,'idempotency_key',n.idempotency_key);
end $$;
create or replace function public.sms_finish_outbox(p_id uuid,p_status text,p_provider text,p_provider_message_id text,p_error text,p_segments integer,p_cost numeric) returns void language plpgsql security definer set search_path=public as $$
begin update sms_notifications set status=p_status,provider=coalesce(p_provider,provider),provider_message_id=coalesce(p_provider_message_id,provider_message_id),last_error=p_error,segment_count=nullif(p_segments,0),estimated_cost=nullif(p_cost,0),sent_at=case when p_status in ('ACCEPTED','SENT') then now() else sent_at end,lease_until=null,updated_at=now() where id=p_id and status='PROCESSING'; end $$;
create or replace function public.sms_record_dlr(p_provider text,p_event_id text,p_provider_message_id text,p_status text,p_payload jsonb) returns boolean language plpgsql security definer set search_path=public as $$
declare n uuid; begin
 insert into sms_delivery_events(provider,event_id,status,payload) values(p_provider,p_event_id,p_status,p_payload) on conflict do nothing;
 if not found then return false; end if;
 select id into n from sms_notifications where provider=p_provider and provider_message_id=p_provider_message_id;
 update sms_delivery_events set notification_id=n where provider=p_provider and event_id=p_event_id;
 if n is not null then update sms_notifications set status=p_status,delivered_at=case when p_status='DELIVERED' then now() else delivered_at end,updated_at=now() where id=n and status not in ('DELIVERED','FAILED'); end if;
 return true; end $$;
revoke all on function public.sms_prepare_payment_link(text,text,text,text,text,text,text,text[]) from public;
revoke all on function public.sms_claim_outbox() from public;
revoke all on function public.sms_finish_outbox(uuid,text,text,text,text,integer,numeric) from public;
revoke all on function public.sms_record_dlr(text,text,text,text,jsonb) from public;

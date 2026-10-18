-- Commercial acquiring hardening. Apply only to the isolated staging project
-- after backup verification; no browser role receives access to these tables.
create table if not exists public.payment_merchants (
  merchant_id text primary key,
  property_id text not null references public.properties(property_id) on delete cascade,
  provider text not null check (provider = 'monobank_acquiring'),
  credentials jsonb not null,
  enabled boolean not null default false,
  credential_version integer not null default 1,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(property_id, provider)
);
alter table public.payment_merchants enable row level security;

alter table public.bookings add column if not exists payment_merchant_id text;
alter table public.bookings add column if not exists payment_currency integer;
alter table public.bookings add column if not exists payment_state text not null default 'PENDING';
alter table public.bookings add column if not exists invoice_expires_at timestamptz;
create index if not exists bookings_payment_reconciliation_idx
  on public.bookings(payment_merchant_id, payment_reference, payment_state)
  where payment_reference is not null;

create table if not exists public.payment_events (
  event_key text primary key,
  provider text not null check (provider = 'monobank_acquiring'),
  source text not null check (source in ('webhook','reconciliation')),
  property_id text not null,
  booking_id text not null,
  merchant_id text not null,
  invoice_id text not null,
  status text not null,
  amount_kopecks bigint,
  currency integer,
  final_amount_kopecks bigint,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  payload_hash text not null,
  outcome text not null
);
create index if not exists payment_events_booking_idx on public.payment_events(property_id, booking_id, received_at desc);
alter table public.payment_events enable row level security;

-- Server-only atomic ledger write and state transition. A late success is
-- intentionally held for operator review instead of silently confirming an
-- inventory hold that already expired.
create or replace function public.payment_record_monobank_event(
 p_event_key text, p_source text, p_property_id text, p_booking_id text,
 p_merchant_id text, p_invoice_id text, p_status text, p_amount_kopecks bigint,
 p_currency integer, p_final_amount_kopecks bigint, p_occurred_at timestamptz,
 p_payload_hash text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.bookings%rowtype; v_outcome text := 'ignored'; v_expected bigint;
begin
 if p_source not in ('webhook','reconciliation') or p_event_key is null or p_payload_hash is null then
   raise exception 'invalid_payment_event';
 end if;
 select * into b from public.bookings where property_id=p_property_id and booking_id=p_booking_id
   and payment_method='monobank_acquiring' and payment_merchant_id=p_merchant_id
   and payment_reference=p_invoice_id for update;
 if found then
   v_expected := round(b.total_price * 100)::bigint;
   if p_status='success' and p_currency=980 and p_amount_kopecks=v_expected
      and (p_final_amount_kopecks is null or p_final_amount_kopecks=v_expected) then
     if b.payment_state='PAID' then v_outcome := 'already_paid';
     elsif b.hold_expires_at is not null and b.hold_expires_at < now() then
       update public.bookings set payment_state='REQUIRES_REVIEW' where property_id=p_property_id and booking_id=p_booking_id;
       v_outcome := 'requires_review';
     else
       update public.bookings set status='paid', payment_state='PAID' where property_id=p_property_id and booking_id=p_booking_id and status='pending_payment';
       v_outcome := 'paid';
     end if;
   elsif p_status in ('expired','failure','reversed') and b.payment_state='PENDING' then
     update public.bookings set payment_state=upper(p_status) where property_id=p_property_id and booking_id=p_booking_id;
     v_outcome := 'terminal_nonpayment';
   else v_outcome := 'unmatched_or_nonterminal'; end if;
 else v_outcome := 'booking_mismatch'; end if;
 insert into public.payment_events(event_key,provider,source,property_id,booking_id,merchant_id,invoice_id,status,amount_kopecks,currency,final_amount_kopecks,occurred_at,payload_hash,outcome)
 values(p_event_key,'monobank_acquiring',p_source,p_property_id,p_booking_id,p_merchant_id,p_invoice_id,p_status,p_amount_kopecks,p_currency,p_final_amount_kopecks,p_occurred_at,p_payload_hash,v_outcome)
 on conflict(event_key) do nothing;
 if not found then return jsonb_build_object('duplicate',true,'outcome','duplicate'); end if;
 return jsonb_build_object('duplicate',false,'outcome',v_outcome);
end $$;

-- Bind a hold to one configured merchant before an invoice request. This
-- prevents a second merchant from attaching an invoice to the same booking.
create or replace function public.booking_bind_monobank_merchant(
 p_property_id text, p_booking_id text, p_merchant_id text
) returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 update public.bookings set payment_merchant_id=p_merchant_id, payment_currency=980
  where property_id=p_property_id and booking_id=p_booking_id and status='pending_payment'
    and payment_method='monobank_acquiring' and payment_reference is null
    and (payment_merchant_id is null or payment_merchant_id=p_merchant_id);
 get diagnostics n = row_count; return n=1;
end $$;

-- Existing function is replaced only to add expiry, preserving its signature.
create or replace function public.booking_attach_monobank_invoice(
  p_property_id text, p_booking_id text, p_invoice_id text, p_payment_link text
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_updated integer;
begin
 update public.bookings set payment_reference=p_invoice_id,payment_link=p_payment_link,
   invoice_expires_at=hold_expires_at,payment_state='PENDING'
  where property_id=p_property_id and booking_id=p_booking_id and status='pending_payment'
    and payment_method='monobank_acquiring' and payment_reference is null
    and payment_merchant_id is not null;
 get diagnostics v_updated = row_count; return v_updated=1;
end $$;
revoke all on public.payment_merchants, public.payment_events from public, anon, authenticated;
revoke all on function public.payment_record_monobank_event(text,text,text,text,text,text,text,bigint,integer,bigint,timestamptz,text) from public, anon, authenticated;
revoke all on function public.booking_bind_monobank_merchant(text,text,text) from public, anon, authenticated;

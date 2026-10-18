-- Staging-safe booking hold for Monobank acquiring.  This adds nullable,
-- backward-compatible fields only; existing bookings keep their values.
alter table public.bookings add column if not exists total_price numeric;
alter table public.bookings add column if not exists payment_method text;
alter table public.bookings add column if not exists payment_reference text;
alter table public.bookings add column if not exists hold_expires_at timestamptz;
alter table public.bookings add column if not exists booking_request_key text;
create unique index if not exists bookings_request_key_unique
  on public.bookings(booking_request_key) where booking_request_key is not null;
create index if not exists bookings_availability_lookup_idx
  on public.bookings(property_id, room_type, check_in, check_out, status);

-- Atomically rechecks inventory and creates a short, pending-payment hold.
-- Calls from other application paths must use this function too to share its
-- per-room advisory lock.  It creates no payment and cannot mark a booking paid.
create or replace function public.booking_prepare_monobank_hold(
  p_property_id text, p_booking_id text, p_request_key text, p_room_type text,
  p_check_in date, p_check_out date, p_guest_name text, p_guest_contact text,
  p_hold_minutes integer default 15
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_room public.rooms%rowtype;
  v_existing public.bookings%rowtype;
  v_occupied integer;
  v_nights integer;
  v_total numeric;
begin
  if p_property_id is null or p_booking_id is null or p_request_key is null
     or p_room_type is null or p_check_in is null or p_check_out is null
     or nullif(trim(p_guest_name),'') is null or nullif(trim(p_guest_contact),'') is null then
    raise exception 'booking_fields_required';
  end if;
  if p_check_out <= p_check_in then raise exception 'invalid_stay_dates'; end if;
  if p_hold_minutes < 5 or p_hold_minutes > 60 then raise exception 'invalid_hold_duration'; end if;

  perform pg_advisory_xact_lock(hashtext(p_property_id || ':' || p_room_type));
  select * into v_existing from public.bookings
    where booking_request_key=p_request_key and property_id=p_property_id;
  if found then
    return jsonb_build_object('ok', true, 'idempotent', true,
      'booking', jsonb_build_object('booking_id',v_existing.booking_id,'room_type',v_existing.room_type,
        'check_in',v_existing.check_in,'check_out',v_existing.check_out,'price_per_night',v_existing.price_per_night,
        'total_price',v_existing.total_price,'status',v_existing.status,'payment_link',v_existing.payment_link,
        'payment_reference',v_existing.payment_reference));
  end if;

  select * into v_room from public.rooms where property_id=p_property_id and room_type=p_room_type for update;
  if not found then return jsonb_build_object('ok',false,'code','room_type_unavailable'); end if;
  select count(*) into v_occupied from public.bookings
    where property_id=p_property_id and room_type=p_room_type
      and status in ('paid','pending_payment')
      and (status='paid' or hold_expires_at is null or hold_expires_at > now())
      and check_in < p_check_out and check_out > p_check_in;
  if v_occupied >= coalesce(v_room.quantity,1) then
    return jsonb_build_object('ok',false,'code','room_no_longer_available');
  end if;
  v_nights := p_check_out - p_check_in;
  v_total := v_room.price_per_night * v_nights;
  insert into public.bookings(booking_id,booking_request_key,property_id,room_type,check_in,check_out,
    guest_name,guest_contact,price_per_night,total_price,status,payment_method,hold_expires_at)
  values(p_booking_id,p_request_key,p_property_id,p_room_type,p_check_in,p_check_out,
    trim(p_guest_name),trim(p_guest_contact),v_room.price_per_night,v_total,'pending_payment','monobank_acquiring',
    now() + make_interval(mins => p_hold_minutes));
  return jsonb_build_object('ok',true,'idempotent',false,
    'booking',jsonb_build_object('booking_id',p_booking_id,'room_type',p_room_type,'check_in',p_check_in,
      'check_out',p_check_out,'price_per_night',v_room.price_per_night,'total_price',v_total,
      'status','pending_payment'));
end $$;

create or replace function public.booking_attach_monobank_invoice(
  p_property_id text, p_booking_id text, p_invoice_id text, p_payment_link text
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_updated integer;
begin
  if p_property_id is null or p_booking_id is null or p_invoice_id is null or p_payment_link is null then
    raise exception 'invoice_fields_required';
  end if;
  update public.bookings set payment_reference=p_invoice_id,payment_link=p_payment_link
    where property_id=p_property_id and booking_id=p_booking_id and status='pending_payment'
      and payment_method='monobank_acquiring' and payment_reference is null;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

create or replace function public.booking_release_monobank_hold(
  p_property_id text, p_booking_id text
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_updated integer;
begin
  update public.bookings set status='payment_failed',hold_expires_at=now()
    where property_id=p_property_id and booking_id=p_booking_id and status='pending_payment'
      and payment_method='monobank_acquiring' and payment_reference is null;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

revoke all on function public.booking_prepare_monobank_hold(text,text,text,text,date,date,text,text,integer) from public, anon, authenticated;
revoke all on function public.booking_attach_monobank_invoice(text,text,text,text) from public, anon, authenticated;
revoke all on function public.booking_release_monobank_hold(text,text) from public, anon, authenticated;

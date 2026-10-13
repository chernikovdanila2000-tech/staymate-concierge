-- StayAI phone-call metadata and atomic admission control. No audio or transcripts are stored.
create table if not exists public.voice_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('zadarma')),
  phone_number text not null,
  property_id text not null references public.properties(property_id) on delete cascade,
  admin_transfer_uri text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, phone_number)
);

create table if not exists public.voice_calls (
  call_id text primary key,
  provider text not null,
  provider_call_id text not null,
  property_id text not null references public.properties(property_id) on delete restrict,
  phone_number text not null,
  caller_hash text,
  status text not null check (status in ('accepted','active','transferring','transferred','completed','failed','rejected','stale')),
  model text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer,
  reserved_seconds integer not null default 0,
  outcome text,
  transferred_to_human boolean not null default false,
  booking_reference text,
  error_code text,
  created_at timestamptz not null default now(),
  unique(provider, provider_call_id)
);
create index if not exists voice_calls_property_started_idx on public.voice_calls(property_id, started_at desc);
create index if not exists voice_calls_active_idx on public.voice_calls(status, started_at) where ended_at is null;

alter table public.voice_phone_numbers enable row level security;
alter table public.voice_calls enable row level security;
-- Backend uses its server-side service credential. No browser/client mutation policy is granted.

create or replace function public.voice_begin_call(
  p_provider text, p_provider_call_id text, p_to_number text, p_caller_hash text, p_model text,
  p_reserve_seconds integer, p_max_concurrent_per_hotel integer, p_max_global integer,
  p_rate_per_caller integer, p_rate_window_seconds integer, p_daily_limit_seconds integer,
  p_monthly_limit_seconds integer, p_global_daily_limit_seconds integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_mapping public.voice_phone_numbers%rowtype; v_existing text; v_count integer; v_seconds bigint;
begin
  perform pg_advisory_xact_lock(hashtext('stayai-voice-global'));
  perform pg_advisory_xact_lock(hashtext(p_provider || ':' || p_to_number));
  select call_id into v_existing from voice_calls where provider = p_provider and provider_call_id = p_provider_call_id;
  if v_existing is not null then return jsonb_build_object('ok', true, 'code', 'CALL_ALREADY_STARTED', 'call_id', v_existing); end if;
  select * into v_mapping from voice_phone_numbers where provider = p_provider and phone_number = p_to_number and enabled = true for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'PHONE_NOT_CONFIGURED'); end if;
  select count(*) into v_count from voice_calls where property_id = v_mapping.property_id and ended_at is null and status in ('accepted','active','transferring');
  if v_count >= p_max_concurrent_per_hotel then return jsonb_build_object('ok', false, 'code', 'HOTEL_CONCURRENCY_LIMIT'); end if;
  select count(*) into v_count from voice_calls where ended_at is null and status in ('accepted','active','transferring');
  if v_count >= p_max_global then return jsonb_build_object('ok', false, 'code', 'GLOBAL_CONCURRENCY_LIMIT'); end if;
  if p_caller_hash is not null then select count(*) into v_count from voice_calls where caller_hash = p_caller_hash and started_at > now() - make_interval(secs => p_rate_window_seconds); if v_count >= p_rate_per_caller then return jsonb_build_object('ok', false, 'code', 'CALLER_RATE_LIMIT'); end if; end if;
  select coalesce(sum(reserved_seconds),0) into v_seconds from voice_calls where property_id = v_mapping.property_id and started_at >= date_trunc('day', now());
  if v_seconds + p_reserve_seconds > p_daily_limit_seconds then return jsonb_build_object('ok', false, 'code', 'HOTEL_DAILY_LIMIT'); end if;
  select coalesce(sum(reserved_seconds),0) into v_seconds from voice_calls where property_id = v_mapping.property_id and started_at >= date_trunc('month', now());
  if v_seconds + p_reserve_seconds > p_monthly_limit_seconds then return jsonb_build_object('ok', false, 'code', 'HOTEL_MONTHLY_LIMIT'); end if;
  select coalesce(sum(reserved_seconds),0) into v_seconds from voice_calls where started_at >= date_trunc('day', now());
  if v_seconds + p_reserve_seconds > p_global_daily_limit_seconds then return jsonb_build_object('ok', false, 'code', 'GLOBAL_DAILY_LIMIT'); end if;
  insert into voice_calls(call_id,provider,provider_call_id,property_id,phone_number,caller_hash,status,model,reserved_seconds) values(p_provider_call_id,p_provider,p_provider_call_id,v_mapping.property_id,p_to_number,p_caller_hash,'accepted',p_model,p_reserve_seconds);
  return jsonb_build_object('ok', true, 'call_id', p_provider_call_id, 'property_id', v_mapping.property_id, 'admin_transfer_uri', v_mapping.admin_transfer_uri);
end $$;

create or replace function public.voice_finish_call(p_call_id text, p_status text, p_outcome text, p_error_code text, p_transferred boolean)
returns void language plpgsql security definer set search_path = public as $$
begin update voice_calls set status=p_status, outcome=p_outcome, error_code=p_error_code, transferred_to_human=p_transferred, ended_at=coalesce(ended_at,now()), duration_seconds=greatest(0,floor(extract(epoch from (coalesce(ended_at,now())-started_at)))::integer), reserved_seconds=greatest(0,floor(extract(epoch from (coalesce(ended_at,now())-started_at)))::integer) where call_id=p_call_id; end $$;

create or replace function public.voice_mark_stale_calls(p_hung_seconds integer) returns void language plpgsql security definer set search_path = public as $$
begin update voice_calls set status='stale', outcome='hung_call_cleanup', ended_at=now(), duration_seconds=greatest(0,floor(extract(epoch from (now()-started_at)))::integer), reserved_seconds=greatest(0,floor(extract(epoch from (now()-started_at)))::integer) where ended_at is null and started_at < now() - make_interval(secs => p_hung_seconds); end $$;

revoke all on function public.voice_begin_call(text,text,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer) from public;
revoke all on function public.voice_finish_call(text,text,text,text,boolean) from public;
revoke all on function public.voice_mark_stale_calls(integer) from public;

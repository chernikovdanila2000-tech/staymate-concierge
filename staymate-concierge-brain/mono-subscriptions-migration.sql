-- StayAI mono acquiring subscriptions: additive-only migration.
-- Apply only after reviewing and testing backend integration.
-- No changes to historical WayForPay or NOWPayments orders.
alter table public.subscription_orders
  add column if not exists mono_invoice_id text;

create unique index if not exists subscription_orders_mono_invoice_unique
  on public.subscription_orders (mono_invoice_id)
  where mono_invoice_id is not null;

-- A single database transaction atomically marks an invoice as paid
-- and activates/extends the linked hotel subscription exactly once.
-- Only the trusted server's service_role can execute this function.
create or replace function public.finalize_mono_subscription(
  p_invoice_id text,
  p_reference text,
  p_amount_kopecks bigint
)
returns table(result text, property_id text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.subscription_orders%rowtype;
begin
  if p_invoice_id is null or p_reference is null
     or p_amount_kopecks is null or p_amount_kopecks <= 0 then
    raise exception 'Invalid invoice parameters';
  end if;

  select o.* into v_order
  from public.subscription_orders o
  where o.mono_invoice_id = p_invoice_id
    and o.order_id = p_reference
    and o.payment_provider = 'monobank'
  for update;

  if not found then
    raise exception 'Subscription order not found';
  end if;

  if v_order.is_trial_card is true
     or v_order.amount_uah is null
     or (v_order.amount_uah * 100) <> p_amount_kopecks then
    raise exception 'Subscription order mismatch';
  end if;

  if v_order.status = 'paid' then
    result := 'already_paid';
    property_id := v_order.property_id;
    return next;
    return;
  end if;

  if v_order.status <> 'pending' then
    raise exception 'Subscription order has unexpected status';
  end if;

  update public.subscription_orders
    set status = 'paid'
  where order_id = v_order.order_id;

  update public.properties
  set subscription_status = 'active',
      subscription_plan = v_order.plan,
      subscription_active_until =
        greatest(coalesce(subscription_active_until, now()), now()) + interval '31 days'
  where properties.property_id = v_order.property_id;

  if not found then
    raise exception 'Hotel for subscription not found';
  end if;

  result := 'paid';
  property_id := v_order.property_id;
  return next;
end;
$$;

revoke all on function public.finalize_mono_subscription(text,text,bigint)
  from public, anon, authenticated;
grant execute on function public.finalize_mono_subscription(text,text,bigint)
  to service_role;

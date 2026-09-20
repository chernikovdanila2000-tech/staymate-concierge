-- StayAI: Блок 3 — інформація про готель для гостей (контекст ШІ-агента).
-- Одна дозволена мова правди про заклад — ці поля, а не вигадки моделі.
-- Безпечно виконувати повторно.
-- Виконати один раз у Supabase → SQL Editor → Run.

create table if not exists hotel_info (
  property_id text primary key references properties(property_id) on delete cascade,
  directions text,            -- адреса і як дістатися
  check_in_time text,
  check_out_time text,
  parking text,                -- наявність, ціна, умови — одним полем
  breakfast text,
  wifi text,
  pets_policy text,
  house_rules text,
  cancellation_policy text,
  payment_methods text,
  amenities text,               -- зручності/послуги закладу
  contacts text,
  late_checkout text,
  early_checkin text,
  transfer text,
  additional_info text,
  updated_at timestamptz default now()
);

alter table hotel_info enable row level security;

drop policy if exists "Owners can manage their own hotel_info" on hotel_info;
create policy "Owners can manage their own hotel_info"
  on hotel_info for all
  using (property_id in (select property_id from properties where owner_id = auth.uid()))
  with check (property_id in (select property_id from properties where owner_id = auth.uid()));

-- StayAI: пряма оплата гостя готелю (картка/IBAN + Monobank API для
-- автоматичного підтвердження), замість єдиного тестового WayForPay-акаунта.
-- Виконати один раз у Supabase → SQL Editor → Run.

-- Реквізити готелю для прямого переказу від гостя. Не секрет (показуються
-- гостю відкрито), тому без шифрування — на відміну від монобанк-токена
-- нижче, який зберігається в уже існуючій зашифрованій таблиці channels.
alter table properties add column if not exists payout_card text;
alter table properties add column if not exists payout_iban text;
alter table properties add column if not exists payout_recipient_name text;

-- Яким способом гість оплачував цю конкретну броню, і за яким коротким
-- кодом звірити переказ у виписці банку (вписується гостем у коментар до
-- переказу). total_price додано окремо від price_per_night — бо саме
-- загальну суму (за всі ночі) звіряє автоматична перевірка Monobank.
alter table bookings add column if not exists total_price numeric;
alter table bookings add column if not exists payment_method text default 'wayforpay';
alter table bookings add column if not exists payment_reference text;
alter table bookings add constraint bookings_payment_method_check
  check (payment_method in ('wayforpay', 'card_transfer'));

-- Раніше броні власник міг тільки переглядати — для ручного "Позначити
-- оплаченим" (коли автоматична перевірка Monobank недоступна чи не
-- налаштована) потрібен ще й UPDATE.
drop policy if exists "Owners can update their own bookings" on bookings;
create policy "Owners can update their own bookings"
  on bookings for update
  using (property_id in (select property_id from properties where owner_id = auth.uid()))
  with check (property_id in (select property_id from properties where owner_id = auth.uid()));

-- StayAI: автопродовження підписки після пробного періоду.
-- Безпечно виконувати повторно (усюди add column if not exists).
-- Виконати один раз у Supabase → SQL Editor → Run.

-- Чи погодився власник готелю на автосписання після 3-денного пробного
-- періоду (вмикається, коли він вводить платіжні дані при старті тріалу).
-- Це ОДИНОКЕ джерело правди для того, чи можна намагатись списати гроші:
-- сервер ніколи не спробує списати, якщо тут false, незалежно від того,
-- що повернув чи не повернув сам WayForPay.
alter table properties add column if not exists auto_renew boolean not null default false;

-- Коли власник натиснув "Скасувати автопродовження" в кабінеті — зберігаємо
-- час для власної історії/підтримки, окремо від самого прапорця auto_renew.
alter table properties add column if not exists subscription_cancelled_at timestamptz;

-- Референс WayForPay для регулярного платежу (потрібен, щоб пізніше
-- скасувати підписку на стороні WayForPay через їх API).
alter table properties add column if not exists regular_payment_reference text;

-- Позначка, що останній автоматичний платіж за тріал/підписку не пройшов —
-- щоб кабінет міг показати попередження власнику й не намагатись списувати
-- нескінченно без сповіщення.
alter table properties add column if not exists last_auto_charge_failed boolean not null default false;

-- Чи це замовлення — підключення картки при старті пробного періоду
-- (регулярний платіж з відкладеним першим списанням), а не звичайна
-- одноразова оплата тарифу. Вебхук оплати читає це поле, щоб знати,
-- чи вмикати properties.auto_renew при підтвердженні.
alter table subscription_orders add column if not exists is_trial_card boolean not null default false;

